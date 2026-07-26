# OpenAcme AI Forensic Evidence Map

## Data Locations

Default test runtime:

```text
dataDir: ~/.openacme-test
database: ~/.openacme-test/state.db
local forensics: ~/.openacme-test/ai-forensics/YYYY-MM-DD/<forensicRunId>/
Langfuse: LANGFUSE_BASE_URL from ~/.openacme-test/.env
OpenAcme API: http://127.0.0.1:3457
```

Production runtime is usually `~/.openacme`. Do not inspect it unless the user
explicitly asks for production.

## Correlation Fields

Use these fields as the investigation spine:

```text
sessionId          OpenAcme chat/session id
agentId            OpenAcme agent id
messageId          user message id for interactive turns
taskId             task id for autonomous/helper work when available
traceId            Langfuse/OpenTelemetry trace id
spanId             Langfuse/OpenTelemetry span/observation id
usageEventId       usage_events.id
forensicRunId      local forensic archive id
forensicPath       absolute local archive path, only in local DB/API
evidenceRef        openacme://forensics/<runId>#<eventType>:<selector>
timelineLocator    /api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<runId>
```

Langfuse should receive correlation metadata and evidence locators, but not
raw prompts, raw provider bodies, raw tool outputs, secrets, or absolute local
filesystem paths.

## EvidenceRef Resolution

`evidenceRef` is a deterministic pointer from a Langfuse-visible observation
to local evidence.

Examples:

```text
openacme://forensics/<runId>#agent.run
openacme://forensics/<runId>#provider.request:1
openacme://forensics/<runId>#tool.finish:call_abc
openacme://forensics/<runId>#compression.memory_flush
openacme://forensics/<runId>#compression.summarizer
```

Resolution algorithm:

1. Parse `<runId>` from the URI.
2. Query `usage_events` where `forensic_run_id = <runId>`.
3. Read `forensic_path/events.jsonl`.
4. Match the fragment:
   - `agent.run`: `type = agent.run.start` or `agent.run.finish`
   - `provider.request:<n>`: `type = provider.request` and `data.ordinal = n`
   - `provider.response:<n>`: `type = provider.response` and `data.ordinal = n`
   - `tool.start:<id>`: `type = tool.start` and `data.toolCallId = id`
   - `tool.finish:<id>`: `type = tool.finish` and `data.toolCallId = id`
   - `compression.memory_flush`: `type = compression.memory_flush.start`
     or `compression.memory_flush.finish`
   - `compression.summarizer`: `type = compression.summarizer.start`
     or `compression.summarizer.finish`
5. Use `relativeEvidenceDir` on the matched event to find raw files under
   `forensic_path` if raw inspection is justified.

## API First Commands

Health:

```bash
curl -sS -H 'host: 127.0.0.1' http://127.0.0.1:3457/api/health
```

Session timeline:

```bash
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&limit=300"
```

Filtered timeline:

```bash
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<runId>&limit=300"
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&traceId=<traceId>&limit=300"
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&usageEventId=<usageEventId>&limit=300"
```

Usage rows through API:

```bash
curl -sS "http://127.0.0.1:3457/api/usage/events?limit=200"
```

## Direct Database Queries

Database file:

```text
<dataDir>/state.db
```

Largest usage rows:

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
  cache_write_tokens,
  reasoning_tokens,
  provider_request_count,
  forensic_run_id,
  forensic_path,
  trace_id,
  span_id
FROM usage_events
ORDER BY total_tokens DESC
LIMIT 20;
```

Resolve a forensic run:

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
  forensic_run_id,
  forensic_path,
  trace_id,
  span_id
FROM usage_events
WHERE forensic_run_id = '<runId>'
ORDER BY created_at DESC;
```

Session timeline table only:

```sql
SELECT
  created_at_ms,
  event_type,
  source,
  status,
  trace_id,
  span_id,
  forensic_run_id,
  usage_event_id,
  duration_ms,
  payload
FROM session_timeline_events
WHERE session_id = '<sessionId>'
ORDER BY created_at_ms ASC, rowid ASC;
```

## Local Archive Files

Archive root:

```text
<forensic_path>/
  run.json
  events.jsonl
  agent/model-input.system.txt
  agent/model-input.messages.json
  agent/model-input.tools.json
  provider-requests/<ordinal>-<provider>-<model>/
    request.pre-transform.body
    request.post-transform.body
    response.body
  tool-calls/<toolCallId>/
    args.json
    result.pre-spill.txt
    result.post-spill.txt
  compression/memory-flush/
    model-input.system.txt
    model-input.messages.json
    output.txt
  compression/summarizer/
    input.json
    prompt.txt
    output.txt
```

Raw files exist only when `OPENACME_AI_FORENSICS_CAPTURE_RAW=1`.

Use `events.jsonl` first:

```bash
tail -n 100 "<forensic_path>/events.jsonl"
```

Look for:

```text
agent.run.start              turn metadata and trace/span
agent.model_input.snapshot   hashes and byte counts of final model input
provider.request             provider/model/url/header/request hash by ordinal
provider.response            status/request id/response hash by ordinal
tool.start                   tool args hash/size by toolCallId
tool.finish                  output hash/size/spill facts and result outcome
compression.memory_flush.start   pre-compaction memory flush input hashes
compression.memory_flush.finish  memory flush token counts and duration
compression.summarizer.start     summarizer prompt hash and summary budget
compression.summarizer.finish    summarizer token counts/output hash
agent.run.finish             token counts, steps, duration
agent.run.error              error summary
```

## Langfuse Lookup

In Langfuse, inspect observation/trace metadata and attributes for:

```text
openacme.forensic.run_id
openacme.forensic.lookup
openacme.forensic.evidence_ref
openacme.forensic.event_selector
openacme.forensic.relative_evidence_dir
openacme.session.timeline_locator
langfuse.trace.metadata.forensic_run_id
langfuse.trace.metadata.evidence_ref
langfuse.trace.metadata.timeline_locator
openacme.session.id
openacme.agent.id
openacme.message.id
openacme.task.id
openacme.tool.execution_status
openacme.tool.result_status
openacme.tool.result_classifier
openacme.tool.failure_kind
openacme.tool.failure_message
openacme.tool.exit_code
openacme.tool.process_status
openacme.provider
openacme.model
openacme.usage.total_tokens
```

Interpret `openacme.tool.execution_status` as the wrapper result and
`openacme.tool.result_status` as the tool-domain result. A shell command that
exits non-zero should show `execution_status=ok`,
`result_status=failure`, `result_classifier=shell`, and
`failure_kind=command_exit_nonzero`.

Use Langfuse to identify the suspicious trace/span. Use local DB and local
forensic files to inspect raw evidence.

## Token Spike Recipe

1. Find the largest `usage_events.total_tokens` row.
2. Record `session_id`, `forensic_run_id`, `forensic_path`, `trace_id`,
   provider/model, and `provider_request_count`.
3. Fetch the session timeline with `forensicRunId`.
4. In `events.jsonl`, compare each `provider.request` ordinal.
5. Check tool events between provider requests.
6. Check hidden helper rows:
   - `kind = summarizer` means compression summarizer tokens.
   - `kind = extractor` can include memory extraction or pre-compaction
     memory flush tokens.
   - `kind = selector` means memory recall selection tokens.
   - `kind = title` means background title generation tokens.
   - `kind = autonomous` means a dispatcher-driven agent turn.
   - Timeline rows `session.dispatcher.*` and `session.autonomous.*` explain
     why the autonomous turn started, waited, skipped because of defer, or
     failed.
7. If a tool result is large or spilled, inspect only its size/hash first.
8. Inspect raw `tool-calls/<id>/result.pre-spill.txt` only if the user needs
   content-level proof.
9. Conclude whether the spike came from history size, compression helpers,
   system prompt/tool schema, provider retries, tool output, reasoning tokens,
   or cache behavior.

## Failure Modes

- Missing `forensicRunId`: the turn likely ran before forensics were enabled
  or failed before usage finalization.
- Missing `forensicPath`: usage row exists but local archive was disabled or
  recorder initialization failed.
- Missing Langfuse observation: telemetry exporter may not be enabled, flush
  may not have completed, or trace ids may not match the queried time window.
- Missing raw file: raw capture disabled or `OPENACME_AI_FORENSICS_MAX_RUN_BYTES`
  skipped the file. Check `raw_file.skipped` events.
- Timeline missing forensic events: usage row may not have `forensic_path`, or
  `includeForensics=0` was used.

## Report Template

```text
Anchor:
- sessionId:
- traceId/spanId:
- usageEventId:
- forensicRunId:
- forensicPath:

Sequence:
- user message received:
- turn started:
- prompt snapshot bytes/hash:
- compression helper events:
- provider request ordinals:
- tool calls and output sizes:
- usage finalized:
- turn finished/error:

Finding:
- likely cause:
- evidence:
- raw files inspected: yes/no, list only relative paths
- residual gaps:
```
