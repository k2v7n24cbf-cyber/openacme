# Parallel Agent Runtime Memory

## Current State

- Branch: `agent/parallel-dispatcher-plan`
- Worktree: `/private/tmp/openacme-parallel-plan`
- Dev data dir: `/private/tmp/openacme-parallel-plan/.openacme-dev`
- Dev port: `127.0.0.1:3457`
- Current slice: Slice 6 - Manual `.openacme-dev` Smoke And Documentation
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
- Implementation: pending.
- Validation: pending.
- Status: pending.

## Open Risks

- This worktree currently has no `node_modules`; validation may need dependency installation before tests can run.
- Full `pnpm check-types` currently stops in baseline workspace package-resolution errors for packages such as `@openacme/tasks` resolving `@openacme/config/logger`; narrow package checks are reliable after dependency install.

## Next Action

Commit Slice 5, then run Slice 6 manual `.openacme-dev` smoke on port `3457` without touching `~/.openacme`.
