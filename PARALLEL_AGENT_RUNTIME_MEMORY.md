# Parallel Agent Runtime Memory

## Current State

- Branch: `agent/parallel-dispatcher-plan`
- Worktree: `/private/tmp/openacme-parallel-plan`
- Dev data dir: `/private/tmp/openacme-parallel-plan/.openacme-dev`
- Dev port: `127.0.0.1:3457`
- Current slice: complete
- Last verified command: `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/parallel-dispatcher.e2e.ts`; `pnpm --filter @openacme/server test -- dispatcher.test.ts app-routes.test.ts`; `pnpm --filter @openacme/server check-types`

## Standing Decisions

- Do not introduce synthetic or persisted ids such as `agent-x##1`.
- Keep one canonical agent identity and allow multiple active session turns for that agent.
- Treat workspace, browser, tool-host, MCP, email, and memory races as documented opt-in risk, not as isolation work in this milestone.
- Default `maxConcurrentSessions` is `1`.
- Initial supported range is `1..5`.
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

## Open Risks

- Full `pnpm check-types` still stops in baseline `@openacme/cli` package-resolution/type errors during the commit hook (`@openacme/server` cannot be resolved from CLI sources, plus existing implicit-any/type shape errors). The targeted package checks used for this feature pass.

## Additional Coverage Backlog

- Priority 1 before PR review:
  - Add `cancelQueuedUserMessage` session-scoping coverage in `packages/db/test/stores.test.ts`.
  - Add dispatcher parallel failure isolation: with two active sessions, one failing turn parks only its own claimed task.
  - Add e2e for agent-wide inbox notice arriving while capacity is full, then single-claiming after a slot frees.
  - Add dispatcher/e2e coverage that changing `maxConcurrentSessions` at runtime is observed without a daemon restart.
- Priority 2:
  - Real task-tool result isolation while two same-agent sessions run.
  - Process completion isolation while another same-agent session is running.
  - Interactive abort frees capacity and lets queued work start.
  - Two same-session queued user messages preserve order and do not create duplicate active turns.
  - One agent at capacity does not block another agent's ready work.
  - Deferred targeted inbox wake remains queued while capacity is full, then still bypasses defer after a slot frees.
- Priority 3:
  - Automated browser regression for the Agent Settings tab `Parallel sessions` control and warning.
  - API regression that partial Settings updates preserve both `memoryExtractionEnabled` and `maxConcurrentSessions`.

## Next Action

Start the next TDD coverage slice from the Priority 1 backlog.
