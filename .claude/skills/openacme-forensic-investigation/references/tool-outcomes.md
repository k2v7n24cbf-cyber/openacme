# Tool Outcomes

## Event Surfaces

Tool execution appears in three places:

```text
OpenTelemetry span: openacme.tool.execute
local forensic JSONL: tool.start, tool.finish, tool.error
session timeline: tool.start, tool.finish, tool.error when includeForensics=1
```

Use `tool.start` for args size/hash and `tool.finish` for output size/hash,
spill facts, and logical result classification. Use `tool.error` when the
wrapper or handler threw before a normal result was produced.

## Wrapper Status Versus Result Status

Two fields answer different questions:

```text
executionStatus   wrapper/handler execution status: ok or error
resultStatus      tool-domain result status: success, failure, partial,
                  running, or unknown
```

Interpretation:

```text
executionStatus=ok + resultStatus=success   tool returned and domain result succeeded
executionStatus=ok + resultStatus=failure   tool returned but domain result failed
executionStatus=error                       wrapper/handler threw; inspect tool.error
resultStatus=partial                        returned partial usable data with a problem
resultStatus=running                        long-running process is still running
resultStatus=unknown                        classifier could not determine outcome
```

## Required Attributes

Use these OpenTelemetry/local forensic fields:

```text
openacme.tool.name
openacme.toolset
openacme.tool.call_id
openacme.tool.runtime
openacme.tool.execution_status
openacme.tool.result_status
openacme.tool.result_classifier
openacme.tool.failure_kind
openacme.tool.failure_message
openacme.tool.exit_code
openacme.tool.process_status
openacme.tool.success_flag
openacme.tool.ok_flag
openacme.tool.parsed_json
openacme.tool.spilled
openacme.tool.worker_dispatched
openacme.tool.outcome.<key>
```

Local `tool.finish` rows also include:

```text
resultPreSpillBytes
resultPreSpillSha256
resultPostSpillBytes
resultPostSpillSha256
spilled
spillPath
rawPreSpillFile
rawPostSpillFile
relativeEvidenceDir
evidenceRef
eventSelector
```

## Shell Results

A shell command that exits non-zero should be classified as a logical result
failure, not a wrapper failure:

```text
executionStatus = ok
resultStatus = failure
resultClassifier = shell
failureKind = command_exit_nonzero
exitCode = <nonzero code>
openacme.tool.outcome.command_family = shell
```

Timeout-like shell results use:

```text
failureKind = command_timeout
```

## Process Results

Process tool classification adds `processStatus` and action outcome facts:

```text
processStatus = running    resultStatus = running
processStatus = timed_out  resultStatus = failure, failureKind = process_timeout
processStatus = killed     resultStatus = failure, failureKind = process_killed
processStatus = exited and exitCode != 0
                           resultStatus = failure, failureKind = process_exit_nonzero
```

## Filesystem Results

Filesystem tools use `resultClassifier=filesystem` and operation attributes:

```text
read_file      operation=read
write_file     operation=write
list_files     operation=list
search_files   operation=search
edit           operation=edit
apply_patch    operation=patch
```

Expected failure kinds include:

```text
file_not_found
file_not_regular
file_too_large
file_unsupported_binary
file_permission_denied
partial_filesystem_error
patch_parse_error
patch_apply_error
edit_no_match
edit_ambiguous_match
no_change
validation_error
filesystem_error
```

For `list_files`, a result with some unreadable entries can be
`resultStatus=partial` instead of total failure.

## MCP And Custom Tools

Custom tools should register a `classifyResult` function when their output has
domain-specific success/failure semantics. Without that, the default
classifier only parses JSON fields such as `success`, `ok`, `error`,
`message`, and `reason`. If output is not parseable JSON, the default is
`resultStatus=success` with `resultClassifier=default`.

For MCP tools, treat native protocol failures, disconnected servers, and
transport errors as wrapper/tool errors when they surface as `tool.error`.
Treat successful protocol responses with domain-level errors as logical result
failures only when a classifier can identify them.

## Tool Evidence Lookup

For `openacme://forensics/run_abc#tool.finish:call_42`:

```text
usage_events.forensic_run_id = run_abc
events.jsonl row: type = tool.finish, data.toolCallId = call_42
raw area: <forensic_path>/tool-calls/call_42/
likely raw files:
  args.json
  result.pre-spill.txt
  result.post-spill.txt
```

Read `events.jsonl` first and use sizes/hashes/statuses before opening raw
files.
