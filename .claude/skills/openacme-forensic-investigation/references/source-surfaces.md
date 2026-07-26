# Source Surfaces

## Runtime Boundaries

Default to the test runtime unless the user explicitly asks for production:

```text
test dataDir: ~/.openacme-test
test database: ~/.openacme-test/state.db
test local forensics: ~/.openacme-test/ai-forensics/YYYY-MM-DD/<forensicRunId>/
test API: http://127.0.0.1:3457
production dataDir: ~/.openacme
```

Use read-only operations for forensic work. Prefer API reads when they provide
the needed data. Use direct SQLite reads only for ledger/timeline drill-down or
when the API is unavailable. Never write to `state.db`.

## Source Of Truth

Use each surface for the job it owns:

```text
usage_events                source of truth for token/cost accounting
session_timeline_events     source of truth for ordered session lifecycle
GET /api/sessions/:id/timeline
  ?includeForensics=1       API projection of DB timeline plus local forensic JSONL
local ai-forensics/         source of truth for hashes, byte counts, event JSONL,
                            and optional raw prompt/provider/tool files
OpenTelemetry backend       trace/span correlation UI; useful for finding traceId,
                            spanId, evidenceRef, and timelineLocator
logs                        operational diagnostics, not token accounting
```

Logs are still important for runtime failures:

```text
daemon log: <dataDir>/openacme.log
terminal UI log: <dataDir>/openacme-tui.log
CLI tail: openacme logs -f
override sink: OPENACME_LOG_FILE=/path/to/file
```

## Observability Backend Routing

Inspect the active observability configuration before using a backend-specific
UI or API. The runtime resolves:

```text
OPENACME_OBSERVABILITY=off|logfire|langfuse|otlp
OPENACME_TELEMETRY=true|1|yes  legacy path; maps to Logfire when no explicit backend is set
OPENACME_TELEMETRY_SERVICE_NAME  service name, default openacme
```

Backend requirements:

```text
off       no remote traces; use logs, usage_events, timeline, local forensics
otlp      OPENACME_OTLP_TRACES_ENDPOINT, optional OPENACME_OTLP_LOGS_ENDPOINT,
          optional OPENACME_OTLP_HEADERS
logfire   LOGFIRE_TOKEN, optional LOGFIRE_ENDPOINT and LOGFIRE_LOGS_ENDPOINT
langfuse  LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
```

Do not assume Langfuse is active. If the resolved backend is Langfuse, confirm
the configured base URL and the deployed version/API behavior before using
Langfuse-specific UI/readback steps. Do not assume a fixed UI shape, API path,
or installed Langfuse skill name. Use OpenTelemetry/OpenAcme attributes as the
portable contract.

Do not open secret files just to discover credentials. If backend env values
are visible through process configuration, logs, or user-provided runtime
context, treat tokens and keys as secrets and never echo them.

## Correlation Fields

Build every investigation around these ids:

```text
sessionId          OpenAcme chat/session id
agentId            OpenAcme agent id
messageId          user message id for interactive turns
taskId             task id for autonomous/helper work when available
traceId            OpenTelemetry trace id
spanId             OpenTelemetry span/observation id
usageEventId       usage_events.id
forensicRunId      local forensic archive id
forensicPath       absolute local archive path, only in local DB/API
evidenceRef        openacme://forensics/<runId>#<eventType>:<selector>
timelineLocator    /api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<runId>
```

## API Commands

Health:

```bash
curl -sS -H 'host: 127.0.0.1' http://127.0.0.1:3457/api/health
```

Usage events:

```bash
curl -sS "http://127.0.0.1:3457/api/usage/events?limit=200"
```

Session timeline:

```bash
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&limit=300"
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<runId>&limit=300"
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&traceId=<traceId>&limit=300"
curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&usageEventId=<usageEventId>&limit=300"
```

Timeline events are returned oldest first. Use `limit` up to 1000. Use the
`after` cursor only when paging is required.

## Read-Only SQL

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
  auth_mode,
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

Rows for one session:

```sql
SELECT
  id,
  created_at,
  kind,
  provider,
  model,
  auth_mode,
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
WHERE session_id = '<sessionId>'
ORDER BY created_at ASC, rowid ASC;
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
ORDER BY created_at DESC, rowid DESC;
```

Session timeline table:

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
