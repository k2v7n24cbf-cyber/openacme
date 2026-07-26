# Reporting And Safety

## Chat-Safe Facts

Prefer facts that prove the sequence without exposing content:

```text
sessionId, agentId, messageId, taskId
traceId, spanId, usageEventId, forensicRunId
timelineLocator
provider, model, authMode
usage kind
total/input/output/cached/cache-write/reasoning token counts
cost and equivalent cost
provider request count and ordinals
byte counts and sha256 hashes
durations and timestamps
HTTP status and provider request id
tool name, toolCallId, runtime
executionStatus, resultStatus, resultClassifier, failureKind
relative evidence paths
short human summaries of raw evidence
```

## Do Not Paste

Never paste these into chat:

```text
raw prompts
raw model/provider request bodies
raw provider response bodies
raw tool outputs
tool arguments containing secrets or customer data
OAuth tokens
API keys
cookies
authorization headers
passwords
customer data
absolute local forensic paths when a relative path or id is enough
```

If raw inspection is necessary, inspect locally, keep it minimal, and report
only a summary plus hashes, byte counts, event ids, and relative paths.

## Failure Modes And Blind Spots

Report these explicitly when present:

```text
missing forensicRunId
  The turn likely ran before forensics were enabled, or failed before usage
  finalization.

missing forensicPath
  The usage row exists but local archive capture was disabled, recorder
  initialization failed, or the archive was not persisted.

missing backend observation/span
  The telemetry exporter may be disabled, backend config may be incomplete,
  exporter flush may not have completed, trace ids may not match the queried
  time window, or the backend may have different version/API behavior.

missing raw file
  Raw capture may be disabled, OPENACME_AI_FORENSICS_MAX_RUN_BYTES may have
  skipped the file, the file write may have failed, or retention cleanup may
  have removed it. Check raw_file.written and raw_file.skipped.

timeline missing forensic events
  includeForensics may be 0, the usage row may lack forensic_path, events.jsonl
  may be absent, or the forensic event type may not be projected by the API.

DB/API mismatch
  The API may be connected to a different dataDir or stale server process.
  Confirm health/logs/runtime boundary before concluding data is absent.

backend-specific lookup unavailable
  Use local usage_events, session_timeline_events, and forensics as the
  authoritative fallback.
```

## Report Template

```text
Anchor:
- sessionId:
- agentId:
- messageId/taskId:
- traceId/spanId:
- usageEventId:
- forensicRunId:
- timelineLocator:

Evidence inspected:
- usage rows:
- timeline events:
- local forensic files:
- backend observations/spans:
- logs:
- raw files inspected: yes/no, relative paths only

Sequence:
- user/autonomous trigger:
- turn/helper started:
- prompt snapshot bytes/hash:
- provider request ordinals:
- tool calls and output sizes:
- compression/helper/autonomous events:
- usage finalized:
- turn finished/error:

Finding:
- likely cause:
- token/cost impact:
- evidence:
- confidence:
- residual gaps:
- recommended next action:
```

## Production Handling

For production `~/.openacme`, require explicit user direction before reading
logs, DB rows, local forensic archive metadata, or backend observations. Keep
all commands read-only unless the user asks for a test run or remediation.
