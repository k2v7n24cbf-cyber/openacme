# Parallel Agent Runtime Memory

## Current State

- Branch: `agent/parallel-dispatcher-plan`
- Worktree: `/private/tmp/openacme-parallel-plan`
- Dev data dir: `/private/tmp/openacme-parallel-plan/.openacme-dev`
- Dev port: `127.0.0.1:3457`
- Current slice: Slice 13 complete; ready to commit.
- Last verified command: `pnpm --filter @openacme/server test -- dispatcher.test.ts`; `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts`

## Standing Decisions

- Do not introduce synthetic or persisted ids such as `agent-x##1`.
- Keep one canonical agent identity and allow multiple active session turns for that agent.
- Treat workspace, browser, tool-host, MCP, email, and memory races as documented opt-in risk, not as isolation work in this milestone.
- Default `maxConcurrentSessions` is `1`.
- Initial supported range is `1..5`.
- Default `parallelSchedulingPolicy` is `lane_first`, shown in Agent Settings as `Start task lanes first`.
- Optional `parallelSchedulingPolicy: "chain_first"` is shown as `Clear task chains first`.
- Priority order is direct prompt/chat user messages first, human task comments second, then autonomous task wakes ordered by the selected task scheduling policy.
- Do not touch `~/.openacme`.
- Do not deploy or restart production during this feature build.

## Slice Progress

### Slice 1 - Config, API Shape, And UI Control

- Goal: add `maxConcurrentSessions` to agent definition and expose it in the agent Settings tab.
- Red tests: `packages/config/test/agent-store.test.ts` failed on missing default, validation, and frontmatter persistence before schema implementation.
- Implementation: `AgentDefinitionSchema.maxConcurrentSessions`; create/edit form wiring; `AgentSettingsTab` parallel sessions select with warning for values above `1`.
- Validation: `pnpm --filter @openacme/config test`; `pnpm --filter @openacme/config check-types`; `pnpm --filter web check-types`.
- Status: complete.

### Slice 2 - Session-Aware Inbox Claim And Agent Drain

- Goal: prevent one session from reading or deleting another session's targeted inbox rows.
- Red tests: `packages/db/test/stores.test.ts` failed because `claimForSession`/`pendingSummaryFor` did not exist; `packages/agent-core/test/agent-inbox.test.ts` failed because another session's targeted system notice was injected/deleted at turn start and mid-turn.
- Implementation: `InboxStore.claimForSession`, `InboxStore.pendingSummaryFor`, turn-start drain via claim, mid-turn drain via claim.
- Validation: `pnpm --filter @openacme/db test -- stores.test.ts`; `pnpm --filter @openacme/agent-core test -- agent-inbox.test.ts`; `pnpm --filter @openacme/db check-types`; `pnpm --filter @openacme/agent-core check-types`.
- Status: complete.

### Slice 3 - Dispatcher Capacity Accounting

- Goal: allow up to `maxConcurrentSessions` distinct active sessions per canonical agent while preserving same-session serialization.
- Red tests: `packages/server/test/dispatcher.test.ts` failed because the dispatcher started only one session for `maxConcurrentSessions: 2` and allowed a different session to run while another session was marked interactive-busy at capacity.
- Implementation: session-keyed autonomous active turn map; active sessions by agent; capacity resolution from agent definition; session-aware inbox summary in tick; agent-wide inbox notice assigned to one candidate; per-agent backfill kick when capacity `>1` or a real inbox signal waited for a slot.
- Validation: `pnpm --filter @openacme/server test -- dispatcher.test.ts`; `pnpm --filter @openacme/server check-types`.
- Status: complete.

### Slice 4 - Interactive Chat Capacity Gate

- Goal: make `/api/chat` respect agent capacity so interactive turns cannot bypass the dispatcher limit.
- Red tests: `packages/server/test/app-routes.test.ts` failed because a different-session `/api/chat` request started the standard interactive path while the agent was already at capacity.
- Implementation: `Dispatcher.canStartRun(agentId, sessionId)` and `/api/chat` capacity queue path returning `queuedReason: "agent_capacity"` while preserving same-session queue semantics.
- Validation: `pnpm --filter @openacme/server test -- app-routes.test.ts`; `pnpm --filter @openacme/server test -- dispatcher.test.ts`; `pnpm --filter @openacme/server check-types`.
- Status: complete.

### Slice 5 - Real Platform E2E Suite

- Goal: prove task wake, tool/process result wake, task result wake, new message wake, capacity queue, inbox isolation, defer, and status behavior on a running platform harness.
- Red tests: the first e2e attempt exposed a race-prone assertion where the third session could start after a slot had already freed, and cleanup timed out when SSE handles were left open after assertion failure.
- Implementation: added `packages/server/test/e2e/parallel-dispatcher.e2e.ts`; extended the e2e client agent creator to accept extra fields; added `[[mock:slow-anywhere]]` and `[[mock:slow-long]]` stub-model directives for real dispatcher timing tests; added afterEach SSE cleanup.
- Validation: `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 8/8; `pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts` passed 33/33; `pnpm --filter @openacme/server check-types` passed.
- Status: complete.

### Slice 6 - Manual `.openacme-dev` Smoke And Documentation

- Goal: verify the feature manually on port `3457` using only `.openacme-dev`.
- Red tests: not applicable.
- Implementation: added `.openacme-dev/` to `.gitignore` so local smoke state never lands in PR commits.
- Validation: started local dev server with `OPENACME_DATA_DIR=/private/tmp/openacme-parallel-plan/.openacme-dev` on `127.0.0.1:3457`; `/api/health` returned ok; created `parallel-smoke` through `/api/agents` with `maxConcurrentSessions: 3`; verified `/api/agents/parallel-smoke` returns `maxConcurrentSessions: 3`; verified `.openacme-dev/agents/parallel-smoke/AGENT.md` frontmatter contains `maxConcurrentSessions: 3`; verified in Playwright that `/agents?id=parallel-smoke&tab=settings` renders the `Parallel sessions` combobox with value `3` and the shared-state warning.
- Status: complete.

### Slice 7 - Simultaneous Chat And Dependency Regression Tests

- Goal: add real e2e coverage for simultaneous `/api/chat` sends into different sessions and task dependency gating.
- Red tests: simultaneous different-session chat coverage was missing; the new dependency e2e failed because a dependency-blocked `task_assigned` event delivered a system_notice inbox row and `hasInbox` bypassed the task readiness predicate.
- Implementation: added a 3-way simultaneous `/api/chat` e2e where `maxConcurrentSessions: 2` starts two sessions and queues one with `queuedReason: "agent_capacity"`; added a dependent-task e2e that proves no wake before the dependency is done and a wake after it is done; suppressed `task_assigned` inbox delivery when the assigned task is not wake-ready because of dependencies or future `start_at`.
- Validation: `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 10/10; `pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts` passed 33/33; `pnpm --filter @openacme/server check-types` passed.
- Status: complete.

### Slice 8 - Expanded Parallel Runtime Test Matrix

- Goal: broaden the real-platform test matrix to cover default capacity, mixed interactive/autonomous accounting, same-session autonomous chat queueing, dependency terminal states, future start gates, API validation, and dispatcher reentrant kicks.
- Red tests: the expanded default-capacity e2e failed because two rapid inbox deliveries called `dispatcher.kick()` concurrently; overlapping ticks computed `available=1` before either tick recorded its active session, allowing default `maxConcurrentSessions: 1` to be exceeded.
- Implementation: serialized dispatcher ticks with a small in-flight tick queue; added a unit regression for concurrent kicks; added API route coverage for `maxConcurrentSessions` create/update persistence and invalid range rejection; expanded `parallel-dispatcher.e2e.ts` from 10 to 15 real server tests.
- Validation: `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 15/15; `pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts` passed 35/35; `pnpm --filter @openacme/server check-types` passed.
- Status: complete.

### Slice 9 - Legacy Scheduler Contract Coverage

- Goal: review the old `TaskScheduler` test cases from `fdd3df8` and port still-relevant runtime contracts into the current dispatcher tests.
- Red tests: dangling `session_id` cleanup from the old orphaned-session scheduler test was missing in the tick dispatcher; an open task bound to a deleted session could remain invisible instead of being rebound.
- Implementation: dispatcher now clears missing session bindings during `bindUnboundTasks` and then rebinds ready open work; added dispatcher tests for no pre-marking before agent claim, unbound dependency allocation gates, same-agent cross-session dependency wake after close, dangling session cleanup, timeout park comments, no-claim failure no-park, and unavailable-agent no-park.
- Retired old-only contracts: debounce/rate-limit wake windows, per-session watchdog no-claim streaks, croner arm registry, and event-tree-specific echo routing were intentionally removed by the tick-based dispatcher design; their active equivalents are covered by inbox targeting, dependency readiness, capacity/backfill, defer, and tick serialization tests.
- Validation: `pnpm --filter @openacme/server test -- dispatcher.test.ts` passed 24/24; `pnpm --filter @openacme/server test -- app-routes.test.ts` passed 18/18; `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 15/15; `pnpm --filter @openacme/server check-types` passed.
- Status: complete.

### Slice 10 - Additional Parallel Coverage Expansion

- Goal: turn the remaining high-value coverage backlog into actual tests and run them.
- Implementation:
  - `packages/db/test/stores.test.ts`: added queued user-message cancel scoping by `(agentId, messageId, sessionId)`.
  - `packages/server/test/dispatcher.test.ts`: added runtime `maxConcurrentSessions` update coverage and parallel failure isolation.
  - `packages/server/test/app-routes.test.ts`: added partial update preservation for `memoryExtractionEnabled` and `maxConcurrentSessions`.
  - `packages/server/test/e2e/parallel-dispatcher.e2e.ts`: expanded from 15 to 22 real-platform tests, adding agent-wide-at-capacity, real task comment event isolation, process completion isolation while another session runs, interactive abort capacity release, multiple same-session queued message ordering, multi-agent capacity independence, and deferred targeted wake queued behind capacity.
  - `apps/web/e2e/agent-edit.spec.ts`: added Playwright coverage for the Agent Settings tab `Parallel sessions` control, warning, save, and reload persistence.
- Validation:
  - `pnpm --filter @openacme/db test -- stores.test.ts` passed 25/25.
  - `pnpm --filter @openacme/server test -- dispatcher.test.ts` passed 26/26.
  - `pnpm --filter @openacme/server test -- app-routes.test.ts` passed 19/19.
  - `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 22/22.
  - `pnpm --filter web test:e2e -- agent-edit.spec.ts` passed 2/2 after installing the missing local Playwright Chromium binary.
  - `pnpm --filter @openacme/server check-types`, `pnpm --filter @openacme/db check-types`, and `pnpm --filter web check-types` passed.
- Status: complete.

### Dev Load Test - 7 Lanes x 6 Task Chains

- Test location: run manually in the `agent/parallel-dispatcher-plan` worktree against a local deterministic-stub Hono daemon.
- Shape: 42 seeded tasks; 7 independent lanes x 6 dependency chain depth; agent `maxConcurrentSessions = 5`.
- Startup state: `open=42`, `ready=7`, `blocked=0`. On this branch, dependency-waiting tasks are not stored as `blocked`; readiness is computed during scheduler tick.
- Completion: 42/42 tasks reached `done` in 17.4s.
- Capacity: `maxDispatcherRunning=5`, `maxHomeRunning=5`.
- Duplicate runs: 0.
- Lane completion: all lanes completed 6/6.
- Home/dispatcher mismatch: 2 transient poll samples saw a race window; not persistent.
- Important finding: fairness is weak. Lanes 1-5 started immediately; lanes 6-7 first started around 9.9s later. The dispatcher enforced capacity correctly, but the first five ready sessions dominated capacity across their chains. If parallelism graduates beyond an advanced/unsafe feature, the scheduler needs an explicit fairness contract such as oldest-ready-session ordering or a per-session/lane fairness queue.

### Slice 11 - Task Scheduling Policy

- Goal: make task-chain scheduling explicit in Agent Settings without reducing responsiveness to direct user sessions.
- Product names:
  - `Start task lanes first`: default `lane_first` policy; prefers sessions with no or older recent run sequence so newly ready lanes get a first turn before hot chains reacquire every slot.
  - `Clear task chains first`: optional `chain_first` policy; preserves targeted-session priority so existing task chains can finish sooner.
- Invariant: queued direct user messages outrank both task scheduling policies.
- Red tests: config rejected/persisted policy tests failed before schema support; DB pending summary lacked targeted user-message ids; server route and dispatcher policy tests failed before implementation; UI e2e lacked coverage for the new Settings select.
- Implementation: added `parallelSchedulingPolicy` to the agent schema and Settings UI; extended inbox pending summary with `userMessageSessionIds`; added dispatcher session ordering with user-message priority first, then `lane_first` or `chain_first`; persisted policy through API and AGENT.md frontmatter.
- Validation:
  - `pnpm --filter @openacme/config test -- agent-store.test.ts` passed 24/24.
  - `pnpm --filter @openacme/db test -- stores.test.ts` passed 25/25.
  - `pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts` passed 48/48.
  - `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 23/23.
  - `pnpm --filter @openacme/config build`, `pnpm --filter @openacme/db build`, `pnpm --filter @openacme/server build`, and `pnpm --filter web build` passed.
  - `pnpm --filter web test:e2e -- agent-edit.spec.ts` passed 2/2.
- Status: complete.

### Slice 12 - Priority Permutation Coverage

- Goal: strengthen the scheduling contract around user-originated work under both task scheduling policies.
- Priority contract:
  - New prompt sessions and existing chat messages are direct `user_message` inbox rows and always run first when capacity frees.
  - Human task comments from `/api/tasks/:id/comments` are user attention signals and run before autonomous task wakes.
  - Direct messages outrank human task comments when both arrive together; the task comment can wait.
  - After direct messages and human task comments are handled, `lane_first` or `chain_first` decides autonomous task ordering.
- Red tests: DB summary lacked user task-comment session classification; dispatcher had only direct `user_message` priority; HTTP task comments delivered inbox rows but did not kick the dispatcher.
- Implementation: added `userTaskCommentSessionIds` to inbox pending summary; dispatcher now orders direct messages, then human task comments, then the configured autonomous policy; task-event inbox delivery kicks the dispatcher immediately.
- Validation:
  - `pnpm --filter @openacme/db test -- stores.test.ts` passed 26/26.
  - `pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts` passed 51/51.
  - `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 32/32.
  - `pnpm --filter @openacme/db check-types`, `pnpm --filter @openacme/server check-types`, and `pnpm --filter @openacme/server build` passed.
- Status: complete.

### Slice 13 - Extended Priority Test Cases

- Goal: extend test coverage beyond one-message/one-comment permutations without changing the product contract.
- Added coverage:
  - Dispatcher unit coverage for both `lane_first` and `chain_first` where two direct-message sessions are queued around a human task comment; both direct-message sessions must run before the comment.
  - Real daemon e2e coverage for simultaneous HTTP arrival using `Promise.all` for task comment plus direct message.
  - Simultaneous e2e covers both policies and both new/existing direct sessions.
  - Real daemon e2e coverage where two queued direct-message sessions run before a pending human task comment.
- Validation:
  - `pnpm --filter @openacme/server test -- dispatcher.test.ts` passed 33/33.
  - `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts` passed 37/37.
- Status: complete.

## Open Risks

- Full `pnpm check-types` still stops in baseline `@openacme/cli` package-resolution/type errors during the commit hook (`@openacme/server` cannot be resolved from CLI sources, plus existing implicit-any/type shape errors). The targeted package checks used for this feature pass.
- The scheduler now exposes explicit task scheduling policies and a user-signal priority tier, but this is still an in-memory daemon policy rather than a durable global ready queue. The load harness was not rerun across both policies after Slice 12; targeted unit and real daemon e2e coverage prove ordering behavior, direct-message preemption, and human task-comment priority.

## Additional Coverage Backlog

- Priority 1: complete in Slice 10.
- Priority 2: complete in Slice 10.
- Priority 3: complete in Slice 10.
- Fairness/load: partially addressed with explicit `lane_first` and `chain_first` policies plus priority permutation tests. A future load harness can compare first-start latency across both policies.

## Next Action

Commit and push Slice 13 on `agent/parallel-dispatcher-plan`; do not deploy or restart production unless explicitly requested later.
