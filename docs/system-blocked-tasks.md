# System Blocked Tasks

`system_blocked` is a non-terminal task status for failures that automatic
retry should not revisit. The intended definition is:

> Automatic retry cannot solve this; every route is blocked until someone
> changes the system or the task state.

## Trigger

The dispatcher marks an in-progress task `system_blocked` when an autonomous
turn fails with an OpenAI context-window overflow response:

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

The parser handles both structured provider objects and stringified error
messages. It keys on `context_length_exceeded` and the matching OpenAI context
window message.

## Behavior

- `system_blocked` clears `start_at`.
- The task keeps its `session_id` for debugging.
- The dispatcher does not wake a session that has a `system_blocked` task, even
  if inbox rows arrive.
- `/api/chat` rejects interactive turns for that session with
  `409 session_system_blocked`.
- A human or repair path must explicitly move the task to another status before
  work can continue.

## Verification

Focused checks:

```sh
pnpm --filter @openacme/agent-core test -- error-classifier.test.ts
pnpm --filter @openacme/tasks test -- store.test.ts
pnpm --filter @openacme/server test -- dispatcher.test.ts
cd packages/server && pnpm vitest run --config vitest.e2e.config.ts test/e2e/tasks.e2e.ts
```

The e2e suite includes a live-style autonomous task turn that injects the exact
`context_length_exceeded` provider response and asserts the task becomes
`system_blocked` with a system comment containing the parsed provider message.
