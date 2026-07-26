# MCP Observability Contract

## Goal

Every MCP tool call in OpenAcme must be explainable from three views:

1. Langfuse/OpenTelemetry: searchable trace and span attributes.
2. Session timeline: ordered session events with safe status and metadata.
3. Local AI forensics: raw evidence references, hashes, byte counts, and
   bounded tool outcome fields.

The MCP server should express domain result semantics. OpenAcme should convert
those semantics into telemetry and local evidence.

## Current OpenAcme Surfaces

Relevant code:

```text
packages/mcp-client/src/client.ts            HTTP/SSE MCP connect, discover, call
packages/server/src/agent-manager.ts         stdio MCP discovery proxy registration
packages/tool-host/src/worker.ts             worker-side stdio MCP execution
packages/tools/src/registry.ts               tool invocation and telemetry emission
packages/tools/src/outcome.ts                result classifiers
packages/server/src/routes/session-timeline.ts timeline forensic merge
```

MCP tools are registered as:

```text
name: mcp_<server>__<tool>
toolset: mcp-<server>
```

All MCP calls must pass through `ToolRegistry`, which emits:

```text
tool.start
tool.finish
tool.error
openacme.tool.execute
```

## Result Model

Separate wrapper execution from domain result:

```text
executionStatus=ok       OpenAcme invoked the tool handler successfully
executionStatus=error    Tool handler threw or registry caught an exception

resultStatus=success     Tool completed the requested domain action
resultStatus=failure     Tool completed transport-wise but failed logically
resultStatus=partial     Tool produced partial usable output with warnings
resultStatus=running     Tool started async work that is still running
resultStatus=unknown     Result could not be confidently classified
```

Example: an MCP tool can have `executionStatus=ok` and
`resultStatus=failure` when the MCP server returned `isError=true`.

## OpenAcme-Owned MCP Tool Envelope

Prefer JSON text or `structuredContent` with this shape:

```json
{
  "success": true,
  "status": "success",
  "data": {},
  "resultCount": 0,
  "warnings": []
}
```

Failure:

```json
{
  "success": false,
  "status": "failure",
  "failureKind": "validation_error",
  "error": "The required field `projectId` is missing.",
  "retryable": false
}
```

Partial:

```json
{
  "success": true,
  "status": "partial",
  "data": {},
  "warnings": ["3 records were skipped because access was denied."],
  "failureKind": "partial_permission_denied"
}
```

Rules:

- Use `success=false` only when the requested domain action failed.
- Use `success=true` and `resultCount=0` for valid empty results.
- Keep `error` short and safe.
- Put large payloads in tool output or local files as appropriate, not in
  telemetry fields.
- Never include secrets, tokens, cookies, credentials, or absolute local paths.

## Failure Kind Taxonomy

Use stable, bounded strings:

```text
validation_error
auth_required
permission_denied
rate_limited
timeout
upstream_error
mcp_server_disconnected
mcp_protocol_error
mcp_tool_is_error
tool_exception
partial_permission_denied
unknown_error
```

Domain-specific additions are allowed when they are stable and useful, for
example `qualys_asset_not_found` or `jira_issue_not_found`.

## Target MCP Adapter Behavior

When changing `@openacme/mcp-client`, preserve MCP-native result facts before
they are flattened into text:

```text
mcp.server
mcp.tool
mcp.transport
mcp.is_error
mcp.content_types
mcp.has_structured_content
mcp.timeout_seconds
```

Do not change model-facing output only to make telemetry easier. If native MCP
metadata is needed for classification, extend the adapter or classifier path so
the model still receives the intended tool content while telemetry receives
bounded outcome facts.

Recommended classification attributes:

```text
openacme.tool.result_classifier=mcp
openacme.tool.result_status=failure
openacme.tool.failure_kind=mcp_tool_is_error
openacme.tool.outcome.mcp_server=<server>
openacme.tool.outcome.mcp_tool=<tool>
openacme.tool.outcome.mcp_is_error=true
```

## Tests

Minimum focused tests:

```text
packages/mcp-client test:
  - MCP result with isError=false classifies success
  - MCP result with isError=true classifies failure
  - disconnected server returns failureKind=mcp_server_disconnected
  - timeout returns failureKind=timeout
  - malformed/protocol error returns failureKind=mcp_protocol_error

packages/tools test:
  - MCP classifier maps common JSON envelopes
  - classifier failure is contained and does not change output

packages/server e2e:
  - HTTP MCP tool call appears in timeline and local forensics
  - stdio MCP proxy preserves classifier behavior after worker execution
```

Use TDD: write or update failing assertions before implementation.

## Validation Commands

Use the narrowest validation that proves the slice:

```bash
pnpm --filter @openacme/mcp-client test
pnpm --filter @openacme/tools test -- outcome.test.ts forensics.test.ts
pnpm --filter @openacme/server exec vitest run test/e2e/mcp.e2e.ts --config vitest.e2e.config.ts
pnpm --filter @openacme/mcp-client build
pnpm --filter @openacme/tools build
pnpm --filter @openacme/server build
```

If the e2e test binds `127.0.0.1` and the sandbox returns `listen EPERM`,
rerun the same command outside the sandbox with approval.

## Live Langfuse Verification

Run live checks only against `~/.openacme-test`.

Expected Langfuse observation:

```text
name=openacme.tool.execute
openacme.tool.name=mcp_<server>__<tool>
openacme.toolset=mcp-<server>
openacme.tool.execution_status=ok
openacme.tool.result_status=<success|failure|partial|running|unknown>
openacme.tool.result_classifier=mcp
openacme.tool.failure_kind=<when failure or partial>
openacme.forensic.evidence_ref=<present>
openacme.session.timeline_locator=<present>
```

Expected local forensic row:

```text
type=tool.finish
data.toolName=mcp_<server>__<tool>
data.resultStatus=<status>
data.resultClassifier=mcp
data.failureKind=<when applicable>
data.evidenceRef=openacme://forensics/<runId>#tool.finish:<toolCallId>
```

Expected timeline:

```text
eventType=tool.finish
source=forensic
status=error for resultStatus=failure
payload.resultClassifier=mcp
payload.failureKind=<bounded kind>
```
