# Context Snapshot Fast Path Plan

## Problem

Long-lived sessions can successfully compact model context and still become slow
on every later turn. The current proactive preflight starts from full canonical
history:

```ts
let currentHistory = history;
```

`latestSnapshotTailHistory()` can build the right projection:

```text
latestSnapshot.modelMessages + canonical messages after sourceLastMessageId
```

but today that helper is used only after a new compression attempt fails or
no-ops. The result is repeated memory flush and summarizer work even when the
latest successful snapshot plus the new tail would already fit.

Canonical UI history is not the problem and must stay unchanged.

## Goal

Use the latest successful context snapshot plus canonical tail as the normal
model-history baseline for long-lived sessions, while preserving canonical chat
history and the existing model-context ledger.

Success means a session like `2277b450-2d97-48ad-83d9-47a7cb8a1b46` can keep
chatting without running fresh compaction on every message when the latest
snapshot projection is already small enough.

## Non-Goals

- Do not mutate or compact canonical `messages`.
- Do not solve tool-result bloat in this milestone.
- Do not replace the forensic prompt snapshot system.
- Do not migrate or retire legacy rename-swap `Agent.compress()`.
- Do not build snapshot retention/delta storage unless the first slice exposes a
  concrete blocker.

## Milestone 1: Snapshot Baseline Preflight

Primary outcome: fix the latency bug in `prepareModelHistory()`.

TDD standard for this milestone: add red tests first, run the focused failing
set, implement the smallest slice, then run both the new tests and the existing
summarizer/compression regression suite. The recently added summarizer layer is
part of the contract; fast-path reuse must not weaken its retries, fallback,
forensics, no-op handling, or emergency-summary behavior.

Current TDD evidence:

- Baseline before implementation was green:
  - `test/compression.test.ts`: 59 passed.
  - `test/agent-compress.test.ts`: 13 passed.
  - `test/agent-preflight.test.ts`: 15 passed.
- New fast-path tests initially failed because preflight still entered memory
  flush/summarizer and materialized a fresh summary instead of reusing the
  snapshot projection.
- After Slice 1.2-1.4 implementation, `test/agent-preflight.test.ts` is green
  with 19 tests.
- Current verification after Milestone 1-3 implementation is green:
  - `test/compression.test.ts`: 59 passed.
  - `test/agent-compress.test.ts`: 13 passed.
  - `test/agent-preflight.test.ts`: 21 passed.
  - `@openacme/agent-core check-types`: passed.
  - `@openacme/agent-core build`: passed.
  - `@openacme/db check-types`: passed.
  - `@openacme/server check-types`: passed after rebuilding agent-core dist.
  - `packages/server` e2e `test/e2e/context-compression.e2e.ts`: 3 passed.

### Slice 1.1: Red Tests

Add focused failing tests in
`packages/agent-core/test/agent-preflight.test.ts`.

TDD cases:

- `canonical_over_threshold_snapshot_under_threshold_reuses_snapshot`
  - Given canonical history is over threshold.
  - And latest valid snapshot plus small canonical tail is under threshold.
  - Expect `prepareModelHistory()` returns snapshot plus tail.
  - Expect no memory flush call.
  - Expect no `compression-summarizer` call.
  - Expect canonical message store remains unchanged.

- `snapshot_reuse_ignores_invalid_snapshot_and_uses_canonical_path`
  - Invalid means missing `sourceLastMessageId`, source id not found, malformed
    `modelMessages`, or empty `modelMessages`.
  - Expect existing canonical compression/fallback behavior still applies.

- `same_second_snapshots_select_latest_deterministically`
  - Multiple snapshots in the same second must have stable newest-first
    ordering.

Expected first run: red, because current code tries fresh compression from
canonical history before using snapshot fallback.

Also run the existing summarizer-layer tests before implementation and keep the
output as baseline evidence:

```sh
pnpm --filter @openacme/agent-core test -- test/compression.test.ts
pnpm --filter @openacme/agent-core test -- test/agent-compress.test.ts
pnpm --filter @openacme/agent-core test -- test/agent-preflight.test.ts
```

### Slice 1.2: Projection Helper

Replace or extend `latestSnapshotTailHistory()` so it returns structured
metadata:

```ts
type SnapshotProjection = {
  snapshotId: string;
  sourceLastMessageId: string;
  sourceIndex: number;
  modelHistory: UIMessage[];
  tailMessageCount: number;
  sourceSummaryText: string | null;
  sourceSummarySha256: string | null;
};
```

Rules:

- Iterate newest valid snapshots first.
- Make ordering deterministic; `created_at` alone is not enough because it is
  second-resolution.
- Require `compressed === true`.
- Require non-empty valid `UIMessage[]`.
- Require `sourceLastMessageId` to exist in current canonical history.
- Build `modelHistory` as `snapshot.modelMessages + canonical tail`.

TDD gate:

```sh
pnpm --filter @openacme/agent-core test -- test/agent-preflight.test.ts
```

### Slice 1.3: Proactive Fast Path

At the start of `prepareModelHistory()` after threshold resolution:

1. Build latest snapshot projection.
2. Estimate tokens for that projection.
3. If reason is `proactive` and projection is under threshold, return it without
   memory flush or summarizer.
4. Emit lightweight telemetry, for example
   `session.compression.snapshot_reused`.

Return shape:

```ts
{
  modelHistory: projection.modelHistory,
  compressed: true,
  snapshotId,
  compressionRequired: false,
  estimatedTokens: projectionTokens,
  compressionThreshold: threshold
}
```

Snapshot id policy for this slice:

- If `tailMessageCount === 0`, reuse the existing snapshot id.
- If `tailMessageCount > 0`, materialize a new snapshot row for the exact
  UIMessage projection and set `sourceLastMessageId` to the latest canonical
  message id.
- Preserve `summaryText`/`summarySha256` from the source snapshot when no new
  summary was generated.
- If materialization fails in a production path where a context snapshot store
  is configured, fail closed before provider call rather than attaching
  misleading snapshot metadata.
- If an Agent is intentionally constructed without a context snapshot store,
  compressed model history may still be returned, but callers must not attach
  `contextCompressed` metadata because there is no ledger row to open.

TDD cases:

- `snapshot_reuse_materializes_exact_ledger_when_tail_exists`
- `snapshot_reuse_preserves_source_summary_audit_fields`
- `production_snapshot_materialization_failure_fails_closed`
- `compressed_history_without_snapshot_store_has_no_snapshot_metadata`

### Slice 1.4: Incremental Compression From Projection

If snapshot projection is still over threshold:

1. Use projection as `currentHistory`.
2. Run normal compression on that projection, not full canonical history.
3. Create the resulting snapshot against full canonical history so
   `sourceLastMessageId` and `canonicalMessageCount` remain correct.
4. If post-compression projection still exceeds hard provider budget, run
   emergency summarization.

TDD cases:

- `snapshot_projection_over_threshold_compresses_projection_not_raw_history`
- `incremental_compression_consolidates_existing_summary_without_stacking`
- `snapshot_projection_over_hard_limit_runs_emergency_summary`
- `projection_over_hard_budget_with_noop_compression_runs_emergency_summary`
- Existing summarizer retry/fallback/no-op tests in `agent-preflight.test.ts`
  and `agent-compress.test.ts` must remain green.

Implementation note: do not rely only on the compressor's in-memory
`previousSummary`; after restart the durable snapshot summary may be the only
prior-summary source.

### Slice 1.5: Verification

Required checks:

```sh
pnpm --filter @openacme/agent-core test -- test/compression.test.ts
pnpm --filter @openacme/agent-core test -- test/agent-compress.test.ts
pnpm --filter @openacme/agent-core test -- test/agent-preflight.test.ts
pnpm --filter @openacme/agent-core check-types
pnpm --filter @openacme/db check-types
cd packages/server
pnpm vitest run --config vitest.e2e.config.ts test/e2e/context-compression.e2e.ts
```

Acceptance:

- Reused snapshot under threshold does not call memory flush.
- Reused snapshot under threshold does not call summarizer.
- When projection is over threshold, existing summarizer behavior still works:
  retry, fallback, no-op telemetry, forensic timeline, usage reporting, and
  emergency summary.
- Canonical DB history is unchanged.
- Model history sent by preflight is snapshot plus canonical tail.
- Production paths that attach snapshot metadata have a real snapshot row.
- Store-less Agent uses do not attach ledger metadata.
- Existing compression/summarizer regression tests still pass.

## Milestone 2: Provider Path Guardrails

Primary outcome: no caller accidentally discards the prepared projection or
sends raw canonical history after required compression failure.

Current TDD evidence:

- `autonomous_preflight_failure_does_not_continue_with_raw_history` failed
  first because `runAutonomous()` caught preflight failure and still called
  `runStream()` with canonical history.
- `agent_ask_uses_prepared_projection_instead_of_reloaded_canonical_history`
  failed first because `AgentManager` called `preflightCompress()` then
  reloaded canonical history before `runStream()`.
- `preflight_estimate_uses_effective_tool_filter` failed first because
  preflight counted full `config.tools`, including tools filtered out before
  the provider call.
- The e2e `agent_ask` case also exposed a projection fallback bug: when a
  valid snapshot projection existed but was still estimated over threshold
  due to tool schemas and could not be further compressed, the no-result path
  returned raw canonical history. The fix returns/materializes the projection
  instead.

### Slice 2.1: Chat And Autonomous No-Raw-Fallback

`/api/chat` already mostly follows this contract. `Agent.runAutonomous()` has a
known gap: it catches preflight compression failure and can continue on
canonical history.

TDD cases:

- `autonomous_preflight_failure_does_not_continue_with_raw_history`
- `reactive_retry_does_not_resend_same_failed_projection`

Acceptance:

- If compression is required and cannot produce a safe prepared history, the
  provider call is not made with raw canonical history.
- Reactive `payload_too_large` / `context_overflow` retry uses a smaller
  compressed or emergency-summarized context.

### Slice 2.2: `agent_ask` Prepared Projection

`AgentManager` currently calls `preflightCompress()` and then re-reads canonical
history. Since model-context compression no longer mutates canonical history,
that can discard the prepared projection.

TDD cases:

- `agent_ask_uses_prepared_projection_instead_of_reloaded_canonical_history`
- `agent_ask_persists_context_snapshot_metadata_when_compressed`

Acceptance:

- `agent_ask` passes prepared model history to `runStream()`.
- Compressed `agent_ask` assistant messages carry `contextSnapshotId` and
  `contextCompressed`.

### Slice 2.3: Effective Request Shape

Some callers pass `toolFilter` to `runStream()`. Preflight estimates should use
the same effective tool set as the provider call when that differs from
`config.tools`.

TDD case:

- `preflight_estimate_uses_effective_tool_filter`

Acceptance:

- `prepareModelHistory()` accepts the same effective `toolFilter` used by
  `runStream()`.
- `agent_ask` uses one shared peer-ask tool filter for preflight and provider
  calls.
- Projection fallback remains projection-based even when the estimated request
  size is dominated by tool schemas.

## Milestone 3: Ledger Semantics And UI Status

Primary outcome: the UI and docs describe context snapshots accurately, without
blocking the main fast-path fix.

Current TDD evidence:

- `context_snapshot_endpoint_labels_projection_semantics` failed first because
  the endpoint returned `modelContext.messages` without identifying that it is
  only the initial UIMessage projection.
- `chat_status_does_not_show_compacting_for_snapshot_reuse` failed first
  because `/api/chat` broadcast `Compacting older context…` before knowing
  whether fresh compression would run.
- Both are now green in
  `test/e2e/context-compression.e2e.ts`; the file has 3 passing tests.

### Slice 3.1: Snapshot Ledger Semantics

Context snapshots are UIMessage-level initial model-history projections. They
are not the full provider request: `runStream()` also adds system prompt, tools,
UIMessage materialization, and autonomous `prepareStep` injections.

TDD cases:

- `snapshot_ledger_includes_relevant_memory_parts_sent_to_provider`
- `snapshot_ledger_policy_covers_materialized_data_parts`
- `autonomous_prepare_step_injections_are_not_misrepresented_as_snapshot_context`
- `context_snapshot_endpoint_labels_projection_semantics`

Acceptance:

- Assistant metadata points only to a usable snapshot row.
- The context snapshot endpoint labels the snapshot as an initial UIMessage
  projection, not a full provider transcript.
- Full provider input remains available through forensic prompt snapshot
  evidence when enabled.
- `docs/context-compression.md` and `packages/db/src/schema.ts` document that
  snapshot rows are initial UIMessage projections, not provider transcripts.

### Slice 3.2: UI Status

The chat UI should not show "Compacting older context..." for pure snapshot
reuse.

TDD case:

- `chat_status_does_not_show_compacting_for_snapshot_reuse`

Acceptance:

- Snapshot reuse is silent or low-noise.
- Fresh compression and reactive retry still show status.
- Status clear behavior remains unchanged.
- `/api/chat` shows and clears the proactive compression status only after
  `prepareModelHistory()` enters a real compressor pass.

### Slice 3.3: Docs

Update:

- `docs/context-compression.md`
- `packages/db/src/schema.ts` comments for `session_context_snapshots`

Docs must distinguish:

- canonical `messages`,
- initial UIMessage context snapshot,
- full provider prompt snapshot/evidence,
- autonomous per-step injections.

## Follow-Up Backlog

These are real risks but should not block Milestone 1.

- Snapshot storage growth telemetry and retention policy.
- Delta/content-addressed snapshot storage.
- Memory-only flush age/size policy during long reuse runs.
- Tool result preview/reference policy for remote MCP outputs.
- Runtime tool schema scoping beyond current `toolFilter` cases.
- Retiring or replacing legacy rename-swap `Agent.compress()`.
