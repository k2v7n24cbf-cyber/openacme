# Parallel Agent Runtime Memory

## Current State

- Branch: `agent/parallel-dispatcher-plan`
- Worktree: `/private/tmp/openacme-parallel-plan`
- Dev data dir: `/private/tmp/openacme-parallel-plan/.openacme-dev`
- Dev port: `127.0.0.1:3457`
- Current slice: Slice 3 - Dispatcher Capacity Accounting
- Last verified command: `pnpm --filter @openacme/server test -- dispatcher.test.ts`; `pnpm --filter @openacme/server check-types`

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
- Red tests: pending.
- Implementation: pending.
- Validation: pending.
- Status: pending.

### Slice 5 - Real Platform E2E Suite

- Goal: prove task wake, tool/process result wake, task result wake, new message wake, capacity queue, inbox isolation, defer, and status behavior on a running platform harness.
- Red tests: pending.
- Implementation: pending.
- Validation: pending.
- Status: pending.

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

Start Slice 4 by reading `/api/chat` turn gating and dispatcher interactive busy APIs, then add red/e2e or route-level tests for capacity-aware interactive queuing.
