# Langfuse + Local AI Forensics TDD Plan

Baseline branch: `local-stage`

Baseline commit: `5bf7275` (`Improve dependency map dense task display`)

Plan created from the clean checkout at `worktrees/local-stage` after polling `origin/local-stage` until it matched local `local-stage`.

## Objective

Build an AI-only forensic observability layer that serves both human operators and agents:

1. Langfuse is the shared trace workspace for LLM calls, tool calls, token usage, costs, errors, timings, sessions, prompts, and evaluations.
2. A local forensic archive is the proof layer for exact request and response evidence that Langfuse or OpenTelemetry may normalize, truncate, filter, or remap.
3. The existing `usage_events` ledger remains the aggregate accounting layer, but it must link back to Langfuse traces and local forensic files.

The implementation must be opt-in by default. No production install should export prompts, tool results, or raw provider payloads unless an operator explicitly enables it.

## Canonical Docs Consulted

- AI SDK telemetry: https://ai-sdk.dev/docs/ai-sdk-core/telemetry
- AI SDK Langfuse observability integration: https://ai-sdk.dev/providers/observability/langfuse
- Langfuse Vercel AI SDK integration: https://langfuse.com/integrations/frameworks/vercel-ai-sdk
- Langfuse OpenTelemetry endpoint: https://langfuse.com/integrations/native/opentelemetry
- Langfuse SDK overview: https://langfuse.com/docs/observability/sdk/overview
- Langfuse MCP server: https://langfuse.com/docs/api-and-data-platform/features/mcp-server
- Langfuse for coding agents: https://langfuse.com/agents

## Current Architecture Snapshot

### AI SDK call ownership

- Main interactive and autonomous calls flow through `packages/agent-core/src/agent.ts`.
- `Agent.runStream` converts persisted `UIMessage[]` into AI SDK model messages with `uiToModelMessages`, builds the system prompt, resolves tools, then calls `streamText`.
- `Agent.runStream` already enables AI SDK telemetry:

```ts
experimental_telemetry: {
  isEnabled: true,
  functionId: opts.telemetryFunctionId ?? this.config.id,
  metadata: { sessionId: opts.sessionId },
}
```

- `onFinish` records aggregate `event.totalUsage` into the usage ledger. This gives per-turn aggregate usage, not per provider step.
- Compression summarization in `packages/agent-core/src/compression.ts` uses `generateText` and already enables telemetry with function id `compression-summarizer`.
- Structured subagent calls in `packages/agent-core/src/subagent.ts` use `generateObject` and enable telemetry.

### Provider HTTP ownership

- Provider construction is centralized in `packages/llm-provider/src/registry.ts`.
- OpenAI OAuth uses `createOpenAI({ fetch })`, rewrites the request body through `transformCodexOAuthBody`, injects OAuth headers, refreshes on 401, and logs the transformed outbound body.
- OpenAI API-key path currently does not install a custom `fetch`.
- Anthropic installs a custom `fetch` for OAuth/API-key switching, body transforms, sampling-parameter stripping, 401/429 retry behavior, and response transformation.
- OpenRouter installs a custom `fetch` to inject usage accounting and Anthropic cache-control markers.
- Google, Ollama, and custom providers do not currently install a forensic-capable fetch wrapper.

### Existing telemetry bootstrap

- `apps/cli/src/index.ts` and `packages/server/src/index.ts` import `@openacme/config/telemetry-bootstrap` at module load.
- `packages/config/src/telemetry-bootstrap.ts` is Logfire-specific:
  - Gate: `OPENACME_TELEMETRY=1`.
  - Required token: `LOGFIRE_TOKEN`.
  - Exporter: OTLP traces and logs to Logfire endpoints.
  - Auto-instrumentations: fetch/undici enabled, fs/dns/http disabled.
  - Default behavior: inert when env is absent.
- The bootstrap currently loads a repo-root `.env`, not the resolved `<dataDir>/.env`, because it runs before `loadConfig`.

### Tool call ownership

- `packages/tools/src/registry.ts` builds AI SDK tools and owns `execute`.
- It threads `toolCallId` through `toolCallContext`, dispatches local or worker tools, then applies `maybeSpill`.
- `packages/tools/src/spill.ts` writes large tool results under `<agentDir>/sessions/<sessionId>/tool-calls/` and returns a preview plus file pointer.
- AI SDK telemetry can emit `ai.toolCall` spans, but a forensic proof layer should capture pre-spill and post-spill tool result facts itself.

### Usage ledger ownership

- `packages/db/src/schema.ts` defines `usage_events`.
- `packages/db/src/stores/usage-store.ts` persists one usage row per completed LLM call or helper call.
- `usage_events` currently stores `steps`, but not per-step token rows, trace id, provider request ids, or forensic file paths.

## Target Architecture

```text
Agent runStream / helper call
  -> AI call context
     -> AI SDK telemetry spans
        -> Langfuse OTLP trace export
     -> provider fetch wrappers
        -> local forensic archive
     -> tool execute wrappers
        -> local forensic archive and OTel spans/events
  -> usage_events aggregate row
     -> links to Langfuse trace id and local forensic archive
```

### Langfuse trace layer

Purpose:

- Shared investigation UI for humans and agents.
- Agent-readable via Langfuse MCP/CLI/API.
- Searchable by `agentId`, `sessionId`, `taskId`, `messageId`, `usageEventId`, `forensicRunId`, provider, model, and kind.

Implementation target:

- Keep AI SDK telemetry enabled where it already exists.
- Add a Langfuse-compatible OTLP exporter path to the existing telemetry bootstrap.
- Prefer direct OTLP export to Langfuse first because the repo already depends on OpenTelemetry exporters and the package engine is `node >=18`.
- Do not add `@langfuse/otel` until a dependency spike confirms it does not force a runtime engine bump or conflicting OpenTelemetry SDK version. If direct OTLP traces render poorly as Langfuse generations, add the official Langfuse span processor in a later slice.

### Local forensic archive

Purpose:

- Byte-level or near-byte-level proof of what was sent and received.
- Resilient to Langfuse normalization, OTel attribute limits, sampling, mapping bugs, and UI truncation.
- Local-only by default, under the OpenAcme data directory.

Default path:

```text
<dataDir>/ai-forensics/YYYY-MM-DD/<forensicRunId>/
```

Suggested files per run:

```text
run.json
events.jsonl
provider-requests/<ordinal>-<provider>-<model>/request.pre-transform.body
provider-requests/<ordinal>-<provider>-<model>/request.post-transform.body
provider-requests/<ordinal>-<provider>-<model>/response.body
tool-calls/<toolCallId>/args.json
tool-calls/<toolCallId>/result.pre-spill.txt
tool-calls/<toolCallId>/result.post-spill.txt
```

The forensic archive should store hashes, byte counts, and redacted metadata in JSONL even when raw payload files are written separately.

### Correlation identifiers

Every layer should carry the same keys where available:

- `forensicRunId`: generated locally at the start of the agent/helper call.
- `traceId`: active OpenTelemetry trace id when available.
- `spanId`: active OpenTelemetry span id when available.
- `usageEventId`: the `usage_events.id` once recorded.
- `agentId`
- `sessionId`
- `messageId`
- `taskId`
- `kind`: `interactive`, `autonomous`, `extractor`, `title`, `selector`, etc.
- `provider`
- `model`
- `authMode`
- `providerRequestOrdinal`
- `providerRequestId`: extracted from provider response headers such as `x-request-id`, `openai-request-id`, or `request-id`.

## Configuration Contract

All names below are proposed implementation targets. Keep the final names consistent across config docs, tests, server launch, and CLI launch.

### Telemetry exporter

```bash
OPENACME_OBSERVABILITY=off|logfire|langfuse|otlp
OPENACME_TELEMETRY=1
OPENACME_TELEMETRY_SERVICE_NAME=openacme
```

Backwards compatibility:

- Existing `OPENACME_TELEMETRY=1` plus `LOGFIRE_TOKEN` must keep current Logfire behavior.
- `OPENACME_OBSERVABILITY=logfire` is the explicit form of the same behavior.
- `OPENACME_OBSERVABILITY=langfuse` enables Langfuse export.
- `OPENACME_OBSERVABILITY=otlp` exports to a generic OTLP HTTP endpoint.

Langfuse:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=http://localhost:3000
```

Derived OTLP target:

```text
${LANGFUSE_BASE_URL}/api/public/otel
```

Required OTLP header:

```text
Authorization: Basic base64("${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}")
x-langfuse-ingestion-version: 4
```

Generic OTLP:

```bash
OPENACME_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
OPENACME_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs
OPENACME_OTLP_HEADERS=key=value,key2=value2
```

### AI content capture controls

```bash
OPENACME_AI_TELEMETRY_RECORD_INPUTS=1
OPENACME_AI_TELEMETRY_RECORD_OUTPUTS=1
```

Rules:

- Defaults should remain privacy-conservative when an exporter is enabled manually.
- For a full forensic investigation profile, the runbook should set both to `1`.
- Tests must prove `recordInputs` and `recordOutputs` are explicitly passed to AI SDK calls from the resolved settings.

### Local forensic controls

```bash
OPENACME_AI_FORENSICS=1
OPENACME_AI_FORENSICS_CAPTURE_RAW=1
OPENACME_AI_FORENSICS_DIR=<dataDir>/ai-forensics
OPENACME_AI_FORENSICS_CAPTURE_HEADERS=redacted
OPENACME_AI_FORENSICS_RETENTION_DAYS=30
OPENACME_AI_FORENSICS_MAX_RUN_BYTES=0
```

Rules:

- `OPENACME_AI_FORENSICS=1` enables structured metadata capture.
- `OPENACME_AI_FORENSICS_CAPTURE_RAW=1` enables body files and streamed response files.
- `OPENACME_AI_FORENSICS_MAX_RUN_BYTES=0` means no per-run cap. Any nonzero value is a soft cap: record the truncation event, do not break the model call.
- Archive writes must be best-effort. A forensic write failure must not fail an agent turn.
- Archive directories should be mode `0700`; raw files should be mode `0600` where the platform supports it.

## Security Rules

Never write the following values in cleartext unless a future explicit break-glass mode is added:

- `Authorization`
- `x-api-key`
- `api-key`
- `cookie`
- `set-cookie`
- OAuth refresh tokens and access tokens
- Langfuse secret keys
- provider API keys

Default redaction:

- Replace secret header values with `[redacted:sha256:<hash>]`.
- Record whether the header was present.
- Hash `chatgpt-account-id` by default instead of storing it raw.
- Store request and response body hashes even when raw body capture is off.

Full raw body capture is explicitly sensitive. The runbook must state that enabling it can store prompts, tool results, customer data, internal files, and model outputs on disk.

## Milestone Review Protocol

At the end of every milestone:

1. Reopen this file.
2. Update the `Milestone Review Log`.
3. Record the exact commit SHA, tests run, failures, unresolved decisions, and whether the milestone was pushed.
4. Re-read the next milestone goal before starting implementation.
5. Do not open the next milestone if the current milestone's acceptance criteria are not met.

This file is the refresh point for future agents. Keep implementation state here, not only in chat.

## Milestones

### Milestone 0: Grounding and Plan

Goal:

- Establish the target architecture, branch baseline, risks, milestones, TDD sequence, and review protocol before code changes.

Scope:

- Confirm `origin/local-stage` has stabilized.
- Inspect existing AI SDK, telemetry, provider, tool, and usage-ledger seams.
- Create this plan file.

Tests first:

- Not applicable. This is the planning artifact.

Acceptance:

- Plan file exists on `local-stage`.
- Plan includes goals, slices, TDD gates, review protocol, and correlation strategy.

### Milestone 1: Observability Configuration and Bootstrap Refactor

Goal:

- Make telemetry backend selection explicit, idempotent, testable, and compatible with Langfuse while preserving current Logfire behavior.

Owned files:

- `packages/config/src/telemetry-bootstrap.ts`
- `packages/config/src/observability-config.ts` or equivalent new pure config module
- `packages/config/test/*observability*.test.ts`
- `packages/config/package.json`
- `apps/cli/src/index.ts`
- `packages/server/src/index.ts`
- docs/runbook file introduced later

Tests first:

1. `resolveObservabilityConfig` returns disabled config when all env is absent.
2. Existing `OPENACME_TELEMETRY=1` plus `LOGFIRE_TOKEN` resolves Logfire exactly as before.
3. `OPENACME_OBSERVABILITY=langfuse` requires `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL`.
4. Langfuse endpoint resolves to `${LANGFUSE_BASE_URL}/api/public/otel`.
5. Langfuse auth header is Basic auth over `public:secret` and includes `x-langfuse-ingestion-version=4`.
6. `OPENACME_OBSERVABILITY=otlp` accepts explicit OTLP endpoints and headers.
7. The initializer is idempotent. Calling it twice should not install two SDKs, two signal handlers, or double-wrap console methods.
8. The initializer can load `<dataDir>/.env` when called after `loadConfig`, without breaking the current repo-root `.env` dev path.

Implementation slices:

1. Extract pure env parsing and endpoint/header resolution into a testable module.
2. Refactor `telemetry-bootstrap.ts` into an idempotent initializer while keeping the existing side-effect import behavior.
3. Add a post-`loadConfig` initializer call in server and CLI startup so `<dataDir>/.env` credentials can work.
4. Keep Logfire logs exporter behavior for `logfire`; use traces-only first for Langfuse unless tests prove logs are safe and useful.

Acceptance:

- Existing Logfire tests or behavior remain intact.
- Langfuse OTLP config resolves without needing new runtime dependencies.
- `pnpm --filter @openacme/config test` passes.
- `pnpm --filter @openacme/server check-types` and `pnpm --filter @openacme/cli check-types` pass.

Review notes to capture:

- Which backend path was implemented: direct OTLP only, or Langfuse span processor.
- Any Node engine/dependency risk discovered.
- Whether side-effect import is still needed.

### Milestone 2: AI SDK Trace Metadata and Content Controls

Goal:

- Ensure every AI SDK call emits consistent searchable metadata and explicit input/output recording choices.

Owned files:

- `packages/agent-core/src/agent.ts`
- `packages/agent-core/src/compression.ts`
- `packages/agent-core/src/subagent.ts`
- `packages/agent-core/src/title.ts`
- `packages/agent-core/src/extractor.ts`
- `packages/agent-core/test/*telemetry*.test.ts`

Tests first:

1. `Agent.runStream` passes `agentId`, `sessionId`, `taskId`, `messageId`, `kind`, provider, model, and a generated `forensicRunId` in telemetry metadata.
2. `recordInputs` and `recordOutputs` reflect the resolved env/config values.
3. Autonomous, extractor, selector, title, compression summarizer, and structured subagent calls carry distinct `functionId` values and the same correlation key names.
4. Metadata values are primitives or primitive arrays accepted by AI SDK telemetry.
5. Existing usage reporting remains one aggregate row per call and still records `event.totalUsage`.

Implementation slices:

1. Introduce a shared helper for AI SDK telemetry settings so call sites do not drift.
2. Thread usage kind/task/message attribution into the helper from `runStream`.
3. Add forensic run id generation at call start.
4. Extend helper call sites for compression and subagent helpers.
5. Keep the implementation compatible with AI SDK v6's `experimental_telemetry`.

Acceptance:

- Focused agent-core tests pass.
- No behavior change when no exporter/forensics are enabled.
- Telemetry settings are explicit and centralized.

Review notes to capture:

- Full list of call sites covered.
- Any call sites intentionally deferred.

### Milestone 3: Forensic Context and Archive Core

Goal:

- Build the local forensic archive core without wiring it into providers yet.

Owned files:

- `packages/llm-provider/src/forensics-context.ts`
- `packages/llm-provider/src/forensics-recorder.ts`
- `packages/llm-provider/test/forensics-recorder.test.ts`
- `packages/llm-provider/src/index.ts`

Tests first:

1. Disabled mode returns a no-op recorder and writes no files.
2. Enabled metadata-only mode writes `run.json` and `events.jsonl` but no raw body files.
3. Raw mode writes body files and records byte counts plus SHA-256 hashes.
4. Header redaction removes secrets and records presence plus hash.
5. Directory and file permissions are restrictive where supported.
6. Write failures are caught, logged, and do not throw into the caller.
7. Concurrent forensic runs write to separate directories.
8. `forensicRunId` is stable for all records in a run.
9. Active OTel `traceId` and `spanId` are captured when a span exists; absence is handled cleanly.

Implementation slices:

1. Define `AIForensicContext` with agent/session/task/message/kind/provider/model/auth fields.
2. Add AsyncLocalStorage helpers: `enterAIForensicContext`, `getAIForensicContext`.
3. Implement `ForensicRecorder` interface with no-op and file-backed implementations.
4. Implement JSONL event writer and raw blob writer.
5. Implement redaction, hashing, file naming, and soft quota accounting.

Acceptance:

- `pnpm --filter @openacme/llm-provider test` passes.
- The recorder can be used without importing agent-core or tools, avoiding cycles.
- The core module has no provider-specific logic yet.

Review notes to capture:

- Final schema version for forensic JSON records.
- Any deviations from the proposed file layout.

### Milestone 4: Provider Fetch Forensics

Goal:

- Capture exact provider HTTP request and response evidence across OpenAI, Anthropic, OpenRouter, Google, Ollama, and custom providers.

Owned files:

- `packages/llm-provider/src/registry.ts`
- `packages/llm-provider/src/forensics-fetch.ts`
- `packages/llm-provider/test/forensics-fetch.test.ts`
- provider-specific transform tests if needed

Tests first:

1. A fake fetch with a string body records request metadata, redacted headers, body hash, and response metadata.
2. A fake streaming response records raw response bytes from a clone without consuming the original response body.
3. Fetch errors record an error event and rethrow the original error.
4. OpenAI OAuth records both pre-transform and post-transform bodies around `transformCodexOAuthBody`.
5. OpenAI OAuth 401 refresh records first attempt and retry attempt under the same provider request group.
6. OpenAI API-key path installs a custom fetch wrapper and records final request body.
7. Anthropic records OAuth/API-key request body after OAuth and sampling transforms, plus retry and entitlement fallback events.
8. OpenRouter records pre-injection and post-injection request bodies.
9. Google, Ollama, and custom providers record final provider requests without changing behavior.
10. No secret headers are written in cleartext.
11. Forensic write failure does not change fetch response behavior.

Implementation slices:

1. Implement `forensicFetch` wrapper that receives provider/model/auth metadata and optional transform labels.
2. Wrap OpenAI OAuth first because it is the currently highest-value path.
3. Wrap OpenAI API-key by supplying a custom fetch to `createOpenAI`.
4. Wrap Anthropic without disturbing retry, response transform, or 1M-context fallback behavior.
5. Wrap OpenRouter around usage/cache-control injection.
6. Wrap Google, Ollama, and custom providers for final-body capture.

Acceptance:

- Provider-focused tests pass.
- Existing provider behavior tests pass.
- Raw archive can answer: "what final HTTP body did this provider receive?"
- Original response streams remain readable by the AI SDK.

Review notes to capture:

- Providers fully covered.
- Any provider response body that cannot be cloned safely.
- Disk growth observed in streaming tests.

### Milestone 5: Agent Turn Snapshots and Context Propagation

Goal:

- Link the agent-level model input snapshot, AI SDK telemetry, provider fetches, and usage ledger under one forensic run.

Owned files:

- `packages/agent-core/src/agent.ts`
- `packages/agent-core/src/compression.ts`
- `packages/agent-core/src/subagent.ts`
- `packages/agent-core/test/*forensics*.test.ts`
- `packages/llm-provider/src/forensics-context.ts`

Tests first:

1. `Agent.runStream` enters forensic context before `streamText` and provider fetch wrappers can read it.
2. Context remains available while the stream is drained, not just during the initial `streamText` call.
3. Concurrent sessions do not cross-write context.
4. A model input snapshot records system prompt hash, model message hash, tool definition hash, and optionally raw JSON files when raw capture is enabled.
5. Compression summarizer and subagent helper calls get their own forensic run ids, linked to parent run ids when present.
6. The archive records model config, auth mode, max output tokens, stop condition label, and effective tool names.

Implementation slices:

1. Add forensic context entry in `Agent.runStream`.
2. Add context entry for `generateText` and `generateObject` helper call sites.
3. Add agent-level `run.start`, `model-input.snapshot`, and `run.finish` events.
4. Link parent/child forensic run ids for compression and subagent calls.
5. Add context propagation tests with fake provider fetches.

Acceptance:

- A single interactive turn creates one run archive plus provider request child records.
- Multi-step tool loops keep all provider requests in the same run archive.
- Subagent/helper calls are independently inspectable and linked.

Review notes to capture:

- Whether AsyncLocalStorage uses `enterWith` or `run`, and why.
- Any known concurrency limits.

### Milestone 6: Tool Call Forensics

Goal:

- Capture tool execution facts locally and in trace metadata so a forensic run can explain why token growth happened after each tool result.

Owned files:

- `packages/tools/src/registry.ts`
- `packages/tools/src/spill.ts`
- `packages/tools/src/session-context.ts`
- `packages/tools/test/*forensics*.test.ts`
- possibly `packages/llm-provider/src/forensics-context.ts` or a shared context module

Tests first:

1. Tool start records tool name, toolCallId, args hash, and args raw file when raw capture is enabled.
2. Tool finish records duration, pre-spill result hash/bytes, post-spill result hash/bytes, spill path if any, and error state.
3. Tool errors record error class/message and rethrow or return the same result as before.
4. `maybeSpill` behavior is unchanged.
5. Worker-dispatched tools still return exactly what they returned before.
6. Forensic failures do not break tool execution.

Implementation slices:

1. Add a narrow bridge that lets `packages/tools` write forensic events without creating an import cycle.
2. Record args before dispatch.
3. Record result before and after `maybeSpill` for local tools.
4. Record worker-dispatched results at the daemon boundary, with worker-side full capture deferred unless needed.
5. Add OTel span attributes/events for tool result size and spill path when a span is active.

Acceptance:

- A multi-step agent trace links each provider step to the tool outputs that inflated the next request.
- Large tool results are searchable by spill path and forensic event hash.

Review notes to capture:

- Whether worker-side full result capture was implemented or deferred.
- Tool result privacy implications.

### Milestone 7: Usage Ledger Correlation and Queryability

Goal:

- Make it easy for humans and agents to jump from aggregate token anomalies to Langfuse and local forensic evidence.

Owned files:

- `packages/db/src/schema.ts`
- `packages/db/src/stores/usage-store.ts`
- `packages/db/drizzle/*`
- `packages/db/test/usage-store.test.ts`
- `packages/agent-core/src/types.ts`
- `packages/server/src/agent-manager.ts`
- `packages/server/src/routes/usage.ts`
- `apps/web/app/usage/*` only if UI linkage is in scope for this milestone

Tests first:

1. New usage rows can store `traceId`, `forensicRunId`, `forensicPath`, and provider request count.
2. Existing DBs migrate cleanly with nullable columns.
3. Usage totals and breakdowns are unchanged.
4. Usage API includes correlation fields for detail/drilldown endpoints without bloating aggregate charts.
5. If a forensic archive is disabled, usage rows remain valid with null correlation fields.

Implementation slices:

1. Add nullable correlation columns to `usage_events`.
2. Thread correlation fields through `UsageReport`.
3. Record correlation in `Agent.reportUsage`.
4. Add a detail query or route that returns correlation fields for suspicious rows.
5. Optionally add a small UI link to local forensic path and Langfuse trace id.

Acceptance:

- The earlier 4M-token style investigation can start with SQL and resolve to the precise trace/archive path.
- Existing usage dashboard behavior remains unchanged.

Review notes to capture:

- Migration id.
- Whether UI drilldown was included or deferred.

### Milestone 8: Langfuse Agent Access Runbook

Goal:

- Document how humans and agents use Langfuse plus local files to investigate AI interactions.

Owned files:

- `docs/ai-forensics.md`
- maybe `docs/self-hosting.mdx` or docs app content if public docs are desired
- maybe `.env.example` if the repo has or adds one

Tests first:

- Documentation checks are manual unless the docs app has a markdown build check.

Implementation slices:

1. Document Langfuse self-host setup and expected URL.
2. Document env vars for Langfuse OTLP export.
3. Document env vars for local forensic archive.
4. Document Langfuse MCP setup for agents.
5. Document query workflow:
   - find suspicious `usage_events` row
   - open Langfuse trace
   - open local forensic run
   - inspect provider request ordinal
   - map tool result to next provider request
6. Document security warnings and cleanup.

Acceptance:

- A new agent can follow the doc to inspect traces without chat history.
- A human can enable forensics, run one turn, find the archive, and open the Langfuse trace.

Review notes to capture:

- Exact local Langfuse version tested.
- Whether MCP was tested against local or cloud Langfuse.

### Milestone 9: Retention, Cleanup, and Operational Safety

Goal:

- Keep full forensic capture usable without unbounded disk growth or accidental leakage.

Owned files:

- `packages/llm-provider/src/forensics-recorder.ts`
- `packages/server/src/agent-manager.ts` or startup cleanup owner
- CLI command files if a purge command is added
- tests for retention sweep

Tests first:

1. Retention sweep deletes runs older than configured days.
2. Sweep preserves active or current-day runs.
3. Sweep handles missing/corrupt run directories.
4. Manual purge command or internal API refuses broad destructive paths outside the forensics root.
5. Quota events are recorded and model calls continue.

Implementation slices:

1. Add startup sweep matching existing tool spill cleanup style.
2. Add optional CLI/status visibility: root path, run count, total bytes, oldest run.
3. Add manual purge if needed.
4. Add docs update.

Acceptance:

- Enabling raw capture for long-running agents has a cleanup story.
- Cleanup cannot delete outside the configured forensics root.

Review notes to capture:

- Final retention default.
- Whether manual purge exists.

### Milestone 10: End-to-End Validation

Goal:

- Prove the full stack works against a local or test Langfuse instance and a fake provider without sending real secrets.

Owned files:

- e2e test support under `packages/server/test/e2e/support`
- possibly a local fixture model/server
- docs updates

Tests first:

1. Fake provider emits a streaming response with tool-call-like chunks.
2. One agent turn produces:
   - Langfuse-compatible OTel spans
   - local forensic run archive
   - usage event with correlation fields
3. A multi-step turn shows provider request ordinal growth.
4. Disabling forensics removes archive writes but preserves normal operation.
5. Disabling observability removes external export but preserves local forensics if enabled.

Implementation slices:

1. Add local fake provider tests for provider fetch capture.
2. Add integration test with one tool call and one follow-up model request.
3. Add optional manual verification against local Langfuse.
4. Record exact commands and expected artifacts in docs.

Acceptance:

- The final review log includes focused tests, typechecks, and manual Langfuse validation if available.
- The implementation can answer:
  - What exact request body was sent?
  - Which tool result caused the next request to grow?
  - Which provider request id failed?
  - Which usage row does this trace belong to?
  - Which local archive should an agent inspect?

Review notes to capture:

- Local Langfuse URL and project tested.
- Any provider-specific limitations.

## Non-Goals

- Do not replace `usage_events` with Langfuse.
- Do not make Langfuse mandatory for normal OpenAcme operation.
- Do not export raw request/response bodies by default.
- Do not store provider auth secrets in forensic files.
- Do not change model selection, OAuth semantics, body transforms, retry semantics, compression behavior, or tool spill behavior except where explicitly scoped.
- Do not build prompt management or evaluations until the trace and forensic foundation is complete.

## Open Design Risks

### Langfuse span processor vs direct OTLP

Direct OTLP is lower risk for this repo because OpenTelemetry exporters already exist and the package currently supports `node >=18`. Langfuse's official JS/TS SDK and span processor may give better Langfuse-native generation mapping, but must be dependency-checked before adoption.

Decision for first implementation:

- Implement direct OTLP Langfuse export first.
- Validate trace rendering.
- Add `@langfuse/otel` only if direct OTLP is insufficient and engine compatibility is acceptable.

### AsyncLocalStorage lifetime during streamed AI SDK calls

`Agent.runStream` returns a stream result. Provider calls may occur as the returned stream is consumed. A naive `AsyncLocalStorage.run(() => streamText(...))` may not cover the whole stream lifecycle.

Decision for first implementation:

- Write tests that prove provider fetch wrappers see the forensic context while the stream is drained.
- Use the narrowest context mechanism that passes the test.
- Document the final choice in the review log.

### Response clone cost

Capturing raw streamed provider responses likely requires `Response.clone()` and reading the clone. This may increase memory/disk/CPU load for very large streams.

Decision for first implementation:

- Use clone-based capture only when `OPENACME_AI_FORENSICS_CAPTURE_RAW=1`.
- Record body hashes and metadata in metadata-only mode.
- Keep write failures and archive lag isolated from model response delivery.

### Sensitive local archives

Full forensics will store prompts, tool outputs, and model outputs. That is the point of the feature, but it changes the data classification of `<dataDir>/ai-forensics`.

Decision for first implementation:

- Explicit opt-in.
- Restrictive file permissions.
- Clear docs and purge path.

## Suggested Validation Commands

Run the narrowest tests for each slice first:

```bash
pnpm --filter @openacme/config test
pnpm --filter @openacme/llm-provider test
pnpm --filter @openacme/agent-core test
pnpm --filter @openacme/tools test
pnpm --filter @openacme/db test
pnpm --filter @openacme/server test
```

Then typecheck affected packages:

```bash
pnpm --filter @openacme/config check-types
pnpm --filter @openacme/llm-provider check-types
pnpm --filter @openacme/agent-core check-types
pnpm --filter @openacme/tools check-types
pnpm --filter @openacme/db check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/cli check-types
```

End-to-end validation should be added only when the unit/integration slices prove the seams.

## Milestone Review Log

### Milestone 0 Review

Status: completed

Date: 2026-07-25

Branch baseline: `local-stage` at `5bf7275`

What changed:

- Added this planning artifact.

Validation:

- Confirmed `origin/local-stage` and local `local-stage` both resolve to `5bf7275`.
- Confirmed clean checkout at `worktrees/local-stage`.
- Reviewed current `agent-core`, `llm-provider`, `tools`, `config`, `server`, and `db` seams.
- Consulted current Langfuse and AI SDK telemetry docs.

Residual blockers:

- None for planning.
- Implementation must start with Milestone 1 tests.

Commit:

- Not created as part of this planning pass unless explicitly requested.

Pushed:

- No.

### Milestone 1 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/config/src/observability-config.ts` with explicit `off`, `logfire`, `langfuse`, and `otlp` resolution.
- Preserved legacy `OPENACME_TELEMETRY=1` plus `LOGFIRE_TOKEN` behavior.
- Refactored `packages/config/src/telemetry-bootstrap.ts` into an idempotent initializer while keeping side-effect import behavior.
- Added post-`loadConfig` initialization in `packages/server/src/index.ts` and terminal `chatCommand` so data-dir `.env` telemetry settings can activate.

Validation:

- First test run failed on the missing `observability-config` module, as expected for TDD.
- `pnpm --filter @openacme/config test`
- `pnpm --filter @openacme/config check-types`
- `pnpm --filter @openacme/config build`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/cli check-types`

Residual blockers:

- None for Milestone 1.
- Downstream package typechecks read generated config `dist` declarations, so `@openacme/config` must be built after telemetry subpath source changes before focused downstream typechecks.

Commit:

- Not created.

Pushed:

- No.

### Milestone 2 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/agent-core/src/telemetry.ts` to centralize AI SDK telemetry settings.
- Added conservative defaults for AI SDK content capture: inputs and outputs are off unless explicitly enabled by `OPENACME_AI_TELEMETRY_RECORD_INPUTS` / `OPENACME_AI_TELEMETRY_RECORD_OUTPUTS`.
- Added `forensicRunId`, agent/session/task/message/kind, provider/model/auth metadata to main `runStream` calls.
- Routed pre-compaction memory flush, compression summarizer, and structured subagent calls through the shared helper.

Validation:

- First focused test run failed on the missing `telemetry` module, as expected for TDD.
- `pnpm --filter @openacme/agent-core test -- test/telemetry.test.ts test/agent-telemetry.test.ts`
- `pnpm --filter @openacme/agent-core test -- test/agent-compress.test.ts test/agent-preflight.test.ts test/subagent.test.ts test/telemetry.test.ts test/agent-telemetry.test.ts`
- `pnpm --filter @openacme/agent-core check-types`

Residual blockers:

- None for Milestone 2.
- Compression summarizer telemetry has session/model/kind metadata but no parent forensic link yet; that is intentionally deferred to the forensic context milestones.

Commit:

- Not created.

Pushed:

- No.

### Milestone 3 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/llm-provider/src/forensics-context.ts` with AsyncLocalStorage-backed AI forensic context.
- Added `packages/llm-provider/src/forensics-recorder.ts` with disabled/no-op mode, metadata-only mode, raw-file mode, SHA-256 hashes, redacted headers, restrictive file permissions, write-failure isolation, and active OTel trace/span capture.
- Exported forensic context and recorder APIs from `@openacme/llm-provider`.
- Added `@opentelemetry/api` as a direct dependency of `@openacme/llm-provider` because this package now imports it directly.

Validation:

- First focused test run failed on missing forensic modules, as expected for TDD.
- `pnpm --filter @openacme/llm-provider test -- test/forensics-recorder.test.ts`
- `pnpm --filter @openacme/llm-provider test`
- `pnpm --filter @openacme/llm-provider check-types`

Residual blockers:

- `pnpm install --offline` could not update links because the workspace install tries to resolve an unrelated `apps/web` package missing from the local metadata cache. For local validation only, a node_modules symlink was created to the already-present `@opentelemetry/api@1.9.0` store entry. Source dependency declaration is present in `packages/llm-provider/package.json`; a normal install with registry metadata should update the lock/link cleanly.
- Provider fetch wiring is not included in Milestone 3 by design.

Commit:

- Not created.

Pushed:

- No.

### Milestone 4 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/llm-provider/src/forensics-fetch.ts`.
- `forensicFetch` records provider request metadata, redacted headers, request hashes, optional pre-transform/final raw request files, response status/headers/provider request id, response hashes, optional raw response files, and fetch errors.
- Wrapped OpenAI OAuth, OpenAI API-key, Anthropic, OpenRouter, Google, Ollama, and custom provider factory fetch paths in `packages/llm-provider/src/registry.ts`.
- Preserved existing OpenAI/Anthropic/OpenRouter body transforms, retries, and response transforms; recording happens around the actual fetch attempts.

Validation:

- First focused test run failed on missing `forensics-fetch` module, as expected for TDD.
- `pnpm --filter @openacme/llm-provider test -- test/forensics-fetch.test.ts`
- `pnpm --filter @openacme/llm-provider test`
- `pnpm --filter @openacme/llm-provider check-types`

Residual blockers:

- Provider-specific registry behavior is covered by typecheck and existing provider tests, plus generic fetch wrapper tests. No live provider request was sent in this milestone.
- Agent-level context propagation is not included here by design; without Milestone 5, provider fetches can record but will not yet be tied cleanly to the agent run.

Commit:

- Not created.

Pushed:

- No.

### Milestone 5 Review

Status: completed

Date: 2026-07-25

What changed:

- Added agent-run forensic context propagation from `Agent.runStream` into `@openacme/llm-provider`.
- Added `setAIForensicContext` for the long-lived async execution path used by AI SDK streaming callbacks and provider fetches.
- `Agent.runStream` now records `agent.run.start`, `agent.model_input.snapshot`, `agent.run.finish`, and `agent.run.error` events under the same `forensicRunId` used by AI SDK telemetry metadata.
- Raw forensic mode now persists the exact model input surface for a turn: system prompt, final UI message array, and tool-name snapshot. Metadata-only mode still records byte counts and SHA-256 hashes.
- Updated stale agent-core provider mocks so existing focused unit tests stay isolated from file-backed forensic IO.

Validation:

- First focused test run failed on missing context propagation and forensic files, as expected for TDD.
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts test/agent-telemetry.test.ts test/telemetry.test.ts test/agent-compress.test.ts test/agent-preflight.test.ts test/subagent.test.ts test/selector.test.ts`
- `pnpm --filter @openacme/agent-core check-types`

Residual blockers:

- `setAIForensicContext` uses AsyncLocalStorage `enterWith` because `runStream` returns an AI SDK stream whose provider work occurs after the function returns. This matches the existing long-lived context pattern used elsewhere in agent-core, but it means future concurrent run tests should stay part of the forensic coverage.
- Tool execution payload forensics is not included in Milestone 5; model-input and provider-wire forensics are now connected.

Commit:

- Not created.

Pushed:

- No.

### Milestone 6 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/tools/src/forensics.ts`, a narrow binding layer that lets agent-core connect tool execution forensics to the llm-provider recorder without adding a tools -> llm-provider dependency.
- Bound the tools forensic sink from `packages/agent-core/src/agent.ts` to `createForensicRecorder()`.
- Added `maybeSpillWithMetadata` while preserving the existing `maybeSpill` return contract.
- Instrumented `ToolRegistry.getVercelTools().execute` and direct `dispatch()` to record `tool.start`, `tool.finish`, and `tool.error` events.
- Tool events include tool name, toolset, toolCallId, runtime, args byte/hash, pre/post spill result byte/hash, spill path, worker-dispatch marker, duration, and optional raw files under `tool-calls/<toolCallId>/`.
- Restored the previous active `toolCallId` after each tool execution rather than always clearing it.

Validation:

- First focused test run failed on missing `packages/tools/src/forensics.ts`, as expected for TDD.
- `pnpm --filter @openacme/tools test -- test/forensics.test.ts`
- `pnpm --filter @openacme/tools test -- test/forensics.test.ts test/spill.test.ts test/tool-host-routing.test.ts test/registry-order.test.ts`
- `pnpm --filter @openacme/tools check-types`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts test/agent-telemetry.test.ts test/telemetry.test.ts test/agent-compress.test.ts test/agent-preflight.test.ts test/subagent.test.ts test/selector.test.ts`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/tools test`

Residual blockers:

- Worker-dispatched tools are fully recorded at the daemon boundary: args before dispatch and returned result after worker spill. Worker-side pre-spill full capture is deferred because the worker process should not need a direct llm-provider dependency for this slice.
- The failure-isolation test intentionally emits warning logs from the fake failing forensic sink.

Commit:

- Not created.

Pushed:

- No.

### Milestone 7 Review

Status: completed

Date: 2026-07-25

What changed:

- Added nullable `usage_events` correlation columns: `trace_id`, `span_id`, `forensic_run_id`, `forensic_path`, and `provider_request_count`.
- Generated migration `0012_dear_chronomancer` plus the corresponding drizzle snapshot and journal entry.
- Added lookup indexes for `trace_id` and `forensic_run_id`.
- Extended `UsageEventInput`, `UsageEventRow`, `createUsageStore().record()`, and `listEvents()` row mapping.
- Extended `UsageReport` and the server usage sink so persisted rows can link to Langfuse traces and local forensic archives.
- `Agent.runStream` now records `forensicRunId`, `forensicPath`, and active OTel trace/span ids when available.
- Compression summarizer, memory flush, and structured subagent usage reports now carry their generated `forensicRunId` where available.
- Updated the web usage row mirror type for `/api/usage/events`.

Validation:

- First focused db test run failed on missing correlation fields, as expected for TDD.
- First focused agent test run failed on missing usage-report forensic fields, as expected for TDD after fixing the mock AI SDK step shape.
- `pnpm --filter @openacme/db db:generate`
- `pnpm --filter @openacme/db test -- test/usage-store.test.ts`
- `pnpm --filter @openacme/llm-provider test -- test/forensics-recorder.test.ts`
- `pnpm --filter @openacme/llm-provider check-types`
- `pnpm --filter @openacme/llm-provider build`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts`
- `pnpm --filter @openacme/db check-types`
- `pnpm --filter @openacme/db build`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts test/agent-telemetry.test.ts test/telemetry.test.ts test/agent-compress.test.ts test/agent-preflight.test.ts test/subagent.test.ts test/selector.test.ts`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/agent-core build`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter web check-types`
- `pnpm --filter @openacme/db test`

Residual blockers:

- `provider_request_count` is storage-ready but currently null unless a caller supplies it. Provider fetches record per-request events in the local archive, but there is not yet a shared per-run counter exposed back to the usage report.
- Usage rows link to the local archive by `forensic_path`; the archive does not yet write the final `usageEventId` back into `events.jsonl`.

Commit:

- Not created.

Pushed:

- No.

### Milestone 8 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `docs/ai-forensics.md` as the operational runbook for humans and agents.
- Documented local forensic env vars, Langfuse OTLP env vars, AI SDK content capture controls, archive layout, database drilldown SQL, agent investigation workflow, test-env smoke expectations, and security warnings.
- Documented that full raw capture can store prompts, tool outputs, customer data, internal files, and model responses.

Validation:

- Manual documentation review against the implemented env names, archive paths, event names, and usage correlation columns.

Residual blockers:

- No docs build was available under the root `docs/` folder. The runnable docs app is separate under `apps/docs`; this runbook is a repository-level markdown file.
- Local Langfuse UI/MCP validation was not run in this milestone; direct OTLP config is covered by config tests.

Commit:

- Not created.

Pushed:

- No.

### Local Test Environment Smoke Review

Status: completed

Date: 2026-07-25

What changed:

- Ran a local no-network smoke against `/Users/alenbohcelyan/.openacme-test`.
- Created a forensic archive with a fake provider fetch and a local tool execution:
  `/Users/alenbohcelyan/.openacme-test/ai-forensics/2026-07-25/smoke-1784988934419`.
- Created a usage ledger smoke row in `/Users/alenbohcelyan/.openacme-test/state.db`:
  `smoke-usage-1784990556039`.
- Manually added the `packages/llm-provider` direct dependency entry for `@opentelemetry/api@1.9.0` to `pnpm-lock.yaml` because `pnpm install` could not complete due an unrelated cached `apps/web` dependency resolution issue.

Validation:

- Fake provider request wrote `provider.request` and `provider.response` events plus raw request/response files.
- Provider `authorization` header was redacted in `events.jsonl`.
- Local tool execution wrote `tool.start` and `tool.finish` events plus raw args, pre-spill result, and post-spill result files.
- Forensic run directory mode was `0700`; `run.json` and `events.jsonl` modes were `0600`.
- Usage smoke row round-tripped `traceId`, `forensicRunId`, `forensicPath`, and `providerRequestCount`.
- No live provider request was sent.

Residual blockers:

- This smoke did not validate a live Langfuse UI because no local Langfuse instance or credentials were configured in the test environment.
- This smoke used the package `dist` output, so affected packages were built before running it.

Commit:

- Not created.

Pushed:

- No.

### Final Validation Pass

Status: completed

Date: 2026-07-25

Validation:

- `pnpm --filter @openacme/config test`
- `pnpm --filter @openacme/llm-provider test`
- `pnpm --filter @openacme/tools test`
- `pnpm --filter @openacme/db test`
- `pnpm --filter @openacme/agent-core test`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter web check-types`

Notes:

- The test suite intentionally emitted warning logs in failure-isolation tests for malformed config fixtures, spill write failure fixtures, forensic recorder initialization failure, and fake forensic sink failure. The assertions passed.
- No commit was created and nothing was pushed.

## Production Telemetry Hardening Plan

Date: 2026-07-25

Status: active

Objective:

- Promote the current Langfuse plus local forensic foundation into a production-grade AI telemetry layer without changing agent behavior, prompt content, model selection, provider transforms, retries, tool semantics, spill behavior, or user-facing workflows.
- Make every AI interaction reconstructable from one trace id, one usage row, and one local forensic run id.
- Keep all telemetry and forensic failures best-effort, bounded, and isolated from the app path.

Canonical docs refreshed for this hardening pass:

- Langfuse OpenTelemetry endpoint and v4 ingestion header: https://langfuse.com/integrations/native/opentelemetry
- Langfuse v4 custom ingestion migration checklist: https://langfuse.com/integrations/native/opentelemetry/migration-to-v4
- AI SDK telemetry lifecycle, content capture, and integration hooks: https://ai-sdk.dev/docs/ai-sdk-core/telemetry
- OpenTelemetry JavaScript manual instrumentation: https://opentelemetry.io/docs/languages/js/instrumentation/
- OpenTelemetry exception recording semantics: https://opentelemetry.io/docs/specs/otel/trace/exceptions/

Non-negotiable exception-handling contract:

- Telemetry setup failure must disable or degrade telemetry, not startup.
- Span creation, attribute setting, event emission, exception recording, span ending, metric recording, log correlation, local file writes, purge scans, and status probes must not throw into the agent/tool/provider path.
- If application code throws, telemetry may record the exception and set error status, but must rethrow the original error object.
- If telemetry code itself throws before app code starts, run the app code without telemetry.
- If telemetry code throws after app code starts, do not execute app code twice.
- Raw forensic writes remain opt-in and quota-bounded. Quota, permission, serialization, clone, and disk errors are recorded where possible and swallowed.
- No secret value may be emitted as an OTel attribute, baggage item, log field, metric label, local JSONL field, or raw-path component.

Production gaps to close:

1. No explicit OpenAcme root span that owns the complete agent turn lifetime.
2. Langfuse v4 trace-level attributes are not propagated to all spans.
3. Helper AI calls can produce usage `forensicRunId`s without matching provider forensic context.
4. Provider fetches have local-file evidence but not manual provider attempt spans.
5. Tool calls have local-file evidence but not OpenTelemetry span events/attributes for spill and size facts.
6. `provider_request_count` is not populated from the provider wrapper.
7. Usage rows are not written back into the local forensic archive after persistence.
8. Error, abort, and partial-turn telemetry is incomplete.
9. No OTel metrics for tokens, latency, provider requests, tool result growth, compression, errors, retries, or forensic write failures.
10. No operator status endpoint that reports current observability backend, export config, forensic root, recent runs, and disk usage.
11. Log correlation is limited and not explicitly trace-aware for Langfuse mode.
12. Retention exists only as planned behavior, not executable cleanup.
13. No per-step usage table for deep token accounting across multi-step turns.
14. No production sampling/exporter policy.
15. No live Langfuse canary proving trace hierarchy, v4 filterability, and archive/usage correlation.

### Production Slice 1: Trace Topology and Hardened Span Utility

Goal:

- Add a reusable OpenAcme OpenTelemetry span utility and wrap `Agent.runStream` in a long-lived `openacme.agent.turn` root span.

Owned files:

- `packages/llm-provider/src/observability.ts`
- `packages/llm-provider/src/index.ts`
- `packages/llm-provider/test/observability.test.ts`
- `packages/agent-core/src/agent.ts`
- `packages/agent-core/test/agent-forensics.test.ts`

Tests first:

1. Starting a span returns trace/span ids and runs callbacks inside that active span context.
2. Attribute setting tolerates unsupported, undefined, null, object, array, and throwing values by sanitizing or dropping them.
3. Recording an app exception sets error status, records the exception, and rethrows the same error object.
4. If span setup fails before app code starts, the callback still runs exactly once without telemetry.
5. If app code starts and throws, telemetry cleanup does not cause the callback to run twice.
6. `Agent.runStream` records `traceId` and root `spanId` from `openacme.agent.turn` into `usage_events` reports.
7. `agent.run.error` records upstream errors without suppressing caller error handling.

Implementation slices:

1. Add a small span handle API in `llm-provider` because that package already owns forensic context and imports `@opentelemetry/api`.
2. Keep the API dependency-light: use only `@opentelemetry/api`, not SDK-specific test or runtime classes.
3. Add safe attribute sanitization and safe span lifecycle wrappers.
4. Use the span handle in `Agent.runStream`; start before `streamText`, keep active through AI SDK async work, and end on finish/error.
5. Report the root trace/span ids to the usage ledger and local forensic events.

Acceptance:

- Focused `llm-provider` observability tests pass.
- Focused `agent-core` forensic tests pass.
- Typecheck passes for `llm-provider` and `agent-core`.
- No prompt, model, provider, retry, tool, or spill logic changes.

Review fields:

- Final span names and key attributes.
- Exact validation commands.
- Whether the root span end path is `onFinish`, `onError`, synchronous throw, or fallback.
- Residual concurrency or streaming lifecycle risk.

### Production Slice 2: Langfuse v4 Attribute Propagation

Goal:

- Make session, agent, task, message, forensic, environment, release, version, and tags filterable on every Langfuse observation.

Tests first:

1. Root span receives `langfuse.trace.name`, `langfuse.session.id`, `langfuse.trace.metadata.*`, `langfuse.release`, `langfuse.version`, and `langfuse.trace.tags` where configured.
2. Child spans created under the root receive the same filter-critical attributes.
3. Sensitive values are rejected from baggage and attributes.

Implementation slices:

1. Add a safe trace-attribute builder shared by AI SDK metadata and manual spans.
2. Add baggage propagation only for non-sensitive, low-cardinality values.
3. Add a `BaggageSpanProcessor` or local equivalent in telemetry bootstrap if dependency shape permits; otherwise use explicit attribute application at manual span boundaries.

### Production Slice 3: Helper AI Context Completion

Goal:

- Ensure compression, memory flush, structured subagent, selector, extractor, and title helper AI calls create matching forensic context, trace span, and usage correlation.

Tests first:

1. Helper usage rows have the same `forensicRunId` that provider fetches use.
2. Parent agent turn id is recorded as `parentForensicRunId` when a helper runs inside a turn.
3. Helper failures record error spans/events and preserve existing fallback behavior.

### Production Slice 4: Provider Attempt Spans and Counts

Goal:

- Emit `openacme.provider.request` spans around every provider fetch attempt and populate `provider_request_count`.

Tests first:

1. Each provider attempt span includes provider/model/auth/ordinal/status/request id/body byte counts/hashes.
2. Retries and fallback attempts increment ordinal under the same forensic run.
3. Provider span exceptions rethrow the original fetch error.
4. Usage reports receive the final provider request count.

### Production Slice 5: Tool Execution Spans

Goal:

- Emit `openacme.tool.execute` spans/events for tool start, result growth, spill, worker dispatch, and error facts.

Tests first:

1. Successful tools set result byte/hash/spill attributes without changing outputs.
2. Tool errors set error status and preserve existing throw-or-error-JSON behavior.
3. Forensic sink failures and OTel failures do not break tool calls.

### Production Slice 6: Usage Finalization and Per-Step Detail

Goal:

- Close the loop from usage row to forensic archive and add per-step detail storage for multi-step investigations.

Tests first:

1. After usage persistence, `usageEventId` is appended to the run archive.
2. Per-step rows store step ordinal, provider request ordinal(s), usage, latency, finish reason, and trace/span ids.
3. Existing aggregate usage queries remain unchanged.

### Production Slice 7: Metrics

Goal:

- Emit OTel metrics for token volume, estimated/requested context size, provider latency/errors/retries, tool result sizes, spill counts, compression activity, cost, and forensic write failures.

Tests first:

1. Metrics are no-op when no meter provider is configured.
2. Recording failure does not affect app code.
3. Labels are bounded and non-sensitive.

### Production Slice 8: Operator Status and Health

Goal:

- Add an operator-visible observability status surface for humans and agents.

Tests first:

1. Status reports backend, enabled flags, endpoints redacted, local forensic root, disk usage, retention setting, recent run ids, and last known exporter init state.
2. Secrets are redacted.
3. Status failure returns degraded diagnostics, not a 500 where avoidable.

### Production Slice 9: Retention and Security Hardening

Goal:

- Implement forensic retention/purge, raw-capture denylist controls, and operator warnings.

Tests first:

1. Sweep deletes only eligible forensic runs inside the configured root.
2. Path traversal and symlink escape attempts are rejected.
3. Raw capture can be disabled per provider/tool pattern.

### Production Slice 10: Live Langfuse Canary

Goal:

- Prove a multi-step turn in the test environment creates a complete Langfuse v4 trace, usage row, and local forensic archive.

Tests first:

1. Local/test Langfuse receives the root span and AI SDK child spans.
2. Filter-critical attributes work in Langfuse.
3. Trace id, usage row, provider request count, and local archive match.

### Production Slice 1 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/llm-provider/src/observability.ts` with `startOpenAcmeSpan`, `withOpenAcmeSpan`, and `sanitizeSpanAttributes`.
- The span helper uses only `@opentelemetry/api`; no SDK-specific runtime dependency was introduced.
- Span attributes are sanitized to supported primitive/primitive-array OTel values; null/undefined/object/mixed/NaN values are dropped; sensitive-looking keys are redacted; reserved Langfuse/prototype-pollution path segments are dropped.
- Telemetry setup/context/attribute/event/exception/status/end failures are swallowed and logged best-effort.
- App exceptions are recorded on the span, marked ERROR, and rethrown as the original object.
- `Agent.runStream` now starts an `openacme.agent.turn` span around forensic setup and `streamText`.
- `agent.run.start`, `agent.run.finish`, and `agent.run.error` events include root trace/span ids when available.
- Usage reports now prefer the root agent-turn `traceId`/`spanId`, falling back to the active child span only if the root ids are unavailable.
- Existing agent-core tests with manual `@openacme/llm-provider` mocks were updated with inert span handles.

Final span names and key attributes:

- Root span: `openacme.agent.turn`.
- OpenAcme attributes: `openacme.span.type`, `openacme.ai.function_id`, `openacme.forensic.run_id`, `openacme.agent.id`, `openacme.session.id`, `openacme.task.id`, `openacme.message.id`, `openacme.usage.kind`, `openacme.provider`, `openacme.model`, `openacme.auth_mode`.
- Langfuse attributes on the root span: `langfuse.trace.name`, `langfuse.session.id`, `langfuse.trace.metadata.forensic_run_id`, `langfuse.trace.metadata.agent_id`, `langfuse.trace.metadata.task_id`, `langfuse.trace.metadata.message_id`, `langfuse.trace.metadata.kind`, `langfuse.trace.metadata.provider`, `langfuse.trace.metadata.model`, `langfuse.trace.metadata.auth_mode`.

Validation:

- `pnpm --filter @openacme/llm-provider test -- test/observability.test.ts`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts test/agent-telemetry.test.ts test/agent-compress.test.ts test/agent-preflight.test.ts test/subagent.test.ts test/selector.test.ts`
- `pnpm --filter @openacme/llm-provider check-types`
- `pnpm --filter @openacme/llm-provider build`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/llm-provider test`
- `pnpm --filter @openacme/agent-core test`
- `pnpm --filter @openacme/agent-core build`
- `pnpm --filter @openacme/server check-types`
- `git diff --check`

Notes:

- `llm-provider` observability failure-isolation tests intentionally emitted warning logs for mocked OTel startup and context activation failures.
- Existing failure-path tests still intentionally emit warning logs for malformed fixtures and simulated component failures.
- `@openacme/llm-provider` had to be rebuilt before `@openacme/agent-core check-types` because downstream packages consume generated workspace declarations.

Residual blockers:

- Root span closure is complete for successful `onFinish`, synchronous `streamText` throws, and stream `onError`. Stream `onError` schedules a delayed best-effort close so `onFinish` can still attach usage if it arrives shortly after the error.
- Langfuse v4 attribute propagation to every child span is not included in this slice; that remains Production Slice 2.
- Helper AI forensic context completion, provider attempt spans, tool spans, provider request counts, usage finalization, metrics, health/status, retention, and live Langfuse canary remain later slices by design.

Commit:

- Not created.

Pushed:

- No.

### Production Slice 2 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `packages/config/src/langfuse-baggage-span-processor.ts`.
- Langfuse mode installs a custom span processor that copies safe `langfuse.*` baggage entries onto every started SDK span.
- `packages/config/src/telemetry-bootstrap.ts` now uses explicit `spanProcessors`, preserving OTLP export with `BatchSpanProcessor(traceExporter)`.
- Added direct `@opentelemetry/sdk-trace-base` dependency to `packages/config`.
- `startOpenAcmeSpan` now seeds safe `langfuse.*` root attributes into active OTel baggage.

Validation:

- `pnpm --filter @openacme/llm-provider test -- test/observability.test.ts`
- `pnpm --filter @openacme/config test -- test/langfuse-baggage-span-processor.test.ts`
- `pnpm --filter @openacme/config check-types`
- `pnpm --filter @openacme/config test`
- `pnpm --filter @openacme/config build`
- `pnpm --filter @openacme/llm-provider check-types`
- `pnpm --filter @openacme/llm-provider build`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/cli check-types`
- `pnpm --filter @openacme/llm-provider test`
- `pnpm --filter @openacme/agent-core build`
- `git diff --check`

Notes:

- Local validation required a symlink for `packages/config/node_modules/@opentelemetry/sdk-trace-base` because a full `pnpm install` was not run. The package declaration and lockfile importer are the durable source changes.

Residual blockers:

- Live Langfuse filterability remains Production Slice 10.
- Environment/release/version/tag attributes remain a later refinement.

Commit:

- Not created.

Pushed:

- No.

### Production Slice 3 Review

Status: completed

Date: 2026-07-25

What changed:

- Added `buildAiForensicContext` in `packages/agent-core/src/telemetry.ts`.
- Memory flush, compression summarizer, and structured subagents now enter an AI forensic context whose `forensicRunId` matches their AI SDK telemetry metadata.
- Helper calls run inside `openacme.ai.helper` spans and usage reports carry helper trace/span ids where available.
- Compression usage callback shape now supports optional `traceId`, `spanId`, and provider request count.

Validation:

- `pnpm --filter @openacme/agent-core test -- test/telemetry.test.ts test/agent-compress.test.ts test/subagent.test.ts test/agent-forensics.test.ts`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/agent-core test`
- `pnpm --filter @openacme/agent-core build`
- `pnpm --filter @openacme/server check-types`
- `git diff --check`

Residual blockers:

- Forked subagents route through `Agent.runStream`; explicit parent-child forensic linkage for forked helper runs can still be refined later.
- Provider request counts and tool spans were separate later slices.

Commit:

- Not created.

Pushed:

- No.

### Production Slice 4 Review

Status: completed

Date: 2026-07-25

What changed:

- `forensicFetch` emits `openacme.provider.request` spans around provider fetch attempts.
- Provider request counts are keyed by `forensicRunId` and exposed through `getAIForensicProviderRequestCount`.
- Counts work even when local forensic archives are disabled, provided an AI forensic context exists.
- Provider spans include provider/model/auth mode, ordinal, method, URL, body bytes/hashes, response status, response ok marker, and provider request id.
- Main turns and helper usage reports now include `providerRequestCount` where available.

Validation:

- `pnpm --filter @openacme/llm-provider test -- test/forensics-fetch.test.ts`
- `pnpm --filter @openacme/llm-provider check-types`
- `pnpm --filter @openacme/llm-provider build`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/agent-core test -- test/agent-forensics.test.ts test/agent-compress.test.ts test/subagent.test.ts`
- `pnpm --filter @openacme/llm-provider test`
- `pnpm --filter @openacme/agent-core test`
- `pnpm --filter @openacme/agent-core build`
- `pnpm --filter @openacme/server check-types`
- `git diff --check`

Residual blockers:

- Counts currently remain in memory by run id; cleanup timing should be decided with usage finalization.
- Retry/fallback classification is represented by ordinal count/events, not a richer taxonomy yet.

Commit:

- Not created.

Pushed:

- No.

### Production Slice 5 Review

Status: completed

Date: 2026-07-25

What changed:

- Extended tools forensics with a dependency-free span bridge.
- Agent-core binds that bridge to `withOpenAcmeSpan`, preserving the tools -> llm-provider dependency boundary.
- AI SDK tool execution and direct `dispatch()` now run inside `openacme.tool.execute`.
- Tool forensic events include trace/span ids when available.
- Tool spans receive result byte, spill, worker-dispatch, and spill-path attributes; errors mark span error status while preserving existing behavior.

Validation:

- `pnpm --filter @openacme/tools test -- test/forensics.test.ts`
- `pnpm --filter @openacme/tools test`
- `pnpm --filter @openacme/tools check-types`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/agent-core check-types`
- `pnpm --filter @openacme/agent-core build`
- `pnpm --filter @openacme/server check-types`
- `git diff --check`

Residual blockers:

- Worker-side pre-spill full capture remains deferred; daemon boundary span/events record returned worker output and worker-dispatch marker.
- Usage finalization and per-step detail remain Production Slice 6.

Commit:

- Not created.

Pushed:

- No.

### Langfuse Visibility E2E Framework Review

Status: completed; live Langfuse assertion passed against local Docker
Langfuse.

Date: 2026-07-25

Goal:

- Add an opt-in forensic e2e canary that proves a real OpenAcme AI turn is
  visible in Langfuse and correlates back to local evidence.

What changed:

- Added `docs/langfuse-visibility-e2e.md` with milestones, TDD gates, live env
  contract, exception-handling standard, and execution report.
- Added `pnpm test:e2e:langfuse` and
  `pnpm --filter @openacme/server test:e2e:langfuse`.
- Added `packages/server/vitest.langfuse-e2e.config.ts`.
- Excluded the Langfuse live spec from the generic server e2e config.
- Added `packages/server/test/e2e/support/langfuse.ts` for guarded env loading,
  Basic-auth Langfuse API access, safe diagnostics, and observation polling.
- Added `packages/server/test/e2e/langfuse-visibility.e2e.ts`, which boots the
  real server, drives a tool-using stub-model chat turn, checks usage ledger
  trace/forensic correlation, checks local forensic events, flushes telemetry,
  and polls Langfuse Observations API v2 for `openacme.agent.turn` and
  `openacme.tool.execute`.
- Added `packages/server/test/langfuse-e2e-support.test.ts` for deterministic
  coverage of the live env gate, Langfuse public API request construction, and
  self-hosted v3 legacy observations fallback.
- Extended the e2e harness with optional data-dir injection and cleanup control.
- Added `shutdownOpenAcmeTelemetry()` to make batch exporter flushing
  deterministic for live tests while preserving normal production shutdown.
- Added `ops/langfuse-local/` with a local Docker Compose deployment and env
  setup script for `~/.openacme-test`.

Validation:

- `docker compose --env-file ~/.openacme-test/langfuse/.env -f
ops/langfuse-local/docker-compose.yml up -d`
- `curl http://localhost:3000/api/public/health` - returned 200.
- `pnpm --filter @openacme/server test -- test/langfuse-e2e-support.test.ts`
  - passed, 4 tests.
- `pnpm test:e2e:langfuse` - passed, 1 live test.
- `pnpm --filter @openacme/config check-types`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/config build`
- `pnpm --filter @openacme/server build`
- `git diff --check`

Environment finding:

- Local Langfuse v3 is running at `http://localhost:3000`.
- Local Langfuse secrets are stored in `~/.openacme-test/langfuse/.env`.
- `~/.openacme-test/.env` now contains Langfuse live-test connection keys and
  preserved the pre-existing `OPENROUTER_API_KEY`.
- The local Docker deployment and OpenAcme live canary are isolated from
  `~/.openacme`.

Live e2e evidence:

- OpenAcme usage ledger produced an `interactive` row with `traceId`, `spanId`,
  `forensicRunId`, and `forensicPath`.
- The local forensic archive contained `agent.run.start`, `agent.run.finish`,
  `tool.start`, and `tool.finish`.
- Langfuse readback found `openacme.agent.turn` and `openacme.tool.execute`
  observations for the same trace.

Attempted but not counted:

- `pnpm --filter @openacme/server test:e2e` was started to verify the generic
  e2e suite exclusion. It did not produce a final Vitest summary after more
  than two minutes and was interrupted, so it is not counted as passing.

Residual blockers:

- Provider HTTP request visibility is not exercised by this canary because it
  intentionally uses the deterministic stub model to avoid live model spend;
  it verifies agent, AI turn, daemon-side tool, usage-ledger, and
  local-forensic visibility.

Commit:

- Not created.

Pushed:

- No.
