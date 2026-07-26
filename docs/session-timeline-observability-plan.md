# Session Timeline Observability Plan

Baseline branch: `local-stage`

Objective: add a session-scoped forensic timeline that lets an operator or
agent reconstruct an OpenAcme session from user message receipt through AI turn
execution, provider requests, tool execution, usage finalization, and local
forensic evidence.

This is an additive extension of the existing observability model. It does not
replace Langfuse, usage accounting, or local AI forensics.

## Architecture Fit

Existing layers:

1. `usage_events` is the aggregate accounting ledger.
2. Langfuse receives OpenTelemetry traces, spans, generations, and tool
   observations.
3. Local AI forensics stores structured event JSONL plus optional raw prompt,
   provider, and tool files.

New layer:

4. `session_timeline_events` is the queryable semantic index for a session. It
   records stable lifecycle boundaries and correlates them to Langfuse and
   local forensic evidence with `sessionId`, `traceId`, `spanId`,
   `forensicRunId`, `usageEventId`, `agentId`, `messageId`, and `taskId`.

The API timeline will merge canonical DB events with non-raw local forensic
events referenced by `usage_events.forensic_path`. Raw prompt/provider/tool
payload bodies remain local files and are not returned by the API.

## Security Contract

- Timeline payloads must contain IDs, hashes, byte counts, durations, statuses,
  token counts, and error class/message summaries only.
- Timeline API must not return raw prompt text, provider request bodies, tool
  output bodies, secret headers, OAuth tokens, API keys, cookies, or Langfuse
  secrets.
- Local forensic raw files stay behind filesystem access and existing
  forensics flags.
- Timeline writes are best-effort. A timeline write failure must never fail an
  agent turn, provider call, tool call, or chat request.

## Milestones

### Milestone 0 - Plan and Architecture Freeze

Goal: document the target model, active slice, non-goals, and validation bar
before code changes.

TDD:

- No code tests. Completion is doc review plus slice lock.

Status:

- Complete.

### Milestone 1 - AI Turn Timeline Core

Goal: make a single session query return the important AI-turn lifecycle for
interactive turns:

- `session.user_message.received`
- `session.turn.started`
- `session.turn.finished`
- `session.turn.failed`
- `session.usage.finalized`
- merged forensic events such as `agent.run.start`,
  `agent.model_input.snapshot`, `provider.request`, `provider.response`,
  `tool.start`, `tool.finish`, and `agent.run.finish`

Implementation slices:

1. DB schema and store:
   - Add `session_timeline_events`.
   - Add `createSessionTimelineStore`.
   - Add newest/oldest pagination by `(created_at_ms, rowid)`.
   - Add filtering by `sessionId`, `traceId`, `forensicRunId`, `usageEventId`,
     and source.
2. API:
   - Add `GET /api/sessions/:id/timeline`.
   - Return DB timeline events plus structured local forensic JSONL events for
     usage rows in that session.
   - Keep raw files out of the response.
3. Agent/server emission:
   - Record user message receipt in `/api/chat`.
   - Record turn start/finish/failure from agent-core through an injected
     manager callback.
   - Record usage finalization after `usage_events.record`.
4. Test environment verification:
   - Run focused DB/store tests.
   - Run route/e2e test with stub model and tool call.
   - Run live `~/.openacme-test` verification using the local fake provider
     and local Docker Langfuse.

TDD:

- Write failing store tests first.
- Write failing API/e2e assertions before route implementation.
- Add agent-core callback tests before wiring manager persistence.
- End with live test-environment verification.

Non-goals:

- No UI timeline view in this slice.
- No dispatcher, memory extraction, title generation, compression, or task
  lifecycle coverage beyond whatever is already visible through usage and
  forensics.
- No raw payload API.
- No new observability backend.

Status:

- Complete for Milestone 1 scope.

### Milestone 2 - Background AI and Dispatcher Timeline

Goal: add semantic events for hidden token consumers and autonomous lifecycle:

- `session.title.started`
- `session.title.finished`
- `session.title.failed`
- `session.memory.selection.started`
- `session.memory.selection.finished`
- `session.memory.selection.skipped`
- `session.memory.selection.failed`
- `session.memory.extraction.started`
- `session.memory.extraction.finished`
- `session.memory.extraction.skipped`
- `session.memory.extraction.failed`
- `session.subagent.started`
- `session.subagent.finished`
- `session.subagent.failed`
- `session.dispatcher.wake.started`
- `session.dispatcher.wake.finished`
- `session.dispatcher.wake.failed`
- `session.dispatcher.defer.skipped`
- `session.dispatcher.capacity_queued`
- `session.autonomous.started`
- `session.autonomous.finished`
- `session.autonomous.failed`

Implementation slices:

1. Agent-core hidden-helper lifecycle:
   - Emit title lifecycle from `Agent.fireTitle`, including generated,
     fallback, and failed outcomes.
   - Emit memory extraction lifecycle from `Agent.fireExtractor`, including
     disabled/no-new-content/coalesced skips and extractor result status.
   - Emit memory selection lifecycle around the recall selector without
     returning raw memory text or absolute paths.
   - Emit generic subagent lifecycle from `runSubagent` for forked and
     structured helper calls when a session id is available.
2. Server dispatcher/autonomous lifecycle:
   - Emit dispatcher wake decision events when a session is enqueued.
   - Emit capacity-queued events when ready work is blocked by per-agent
     concurrency.
   - Emit coalesced defer-skip events when a session would otherwise wake but
     `defer_until` suppresses the routine check.
   - Emit autonomous start/finish/failure events around `runAutonomous`.
3. Documentation and investigation workflow:
   - Update the AI forensics runbook and investigation skill with the new
     event types and how they connect to `usage_events.kind`.
   - Keep local raw evidence out of Langfuse and the timeline API.

TDD:

- Add failing agent-core tests before implementation for title, extractor,
  selector, and generic subagent timeline events.
- Add failing server dispatcher tests before implementation for wake,
  capacity queue, defer skip, autonomous success, and autonomous failure.
- Run focused package tests before broad builds.
- Run any live/dev verification only against `~/.openacme-test`, never
  `~/.openacme`.

Exception handling contract:

- Timeline recording is best-effort and must never change title generation,
  memory selection, memory extraction, subagent, dispatcher, or autonomous
  behavior.
- Event payloads contain IDs, counts, statuses, bounded error summaries,
  provider/model/auth facts when already available, and durations.
- Event payloads must not contain raw prompts, memory file bodies, raw tool
  results, provider request bodies, secrets, API keys, cookies, OAuth tokens,
  or absolute local paths.
- Dispatcher defer/capacity events are coalesced enough to avoid one timeline
  row per routine tick for the same unchanged condition.

Non-goals:

- No change to scheduling, capacity, defer, memory selection, memory
  extraction, title, or subagent logic.
- No MCP-native outcome instrumentation in this slice.
- No web UI timeline view in this slice.

Status:

- Complete for Milestone 2 scope.

### Milestone 3 - Langfuse Evidence Locators and Investigation Skill

Goal: make every Langfuse-visible AI turn, provider request, and tool
execution point to deterministic local forensic evidence without exposing raw
content or absolute local paths in Langfuse.

Implementation slices:

1. Evidence locator contract:
   - Add `openacme://forensics/<forensicRunId>#<eventType>:<selector>`
     references.
   - Add a session timeline locator:
     `/api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<forensicRunId>`.
   - Add `usage_events.forensic_run_id` as the canonical DB lookup key.
2. Langfuse/OTel propagation:
   - Put run-level evidence and timeline locators on the agent turn span and
     Langfuse trace metadata.
   - Put provider-request evidence locators on provider request spans.
   - Put tool execution evidence locators on tool spans and structured tool
     forensic events.
3. Documentation and reusable skill:
   - Update the AI forensics runbook with locator semantics.
   - Add a repository skill for full OpenAcme forensic investigation.

TDD:

- Add failing helper tests for evidence reference formatting and safe omission
  when ids are unavailable.
- Add failing provider span/event tests for provider-request locators.
- Add failing agent-core tests for run-level locator propagation.
- Add failing tool tests for tool-call locators.
- Validate with focused package tests and a live `~/.openacme-test` smoke
  against local Docker Langfuse.

Security contract:

- Do not send raw prompt, provider body, tool args, tool result, secrets, or
  absolute local filesystem paths to Langfuse.
- Relative evidence directories are allowed only when they are rooted under the
  run archive and contain no raw content.
- Locator writes are best-effort metadata only and must not affect AI, provider,
  or tool execution.

Status:

- Complete for Milestone 3 scope.

### Milestone 4 - Compression and Hidden Helper Forensics

Goal: make history compression forensic-grade. A single session timeline must
show when compaction started, whether memory flush ran or skipped, when the
summarizer ran, how many tokens the hidden helper calls used, and where their
local evidence lives.

Owned paths:

- `Agent.compress(...)` semantic timeline events.
- Pre-compaction memory flush helper telemetry, usage, and local evidence.
- Compression summarizer helper telemetry, usage, and local evidence.
- Timeline API merge support for compression-local JSONL events.

Implementation slices:

1. Compression lifecycle events:
   - Emit `session.compression.started`.
   - Emit `session.compression.noop` for no-op outcomes.
   - Emit `session.compression.finished` only after the rename-swap and
     compressed message persistence succeed.
   - Emit `session.compression.failed` for rename/persist failures without
     hiding the original failure.
2. Memory flush helper evidence:
   - Emit `session.compression.memory_flush.started`,
     `session.compression.memory_flush.finished`,
     `session.compression.memory_flush.skipped`, and
     `session.compression.memory_flush.failed`.
   - Add `forensicPath` to the extractor usage report.
   - Add Langfuse evidence and timeline locators to the helper span/trace
     metadata.
   - Write local `compression.memory_flush.*` events and raw prompt snapshots
     only under the local forensic archive when raw capture is enabled.
3. Summarizer helper evidence:
   - Emit `session.compression.summarizer.started`,
     `session.compression.summarizer.finished`, and
     `session.compression.summarizer.failed`.
   - Add `forensicPath` to the summarizer usage report.
   - Add Langfuse evidence and timeline locators to the helper span/trace
     metadata.
   - Write local `compression.summarizer.*` events and raw summarizer prompt
     snapshots only under the local forensic archive when raw capture is
     enabled.
4. Timeline API:
   - Merge sanitized `compression.memory_flush.*` and
     `compression.summarizer.*` forensic JSONL rows referenced by
     `usage_events.forensic_path`.
   - Continue excluding raw file names, raw payload bodies, secrets, and
     absolute filesystem paths from API responses.

TDD:

- Add failing agent-core compression tests before implementation for:
  usage `forensicPath`, helper span evidence locators, semantic timeline
  events, no-op timeline events, and local compression JSONL events.
- Add failing session timeline route/e2e assertions for sanitized compression
  forensic event merge.
- Add or extend live `~/.openacme-test` verification to run a compression
  canary and confirm OpenAcme timeline + local Langfuse visibility.

Exception handling contract:

- Timeline recording, locator construction, raw snapshot writing, and usage
  reporting remain best-effort and must never change compression behavior.
- GenerateText failures keep the existing compression semantics:
  aux summarizer fallback, cooldown, proactive no-op, or reactive placeholder.
- Compression storage failures remain real failures and are surfaced as
  `session.compression.failed`.

Non-goals:

- No change to compression boundary selection, pruning, summary prompt
  semantics, memory flush prompt semantics, or rename-swap behavior.
- No web UI timeline view in this slice.
- No new observability backend.

Status:

- Complete for Milestone 4 scope.

### Milestone 4.5 - Tool Result Outcome Classification

Goal: categorize every tool call with a stable forensic outcome that separates
wrapper execution success from the tool's domain result. A tool handler can
complete normally while the action it performed failed, such as `shell`
returning `exitCode=2` or `process` reporting `status="timed_out"`.

Architecture contract:

- `ToolRegistry` owns invocation, timing, spilling, and telemetry emission.
- Each `ToolEntry` may own a `classifyResult` hook for domain-specific
  semantics. The registry must not hard-code shell/process/filesystem behavior.
- A default classifier handles common JSON contracts:
  `{ success: false }`, `{ ok: false }`, and `{ error: "..." }`.
- Tool-specific classifiers cover materially different domains:
  `shell`, `process`, and filesystem tools (`read_file`, `write_file`,
  `list_files`, `search_files`, `edit`, `apply_patch`).
- Classification is observability-only. Tool handler outputs, model-facing
  tool results, spill behavior, and application logic must not change.
- Classifier failures are best-effort and must never fail the tool call.

Telemetry fields:

- `executionStatus`: wrapper-level result, `ok` or `error`.
- `resultStatus`: domain-level result, `success`, `failure`, `partial`,
  `running`, or `unknown`.
- `resultClassifier`: classifier name such as `default`, `shell`, `process`,
  or `filesystem`.
- `failureKind` and `failureMessage` for failed domain outcomes.
- Optional domain facts such as `exitCode`, `processStatus`, and bounded
  classifier attributes.

Langfuse/OpenTelemetry propagation:

- OpenAcme core emits canonical `openacme.*` attributes only. Langfuse-specific
  `langfuse.*` attributes are produced only by the observability adapter when
  `OPENACME_OBSERVABILITY=langfuse`.
- Safe `openacme.*` context keys propagate through OpenTelemetry baggage so
  provider, tool, and child spans remain correlatable in generic OTLP
  backends. The Langfuse adapter maps these canonical keys to
  `langfuse.session.id`, `langfuse.trace.metadata.*`, and
  `langfuse.observation.metadata.*` immediately before export.
- `openacme.tool.execute` spans carry equivalent attributes:
  `openacme.tool.execution_status`, `openacme.tool.result_status`,
  `openacme.tool.result_classifier`, `openacme.tool.failure_kind`,
  `openacme.tool.failure_message`, `openacme.tool.exit_code`, and
  `openacme.tool.process_status` when present.
- Logical failures set the span status to error even when the handler returned
  normally; true handler exceptions still record `tool.error`.
- The agent-core tool span binding must not auto-overwrite tool status to OK
  after the registry has classified a logical failure.

TDD:

- Add failing registry tests proving custom classifiers can mark logical
  failures without changing tool output.
- Add failing default-classifier tests for `{ error }`, `{ success: false }`,
  `{ ok: false }`, plain text, and classifier exceptions.
- Add failing shell/process/filesystem tests for non-zero exit codes,
  timeouts, detached/running processes, file read errors, media reads, and
  no-match search success.

Validation:

- Initial TDD run failed as expected because `src/outcome.ts` and telemetry
  propagation did not exist yet:
  `pnpm --filter @openacme/tools test -- outcome.test.ts forensics.test.ts`.
- Focused `@openacme/tools` outcome/forensics tests passed after
  implementation.
- Focused shell/process/filesystem regression tests passed:
  `shell-session.test.ts`, `process-run.test.ts`, `process.test.ts`,
  `read-file-multimodal.test.ts`, `forensics.test.ts`, and
  `outcome.test.ts`.
- Full `pnpm --filter @openacme/tools test` passed, 216 tests.
- `pnpm --filter @openacme/tools build` passed.
- `pnpm --filter @openacme/server exec vitest run test/e2e/session-timeline.e2e.ts --config vitest.e2e.config.ts`
  passed 3 e2e tests after sandbox `listen EPERM` was rerun outside the
  sandbox. This proves `tool.finish` result failures project to timeline
  `status="error"` while raw file references remain sanitized.
- `pnpm --filter @openacme/agent-core test -- agent-forensics.test.ts agent-telemetry.test.ts agent-preflight.test.ts`
  passed 8 tests after changing the tool span binding to preserve registry-set
  logical failure status.
- `pnpm --filter @openacme/agent-core build` passed.
- `pnpm --filter @openacme/server build` passed.
- If this slice later needs live proof, run only against `~/.openacme-test`,
  never `~/.openacme`.

Status:

- Complete for Milestone 4.5 scope.

### Milestone 5 - Operator and Agent Investigation Surface

Goal: make the timeline easy to consume by humans and agents.

Candidate deliverables:

- Web timeline view for a session.
- CLI/API helper to fetch by session, trace, forensic run, or usage event.
- Langfuse deep links when base URL is configured.
- Redaction checks for all response payloads.

Status:

- Future.

## Validation Log

This section is updated after every completed slice.

- 2026-07-26: Milestone 0 complete. Active slice is Milestone 1 only:
  DB/store, API route, interactive AI-turn emission, focused tests, and
  `~/.openacme-test` live verification.
- 2026-07-26: Milestone 1 slice 1 complete. Added
  `session_timeline_events` schema/store and generated migration. Validation:
  `pnpm --filter @openacme/db test -- session-timeline-store.test.ts`
  passed 3 tests.
- 2026-07-26: Milestone 1 slices 2-3 complete for interactive turns. Added
  `GET /api/sessions/:id/timeline`, forensic JSONL merge/sanitization,
  `session.user_message.received`, `session.turn.started`,
  `session.prompt.snapshot.created`, `session.turn.finished`,
  `session.turn.failed`, and `session.usage.finalized` emission. Validation:
  `pnpm --filter @openacme/server exec vitest run test/e2e/session-timeline.e2e.ts --config vitest.e2e.config.ts`
  passed 1 e2e test. The stub harness bypasses provider HTTP, so
  provider.request/provider.response remain live-test coverage.
- 2026-07-26: Focused regression passed:
  `pnpm --filter @openacme/db test -- session-timeline-store.test.ts usage-store.test.ts`
  passed 14 tests; `pnpm --filter @openacme/agent-core test -- agent-telemetry.test.ts agent-forensics.test.ts`
  passed 2 tests; `pnpm --filter @openacme/server build` passed.
- 2026-07-26: Live `~/.openacme-test` verification passed using local-only
  fake provider plus local Docker Langfuse. Direct session
  `66c399ba-ba29-48c0-9231-d2e0ce584e20` produced trace
  `1da9bfbb772085088d6157cfb7bd589b`, 10 timeline events, provider
  request/response, usage, and Langfuse generation spans. Tool session
  `9d688bfd-9855-4825-b3f4-2266ffd5b799` produced trace
  `782ab6f86139f5294b8980a5bfa7212a`, 14 timeline events,
  providerRequestCount `2`, `tool.start`, `tool.finish`,
  `openacme.tool.execute`, and Langfuse `TOOL` observation.
- 2026-07-26: Milestone 3 complete. Added deterministic evidence locator
  helpers and propagated `openacme.forensic.evidence_ref`,
  `openacme.forensic.event_selector`,
  `openacme.forensic.relative_evidence_dir`, and
  `openacme.session.timeline_locator` to agent, provider, and tool
  observability paths without exposing raw content or absolute local paths.
  Added the repository skill
  `.claude/skills/openacme-forensic-investigation`. Validation:
  `pnpm --filter @openacme/llm-provider test -- evidence-locator.test.ts forensics-fetch.test.ts forensics-recorder.test.ts observability.test.ts`
  passed 25 tests; `pnpm --filter @openacme/tools test -- forensics.test.ts`
  passed 5 tests; `pnpm --filter @openacme/agent-core test -- agent-forensics.test.ts agent-telemetry.test.ts agent-compress.test.ts agent-preflight.test.ts selector.test.ts subagent.test.ts`
  passed 40 tests; `pnpm --filter @openacme/server exec vitest run test/e2e/session-timeline.e2e.ts --config vitest.e2e.config.ts`
  passed 1 e2e test; `pnpm --filter @openacme/server build` passed;
  skill validation passed. Live `~/.openacme-test` verifier passed with
  direct session `a957b2ed-07be-435b-9151-16c6d6b866a4`, trace
  `1038bd896b277a744ed8ea6b0b86f45c`, forensic run
  `e0486f58-9080-4c63-a9f2-4316982111e7`; and tool session
  `ed5c3822-1c65-49e0-aed8-3b20de214e9a`, trace
  `07a5d10ddfd8c61fa06af0f083f0a9f8`, forensic run
  `69379bf9-fd1e-494c-8c3d-c1aca310f930`. Local forensics and timeline
  included provider request/response evidence refs and tool start/finish
  evidence refs. Langfuse observations showed evidence locators on
  `openacme.agent.turn`, `openacme.provider.request`, and tool-run
  `openacme.tool.execute`.
- 2026-07-26: Milestone 4 complete. Added forensic-grade history
  compression coverage: `session.compression.*`,
  `session.compression.memory_flush.*`,
  `session.compression.summarizer.*`, local
  `compression.memory_flush.*` and `compression.summarizer.*` JSONL events,
  helper raw snapshots, helper Langfuse evidence locators, and
  `forensicPath` propagation for `extractor` and `summarizer` usage rows.
  Validation: `pnpm --filter @openacme/agent-core test -- agent-compress.test.ts`
  passed 9 tests after the expected TDD failure; `pnpm --filter @openacme/agent-core test -- agent-compress.test.ts agent-preflight.test.ts agent-forensics.test.ts agent-telemetry.test.ts telemetry.test.ts`
  passed 22 tests; `pnpm --filter @openacme/server exec vitest run test/e2e/session-timeline.e2e.ts --config vitest.e2e.config.ts`
  passed 2 e2e tests; `node --check ops/langfuse-local/verify-openacme-test-compression.mjs`
  passed; `pnpm --filter @openacme/agent-core build`,
  `pnpm --filter @openacme/server build`, and
  `pnpm --filter @openacme/cli build` passed. Live `~/.openacme-test`
  compression canary passed with session
  `530177cc-b9e3-4aba-be0a-4387b32e23d6`, 109 timeline events,
  summarizer trace `910ca319d8ca74edad68c5c9ba76279f`, summarizer forensic
  run `a7a43c7a-d4e1-4f86-8fb5-a96578754e5b`, extractor trace
  `794f0c90f0b342ef7ec9e1eecd8eab26`, extractor forensic run
  `581c2ecc-f309-41a6-a2df-0e0c044d56f7`, and Langfuse observations
  `openacme.ai.helper` plus `openacme.provider.request`. The canary restored
  `~/.openacme-test/config.yaml`, the final post-build test daemon health
  check passed at PID `7949`, and the local fake provider was stopped.
- 2026-07-26: Milestone 4.5 complete. Added per-tool outcome classification:
  `ToolEntry.classifyResult`, default JSON failure classification, custom
  shell/process/filesystem classifiers, `tool.finish` outcome fields, and
  Langfuse/OpenTelemetry span attributes for execution status, result status,
  classifier, failure kind/message, exit code, process status, and bounded
  domain attributes. Logical failures now set `openacme.tool.execute` span
  status to error without changing handler output. Validation:
  initial TDD run failed as expected; focused outcome/forensics tests passed;
  focused shell/process/filesystem regression tests passed; full
  `pnpm --filter @openacme/tools test` passed 216 tests; and
  `pnpm --filter @openacme/tools build` passed. Session timeline e2e passed
  3 tests after sandbox `listen EPERM` was rerun outside the sandbox, and
  `pnpm --filter @openacme/agent-core test -- agent-forensics.test.ts agent-telemetry.test.ts agent-preflight.test.ts`,
  `pnpm --filter @openacme/agent-core build`, and
  `pnpm --filter @openacme/server build` passed.
- 2026-07-27: Live Langfuse readback for tool outcome classification is
  complete. The guarded `pnpm test:e2e:langfuse` canary now drives two real
  tool turns against `~/.openacme-test`: a successful tool call and a shell
  command that exits with code 7. It verifies local `tool.finish` forensic
  data has `resultStatus=failure`, `resultClassifier=shell`,
  `failureKind=command_exit_nonzero`, `failureMessage=Command exited with code 7`,
  and `exitCode=7`; then it flushes telemetry and verifies the same logical
  failure is visible in Langfuse observation metadata as
  `tool_execution_status=ok`, `tool_result_status=failure`,
  `tool_result_classifier=shell`, `tool_failure_kind=command_exit_nonzero`,
  `tool_failure_message=Command exited with code 7`, and `tool_exit_code=7`.
  Validation: `pnpm --filter @openacme/config test -- langfuse-attribute-span-processor.test.ts`
  passed 2 tests; `pnpm --filter @openacme/server test -- test/langfuse-e2e-support.test.ts`
  passed 4 tests; `pnpm --filter @openacme/config build` and
  `pnpm --filter @openacme/server build` passed; `pnpm test:e2e:langfuse`
  passed 1 live test outside the sandbox.
- 2026-07-27: Milestone 2 complete. Added background/helper and dispatcher
  timeline coverage for `session.title.*`, `session.memory.selection.*`,
  `session.memory.extraction.*`, `session.subagent.*`,
  `session.dispatcher.wake.*`, `session.dispatcher.defer.skipped`,
  `session.dispatcher.capacity_queued`, and `session.autonomous.*`.
  Timeline writes remain best-effort and do not change title, memory,
  subagent, dispatcher, or autonomous behavior. TDD validation: the initial
  focused runs failed as expected with missing timeline events. After
  implementation, `pnpm --filter @openacme/agent-core test -- agent-fire-title.test.ts agent-fire-extractor.test.ts selector.test.ts subagent.test.ts`
  passed 45 tests; `pnpm --filter @openacme/server exec vitest run test/dispatcher.test.ts`
  passed 37 tests; `pnpm --filter @openacme/agent-core build` and
  `pnpm --filter @openacme/server build` passed. Session timeline e2e first
  hit sandbox `listen EPERM`, then passed outside the sandbox with
  `pnpm --filter @openacme/server exec vitest run test/e2e/session-timeline.e2e.ts --config vitest.e2e.config.ts`,
  4 tests including dispatcher/autonomous DB/API timeline persistence.
- 2026-07-27: Boundary cleanup slice complete. Removed Langfuse-specific
  attribute generation from agent-core and llm-provider core paths. The core
  now emits canonical `openacme.*` attributes and propagates only safe
  `openacme.*` baggage. Config owns the backend-specific adapter:
  `OpenAcmeBaggageSpanProcessor` copies safe canonical baggage to child spans,
  and `LangfuseAttributeSpanProcessor` maps canonical attributes to
  `langfuse.session.id`, `langfuse.trace.metadata.*`, and
  `langfuse.observation.metadata.*` only when the Langfuse backend is active.
  TDD validation: initial focused runs failed as expected with missing config
  processors, missing canonical baggage, and remaining core `langfuse.*`
  attributes. After implementation, `pnpm --filter @openacme/config test`
  passed 74 tests; `pnpm --filter @openacme/llm-provider test -- observability.test.ts forensics-recorder.test.ts forensics-fetch.test.ts evidence-locator.test.ts`
  passed 25 tests; `pnpm --filter @openacme/agent-core test -- agent-forensics.test.ts agent-compress.test.ts`
  passed 10 tests; `pnpm --filter @openacme/agent-core test -- subagent.test.ts`
  passed 17 tests; `pnpm --filter @openacme/config build`,
  `pnpm --filter @openacme/llm-provider build`,
  `pnpm --filter @openacme/agent-core build`, and
  `pnpm --filter @openacme/server build` passed. Live readback validation:
  the sandboxed `pnpm test:e2e:langfuse` run failed only because it could not
  create `~/.openacme-test/langfuse-e2e/run-*`; rerunning the same command
  outside the sandbox passed 1 live test against `~/.openacme-test` and local
  Langfuse, confirming `openacme.agent.turn` and `openacme.tool.execute`
  observations are still visible in Langfuse.

## Current Residual Gaps

- MCP-native outcome facts are still deferred. Built-in tools classify
  outcomes, but MCP tools still need tool-owned native classification.
- Langfuse receives helper/turn/span metadata through the config-owned
  OpenTelemetry adapter. The semantic dispatcher/background events are stored
  in the local session timeline, not duplicated as separate Langfuse
  observations.
- History compression helper coverage is complete for Milestone 4.
- Tool result outcome classification is complete for Milestone 4.5. Shell,
  process, and filesystem outcomes are tool-owned; other tools use the default
  JSON failure contract.
- The web UI does not yet render the session timeline. Operators and agents
  can use `GET /api/sessions/:id/timeline` for now.
- The stub e2e harness bypasses provider HTTP, so provider request/response
  timeline coverage is validated by the live local fake-provider test.
