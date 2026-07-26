# Evidence Resolution

## EvidenceRef Contract

`evidenceRef` is the backend-safe pointer from an OpenTelemetry observation to
local evidence. It never contains a raw prompt/body/output or an absolute local
filesystem path.

```text
openacme://forensics/<runId>#agent.run
openacme://forensics/<runId>#provider.request:1
openacme://forensics/<runId>#provider.response:1
openacme://forensics/<runId>#tool.start:call_abc
openacme://forensics/<runId>#tool.finish:call_abc
openacme://forensics/<runId>#compression.memory_flush
openacme://forensics/<runId>#compression.summarizer
```

Use `openacme.forensic.event_selector` and
`openacme.forensic.relative_evidence_dir` when present. They exist to avoid
large searches.

## Deterministic Resolution

For `openacme://forensics/run_abc#tool.finish:call_42`:

1. Parse `run_abc` as `forensicRunId`.
2. Query `usage_events` for that run id:

   ```sql
   SELECT
     id,
     session_id,
     task_id,
     message_id,
     forensic_run_id,
     forensic_path,
     trace_id,
     span_id
   FROM usage_events
   WHERE forensic_run_id = 'run_abc'
   ORDER BY created_at DESC, rowid DESC;
   ```

3. Read `<forensic_path>/events.jsonl`.
4. Match the fragment by event type and selector:

   ```text
   agent.run                   type = agent.run.start or agent.run.finish
   provider.request:<n>        type = provider.request and data.ordinal = n
   provider.response:<n>       type = provider.response and data.ordinal = n
   tool.start:<id>             type = tool.start and data.toolCallId = id
   tool.finish:<id>            type = tool.finish and data.toolCallId = id
   compression.memory_flush    type = compression.memory_flush.start
                                or compression.memory_flush.finish
   compression.summarizer      type = compression.summarizer.start
                                or compression.summarizer.finish
   ```

5. For the example, the exact JSONL row is:

   ```text
   type = tool.finish
   data.toolCallId = call_42
   ```

6. The local raw-file area is normally:

   ```text
   <forensic_path>/tool-calls/call_42/
   ```

   If the matched JSONL row has `data.relativeEvidenceDir`, prefer that
   relative directory.

## Local Archive Layout

Use `events.jsonl` before opening raw files:

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

Provider request ordinal 2 lives under:

```text
<forensic_path>/provider-requests/2-<provider>-<model>/
```

Tool call `call_42` lives under:

```text
<forensic_path>/tool-calls/call_42/
```

Raw files exist only when `OPENACME_AI_FORENSICS_CAPTURE_RAW=1`. Raw files may
also be absent when raw capture was disabled, the run exceeded
`OPENACME_AI_FORENSICS_MAX_RUN_BYTES`, the recorder failed to initialize, the
file write failed, or retention cleanup removed the archive. Check
`raw_file.written` and `raw_file.skipped` rows in `events.jsonl`.

## Forensic JSONL Events

Look for these local event types:

```text
agent.run.start               turn metadata and trace/span
agent.model_input.snapshot    hashes and byte counts of final model input
provider.request              provider/model/url/header/request hash by ordinal
provider.response             status/request id/response hash by ordinal
provider.error                upstream fetch exception
tool.start                    tool args hash/size by toolCallId
tool.finish                   output hash/size/spill facts and result outcome
tool.error                    wrapper/handler exception
compression.memory_flush.start
compression.memory_flush.finish
compression.memory_flush.error
compression.summarizer.start
compression.summarizer.finish
compression.summarizer.error
agent.run.finish              token counts, steps, duration
agent.run.error               error summary
raw_file.written              raw local evidence file was written
raw_file.skipped              raw local evidence file was skipped
```

## Backend Attributes

Search the configured OpenTelemetry backend for OpenAcme attributes, not raw
content:

```text
openacme.forensic.run_id
openacme.forensic.lookup
openacme.forensic.evidence_ref
openacme.forensic.event_selector
openacme.forensic.relative_evidence_dir
openacme.session.id
openacme.session.timeline_locator
openacme.agent.id
openacme.message.id
openacme.task.id
openacme.provider
openacme.model
openacme.auth_mode
openacme.usage.kind
openacme.tool.name
openacme.tool.call_id
openacme.tool.execution_status
openacme.tool.result_status
openacme.tool.result_classifier
openacme.tool.failure_kind
openacme.tool.failure_message
openacme.tool.exit_code
openacme.tool.process_status
```

If the backend is Langfuse, OpenAcme may also mirror selected fields into
`langfuse.trace.metadata.*` or `langfuse.observation.metadata.*`. Confirm that
on the deployed version before relying on specific UI labels or API response
shape.
