# Session Turn Control

Branch: `local-stage`

## Objective

Separate user-driven chat sessions from task-driven sessions without changing
the task lifecycle. A plain chat session should run only when the user sends a
message. A task session may be woken by the dispatcher according to task state.
Provider/system errors that cannot be solved by retry must stop further turns
even when no task is attached.

## Runtime Model

Sessions carry two operational facts:

- `kind`: `chat` or `task`.
- `turns_blocked_reason`: nullable hard-stop reason.

`kind` answers whether the dispatcher may start autonomous work:

- `chat`: direct `/api/chat` only. The model/tool loop may run until the
  assistant final response for that user message, but the dispatcher must not
  wake the session later by itself. A queued direct `user_message` for the same
  chat session is still user-driven and may run when capacity frees.
- `task`: dispatcher may wake the session from task lifecycle signals.

`turns_blocked_reason` answers whether any new turn may start:

- `null`: turns are allowed subject to `kind`, capacity, and task state.
- non-null: both `/api/chat` and dispatcher must reject/skip the session until
  a repair path clears the reason.

This is intentionally not a second task state machine. Task progress,
retryability, and completion remain owned by task status.

## Provider Error Contract

The OpenAI context-window overflow response is a hard stop:

```json
{
  "type": "error",
  "sequence_number": 2,
  "error": {
    "type": "invalid_request_error",
    "code": "context_length_exceeded",
    "message": "Your input exceeds the context window of this model. Please adjust your input and try again.",
    "param": "input"
  }
}
```

On this error:

- If a task is attached to the session, mark the task `system_blocked`.
- Always set `turns_blocked_reason = "context_length_exceeded"` on the session.
- `/api/chat` must return `409 session_system_blocked` for subsequent user
  messages.
- The dispatcher must not wake the session.

Compression failure before provider send is also a hard stop:

- If compaction was required and failed/no-oped, do not send raw history.
- Mark the attached task `system_blocked` when present.
- Set `turns_blocked_reason = "compression_failed"` on the session.

## Milestones

### Milestone 1 - Architecture And Contract

Goal: lock the smallest model that supports chat-vs-task scheduling and
taskless hard-stop provider errors.

TDD:

- Documentation before code.
- Explicit non-goals and acceptance criteria before implementation.

Status:

- Complete.

### Milestone 2 - Storage And Store API

Goal: add session-owned operational fields and methods.

Slices:

1. Add DB columns:
   - `sessions.kind`, default `chat`, not null.
   - `sessions.turns_blocked_reason`, nullable.
   - `sessions.turns_blocked_at`, nullable unix seconds.
2. Add session store methods:
   - create sessions with `kind`, defaulting to `chat`.
   - set kind to `task` for explicit creation/repair paths.
   - block turns with a reason.
   - clear turn block for manual repair paths.
3. Preserve compaction fork behavior:
   - active replacement keeps `kind` and turn block fields.
   - archived shell does not receive a turn block.

TDD:

- Store tests fail first for default `chat`, explicit `task`, block/clear, and
  compaction fork preservation.

Status:

- Complete.

### Milestone 3 - Scheduling And Chat Gates

Goal: use the storage facts at turn boundaries.

Slices:

1. `/api/chat`:
   - reject blocked sessions with `409 session_system_blocked`.
   - create new direct-chat sessions as `chat`.
2. Dispatcher:
   - skip sessions with `turns_blocked_reason`.
   - skip taskless `chat` sessions for autonomous/system wake.
   - allow queued direct `user_message` rows for `chat` sessions because those
     are delayed user turns, not autonomous work.
   - create task sessions for unbound tasks.
   - treat any session with bound tasks as task-driven for scheduling, even if
     the row predates `kind` or was originally created as chat.

TDD:

- Dispatcher test: pending inbox on a taskless `chat` session does not wake.
- Dispatcher test: ready task session wakes.
- Route/e2e test: blocked taskless session rejects `/api/chat`.

Status:

- Complete.

### Milestone 4 - Provider Error Hard Stop

Goal: turn context overflow and compression failure into session hard stops.

Slices:

1. Stream/provider error path:
   - mark task `system_blocked` when one exists.
   - block the session even when no task exists.
2. Preflight compression failure path:
   - block the session before returning the upstream error message.
3. Keep canonical messages visible; do not delete or replace history.

TDD:

- E2E taskless context overflow: first message records provider error, second
  message returns `409 session_system_blocked`.
- E2E task-bound context overflow: task is `system_blocked`, session is blocked,
  retry returns `409`.
- E2E compression failure: raw history is not sent and retry returns `409`.

Status:

- Complete.

### Milestone 5 - Validation And Documentation Close

Goal: prove behavior locally and in the isolated live test environment.

Validation:

- Focused DB/session store tests.
- Focused dispatcher tests.
- Focused server e2e tests for chat/task/context overflow.
- Live `~/.openacme-test` taskless overflow verification.
- Live `~/.openacme-test` task-bound overflow/compression verification.

Acceptance:

- Plain chat sessions do not receive autonomous dispatcher turns.
- Task sessions keep current task lifecycle behavior.
- Context overflow blocks further turns whether or not a task exists.
- Documentation records exact validation commands and live evidence.

## Non-Goals

- No change to task statuses or task lifecycle semantics.
- No UI control for manually clearing a blocked session in this slice.
- No automatic conversion of every chat request into a task.
- No broad scheduler redesign beyond the session-kind gate.
- No compatibility alias for old session kinds.

## Validation Record

Completed on 2026-07-28:

- `pnpm --filter @openacme/db test -- stores.test.ts clean-bootstrap.test.ts`
  passed.
- `pnpm --filter @openacme/db build` passed.
- `pnpm --filter @openacme/server test -- dispatcher.test.ts` passed.
- `pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/chat.e2e.ts`
  passed outside the sandbox.
- `pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/tasks.e2e.ts`
  passed outside the sandbox.
- `pnpm --filter @openacme/server build` passed.

Live `~/.openacme-test` evidence:

- Taskless chat overflow:
  - session `live-session-only-1785261180100-198448ba-d5da-4736-9188-0acefabf4ff1`
  - `kind = "chat"`
  - `turnsBlockedReason = "context_length_exceeded"`
  - retry returned `409 session_system_blocked`
- Compression failure:
  - session `live-1785261214183-bc650fcf-1cec-438f-ae06-e2f9a29beb20`
  - task `279`
  - task status `system_blocked`
  - retry returned `409 session_system_blocked`
- Task-bound context overflow:
  - session `live-1785261223550-6d2c77f7-1f85-4622-960b-18ca09fffcc6`
  - task `280`
  - task status `system_blocked`
  - retry returned `409 session_system_blocked`
