# Parallel Agent Runtime TDD Plan

Branch: `agent/parallel-dispatcher-plan`

Worktree: `/private/tmp/openacme-parallel-plan`

Status: complete. Slices 1-12 are implemented and validated.

Dev data dir prepared for manual platform smoke:

```sh
cd /private/tmp/openacme-parallel-plan
OPENACME_DATA_DIR="$PWD/.openacme-dev" pnpm dev
```

This data dir is intentionally local to the temp worktree. Do not use or mutate `~/.openacme`. The configured manual smoke port is `127.0.0.1:3457`.

## Goal

Allow one canonical agent to run multiple distinct sessions concurrently, bounded by an agent-level limit, without introducing virtual agent identities.

The product model stays:

- one roster entry per agent
- one `AGENT.md` per agent
- one canonical `session.agentId`
- one task assignee id
- one memory namespace

The runtime model becomes:

- one canonical agent can have `N` active session turns
- the same session can never have two active turns
- dispatcher capacity is counted by active sessions, not by synthetic agent clones
- external side effects remain the responsibility of the user/agent design when they opt into parallel execution

## Explicit Non-Goals

- Do not create `agent-x##1` / `agent-x##2` persisted or public ids.
- Do not fork workspaces, browser profiles, MCP clients, memory stores, or email accounts in this milestone.
- Do not attempt fleet orchestration or worker-specific identity.
- Do not make parallelism default. Default remains `1`.
- Do not touch production data in `~/.openacme`.

## Current Architecture Facts

Dispatcher serialization is the current hard lock:

- `packages/server/src/dispatcher.ts` stores one `chains: Map<agentId, Promise>` and skips the agent when a chain exists.
- `tick()` walks active sessions for an agent and enqueues only the first eligible session.
- `enqueueTurn()` writes one promise under the agent id and deletes that key after the turn.
- `runningSessionIds()` and `isRunning(sessionId)` are already session-oriented and can survive the change.

Inbox delivery is the correctness blocker:

- `packages/db/src/stores/inbox-store.ts` exposes `pendingFor(agentId)` and `deleteDelivered(ids)`.
- `packages/agent-core/src/agent.ts` turn-start drain reads all rows for `this.config.id`, filters queued `user_message` rows by `relatedSession`, but treats non-user `system_notice` rows as deliverable to the current turn.
- The mid-turn drain reads `pendingFor(turnAgentId)` and deletes every fresh row it sees.
- Under parallel turns, this can inject or delete another session's wake.

Interactive turns already guard only the same session:

- `/api/chat` checks `activeTurns.has(sessionId) || dispatcher.isRunning(sessionId)`.
- If true, it queues the latest user message to the inbox with `relatedSession`.
- If false, it starts a direct `runChatTurn`.
- With agent-level concurrency, `/api/chat` must also respect the agent's capacity or it can bypass the dispatcher limit.

Task/process wakes route through inbox:

- `AgentManager.eventStore.onEmit` fans task events to recipients and writes `system_notice` inbox rows with `relatedTask` and `relatedSession` when known.
- Process completion validates `(sessionId, agentId)` before appending a `process_completed` event. That event then fans out as an inbox/system notice.

Tool/browser/workspace race risks are real but out of scope for runtime correctness:

- Tool-host is currently per canonical agent.
- Browser is currently per canonical agent.
- Workspace is currently per canonical agent.
- This milestone documents that opting into `maxConcurrentSessions > 1` means those shared side effects can collide.

## Target Design

Add per-agent settings:

```ts
maxConcurrentSessions?: number // default 1, min 1, max initial cap 5
parallelSchedulingPolicy?: "lane_first" | "chain_first" // default lane_first
```

Recommended schema placement:

- `packages/config/src/schema.ts`: `AgentDefinitionSchema.maxConcurrentSessions` and `parallelSchedulingPolicy`
- `packages/config/src/agent-store.ts`: no special work expected; frontmatter serialization should carry the field automatically
- `apps/web/app/routes/agents.tsx`: Settings tab controls near memory extraction

Runtime state:

```ts
type ActiveRunKind = "autonomous" | "interactive";

type ActiveRun = {
  agentId: string;
  sessionId: string;
  kind: ActiveRunKind;
  promise?: Promise<void>;
};

runningByAgent: Map<string, Set<string>>; // agentId -> sessionIds
runningSessions: Set<string>;             // existing session guard
interactiveBusy: Set<string>;             // can remain, but must count toward agent capacity
```

Core invariants:

- A session id appears in at most one active run.
- An agent id has at most `maxConcurrentSessions` active sessions.
- Interactive runs count against the same cap as autonomous runs.
- `maxConcurrentSessions` is resolved from the canonical agent definition at scheduling time.
- Direct user-message sessions get priority over task comments and autonomous task scheduling in every policy.
- Human-authored task comments get priority over autonomous task scheduling, but wait behind direct user messages.
- Existing public APIs continue to expose canonical `agentId` only.

Dispatcher tick behavior:

1. For each agent, resolve `limit = clamp(agent.maxConcurrentSessions ?? 1, 1, 5)`.
2. Compute `available = limit - runningByAgent.get(agentId).size`.
3. If `available <= 0`, skip this agent and remember it may need a post-run kick.
4. Bind unbound ready tasks as today.
5. Read pending inbox summary for the agent, but use session-aware targeting for spawn choice.
6. Order candidate sessions:
   - queued direct user messages first
   - then human-authored task comments
   - then `lane_first`: sessions with no or older recent run sequence first
   - or `chain_first`: targeted/hot chain sessions first
7. Walk ordered active sessions and enqueue up to `available` distinct sessions.
8. Never enqueue a session already in `runningSessions` or `interactiveBusy`.

Inbox semantics:

- `user_message` rows with `relatedSession = S` are deliverable only to session `S`.
- `system_notice` rows with `relatedSession = S` are deliverable only to session `S`.
- Rows with `relatedSession = null` are agent-wide notices. They may be claimed by one eligible session, not every parallel session.
- Mid-turn drain must claim only rows deliverable to the current session plus any one-time agent-wide rows assigned to that run.

Proposed store API:

```ts
claimForSession(input: {
  agentId: string;
  sessionId: string;
  includeAgentWide?: boolean;
  limit?: number;
}): InboxRow[]

pendingSummaryFor(agentId: string): {
  total: number;
  targetedSessionIds: Set<string>;
  userMessageSessionIds: Set<string>;
  userTaskCommentSessionIds: Set<string>;
  hasAgentWide: boolean;
}
```

Implementation detail: the claim must be atomic at the store boundary: select the deliverable rows and remove/mark them before returning so two active runs cannot both consume the same row. If we do hard-delete-on-claim, the agent must only claim immediately before it can materialize the rows into the turn. If we want retry-on-persist-failure, add a claimed state instead of delete, but that is a larger storage change.

Recommended first implementation: claim-and-delete in one synchronous DB method, because current inbox is staging, not audit, and task events remain durable in `task_events`.

Interactive `/api/chat` behavior:

- Same-session in-flight behavior stays unchanged: queue latest user message to inbox and return `queued: true`.
- Different-session behavior:
  - If agent has available capacity, start `runChatTurn` as today.
  - If agent is at capacity, queue the latest user message to that session's inbox and return `queued: true` with a clear `queuedReason: "agent_capacity"`.
- The queued session must be picked by dispatcher as soon as a slot frees.

UI behavior:

- Agent Settings tab gets an advanced control:
  - label: `Parallel sessions`
  - numeric stepper or select: `1..5`
  - default: `1`
  - warning visible when value > 1:
    - sessions can run concurrently
    - workspace, browser, tool-host, MCP, email, and memory are shared for this agent
    - user messages are prioritized before autonomous task scheduling
    - use only for agents whose tasks are safe to overlap
  - task scheduling select visible when value > 1:
    - `Start task lanes first` maps to `lane_first` and is the default
    - `Clear task chains first` maps to `chain_first`
- Do not auto-disable tools in this milestone. The user explicitly owns race-risk decisions for parallel agents.

## TDD Rule

Every implementation slice starts by adding or updating tests that fail on current `local-stage`. Only then implement the smallest code change to pass them.

Automated tests must use the existing real e2e server harness where behavior spans HTTP, SSE, dispatcher, task store, inbox, and agent loop:

```sh
pnpm --filter @openacme/server test:e2e -- parallel-dispatcher.e2e.ts
```

Narrow unit tests are allowed for dispatcher bookkeeping and inbox atomic claim, but they are not sufficient alone.

Manual smoke must use:

```sh
OPENACME_DATA_DIR="$PWD/.openacme-dev" pnpm dev
```

or, for bundled-static daemon smoke after build:

```sh
pnpm build
pnpm agent restart --data-dir "$PWD/.openacme-dev" --no-service --no-browser
```

Never run `pnpm agent start` or `openacme restart` against the default `~/.openacme` while developing this feature.

## Required Test Matrix

### Unit: Config And Serialization

File: `packages/config/test/agent-store.test.ts` or existing config schema test.

Tests:

1. `AgentDefinitionSchema defaults maxConcurrentSessions to 1`.
2. `AgentDefinitionSchema rejects maxConcurrentSessions < 1`.
3. `AgentDefinitionSchema rejects values above the initial supported cap`.
4. `AgentStore persists maxConcurrentSessions in AGENT.md frontmatter`.
5. Existing AGENT.md files without the field still parse.
6. `AgentDefinitionSchema defaults parallelSchedulingPolicy to lane_first`.
7. `AgentDefinitionSchema rejects invalid parallelSchedulingPolicy`.
8. `AgentStore persists parallelSchedulingPolicy in AGENT.md frontmatter`.

Acceptance:

- No existing AGENT.md grows noisy default frontmatter unless saved through UI/API.

### Unit: Inbox Claim Semantics

File: `packages/db/test/stores.test.ts` or `packages/db/test/inbox-store.test.ts`.

Tests:

1. `claimForSession returns only user messages for that session`.
2. `claimForSession returns only system notices for that session`.
3. `claimForSession does not claim rows targeted to another session`.
4. `claimForSession can claim agent-wide rows once`.
5. Two sequential claims for different sessions cannot both receive the same agent-wide row.
6. `pendingSummaryFor` reports targeted session ids and agent-wide presence.
7. `cancelQueuedUserMessage` still deletes only `(agentId, user_message, sourceId, relatedSession)`.

Acceptance:

- The old `pendingFor(agentId)` can remain for legacy callers only if parallel drain paths stop using it.
- Agent runtime drain must use the new claim API.

### Unit: Dispatcher Slot Accounting

File: `packages/server/test/dispatcher.test.ts`.

Tests:

1. Default `maxConcurrentSessions` preserves current behavior: one session per agent at a time.
2. `maxConcurrentSessions: 2` starts two distinct sessions for the same agent in one tick.
3. Limit `2` with three ready sessions starts exactly two; after one completes, a follow-up tick starts the third.
4. `runningSessionIds()` contains all active autonomous sessions.
5. `isRunning(sessionId)` returns true only for active sessions, not for all sessions owned by the agent.
6. Interactive busy sessions count toward the agent limit.
7. A same-session duplicate is never enqueued even when capacity remains.
8. Failure parking is scoped to the failing session and does not block another active session for the same agent.
9. `drain()` waits for all active run promises, not one promise per agent.
10. Post-run kick is per agent or otherwise safe when multiple agents/runs finish out of order.
11. Queued direct user messages are scheduled before autonomous task wakes when capacity frees.
12. `lane_first` starts unrun task lanes before continuing a hot chain.
13. `chain_first` continues a hot task chain before starting an unrun lane.

Acceptance:

- No synthetic agent ids appear in calls; fake manager sees canonical `agentId`.

### E2E: Parallel Task Wake

File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`.

Harness:

- Use `startE2EServer({ dispatcher: true, tickMs: 100 })`.
- Create one agent with `maxConcurrentSessions: 2`.
- Use two sessions with bound ready tasks.
- Use a stub-model slow directive that works for autonomous task prompts. If current `[[mock:slow]]` is only detected from last user text, extend test stub with a test-only `[[mock:slow-anywhere]]` directive based on `allText(prompt)`.

Test:

1. Open SSE for both sessions.
2. Seed two ready tasks bound to different sessions for the same agent.
3. Assert both sessions enter `running` before either has emitted final `idle`.
4. Assert both sessions eventually return `idle`.
5. Assert both sessions have an assistant message.

Acceptance:

- Proves real dispatcher + Hono + SSE + agent loop, not a fake manager.

### E2E: Capacity Limit With Backfill

Setup:

- One agent `maxConcurrentSessions: 2`.
- Three sessions with ready work.

Test:

1. Assert two sessions run first.
2. Assert the third does not run while both slots are active.
3. After one of the first two idles, assert the third starts without waiting for a long periodic tick.

Acceptance:

- Confirms post-run kick/backfill behavior.

### E2E: Same-Session New Message Wake

Setup:

- Start a slow interactive turn in session `S`.

Test:

1. POST a second user message to the same `S` while `S` is running.
2. Expect `/api/chat` response `{ queued: true }`.
3. Assert no second `running` event starts for `S` before the first turn idles.
4. Assert queued message is persisted after first assistant.
5. Assert dispatcher wakes `S` again and assistant responds to the queued message.

Acceptance:

- Existing same-session queue semantics survive parallel agent support.

### E2E: Different-Session New Message Uses Available Capacity

Setup:

- Agent `maxConcurrentSessions: 2`.
- Session `A` is running a slow turn.

Test:

1. POST chat to new session `B`.
2. Assert `B` starts immediately because one slot is still free.
3. Assert both `A` and `B` are visible in `runningSessionIds()` or via SSE `running` states.

Acceptance:

- Confirms this is agent-level scaling, not one session at a time.

### E2E: Different-Session New Message Queues At Capacity

Setup:

- Agent `maxConcurrentSessions: 2`.
- Sessions `A` and `B` are both running slow turns.

Test:

1. POST chat to session `C`.
2. Expect `queued: true` and `queuedReason: "agent_capacity"`.
3. Assert `C` does not run until either `A` or `B` idles.
4. Assert `C` later runs and consumes the queued user message.

Acceptance:

- `/api/chat` cannot bypass the configured agent cap.
- Queued direct user messages preempt autonomous task wakes when capacity frees.

### E2E: Tool Result Wake

Setup:

- Dispatcher enabled.
- Agent `maxConcurrentSessions: 2`.

Test:

1. Start a chat in session `S` using the real `process` tool:

```text
[[mock:tool:process:{"action":"run","command":"node -e \"setTimeout(()=>console.log('done'), 300)\"","waitMs":0,"timeoutMs":5000}]]
```

2. The first turn returns a detached process result and idles.
3. When process completion emits, assert `process_completed` task/event stream reaches the session.
4. Assert dispatcher wakes `S` again from the process completion system notice.
5. Assert the new autonomous wake is in session `S`, not another session for the same agent.

Acceptance:

- Proves worker-originated async completion still wakes the right session.

### E2E: Task Result Wake

Setup:

- Agents `creator` and `worker`.
- `creator` creates a task assigned to `worker`, with creator session `C`.
- `worker` has a session `W`.

Test:

1. Worker leaves a `task_comment(..., mode: "result")`.
2. Worker marks the task done.
3. Assert the event fan-out writes a `system_notice` for `creator`.
4. Assert dispatcher wakes creator session `C`.
5. Assert worker's own result event is not echoed back to worker as a self-wake.

Acceptance:

- Covers "tool result wake" in the task-tool sense, not only process completion.

### E2E: Session-Targeted Inbox Isolation

Setup:

- Agent `maxConcurrentSessions: 2`.
- Sessions `A` and `B` both running slow turns.

Test:

1. While both are running, deliver a `user_message` row for `B`.
2. Assert `A` does not inject, delete, or persist that row.
3. Assert `B` receives/persists that user message.
4. Repeat with `system_notice` targeted to `B`.

Acceptance:

- This is the red test for the current mid-turn `pendingFor(agentId)` bug.

### E2E: Agent-Wide Inbox Notice Is Single-Claim

Setup:

- Agent `maxConcurrentSessions: 2`.
- Sessions `A` and `B` both eligible.

Test:

1. Deliver a `system_notice` with `relatedSession: null`.
2. Assert exactly one session consumes it.
3. Assert the row is not duplicated into both prompts.

Acceptance:

- Defines behavior for legacy or agent-wide notices.

### E2E: Defer Semantics Under Parallelism

Setup:

- Agent `maxConcurrentSessions: 2`.
- Session `A` has future `defer_until`.
- Session `B` has ready work.

Tests:

1. Routine tick skips `A` and runs `B`.
2. A targeted inbox row for `A` bypasses `A`'s defer and can run if capacity is available.
3. If capacity is full, `A` waits until a slot frees and then runs.

Acceptance:

- Existing defer semantics remain per-session.

### E2E: Home/Status Running State

Setup:

- Two sessions running for same agent.

Test:

1. Call `/api/home` or the route that uses `runningSessionIds()`.
2. Assert both sessions are marked running.
3. Assert the agent roster is not duplicated.

Acceptance:

- UI-facing state stays session-based and canonical-agent based.

### Manual `.openacme-dev` Smoke

After implementation passes automated tests:

1. Start dev platform:

```sh
cd /private/tmp/openacme-parallel-plan
OPENACME_DATA_DIR="$PWD/.openacme-dev" pnpm dev
```

2. Open `http://127.0.0.1:3457`.
3. Create or update a dev-only agent with `maxConcurrentSessions: 2`.
4. Open two sessions for that agent.
5. Start two slow turns.
6. Confirm both sessions show running.
7. Send a third message at capacity and confirm it queues, then drains.
8. Stop dev server. Do not start or restart the user's production daemon.

## Additional Coverage Candidates

These cases were identified after comparing the current dispatcher/inbox/e2e
suite against the retired `TaskScheduler` tests and the new parallel runtime
contracts. They are not new product requirements; they are regression coverage
for behavior the current implementation already intends to preserve.

### Priority 1: Add Before PR Review

1. `cancelQueuedUserMessage` session scoping
   - File: `packages/db/test/stores.test.ts`
   - Scenario: two queued `user_message` rows share the same `(agentId,
     sourceId)` but belong to different `relatedSession` values.
   - Expected: cancelling one session deletes only that session's row.
   - Why: this was listed in the original inbox matrix but is not currently
     asserted. It protects queue-chip cancel behavior under parallel sessions.

2. Parallel failure isolation
   - File: `packages/server/test/dispatcher.test.ts`
   - Scenario: agent has `maxConcurrentSessions: 2`; two sessions are running;
     one turn throws after claiming an `in_progress` task, the other turn
     completes normally or remains running.
   - Expected: only the failing session's task is parked; the other session's
     task is not parked, and active bookkeeping is cleaned up per session.
   - Why: the plan explicitly requires failure parking to be scoped to the
     failing session, but current tests only cover a single active session.

3. Agent-wide inbox at capacity
   - File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
   - Scenario: capacity is full with two slow sessions; an agent-wide notice
     lands while both slots are occupied.
   - Expected: no extra session starts while full; when a slot frees, exactly
     one eligible session claims the notice.
   - Why: current e2e proves single-claim when capacity is available, but not
     the queued-at-capacity path.

4. Runtime cap update is observed by dispatcher
   - File: `packages/server/test/dispatcher.test.ts` or
     `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
   - Scenario: an agent starts at `maxConcurrentSessions: 1`, one session is
     running, then the setting is updated to `2` and another ready session is
     kicked.
   - Expected: dispatcher reads the fresh agent definition and starts the
     second session without a daemon restart.
   - Why: settings are runtime-facing; persistence alone does not prove the
     scheduler observes the new value.

Status: implemented in Slice 10 and validated.

### Priority 2: Strong Regression Coverage

5. Real task-tool result isolation under parallel sessions
   - File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
   - Scenario: two sessions of the same agent are running; a task result or
     comment event with `relatedSession = B` lands mid-turn.
   - Expected: session `A` never sees/deletes that event; session `B` later
     consumes it.
   - Why: synthetic inbox isolation exists, but this proves the real task event
     fan-out path preserves the same boundary.

6. Process completion isolation under parallel sessions
   - File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
   - Scenario: session `A` launches a detached process while session `B` is
     also running.
   - Expected: `process_completed` wakes and persists only in session `A`.
   - Why: current process wake test is single-session.

7. Interactive abort frees capacity
   - File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
   - Scenario: start a slow `/api/chat` turn at capacity, call
     `/api/chat/:sessionId/abort`, then queue another session.
   - Expected: the aborted session leaves running state and the queued session
     can start.
   - Why: abort currently clears `activeTurns`; the dispatcher capacity marker
     is cleared by `runChatTurn` cleanup. This deserves coverage because stale
     busy state would deadlock capacity.

8. Same-session duplicate inbox rows preserve order
   - File: `packages/agent-core/test/agent-inbox.test.ts` plus optional e2e.
   - Scenario: two queued user messages for the same session arrive while the
     session is running.
   - Expected: after the follow-up turn, both messages are appended in inbox id
     order and no duplicate parallel turn is started for that session.
   - Why: current same-session tests cover one queued follow-up only.

9. Multiple agents do not share capacity
   - File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
   - Scenario: agent `A` is at capacity; agent `B` has ready work.
   - Expected: `B` starts independently.
   - Why: most tests focus on one canonical agent. This protects the global
     tick serialization from accidentally becoming a global capacity lock.

10. Defer plus capacity-full targeted wake
    - File: `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
    - Scenario: deferred session `A` receives a targeted inbox row while agent
      capacity is full.
    - Expected: `A` does not run while full; once capacity frees, the targeted
      inbox still bypasses defer and runs.
    - Why: current e2e proves targeted inbox bypasses defer with available
      capacity, not while queued behind capacity.

Status: implemented in Slice 10 and validated.

## Load/Fairness Finding

A manual deterministic-stub dev load test was run in the
`agent/parallel-dispatcher-plan` worktree:

- 42 tasks seeded as 7 lanes x 6 dependency chain depth.
- Agent `maxConcurrentSessions = 5`.
- All 42 tasks completed in 17.4s.
- Capacity held: `maxDispatcherRunning=5`, `maxHomeRunning=5`.
- Duplicate run count was 0.
- All lanes completed 6/6.
- 2 home/dispatcher mismatch poll samples were observed as transient race
  windows.

The load test exposed a scheduling-quality gap: lanes 1-5 started immediately,
while lanes 6-7 first started about 9.9s later. The dispatcher kept the cap
correct, but the first ready sessions could dominate capacity across chained
work.

Slice 11 addressed the product-visible part of this gap with an explicit agent
setting:

- `Start task lanes first` (`lane_first`, default): gives never-run/older-run
  sessions priority so ready lanes can get an initial turn.
- `Clear task chains first` (`chain_first`): preserves hot-chain priority so
  existing dependency chains finish sooner.
- Direct user-message sessions always preempt both autonomous task policies.
- Human task comments are a second priority tier: they preempt autonomous task
  policies but can wait behind direct prompt/chat messages.

Validation:

- Config/schema and AGENT.md persistence tests cover defaults, rejection, and
  round-trip behavior.
- Dispatcher unit tests cover user-message priority, `lane_first`, and
  `chain_first`.
- Real server e2e covers direct user-message priority over autonomous task
  wakes.
- Web Playwright e2e covers Settings save/reload for the scheduling policy.
- Slice 12 expands this with both policies, new/existing direct sessions, and
  comment-first/message-first arrival orders.

### Priority 3: UI/Smoke Automation

11. Agent Settings tab browser regression
    - File: web e2e or Playwright smoke harness
    - Scenario: open an agent Settings tab, change `Parallel sessions`, save,
      reload, and verify the selected value and warning.
    - Expected: the value persists and warning appears only when value > 1.
    - Why: manual `.openacme-dev` smoke covered this, but no automated browser
      test currently guards the UI.

12. Settings save preserves memory extraction and parallel sessions together
    - File: `packages/server/test/app-routes.test.ts`
    - Scenario: update `memoryExtractionEnabled` and `maxConcurrentSessions`
      in separate requests and together.
    - Expected: partial updates do not reset the other field.
    - Why: both controls share the same settings surface and AGENT.md
      frontmatter path.

Status: implemented in Slice 10 and validated.

### Slice 11: Task Scheduling Policy

Owner files:

- `packages/config/src/schema.ts`
- `packages/db/src/stores/inbox-store.ts`
- `packages/server/src/dispatcher.ts`
- `apps/web/app/routes/agents.tsx`
- focused config, db, server, e2e, and web tests

Tasks:

1. Add `parallelSchedulingPolicy` to the agent schema, defaulting to `lane_first`.
2. Add an Agent Settings select shown when `Parallel sessions > 1`.
3. Extend inbox pending summary to identify sessions with queued user messages.
4. Order scheduler candidates so user-message sessions always come first.
5. Implement `lane_first` and `chain_first` ordering for autonomous task wakes.
6. Persist and validate the setting through API and AGENT.md frontmatter.

Tests first:

- Config default/reject/persist tests.
- DB pending summary test for `userMessageSessionIds`.
- Server route create/update/partial-preserve tests.
- Dispatcher tests for user-message preemption and both scheduling policies.
- Real server e2e for direct user-message priority over task wakes.
- Web Playwright save/reload coverage for the policy select.

Validation:

```sh
pnpm --filter @openacme/config test -- agent-store.test.ts
pnpm --filter @openacme/db test -- stores.test.ts
pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts
pnpm --filter @openacme/config build
pnpm --filter @openacme/db build
pnpm --filter @openacme/server build
pnpm --filter web build
pnpm --filter web test:e2e -- agent-edit.spec.ts
```

Acceptance:

- Default behavior is `Start task lanes first`.
- `Clear task chains first` is selectable and persisted.
- Direct user sessions are prioritized ahead of task chains in every mode.
- No synthetic agent ids are introduced.

### Slice 12: Priority Permutation Coverage

Owner files:

- `packages/db/src/stores/inbox-store.ts`
- `packages/server/src/dispatcher.ts`
- `packages/server/src/agent-manager.ts`
- focused DB, dispatcher, route, and real-server e2e tests

Tasks:

1. Classify human-authored task comments separately from generic system notices.
2. Order dispatcher candidates as direct user messages, then human task comments, then autonomous task policy.
3. Kick the dispatcher when task-event fan-out delivers inbox rows, so human task comments do not wait for the periodic tick.
4. Add tests for both `lane_first` and `chain_first`.
5. Add tests for new prompt sessions and existing chat sessions.
6. Add tests for comment-first and message-first arrival order while capacity is full.
7. Add a combined real-server case where new direct prompt beats a human task comment and the task comment beats an autonomous task wake.

Tests first:

- DB summary test for `userTaskCommentSessionIds`.
- Dispatcher unit test for direct message > human task comment > autonomous task wake under both policies.
- Route test proving HTTP task comments kick the dispatcher.
- Real daemon e2e matrix:
  - `lane_first` / `chain_first`
  - new / existing direct session
  - comment-first / message-first arrival

Validation:

```sh
pnpm --filter @openacme/db test -- stores.test.ts
pnpm --filter @openacme/db build
pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts
pnpm --filter @openacme/db check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/server build
```

Acceptance:

- Direct user messages always win over human task comments.
- Human task comments always win over autonomous task wakes.
- Both scheduling policies preserve those priority tiers.
- New prompt sessions and existing chat sessions both receive direct-message priority.

## Implementation Slices For Sub-Agents

Each slice below should be run as a separate development task. The lead agent should merge slices only after their tests pass locally.

### Slice 1: Config, API Shape, And UI Control

Owner files:

- `packages/config/src/schema.ts`
- config/agent store tests
- `apps/web/app/routes/agents.tsx`

Tasks:

1. Add `maxConcurrentSessions` to `AgentDefinitionSchema`.
2. Keep default `1`.
3. Add validation range `1..5`.
4. Ensure API create/update round-trips the field.
5. Add Agent Settings UI control and warning.

Tests first:

- Config schema/default/reject tests.
- AgentStore serialization test.
- Web type-check.

Validation:

```sh
pnpm --filter @openacme/config test
pnpm --filter web check-types
```

Acceptance:

- No dispatcher behavior changes in this slice.

### Slice 2: Session-Aware Inbox Claim And Agent Drain

Owner files:

- `packages/db/src/stores/inbox-store.ts`
- `packages/db/src/schema.ts` only if a claimed-state design is chosen
- `packages/agent-core/src/agent.ts`
- DB store tests
- agent-core focused tests if existing agent tests can cover drain behavior

Tasks:

1. Add session-aware claim/summary APIs.
2. Update turn-start drain to claim rows for current session only.
3. Update mid-turn drain to claim rows for current session only.
4. Define and test agent-wide notice behavior.
5. Stop using `pendingFor(agentId)` in parallel-sensitive runtime paths.

Tests first:

- Inbox claim unit tests.
- Agent drain regression test where session `A` must not consume `B`'s targeted rows.

Validation:

```sh
pnpm --filter @openacme/db test
pnpm --filter @openacme/agent-core test -- agent*.test.ts
pnpm --filter @openacme/agent-core check-types
```

Acceptance:

- This slice must land before dispatcher can actually run `maxConcurrentSessions > 1`.

### Slice 3: Dispatcher Capacity Accounting

Owner files:

- `packages/server/src/dispatcher.ts`
- `packages/server/test/dispatcher.test.ts`

Tasks:

1. Replace `chains: Map<agentId, Promise>` with session-level active run bookkeeping.
2. Keep `runningSessions` as the same-session guard.
3. Count interactive sessions toward agent limit.
4. Enqueue up to available capacity per agent per tick.
5. Make `drain()` wait for all active promises.
6. Make post-run kick safe with multiple active runs.

Tests first:

- Unit dispatcher tests listed above.

Validation:

```sh
pnpm --filter @openacme/server test -- dispatcher.test.ts
pnpm --filter @openacme/server check-types
```

Acceptance:

- Existing single-session behavior remains with default `1`.
- Concurrent autonomous turns are enabled only after Slice 2 is merged.

### Slice 4: Interactive Capacity Gate

Owner files:

- `packages/server/src/app.ts`
- `packages/server/src/dispatcher.ts`
- server route tests if needed

Tasks:

1. Add dispatcher methods:

```ts
canStartRun(agentId: string, sessionId: string): boolean
markInteractiveBusy(agentId: string, sessionId: string): void
clearInteractiveBusy(agentId: string, sessionId: string): void
```

2. Preserve existing same-session queued behavior.
3. Add at-capacity different-session queued behavior with `queuedReason: "agent_capacity"`.
4. Ensure queued capacity messages wake through dispatcher after a slot frees.

Tests first:

- E2E same-session queue.
- E2E different-session available capacity.
- E2E different-session at-capacity queue.

Validation:

```sh
pnpm --filter @openacme/server test:e2e -- parallel-dispatcher.e2e.ts
pnpm --filter @openacme/server check-types
```

Acceptance:

- `/api/chat` cannot bypass the cap.

### Slice 5: Real Platform E2E Suite

Owner files:

- `packages/server/test/e2e/parallel-dispatcher.e2e.ts`
- `packages/server/test/e2e/support/stub-model.mjs`
- `packages/server/test/e2e/support/client.ts` only if helper additions are needed

Tasks:

1. Add slow autonomous stub support when directive appears anywhere in prompt.
2. Add the required e2e tests from the matrix.
3. Keep tests deterministic: SSE subscribe before seeding work, bounded waits, no sleeps except tiny process-completion waits where unavoidable.
4. Reuse `startE2EServer`; it runs a real Hono daemon on a temp data dir and random port.

Validation:

```sh
pnpm --filter @openacme/server test:e2e -- parallel-dispatcher.e2e.ts
pnpm --filter @openacme/server test:e2e
```

Acceptance:

- Tests prove task wake, task result wake, process/tool result wake, new message wake, capacity cap, and inbox isolation on a running platform.

### Slice 6: Manual Dev Smoke And Documentation

Owner files:

- `PARALLEL_AGENT_RUNTIME_TDD_PLAN.md`
- possibly `CLAUDE.md` or contributor docs after implementation is accepted

Tasks:

1. Run `.openacme-dev` smoke on port `3457`.
2. Capture exact commands and observed behavior.
3. Document that parallel sessions share workspace/browser/tool-host/MCP/email/memory.
4. Do not deploy or restart production daemon during this slice.

Validation:

```sh
OPENACME_DATA_DIR="$PWD/.openacme-dev" pnpm dev
curl -sS http://127.0.0.1:3457/api/health
```

Acceptance:

- Manual smoke confirms the feature outside the test harness while still avoiding `~/.openacme`.

## Slice Order

1. Config/UI shape.
2. Inbox claim tests and implementation.
3. Dispatcher capacity accounting.
4. Interactive capacity gate.
5. Full real-platform e2e suite.
6. Manual `.openacme-dev` smoke and docs.

Reasoning: dispatcher concurrency without inbox session-aware claim is unsafe, so inbox must be solved before any branch state where `maxConcurrentSessions > 1` can actually run concurrent autonomous turns.

## Lead-Agent Checklist

Before assigning a slice:

- Confirm branch is `agent/parallel-dispatcher-plan`.
- Confirm worktree is not the live prod worktree.
- Confirm `git status -sb` and note unrelated changes.
- Ask the slice owner to start with red tests.
- Require exact validation output before merge.

Before merging any slice:

- Tests named in the slice pass.
- `~/.openacme` was not read/written by dev commands.
- No synthetic agent ids appear in persisted data or API responses.
- Default `maxConcurrentSessions = 1` preserves existing behavior.
- New behavior is covered by a real platform e2e test before it is considered accepted.

Before any deployment:

- Run:

```sh
pnpm check-types
pnpm test
pnpm --filter @openacme/server test:e2e
```

- Then manually smoke with `.openacme-dev`.
- Production deploy/restart requires explicit user approval in that later phase.
