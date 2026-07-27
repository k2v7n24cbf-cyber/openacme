# AI Forensics and Langfuse Observability

This runbook covers the opt-in AI observability path for OpenAcme. It is built
for investigations where an operator or agent needs to answer:

- Which session, task, and message produced this token spike?
- What exact model input was assembled for the turn?
- Which provider request/response happened, with status and request id?
- Which tool output inflated the next model request?
- Which `usage_events` row links to the trace and local evidence?

## Layers

OpenAcme now records AI interactions in three linked layers:

1. `usage_events`: aggregate accounting in SQLite. This is the first place to
   query for abnormal token or cost rows.
2. Langfuse through OpenTelemetry: shared trace UI for humans and agents.
3. Local AI forensic archive: local proof files for model inputs, helper
   prompts, tool arguments, tool outputs, hashes, sizes, errors, and timings.
4. `session_timeline_events` plus `GET /api/sessions/:id/timeline`: a
   session-scoped semantic timeline that links user-message receipt, turn
   lifecycle events, usage finalization, Langfuse correlation ids, and local
   forensic JSONL events.

All capture is opt-in. A normal install with no env vars keeps telemetry and
forensic file capture disabled.

## Enable Local Forensics

For test work, use the existing test data directory:

```bash
OPENACME_DATA_DIR="$HOME/.openacme-test" \
OPENACME_AI_FORENSICS=1 \
OPENACME_AI_FORENSICS_CAPTURE_RAW=1 \
pnpm dev
```

For metadata-only capture, omit raw capture:

```bash
OPENACME_DATA_DIR="$HOME/.openacme-test" \
OPENACME_AI_FORENSICS=1 \
pnpm dev
```

Default archive path:

```text
<dataDir>/ai-forensics/YYYY-MM-DD/<forensicRunId>/
```

Useful overrides:

```bash
OPENACME_AI_FORENSICS_DIR="$HOME/.openacme-test/ai-forensics"
OPENACME_AI_FORENSICS_RETENTION_DAYS=30
OPENACME_AI_FORENSICS_MAX_RUN_BYTES=0
OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES=1048576
OPENACME_AI_FORENSICS_QUEUE_MAX_JOBS=10000
OPENACME_AI_FORENSICS_QUEUE_MAX_RAW_BYTES=16777216
```

`OPENACME_AI_FORENSICS_MAX_RUN_BYTES=0` means no per-run raw-file cap. Any
positive value is a soft cap: raw files beyond the cap are skipped and an event
is recorded, but the model call continues.

`OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES` is the hard per-file cap before a
raw file is copied into the archive queue. Archive queue overflow drops evidence
jobs instead of delaying model, tool, or HTTP execution.

## Enable Langfuse

Set Langfuse credentials in the process environment or in the resolved
`<dataDir>/.env` loaded after config initialization:

```bash
OPENACME_OBSERVABILITY=langfuse
OPENACME_TELEMETRY_SERVICE_NAME=openacme
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=http://localhost:3000
```

The telemetry bootstrap exports OTLP traces to:

```text
${LANGFUSE_BASE_URL}/api/public/otel/v1/traces
```

with Basic auth using `LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY` and
`x-langfuse-ingestion-version: 4`.

Prompt and response content in AI SDK telemetry remains off unless explicitly
enabled:

```bash
OPENACME_AI_TELEMETRY_RECORD_INPUTS=1
OPENACME_AI_TELEMETRY_RECORD_OUTPUTS=1
```

Use these only during an investigation. Local raw forensics can contain prompts,
tool output, customer data, internal files, and helper outputs.

## What Gets Recorded

Each agent turn creates a `forensicRunId` and writes:

```text
run.json
events.jsonl
agent/model-input.system.txt
agent/model-input.messages.json
agent/model-input.tools.json
tool-calls/<toolCallId>/args.json
tool-calls/<toolCallId>/result.pre-spill.txt
tool-calls/<toolCallId>/result.post-spill.txt
compression/memory-flush/model-input.system.txt
compression/memory-flush/model-input.messages.json
compression/memory-flush/output.txt
compression/summarizer/input.json
compression/summarizer/prompt.txt
compression/summarizer/output.txt
```

Raw files are present only when `OPENACME_AI_FORENSICS_CAPTURE_RAW=1`.
Provider wire request and response bodies are intentionally not written as raw
files. Provider events record provider/model/auth, request ordinal, redacted
headers, body presence/kind, response status, provider request id, trace/span
ids, and evidence locators. Raw-file events record hashes and byte counts for
the local evidence files that are still captured.

History compression creates separate helper forensic runs:

- `kind="extractor"` for the pre-compaction memory flush.
- `kind="summarizer"` for the compression summarizer.

Both helper usage rows carry `trace_id`, `span_id`, `forensic_run_id`,
`forensic_path`, and `provider_request_count` when capture is enabled.

Sensitive headers are never written in cleartext. Values such as
`authorization`, `x-api-key`, `api-key`, `cookie`, `set-cookie`, and
`chatgpt-account-id` are replaced with a redacted SHA-256 marker.

## Langfuse Evidence Locators

Langfuse is the correlation UI, not the raw evidence store. OpenAcme sends
deterministic locator metadata to OpenTelemetry spans so an operator or agent
can jump from a trace observation to local forensic evidence without large
filesystem searches. Core code emits canonical `openacme.*` attributes. When
the Langfuse backend is enabled, the config-owned telemetry adapter maps those
canonical fields to Langfuse metadata keys before export.

Run-level agent turn spans include:

```text
openacme.forensic.lookup=usage_events.forensic_run_id
openacme.forensic.evidence_ref=openacme://forensics/<forensicRunId>#agent.run
openacme.forensic.event_selector=type=agent.run.start
openacme.session.timeline_locator=/api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<forensicRunId>
```

Langfuse receives equivalent adapter-owned metadata such as
`langfuse.trace.metadata.forensic_run_id` and
`langfuse.observation.metadata.evidence_ref`; these keys must not be emitted
directly by agent-core, llm-provider, tools, or dispatcher code.

Provider request spans include:

```text
openacme.forensic.evidence_ref=openacme://forensics/<forensicRunId>#provider.request:<ordinal>
openacme.forensic.event_selector=type=provider.request ordinal=<ordinal>
openacme.forensic.relative_evidence_dir=provider-requests/<ordinal>-<provider>-<model>
```

Tool spans and tool forensic events include:

```text
openacme.forensic.evidence_ref=openacme://forensics/<forensicRunId>#tool.execute:<toolCallId>
openacme.forensic.event_selector=type=tool.execute toolCallId=<toolCallId>
openacme.forensic.relative_evidence_dir=tool-calls/<toolCallId>
openacme.tool.execution_status=ok|error
openacme.tool.result_status=success|failure|partial|running|unknown
openacme.tool.result_classifier=default|shell|process|filesystem|...
openacme.tool.failure_kind=<bounded failure category>
openacme.tool.exit_code=<number, when applicable>
openacme.tool.process_status=<status, when applicable>
```

`execution_status` is the wrapper result: whether OpenAcme invoked the handler
without a thrown exception. `result_status` is the tool-domain result: for
example, `shell` can have `execution_status=ok` and `result_status=failure`
when the command exits non-zero. `ToolEntry.classifyResult` owns
tool-specific classification; the registry only invokes the hook and emits the
bounded outcome. Handler output and model-facing tool results are unchanged.

Compression helper spans include:

```text
openacme.forensic.evidence_ref=openacme://forensics/<forensicRunId>#compression.memory_flush
openacme.forensic.evidence_ref=openacme://forensics/<forensicRunId>#compression.summarizer
openacme.forensic.event_selector=type=compression.memory_flush.start
openacme.forensic.event_selector=type=compression.summarizer.start
openacme.forensic.relative_evidence_dir=compression/memory-flush
openacme.forensic.relative_evidence_dir=compression/summarizer
openacme.session.timeline_locator=/api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<forensicRunId>
```

The locator intentionally avoids absolute local paths and raw content. To
resolve an `evidence_ref`, query `usage_events.forensic_run_id`, open that
row's `forensic_path`, then match `events.jsonl` by the event selector.

## Database Drilldown

Start with the newest large usage rows:

```sql
SELECT
  id,
  created_at,
  agent_id,
  session_id,
  task_id,
  message_id,
  kind,
  provider,
  model,
  total_tokens,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  forensic_run_id,
  forensic_path,
  trace_id
FROM usage_events
ORDER BY total_tokens DESC
LIMIT 20;
```

Then inspect the local archive:

```bash
ls -la "$forensic_path"
tail -n 50 "$forensic_path/events.jsonl"
```

Look for this sequence:

1. `agent.model_input.snapshot`: final system/message/tool payload hash.
2. `provider.request`: exact provider request ordinal, URL, request hash, and
   provider request metadata.
3. `tool.start` and `tool.finish`: tool args, result sizes, spill path, and
   result hashes.
4. `compression.memory_flush.*` and `compression.summarizer.*`: hidden helper
   prompt/output hashes, token counts, and evidence locators when compaction
   ran.
5. The next `provider.request`: confirms whether a tool result expanded the
   next model input.
6. `agent.run.finish`: aggregate usage for the turn.

Use `trace_id` to search in Langfuse when observability is enabled. Use
`forensic_run_id` to find both the Langfuse metadata and the local archive.

## Session Timeline API

Use the session timeline when you need a single ordered view of what happened
inside one session:

```bash
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&limit=300"
```

The response merges:

- DB semantic events from `session_timeline_events`.
- Structured local forensic events referenced by that session's
  `usage_events.forensic_path`.

Expected session timeline event types include:

```text
session.user_message.received
session.turn.started
session.prompt.snapshot.created
session.turn.finished
session.turn.failed
session.usage.finalized
agent.run.start
agent.model_input.snapshot
provider.request
provider.response
tool.start
tool.finish
agent.run.finish
agent.run.error
session.compression.started
session.compression.noop
session.compression.memory_flush.started
session.compression.memory_flush.finished
session.compression.memory_flush.failed
session.compression.summarizer.started
session.compression.summarizer.finished
session.compression.summarizer.failed
session.compression.finished
session.compression.failed
compression.memory_flush.start
compression.memory_flush.finish
compression.memory_flush.error
compression.summarizer.start
compression.summarizer.finish
compression.summarizer.error
session.title.started
session.title.finished
session.title.failed
session.memory.selection.started
session.memory.selection.finished
session.memory.selection.skipped
session.memory.selection.failed
session.memory.extraction.started
session.memory.extraction.finished
session.memory.extraction.skipped
session.memory.extraction.failed
session.subagent.started
session.subagent.finished
session.subagent.failed
session.dispatcher.wake.started
session.dispatcher.wake.finished
session.dispatcher.wake.failed
session.dispatcher.defer.skipped
session.dispatcher.capacity_queued
session.autonomous.started
session.autonomous.finished
session.autonomous.failed
```

The API intentionally excludes raw forensic file contents and raw file path
references. It returns IDs, hashes, byte counts, durations, token counts,
statuses, event types, and correlation fields. Inspect raw files directly from
`forensic_path` only when the investigation requires it.

## Agent Workflow

When an agent investigates an anomaly, it should:

1. Query `usage_events` for the suspicious row.
2. Read `forensic_path/run.json`.
3. Parse `forensic_path/events.jsonl`.
4. Inspect raw files only when needed.
5. Prefer hashes and byte counts in summaries; avoid pasting raw prompts,
   secrets, customer data, or large tool outputs into chat.

If Langfuse MCP access is configured, the agent can search by `trace_id`,
`forensicRunId`, `sessionId`, `taskId`, `messageId`, `agentId`, provider, model,
or usage kind.

## Test Environment Smoke

A local smoke that does not contact a real provider should create forensic
files under `~/.openacme-test/ai-forensics` by using a fake fetch or mocked AI
SDK call. The expected outcome is:

- `run.json` exists.
- `events.jsonl` contains `agent.run.start`, provider or tool events, and
  `agent.model_input.snapshot`.
- A compression canary contains `compression.memory_flush.*` and
  `compression.summarizer.*` events, plus helper `usage_events` rows with
  `kind="extractor"` and `kind="summarizer"`.
- Background/autonomous tests should show semantic timeline rows for
  `kind="title"`, `kind="selector"`, `kind="extractor"`, dispatcher wake,
  capacity/defer, and autonomous start/finish/failure events when those paths
  run.
- Raw files exist when `OPENACME_AI_FORENSICS_CAPTURE_RAW=1`.
- `usage_events.forensic_run_id` and `usage_events.forensic_path` are set for
  completed agent turns and compression helper calls.

## Cleanup

The archive changes the data classification of the data directory. Treat
`<dataDir>/ai-forensics` as sensitive local evidence.

Until an automated retention sweep is enabled, remove old test archives by
deleting only inside the configured forensics root:

```bash
find "$HOME/.openacme-test/ai-forensics" -mindepth 1 -maxdepth 1 -type d
```

Review the paths before deleting anything. Do not point forensic cleanup at a
directory outside `OPENACME_AI_FORENSICS_DIR`.
