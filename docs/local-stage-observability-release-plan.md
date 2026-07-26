# Local-Stage Observability Release Plan

Date: 2026-07-27

Branch: `local-stage`

Upstream: `origin/local-stage`

## Objective

Promote the completed OpenAcme AI observability and forensic visibility work to
local `local-stage` and `origin/local-stage` with enough validation to support a
production rollout decision.

The release must preserve product behavior. The intended runtime changes are
telemetry propagation, local forensic indexing, Langfuse/OpenTelemetry metadata
mapping, session timeline persistence, tool outcome classification, and DB
migrations required for those observability surfaces.

## Scope

Included:

- OpenAcme-native session timeline events and API read path.
- Usage ledger correlation fields for trace/span/forensic evidence.
- Local AI forensic archive and deterministic evidence locators.
- Config-owned Langfuse adapter for canonical `openacme.*` telemetry.
- Built-in tool outcome classification for local forensics and Langfuse
  readback.
- Background/helper/autonomous timeline coverage.
- History compression timeline and forensic coverage.
- Local Docker Langfuse test stack and guarded live readback test.
- Clean DB bootstrap smoke coverage for fresh deploys.
- Operator/agent investigation skills and runbooks.

Excluded:

- MCP-native result classification improvements beyond the current registry
  contract.
- A web UI timeline screen inside OpenAcme.
- Storing raw prompts, provider bodies, tool outputs, secrets, or absolute local
  paths in Langfuse.

## Milestones

### Milestone 1 - Release Grounding

Goal: confirm local `local-stage` is based on the current `origin/local-stage`
before promotion.

TDD/validation:

- `git fetch origin local-stage`
- `git rev-list --left-right --count HEAD...origin/local-stage`

Acceptance:

- Local and upstream start from the same commit before the release commit.

Status:

- Complete. Divergence was `0 0` before release validation.

### Milestone 2 - Schema And Clean Bootstrap

Goal: ensure a clean deploy with an empty data directory creates the correct DB
shape without a manual structure bootstrap.

TDD/validation:

- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts`
- `pnpm --filter @openacme/db test`
- `pnpm --filter @openacme/db build`

Acceptance:

- A fresh `state.db` is created through `createDatabase`.
- `__drizzle_migrations` is populated.
- `usage_events` has forensic correlation columns.
- `session_timeline_events` and its indexes exist.
- New migration SQL, metadata snapshots, and `_journal.json` are committed.

Status:

- Complete locally before promotion.

### Milestone 3 - Focused Observability Regression

Goal: prove the release still records local forensic, timeline, usage, and
Langfuse-visible metadata for the changed paths.

TDD/validation:

- Config processor tests and build.
- LLM provider forensic/observability tests and build.
- Agent-core timeline/forensic/compression/subagent tests and build.
- Tools outcome/forensics tests and build.
- Server dispatcher/timeline/Langfuse helper tests and build.

Acceptance:

- Timeline writes remain best-effort.
- Core packages emit canonical `openacme.*` facts.
- Langfuse-specific mapping stays in config.
- Built-in tool logical failures are categorized without changing model-facing
  tool output.

Status:

- Complete locally before promotion.

### Milestone 4 - Live Test Environment Readback

Goal: verify the integrated behavior against the isolated test environment, not
the operator runtime.

TDD/validation:

- Use `~/.openacme-test` only.
- Run the guarded Langfuse visibility canary.
- Verify both successful tool use and shell logical failure readback.

Acceptance:

- OpenAcme usage rows include trace/span/forensic ids.
- Local `events.jsonl` contains the expected lifecycle rows.
- Langfuse readback finds `openacme.agent.turn` and `openacme.tool.execute`.
- Shell failure metadata appears in Langfuse as `resultStatus=failure`,
  `failureKind=command_exit_nonzero`, and `exitCode=7`.

Status:

- Complete locally before promotion.

### Milestone 5 - Promotion

Goal: commit the accepted release packet and push it to `origin/local-stage`.

TDD/validation:

- `git diff --check`
- Review staged files before commit.
- Commit once with the full observability release packet.
- `git push origin local-stage`
- Confirm local branch is even with `origin/local-stage`.

Acceptance:

- Release commit exists locally on `local-stage`.
- Same commit exists on `origin/local-stage`.
- Migration files and clean-bootstrap test are included in the commit.

Status:

- Ready for commit and push after local validation.

## Validation Record

Local validation completed before promotion:

- `git fetch origin local-stage` - passed.
- `git rev-list --left-right --count HEAD...origin/local-stage` - `0 0`.
- `pnpm exec prettier --check docs/local-stage-observability-release-plan.md packages/db/test/clean-bootstrap.test.ts` - passed.
- `git diff --check` - passed.
- `pnpm --filter @openacme/db test` - passed, 50 tests.
- `pnpm --filter @openacme/config test` - passed, 74 tests.
- `pnpm --filter @openacme/tools test` - passed, 216 tests.
- `pnpm --filter @openacme/llm-provider test -- observability.test.ts forensics-recorder.test.ts forensics-fetch.test.ts evidence-locator.test.ts` - passed, 25 tests.
- `pnpm --filter @openacme/agent-core test -- agent-forensics.test.ts agent-compress.test.ts agent-fire-title.test.ts agent-fire-extractor.test.ts selector.test.ts subagent.test.ts agent-preflight.test.ts agent-telemetry.test.ts telemetry.test.ts` - passed, 67 tests.
- `pnpm --filter @openacme/server test -- dispatcher.test.ts langfuse-e2e-support.test.ts` - passed, 41 tests.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/config build` - passed.
- `pnpm --filter @openacme/llm-provider build` - passed.
- `pnpm --filter @openacme/tools build` - passed.
- `pnpm --filter @openacme/agent-core build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/cli build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed with the existing large-chunk Vite warning.
- `pnpm --filter @openacme/server exec vitest run test/e2e/session-timeline.e2e.ts --config vitest.e2e.config.ts` - sandbox run failed with `listen EPERM`; rerun outside the sandbox passed, 4 tests.
- `pnpm test:e2e:langfuse` - passed outside the sandbox against `~/.openacme-test` and local Langfuse, 1 live test.

## Rollback Notes

The release is additive at the DB layer. Existing databases receive pending
migrations through `__drizzle_migrations`; fresh databases apply the full
migration chain. Before production rollout, take a DB backup. If rollback is
needed after migrations, roll back application code only after confirming the
older code tolerates the new additive columns/tables or restore the backed-up DB
with the older application.

## Current Known Gaps

- MCP-native tool outcome facts remain a deferred slice.
- OpenAcme web UI does not yet render the session timeline.
- Some semantic dispatcher/background events are local timeline events rather
  than separate Langfuse observations by design.
