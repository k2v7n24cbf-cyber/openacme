# Observability Side-Effect Refactor Plan

## Objective

Restore the main OpenAcme execution flow so it stays structurally equivalent to
the pre-forensics implementation, while keeping telemetry, local evidence, DB
timeline, and Langfuse/OpenTelemetry export as best-effort side effects.

The baseline for this refactor is the core execution structure before
`9838761 Add AI observability forensics`. Any code that sends provider HTTP
requests, consumes AI streams, executes tools, runs compression, or drives
autonomous turns should remain recognizable as that baseline flow. Collection
code may observe those operations, but it must not become the named owner of the
operation.

## Architectural Contract

1. Core execution owns behavior.
   Provider request dispatch, AI SDK streaming, tool execution, compression, and
   autonomous scheduling must not depend on local forensic collection.

2. Collection is a side effect.
   Observability sinks may record events, spans, hashes, metadata, file
   locators, and DB correlation fields. Sink failure must not change the
   execution result, timing contract, stream consumption contract, or retry
   behavior.

3. Collection code does not pre-consume streams.
   A collector must not fully read provider response streams before the AI SDK
   receives them. Raw body capture may only happen where it is already part of
   the existing core behavior, or through a bounded observer that cannot affect
   the returned stream.

4. Naming must not imply ownership of the main operation.
   A function named for forensics or evidence must not be the primary provider
   HTTP executor. Core call sites may use neutral wrappers such as
   `observeProviderRequest(fn)` or `withAiRunObservation(fn)`, but the callback
   remains the owner of the real work.

5. Core modules speak in neutral correlation terms.
   Domain code may carry `traceId`, `spanId`, `runId`, `usageEventId`, or
   `evidenceRef` when needed. It should avoid coupling to archive-specific
   words such as `forensicPath` except at persistence or operator lookup
   boundaries.

6. Local evidence archive is one sink, not the model.
   The local archive may be called "forensics" in docs, operator runbooks, and
   filesystem paths. Core execution APIs should treat it as an evidence sink
   behind an observation interface.

7. Pre-forensics structure is the default target.
   For code touched by `9838761 Add AI observability forensics`, the preferred
   fix is to recover the control flow, naming, and module ownership that existed
   immediately before that commit, then add observability as a narrow wrapper or
   callback around that flow.

8. Exception handling is local first, process-level last.
   Known async work must catch and report its own failures. Process-level
   `unhandledRejection` and `uncaughtException` handlers are allowed only as the
   final guardrail and must not become normal provider-error control flow.

## Audit Evidence

The current branch was audited against the pre-forensics baseline:
`9838761^:packages/...`. The important comparisons are:

- `packages/llm-provider/src/registry.ts` previously used direct provider
  `fetch(...)` calls inside provider-local `send(...)` helpers. Current code
  routes those calls through `forensicFetch`.
- `packages/agent-core/src/agent.ts` previously kept `streamText(...)` as the
  direct center of `runStream`. Current code wraps the turn in forensic context,
  recorder setup, span setup, raw file writes, timeline events, and usage
  correlation inline.
- `packages/tools/src/registry.ts` previously validated args, ran the handler or
  worker dispatcher, applied spill, and returned the output. Current code makes
  forensic spans, raw files, locator payloads, and events part of the registry
  body.

Repo-wide source audit coverage:

- AI SDK calls are confined to `packages/agent-core/src/agent.ts`,
  `packages/agent-core/src/compression.ts`, and
  `packages/agent-core/src/subagent.ts`. `selector.ts`, `title.ts`, and
  `extractor.ts` call `runSubagent(...)`, so they are covered by the subagent
  boundary.
- Provider LLM HTTP ownership is confined to
  `packages/llm-provider/src/registry.ts` plus the current temporary
  `forensics-fetch.ts` helper.
- Tool execution ownership is confined to `packages/tools/src/registry.ts`,
  with worker execution entering through `packages/tool-host/src/worker.ts`.
- Persistence/query/display surfaces are `packages/db/src/schema.ts`,
  `packages/db/src/stores/*usage*`, `packages/db/src/stores/*timeline*`,
  `packages/server/src/agent-manager.ts`,
  `packages/server/src/routes/session-timeline.ts`, and frontend/CLI type or
  lifecycle propagation code.
- Verification and local deployment scripts under `ops/langfuse-local/*` are
  test/operator tooling, not production execution flow.

## Tuned Violation Inventory

### Provider Request Boundary

`packages/llm-provider/src/forensics-fetch.ts` currently performs the actual
provider HTTP request. This makes forensic collection appear to own the network
operation.

It also attempts to clone and fully read the provider response body before
returning the response. That is not a side effect for streaming responses; it can
change latency, memory behavior, and failure timing.

Evidence:

- `packages/llm-provider/src/registry.ts` imports `forensicFetch` and calls it
  in every provider fetch hook.
- `packages/llm-provider/src/forensics-fetch.ts` calls the real fetch and then
  reads `res.clone().arrayBuffer()` when raw capture is enabled.
- `packages/llm-provider/test/forensics-fetch.test.ts` currently encodes this
  behavior with a streaming-response test that expects `response.body` capture.

Required correction:

- Restore provider-local `send(...) => fetch(...)` shape from the baseline.
- Replace the executor with a neutral observer around the provider-owned fetch,
  for example `observeProviderRequest(context, () => fetch(...))`.
- Remove full provider response body capture at the fetch boundary for streams.
  Record status, headers, request id, hashes of safely inspectable request
  bodies, and errors.

### Public API Surface

`@openacme/llm-provider` exports forensic recorder, context, locator, and fetch
helpers directly. This lets `agent-core`, `compression`, `subagent`, and `tools`
depend on local evidence archive concepts instead of a neutral observability
contract.

Evidence:

- `packages/llm-provider/src/index.ts` exports `createForensicRecorder`,
  `enterAIForensicContext`, `setAIForensicContext`, `forensicFetch`, forensic
  locator builders, and archive-specific types.
- `packages/agent-core/src/agent.ts`, `packages/agent-core/src/compression.ts`,
  and `packages/agent-core/src/subagent.ts` import these archive-specific APIs.
- `packages/tools/src/index.ts` exports `bindToolForensics` and related
  forensic tool types.

Required correction:

- Keep OpenTelemetry span helpers and local evidence archive implementation in
  collection modules.
- Expose neutral observation contracts to core packages.
- Remove `forensicFetch` from the public API entirely.
- Avoid legacy aliases that keep new core code using forensic-named APIs.

### Agent Run Path

`Agent.runStream` currently creates forensic context, recorder files, evidence
locators, spans, timeline events, and usage correlation inline. The main
`streamText` path should stay visually close to the pre-forensics flow, with
observation delegated to a wrapper or sink.

Evidence:

- `packages/agent-core/src/agent.ts` has module-load tool forensic binding.
- `runStream` calls `setAIForensicContext(...)`, `createForensicRecorder(...)`,
  raw model-input writes, and multiple forensic events before reaching
  `streamText(...)`.
- The baseline `runStream` built tools/messages/system, then returned
  `streamText(...)` with `onFinish` usage reporting.

Required correction:

- Extract turn observation into a helper such as `withAiRunObservation`.
- Keep `streamText({ model, system, messages, tools, ... })` in the same visible
  location and preserve its existing options and error behavior.
- Replace unscoped `setAIForensicContext(...)` with scoped observation context.
- Keep usage ledger callback behavior, but move locator/raw archive mechanics
  behind the observation helper.

### Tool Registry

`ToolRegistry` currently knows forensic raw-file naming, evidence directory
structure, and forensic event payloads. It should emit tool lifecycle facts and
let an observer decide how to map those facts to local evidence files, spans, or
timeline rows.

Evidence:

- `packages/tools/src/registry.ts` imports forensic helpers, constructs
  `tool-calls/...` archive directories, writes args/results, and starts
  forensic spans inside both `getVercelTools()` and `dispatch()`.
- `packages/tools/src/types.ts` already defines `classifyResult` as
  observability-only. That is the correct model; the registry implementation is
  where the archive coupling leaks in.

Required correction:

- Keep tool outcome classification and span attributes as observable facts.
- Rename tool observation interfaces away from `ToolForensics*`.
- Move raw evidence file layout behind a sink.
- Move binding setup out of `agent-core` module load and into server/agent
  composition.

### Compression Helpers

Compression summarizer and memory-flush logic currently interleave helper
generation with forensic archive setup, locator construction, raw prompt/output
capture, and DB timeline payload construction. That should move behind helper
observation wrappers.

Evidence:

- `packages/agent-core/src/compression.ts` wraps summarizer `generateText(...)`
  with forensic context/span/archive setup.
- `packages/agent-core/src/agent.ts` does the same for pre-compaction
  memory flush.
- The baseline compression helper primarily built the prompt, called
  `generateText(...)`, reported usage, and handled fallback/cooldown.

Required correction:

- Introduce a neutral helper observation boundary for summarizer, memory flush,
  and structured subagent helper calls.
- Keep compression fallback, cooldown, no-op, and failure behavior unchanged.
- Keep raw prompt/output evidence only as sink output, not as compression logic.

### Subagent Helper Path

Subagent calls are a smaller but real copy of the same issue:
`packages/agent-core/src/subagent.ts` imports forensic context APIs and wraps
structured `streamObject(...)` / `generateObject(...)` calls in forensic
span/context setup. Forked subagents route through `Agent.runStream`, so they
inherit the main turn observation boundary.

This also covers:

- `packages/agent-core/src/selector.ts` memory selection.
- `packages/agent-core/src/title.ts` title generation.
- `packages/agent-core/src/extractor.ts` post-turn memory extraction.

Required correction:

- Reuse the same AI helper observation abstraction from the compression slice
  for structured subagents.
- Ensure forked subagents inherit neutral `runStream` observation without adding
  their own archive-specific coupling.
- Preserve structured result, timeout, stream draining, and usage-report
  behavior.

### Evidence Locator Layer

`packages/llm-provider/src/evidence-locator.ts` builds server timeline URLs and
declares DB lookup keys. That couples the LLM provider package to operator API
routes and database schema.

Required correction:

- Keep evidence refs and lookup fields as neutral correlation data where needed.
- Move route-specific timeline locator construction to the server/operator
  boundary or inject it from the composition root.
- Update tests that assert server URLs in `llm-provider`.

### Async Crash Boundary

The autonomous broadcaster branch is a fire-and-forget async reader without an
outer catch. Stream failures can escape as unhandled rejections even though the
main autonomous turn path has error handling.

Evidence:

- `packages/agent-core/src/agent.ts` starts `void (async () => { ... })()` for
  the broadcaster branch and only catches `bc.broadcast(...)`, not
  `reader.read()`.
- `packages/server/src/agent-manager.ts` and `packages/tool-host/src/worker.ts`
  also use fire-and-forget async work, but their bodies have internal catches.

Required correction:

- Add a local catch around the broadcaster reader branch.
- Report/log this as broadcaster observation failure, not as the main turn
  result.
- Keep process-level handlers as a final safety net only.

## Test And Verifier Expectations To Update

Some tests now encode the wrong architecture. They must be changed as part of
the implementation slices, not treated as source-of-truth behavior.

- `packages/llm-provider/test/forensics-fetch.test.ts` should be replaced by
  provider request observation tests. The current streaming case expects cloned
  `response.body` capture; the corrected test should assert that streaming
  provider responses are not fully read by observation before the AI SDK caller
  consumes them.
- `packages/llm-provider/test/evidence-locator.test.ts` should stop asserting
  server route strings from the provider package. Timeline route locator
  assertions belong in server/operator tests.
- `packages/agent-core/test/agent-forensics.test.ts`,
  `packages/agent-core/test/agent-telemetry.test.ts`,
  `packages/agent-core/test/agent-compress.test.ts`,
  `packages/agent-core/test/subagent.test.ts`,
  `packages/agent-core/test/selector.test.ts`, and
  `packages/agent-core/test/agent-preflight.test.ts` should move from
  forensic-named imports/mocks to neutral AI observation contracts while
  preserving their usage, timeline, correlation, and local evidence assertions.
- `packages/tools/test/forensics.test.ts` should become tool observation/evidence
  sink coverage. Keep the existing outcome classification coverage, including
  shell exit-code failure, thrown exception, timeout, protocol error,
  disconnected worker, and empty success cases.
- `packages/server/test/e2e/session-timeline.e2e.ts` should remain the route
  and operator-readback authority for `includeForensics=1`, local evidence
  hydration, and payload sanitization. This route-specific knowledge should not
  move back into provider/core packages.
- `packages/db/test/session-timeline-store.test.ts` may keep compatibility
  coverage for persisted `forensic_run_id` and `forensic_path` fields until a
  later migration renames storage. Those names should not drive new core APIs.
- `ops/langfuse-local/verify-openacme-test-telemetry.mjs` and
  `ops/langfuse-local/verify-openacme-test-compression.mjs` are operator
  verifiers. They can remain Langfuse/local-evidence-specific, but they should
  consume neutral span attributes and server/operator locators after the
  boundary refactor.
- `apps/cli/test/lifecycle-env.test.ts` is acceptable env propagation coverage.
  Preserve it as a service-management boundary, not a collection
  implementation test.

## Acceptable Boundaries To Preserve

These are not violations of the side-effect principle:

- `packages/config/src/telemetry-bootstrap.ts` is a collection/bootstrap module.
  It is env-gated, inert by default, and wraps console/log export failures in
  best-effort handling.
- `packages/llm-provider/src/observability.ts` is a collection helper. Its
  no-op span fallback and attribute sanitization belong in the collection
  library.
- `packages/config/src/openacme-baggage-span-processor.ts` and
  `packages/config/src/langfuse-attribute-span-processor.ts` are backend
  adapters. They may map canonical OpenAcme attributes to Langfuse metadata, and
  their failures are already swallowed.
- `packages/server/src/agent-manager.ts` usage and timeline persistence are
  sink callbacks. They catch failures and do not change turn behavior.
- `packages/server/src/dispatcher.ts` autonomous lifecycle timeline events are
  operational DB timeline facts, not local evidence archive ownership. The
  `recordTimeline(...)` helper catches sink failures.
- `packages/server/src/app.ts` interactive chat stream handling is not a
  telemetry boundary violation. It captures provider errors for user-visible
  message parts and catches stream/broadcast/assembler failures locally.
- `packages/server/src/routes/session-timeline.ts` is an operator read surface,
  not a model execution path. It may read local evidence, but file reads must be
  bounded and explicitly requested when this endpoint becomes user-facing at
  scale.
- `apps/cli/src/lifecycle/common.ts` only persists non-secret observability
  toggles/endpoints into service managers. It does not collect telemetry or
  alter AI execution.
- `apps/cli/src/commands/chat.ts` initializes telemetry for CLI chat, then uses
  the same `AgentManager` path as the server. The initializer is idempotent.
- `packages/db/src/schema.ts` and DB stores carry existing correlation columns
  (`trace_id`, `span_id`, `forensic_run_id`, `forensic_path`,
  `provider_request_count`). They are persistence compatibility, not core
  observation APIs.
- Frontend usage/timeline types display persisted fields and are not execution
  boundaries.
- `ops/langfuse-local/*` scripts are verification tooling. They can remain
  Langfuse/local-forensics-specific, though their assertions must be updated as
  neutral names replace core forensic names.
- Existing provider-specific diagnostic body reads, such as OpenAI OAuth error
  logging and Anthropic 1M entitlement fallback, predate this observability
  slice and are provider behavior. They are not refactor targets unless tests
  show they alter stream semantics.

## Milestone Operating Rule

After each milestone:

- Reopen this document before starting the next milestone.
- Add a short review note with what changed, what tests passed, and whether any
  new violation was discovered.
- Re-run the milestone's search gates.
- Do not start the next slice until the current slice preserves app behavior
  with observability enabled and disabled.

## Milestones

### Milestone 0 - Lock The Side-Effect Contract

Goal: make the refactor target explicit before implementation.

Scope:

- Keep this document as the acceptance contract.
- Mark `forensicFetch` as a temporary violation to remove.
- Define "core-equivalent" as preserving the pre-`9838761` execution shape and
  semantics unless a non-observability bug fix explicitly requires otherwise.

TDD:

- No code tests yet.
- Review test names and expectations that encode the wrong model, especially
  streaming response raw capture in `forensics-fetch.test.ts`.
- Record the tests that must be renamed or inverted before implementation starts
  so later milestones do not preserve a telemetry-owned execution model.

Done when:

- This document contains the tuned violation inventory above.
- This document contains the test and verifier expectation inventory above.
- The active implementation slices reference this contract.

Review note:

- Repo-wide source searches found archive-specific execution coupling in the
  planned violation areas: provider fetch, agent run path, compression helpers,
  structured subagents, tool registry, and provider-side locator construction.
- Direct AI SDK call-site search found production calls only in
  `agent.ts`, `compression.ts`, and `subagent.ts`; selector, title, extractor,
  and forked subagents route through those boundaries.
- Fire-and-forget async search found one relevant unguarded branch in
  `agent.ts`; the server cleanup and tool-host worker branches already have
  local catches.
- Test and verifier searches found coupling that must be inverted during the
  relevant slices, especially provider streaming response raw capture and
  provider-package server timeline locator assertions.

### Milestone 1 - Crash Containment Without Architecture Expansion

Goal: fix the known prod crash path without deep refactor.

Status: completed

Scope:

- Add a local catch around the autonomous broadcaster fire-and-forget reader.
- Log/report the broadcaster branch failure as observation, not turn behavior.
- Do not introduce new forensic execution APIs.

TDD:

- A rejected broadcaster `reader.read()` must not create an unhandled rejection.
- The main autonomous stream path must still surface/throw provider failures
  through the existing runAutonomous and dispatcher boundaries.
- Dispatcher cleanup must still return the session to idle.

Done when:

- Focused agent-core test passes.
- No process-level handler is needed to pass this regression.

Review note:

- Added `packages/agent-core/test/agent-autonomous-broadcaster.test.ts`.
- Before the fix, the test failed because the broadcaster fanout
  `reader.read()` rejection reached `unhandledRejection`.
- Added a local catch around the broadcaster reader loop in
  `packages/agent-core/src/agent.ts`; the main autonomous turn path and
  provider error propagation were not changed.
- Validation passed:
  `pnpm --filter @openacme/agent-core test -- agent-autonomous-broadcaster.test.ts`,
  `pnpm --filter @openacme/agent-core test -- agent-inbox.test.ts agent-fire-title.test.ts`,
  and `pnpm --filter @openacme/agent-core check-types`.

### Milestone 2 - Restore Provider Fetch Ownership

Goal: provider HTTP flow should again look like provider HTTP flow.

Status: completed

Scope:

- Remove `forensicFetch` as the primary network executor.
- Introduce a neutral observation helper such as
  `observeProviderRequest(context, async () => fetch(...))`.
- Preserve provider-specific `send(false)` / retry / body transform structure
  from the pre-forensics registry.
- Record request/response metadata through observers.
- Stop full-body raw response capture at the provider fetch boundary for
  streaming responses.
- Keep request raw capture best-effort and only for safely inspectable body
  values.

TDD:

- Streaming response is not fully read by the observer before caller
  consumption.
- Observer failure does not reject the provider request.
- Fetch rejection is still propagated to the AI SDK caller.
- Non-OK status metadata is still recorded.
- Provider request ordinal/count correlation remains available.

Done when:

- Registry code no longer calls a forensic-named function to send provider
  HTTP.
- The returned `Response` is semantically owned by the AI SDK consumer.
- `packages/llm-provider/src/registry.ts` reads like the pre-forensics provider
  flow, with observation wrapped around provider-owned fetch calls.

Review note:

- Replaced `packages/llm-provider/src/forensics-fetch.ts` with
  `packages/llm-provider/src/provider-observation.ts`.
- Removed the public `forensicFetch` / `ForensicFetchOptions` API. Provider
  request count correlation now exports from `provider-observation.ts`.
- Updated provider registry `send(...)` hooks so request init construction and
  real `fetch(...)` execution are owned by provider-local code; observation
  wraps that callback and records metadata as a side effect.
- Removed provider response raw body capture at the fetch boundary. The new
  streaming test asserts observation does not fully consume the response before
  the caller reads it.
- Added sink-failure coverage proving recorder failures do not change provider
  request results.
- Validation passed:
  `pnpm --filter @openacme/llm-provider test -- provider-observation.test.ts evidence-locator.test.ts`,
  `pnpm --filter @openacme/llm-provider check-types`,
  `pnpm --filter @openacme/agent-core check-types`, and the M2 search gates for
  `forensicFetch`, `ForensicFetchOptions`, `forensics-fetch`, and provider
  `res.clone().arrayBuffer()` response capture.

### Milestone 3 - Introduce Neutral AI Observation Interfaces

Goal: keep forensic archive concepts out of core agent APIs.

Status: completed

Scope:

- Add neutral types such as `AiRunObservation`, `ProviderRequestObservation`,
  `ToolExecutionObservation`, and `EvidenceSink`.
- Keep local forensic archive implementation behind the sink.
- Keep OpenTelemetry span implementation behind the observation wrapper.
- Rename local variables where possible from `forensicContext` to `runContext`
  or `observationContext`.
- Keep `forensicRunId` / `forensicPath` DB column names for compatibility during
  this refactor, but do not expose them as the primary core abstraction.

TDD:

- Sink initialization failure returns a no-op observer.
- Span/export failure is swallowed.
- Existing usage rows still carry correlation fields.
- Local archive still receives expected event facts when enabled.

Done when:

- `agent-core` imports fewer archive-specific APIs from `llm-provider`.
- Core run code describes AI runs, provider requests, and tool executions, not
  forensic mechanics.
- Public package exports no longer encourage core modules to depend on archive
  internals.

Review note:

- Added `packages/llm-provider/src/ai-observation.ts` as the neutral public
  contract over the local evidence archive implementation.
- Removed forensic-named recorder/context/locator exports from
  `packages/llm-provider/src/index.ts`; internal sink implementation files keep
  their existing names.
- Updated agent-core source and focused tests to use neutral public names such
  as `createEvidenceRecorder`, `enterAiObservationContext`,
  `getAiObservationContext`, `buildEvidenceLocatorPayload`, and
  `getProviderRequestCountForRun`.
- Added `packages/llm-provider/test/ai-observation-public-api.test.ts` to guard
  the public API boundary.
- Validation passed:
  `pnpm --filter @openacme/llm-provider check-types`,
  `pnpm --filter @openacme/llm-provider build`,
  `pnpm --filter @openacme/agent-core check-types`,
  `pnpm --filter @openacme/llm-provider test -- ai-observation-public-api.test.ts provider-observation.test.ts`,
  `pnpm --filter @openacme/agent-core test -- telemetry.test.ts agent-telemetry.test.ts agent-forensics.test.ts agent-compress.test.ts subagent.test.ts selector.test.ts agent-preflight.test.ts`,
  and the M3 search gate confirming old forensic-named public APIs are absent
  from `agent-core` source/tests and `llm-provider` public index.

### Milestone 4 - Agent Run Observation Wrapper

Goal: restore `Agent.runStream` readability and baseline flow shape.

Status: completed

Scope:

- Move agent turn span, model input snapshot, local archive writes, and timeline
  payload construction behind `withAiRunObservation`.
- Keep `streamText({ model, system, messages, tools, ... })` as the visually
  central operation.
- Preserve existing usage ledger behavior.
- Preserve existing upstream error surfacing behavior.

TDD:

- Successful turn records usage/timeline/local evidence when enabled.
- Provider error records failed turn telemetry but surfaces through existing
  error path.
- Observation sink failures do not alter `streamText` result/error.
- Observability disabled leaves `streamText` options and `onFinish` usage
  behavior equivalent to the baseline.

Done when:

- `runStream` is no longer dominated by local archive setup.
- There is no module-load `bindToolForensics(...)` in `agent-core`.

Review note:

- Added `packages/agent-core/src/agent-observation.ts` to own agent turn
  telemetry, local evidence, timeline, usage, span close, and sink-failure
  handling.
- Reduced `Agent.runStream` to domain setup, `createAgentRunObservation(...)`,
  and the central `streamText({...})` call with delegated `onFinish` /
  `onError` handlers.
- Added coverage in `packages/agent-core/test/agent-telemetry.test.ts` proving
  evidence recorder `recordEvent` / `writeRawFile` failures do not prevent
  `streamText` execution.
- Validation passed:
  `pnpm --filter @openacme/agent-core check-types`,
  `pnpm --filter @openacme/agent-core test -- agent-telemetry.test.ts agent-forensics.test.ts agent-autonomous-broadcaster.test.ts`,
  `pnpm --filter @openacme/agent-core test -- agent-inbox.test.ts subagent.test.ts`,
  and the M4 search gate confirming agent-run archive events and raw
  `agent/model-input.*` writes live in `agent-observation.ts`, not in the
  `runStream` body.
- Remaining note: module-load `bindToolForensics(...)` is intentionally left
  for Milestone 5, where tool lifecycle observation is refactored.

### Milestone 5 - Tool Lifecycle Observation Boundary

Goal: tool registry emits lifecycle facts; observers choose sinks.

Status: completed

Scope:

- Replace forensic-specific names in tools package with observation-neutral
  names.
- Move raw-file path/layout decisions out of the core registry where practical.
- Move binding setup out of module-load side effects into server/agent
  composition.

TDD:

- Tool success/failure/exception classification remains unchanged.
- Shell exit-code failure still marks logical failure.
- Observer failure does not alter tool output.
- Worker and daemon tool paths both emit lifecycle facts.
- Tool result spill behavior remains unchanged.

Done when:

- `ToolRegistry` no longer appears to know the local evidence archive as its
  primary model.
- Tool archive directory naming lives in the evidence sink, not the registry.

Review note:

- Replaced `packages/tools/src/forensics.ts` with
  `packages/tools/src/observation.ts` and neutral public API names:
  `bindToolObservation`, `ToolObservationSink`, `ToolObservationSpan`,
  `withToolObservationSpan`, and related helpers.
- Updated `ToolRegistry` to use neutral tool observation names while preserving
  execution, worker dispatch, spill, classification, and output behavior.
- Moved agent tool observation binding out of module-load execution. Agent
  construction now composes the global tool observation binding through
  `bindAgentToolObservation()`.
- Renamed the focused test to
  `packages/tools/test/tool-observation.test.ts`; preserved coverage for
  daemon tools, worker-dispatched tools, spill facts, logical failures,
  exceptions, and observation sink failures.
- Validation passed:
  `pnpm --filter @openacme/tools check-types`,
  `pnpm --filter @openacme/tools build`,
  `pnpm --filter @openacme/agent-core check-types`,
  `pnpm --filter @openacme/tools test -- tool-observation.test.ts`,
  `pnpm --filter @openacme/agent-core test -- agent-telemetry.test.ts agent-forensics.test.ts agent-autonomous-broadcaster.test.ts`,
  and the M5 search gate confirming old `ToolForensics*` / `bindToolForensics`
  APIs are absent from production source.
- Remaining note: the registry still computes `tool-calls/...` relative
  evidence directories. That is behavior-preserving for this slice; deeper raw
  evidence layout extraction can be handled after helper and locator boundaries
  if search gates still show meaningful coupling.

### Milestone 6 - Helper AI Observation Boundary

Goal: compression, memory flush, forked subagent, and structured subagent
helper AI calls remain their domain logic first.

Status: completed

Scope:

- Wrap summarizer and memory-flush helper calls in neutral observation helpers.
- Reuse the same helper observation boundary for structured subagent calls.
- Verify forked subagents inherit the neutral `runStream` observation boundary.
- Move locator construction and raw prompt/output writes out of the core helper
  body.
- Preserve compression fallback and error behavior.

TDD:

- Summarizer success/failure behavior unchanged.
- Memory flush remains best-effort and cannot block compression.
- Structured subagent timeout, stream draining, and usage behavior unchanged.
- Forked subagent extractor/title/selector behavior unchanged.
- Helper usage rows still carry trace/run correlation.
- Local evidence archive receives helper facts only when enabled.

Done when:

- Compression files are not dominated by forensic setup.
- `subagent.ts` does not import archive-specific context APIs directly.
- `selector.ts`, `title.ts`, and `extractor.ts` remain free of archive-specific
  imports and keep routing through `runSubagent(...)`.

Review note:

- Added `packages/agent-core/src/helper-observation.ts` as the shared neutral
  AI helper observation boundary. It owns helper span setup, observation
  context propagation, provider request count lookup, evidence locator payloads,
  helper evidence file layout, and best-effort sink exception handling.
- Refactored compression summarizer, pre-compaction memory flush, and
  structured subagent helper calls to use `createAiHelperObservation(...)`.
  Their core AI SDK calls still happen locally through `generateText(...)`,
  `generateObject(...)`, or `streamObject(...)`; observation wraps the callback
  and does not own the provider call.
- Moved helper raw evidence file paths and helper relative evidence directories
  into helper observation profiles. Compression and memory-flush call sites now
  select profiles instead of constructing local archive layout strings.
- Added `packages/agent-core/test/helper-observation.test.ts`, covering the
  strongest exception-handling case for this slice: recorder creation can throw
  and the helper callback still completes.
- Updated selector and subagent test mocks to include the neutral locator APIs
  now imported by the shared helper boundary.
- Validation passed:
  `pnpm --filter @openacme/agent-core check-types`,
  `pnpm --filter @openacme/agent-core test -- helper-observation.test.ts agent-compress.test.ts subagent.test.ts agent-telemetry.test.ts agent-forensics.test.ts agent-autonomous-broadcaster.test.ts selector.test.ts agent-preflight.test.ts`,
  `git diff --check` for touched M6 files, and search gates confirming direct
  helper telemetry builders are absent from `compression.ts` and `subagent.ts`.
- Remaining note: `agent.ts` still imports local evidence/locator APIs for the
  tool observation binding composition point from Milestone 5. That is not part
  of helper AI execution and should be revisited only if the later composition
  boundary is moved out of `agent-core`.

### Milestone 7 - Operator Locator Boundary

Goal: keep route/database knowledge out of provider/core observation helpers.

Status: completed

Scope:

- Move server timeline URL construction out of `llm-provider`.
- Keep span attributes to opaque evidence references and lookup fields unless a
  server/operator adapter provides route locators.
- Review `session-timeline` default behavior for local evidence reads.

TDD:

- `llm-provider` locator tests no longer assert `/api/sessions/...` route
  strings.
- Server timeline tests still resolve local evidence from usage rows when
  explicitly requested.
- Sanitization still excludes raw/file/path fields from API payloads.

Done when:

- Provider package has no server route construction.
- Operator lookup still works through DB usage rows plus local archive metadata.

Review note:

- Removed provider-package session timeline route construction from
  `packages/llm-provider/src/evidence-locator.ts` and removed
  `buildTimelineLocator` from the public `@openacme/llm-provider` export
  surface.
- `buildEvidenceLocatorAttributes(...)` and
  `buildEvidenceLocatorPayload(...)` now emit evidence refs, lookup keys,
  event selectors, and relative evidence directories, but not
  `/api/sessions/...` route locators.
- Added server/operator route synthesis in
  `packages/server/src/routes/session-timeline.ts`. Forensic events returned
  from `GET /api/sessions/:id/timeline` can include a `timelineLocator`
  generated at the server boundary.
- Updated provider, agent-core, tools, and server tests so route URL assertions
  live in server e2e coverage rather than provider/core observation tests.
- Validation passed:
  `pnpm --filter @openacme/llm-provider check-types`,
  `pnpm --filter @openacme/llm-provider test -- evidence-locator.test.ts provider-observation.test.ts ai-observation-public-api.test.ts`,
  `pnpm --filter @openacme/tools test -- tool-observation.test.ts`,
  `pnpm --filter @openacme/server check-types`,
  `pnpm --filter @openacme/agent-core test -- helper-observation.test.ts agent-compress.test.ts agent-forensics.test.ts subagent.test.ts selector.test.ts`,
  and `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/session-timeline.e2e.ts`.
- The first server e2e attempt failed in sandbox with
  `listen EPERM: operation not permitted 127.0.0.1`; rerunning the same test
  outside the sandbox passed because the e2e harness needs to bind a local test
  server.
- Remaining note: `openacme.session.timeline_locator` remains in config
  attribute/baggage allow-lists and the generic tool observation attribute
  mapper so a server/operator adapter can still propagate it. No provider or
  core helper code constructs the route string.

### Milestone 8 - Process-Level Safety Net

Goal: add a final guard without using it as the primary fix.

Status: completed

Scope:

- Add process-level logging for `unhandledRejection` and `uncaughtException`.
- Flush telemetry best-effort.
- Treat unknown fatal exceptions conservatively.
- Verify the known autonomous stream case no longer reaches this guard.

TDD:

- Known broadcaster reader failure is handled locally.
- Synthetic unhandled rejection is logged and flushed by the process guard.

Done when:

- Process-level handler is a last resort, not normal provider-error control
  flow.

Review note:

- Added `packages/config/src/process-exception-guard.ts` as an idempotent,
  testable process-level guard for `unhandledRejection` and
  `uncaughtException`.
- The guard logs fatal process-level escapes, attempts
  `shutdownOpenAcmeTelemetry()` best-effort, swallows telemetry shutdown
  failures, sets exit code `1`, and exits conservatively.
- Registered the guard in `apps/cli/src/index.ts` for CLI/service processes and
  in `packages/server/src/index.ts` only for direct server execution. Server
  e2e/test harness imports do not automatically install fatal process
  listeners.
- Added `packages/config/test/process-exception-guard.test.ts` covering
  synthetic unhandled rejection logging/flush/exit, shutdown failure
  containment, and repeated fatal-event reentry.
- Re-ran the known autonomous broadcaster regression to confirm the known async
  reader failure is still handled locally rather than by the process guard.
- Validation passed:
  `pnpm --filter @openacme/config check-types`,
  `pnpm --filter @openacme/config test -- process-exception-guard.test.ts observability-config.test.ts`,
  `pnpm --filter @openacme/server check-types`,
  `pnpm --filter @openacme/cli check-types`,
  `pnpm --filter @openacme/agent-core test -- agent-autonomous-broadcaster.test.ts`,
  `pnpm --filter @openacme/server build`, and
  `pnpm --filter @openacme/cli build`.

## Validation Strategy

Focused tests first:

- `@openacme/agent-core` autonomous stream failure test.
- `@openacme/llm-provider` provider request observer tests.
- `@openacme/tools` tool observation tests.
- `@openacme/agent-core` compression/helper/subagent observer tests.
- `@openacme/server` dispatcher/chat error-containment tests for timeline sink
  failures and provider stream failures.

Then integration:

- OpenAcme test environment under `~/.openacme-test`.
- Local Langfuse readback for trace/session continuity.
- A live provider failure canary only after mock/stub tests prove the local
  boundaries.

Search gates:

- The following commands return no matches:

```sh
rg "forensicFetch" packages/llm-provider/src/registry.ts
rg "forensicFetch" packages/llm-provider/src/index.ts
rg "setAIForensicContext" packages/agent-core/src
rg "bindToolForensics" packages/agent-core/src
rg "timeline\\?includeForensics|/api/sessions" packages/llm-provider/src
rg "res\\.clone\\(\\)\\.arrayBuffer\\(\\)" packages/llm-provider/src
```

- This command is either empty or confined to observation helper modules:

```sh
rg "writeRawFile|createForensicRecorder|buildForensicLocator" \
  packages/agent-core/src/agent.ts \
  packages/agent-core/src/compression.ts \
  packages/agent-core/src/subagent.ts
```

- This command returns no matches from the registry after tool observation is
  neutralized:

```sh
rg "ToolForensics|toolForensic|Forensic" packages/tools/src/registry.ts
```

- This command confirms no new direct AI SDK call sites were introduced outside
  the audited boundaries:

```sh
rg "\\b(streamText|generateText|generateObject|streamObject)\\b" \
  packages apps ops \
  --glob '!**/test/**' \
  --glob '!**/web/assets/**' \
  --glob '!**/dist/**'
```

- This command confirms archive-specific types do not leak outside observation
  implementations, tests, and compatibility persistence surfaces:

```sh
rg "AIForensicContext|ForensicRecorder|ForensicFetchOptions|ToolForensics|forensics-fetch|forensics-recorder|forensics-context|evidence-locator|tools/forensics" \
  packages/*/src apps/*/src ops \
  --glob '!**/web/assets/**'
```

- These commands confirm tests have been moved to the corrected ownership
  boundaries:

```sh
rg "forensicFetch|captures a cloned streaming response|response\\.body" \
  packages/llm-provider/test
rg "timeline\\?includeForensics|/api/sessions|usage_events\\.forensic_run_id" \
  packages/llm-provider/test
rg "createForensicRecorder|enterAIForensicContext|getAIForensicContext|setAIForensicContext|buildForensicLocator|bindToolForensics|ToolForensics" \
  packages/agent-core/test packages/tools/test packages/llm-provider/test
```

Production acceptance:

- Provider 503 or stream termination fails the turn/session, not the process.
- Core request/stream/tool/compression code remains structurally close to the
  pre-forensics baseline.
- Telemetry and local evidence are present when enabled.
- Disabling observability/forensics leaves core behavior unchanged.

## Final Test-Environment Validation - 2026-07-27

Environment:

- All live application validation was executed against
  `/Users/alenbohcelyan/.openacme-test`.
- Production data dir `/Users/alenbohcelyan/.openacme` was not intentionally
  touched.
- The isolated daemon was restarted with
  `pnpm agent restart -d /Users/alenbohcelyan/.openacme-test --no-service --no-browser`
  and finished healthy on `127.0.0.1:3457`.

Live verifier results:

- `OPENACME_VERIFY_AGENT_ID=langfuse-canary-local node ops/langfuse-local/verify-openacme-test-telemetry.mjs`
  passed.
- Direct run:
  session `86c0b8ce-67bb-4435-b093-137fa1539911`, trace
  `91b79a476a87161267df2b39216b7058`, forensic run
  `7ebccb06-3508-4aa0-9c6a-267f34b2c8ca`, provider request count `1`.
- Tool run:
  session `2a5d630e-859e-4f61-b526-7e7bdaa0820f`, trace
  `a29f777768a7035371c5b577feeb07cf`, forensic run
  `a4b7de02-71af-4402-ac50-ec5700702734`, provider request count `2`.
- Langfuse readback included `openacme.agent.turn`,
  `openacme.provider.request`, `openacme.tool.execute`, `shell`, and AI SDK
  generation spans with no failed observations.

Compression verifier:

- `node ops/langfuse-local/verify-openacme-test-compression.mjs` passed.
- Session `41d9c61b-fab2-4f15-a0f4-a9f5e246d60b` produced the expected
  compression marker `OPENACME_COMPRESSION_CANARY_20260727131729`.
- The usage rows and session timeline included compression summarizer,
  memory-flush extractor, interactive turn, provider request counts,
  Langfuse trace/span ids, forensic run ids, and forensic file paths.
- Local evidence included helper files under
  `compression/summarizer/input.json`, `compression/summarizer/output.txt`,
  `compression/summarizer/prompt.txt`,
  `compression/memory-flush/model-input.messages.json`,
  `compression/memory-flush/model-input.system.txt`, and
  `compression/memory-flush/output.txt`.
- Langfuse readback included `openacme.ai.helper`,
  `openacme.provider.request`, `compression-summarizer:ai.generateText`, and
  provider HTTP spans with no failed observations.

Verifier preflight findings:

- The first telemetry verifier attempt correctly failed because it selected the
  default OAuth-backed OpenAI agent, which was not signed in in the test data
  dir.
- The second attempt correctly failed because the local canary OpenAI-compatible
  provider was not running.
- After selecting `langfuse-canary-local` and starting the local canary
  provider, both telemetry and compression readback verifiers passed.

Final hygiene checks:

- `git diff --check` passed.
- `pnpm --filter @openacme/agent-core check-types` passed.
- `pnpm --filter @openacme/llm-provider check-types` passed.
- `pnpm --filter @openacme/tools check-types` passed.
- `pnpm --filter @openacme/config check-types` passed.
- `pnpm --filter @openacme/server check-types` passed.
- `pnpm --filter @openacme/cli check-types` passed.
- `pnpm --filter @openacme/cli build` passed.
- Final isolated daemon status was verified with
  `pnpm agent status -d /Users/alenbohcelyan/.openacme-test --no-service`:
  pid `76123`, bind `127.0.0.1:3457`, health `200 OK`.

## Non-Goals

- Do not build new product behavior while doing this refactor.
- Do not change provider retry policy except where existing behavior is broken.
- Do not use Langfuse-specific concepts in core execution modules.
- Do not keep legacy aliases for removed forensic execution APIs.
