# OpenAcme Workflow Authoring Reference

## Table Of Contents

- Definition shape
- Trigger types
- Node families
- Variables and assignments
- Flow control
- Transform operations
- Logs and errors
- MCP tools
- Agent calls
- Python execution
- UI workflow
- API workflow
- API run inspection
- Run console inspection
- Validation checklist
- Example definitions

## Definition Shape

Minimum workflow definition:

```json
{
  "id": "wf_example",
  "name": "Example workflow",
  "description": "Optional",
  "inputSchema": {
    "type": "object",
    "required": ["customer"],
    "properties": {
      "customer": { "type": "object" }
    }
  },
  "triggers": [{ "id": "manual", "kind": "manual", "enabled": true }],
  "nodes": []
}
```

Ids must match `[A-Za-z0-9][A-Za-z0-9_.-]*`. Use stable ids because branch
references, assignments, run history, and step output paths depend on them.

Optional visual layout metadata:

```json
{
  "ui": {
    "canvas": {
      "nodes": {
        "set_customer": { "position": { "x": 120, "y": 80 } }
      }
    }
  }
}
```

Agents should omit `ui` unless they are preserving or intentionally updating
visual layout. The runner ignores `ui`; execution order, branch/foreach
references, triggers, assignments, MCP calls, agent calls, and Python execution
come only from `triggers` and `nodes`.

## Trigger Types

Manual:

```json
{ "id": "manual_review", "kind": "manual", "enabled": true }
```

Manual with trigger input schema:

```json
{
  "id": "manual_review",
  "kind": "manual",
  "enabled": true,
  "inputSchema": {
    "type": "object",
    "required": ["approvalNote"],
    "properties": { "approvalNote": { "type": "string" } }
  }
}
```

Scheduled:

```json
{
  "id": "nightly",
  "kind": "scheduled",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 2 * * *", "tz": "UTC" },
  "input": { "source": "schedule" }
}
```

Webhook:

```json
{
  "id": "incoming",
  "kind": "webhook",
  "enabled": true,
  "path": "/crm/customer",
  "inputSchema": {
    "type": "object",
    "required": ["source"],
    "properties": { "source": { "const": "crm" } }
  },
  "secretSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Task triggers are modeled but disabled until task dispatch is implemented:

```json
{
  "id": "task_gate",
  "kind": "task",
  "enabled": false,
  "filter": { "queue": "support" }
}
```

Validation rules:

- Trigger ids use the same safe-id pattern as node ids.
- Duplicate trigger ids are invalid.
- Duplicate normalized webhook paths are invalid.
- Manual triggers must stay enabled.
- Scheduled triggers require boolean `enabled` and cron schedule.
- Webhook triggers require boolean `enabled`; `secretSha256`, when present,
  must be a 64-character SHA-256 hex digest.
- Task triggers must stay disabled and require a `filter`.

## Node Families

### `builtin.set`

Set context variables directly:

```json
{
  "id": "set_customer",
  "type": "builtin.set",
  "assign": { "customer": "$.input.customer" }
}
```

### `builtin.transform`

Transform input and assign output:

```json
{
  "id": "normalize",
  "type": "builtin.transform",
  "input": { "customer": "$.context.customer" },
  "transform": { "kind": "identity" },
  "assign": {
    "customer": {
      "from": "$.steps.normalize.output",
      "mode": "replace"
    }
  }
}
```

`transform` may be a direct JSON value, a JSONPath-style reference string, or
one of the supported operation objects listed in Transform Operations.

### Branching With `builtin.if`

Use `builtin.if` for new workflows. It has both true and false routes through
`then` and `else`; do not create new definitions with `builtin.if_else` unless
you are preserving an old definition that already uses it.

```json
{
  "id": "risk_gate",
  "type": "builtin.if",
  "condition": "$.context.customer.riskScore >= 70",
  "then": ["log_review"],
  "else": ["auto_approve"]
}
```

On the canvas, the `then` route is the true route and `else` is the false
route. Add-step actions from the true/false route must append the new node id
to the matching array.

### Foreach

```json
{
  "id": "each_asset",
  "type": "builtin.foreach",
  "items": "$.input.assets",
  "itemVar": "asset",
  "body": ["score_asset"],
  "assign": {
    "assetScores": {
      "from": "$.steps.each_asset.output",
      "mode": "replace"
    }
  }
}
```

Foreach runs a body over `items`; current concurrency is definition-bound to 1.
Body steps can read the current item with the configured `itemVar` name.
The foreach output is the aggregate body output for each item, so assign it to
a context variable when later steps need the aggregate.

### Parallel

Use `builtin.parallel` for independent branches such as N tool calls,
independent enrichments, or "fetch + parse + classify" routes that can run at
the same time.

```json
{
  "id": "parallel_enrichment",
  "type": "builtin.parallel",
  "branches": [
    { "id": "asset", "label": "Asset", "nodes": ["copy_asset"] },
    { "id": "uri", "label": "URI", "nodes": ["parse_uri"] },
    { "id": "ip", "label": "IP", "nodes": ["check_internal"] }
  ],
  "concurrency": 3,
  "failFast": true,
  "assign": {
    "parallelSummary": {
      "from": "$.steps.parallel_enrichment.output",
      "mode": "replace"
    }
  }
}
```

Parallel behavior:

- Each branch starts from a cloned parent context and cloned step-output state.
- Branch-local assignments stay inside the branch result.
- Parent context changes only through the parallel node's own `assign`.
- `concurrency` is optional, defaults to branch count, and must be 1-16.
- `failFast` defaults to true. When true, the first failed branch fails the
  parallel step and aborts siblings. When false, all branches finish and the
  workflow can continue with failed branches recorded in the aggregate.
- Output includes `count`, `succeededCount`, `failedCount`, `canceledCount`,
  `failFast`, `branches`, and `branchOrder`.

### Exit

```json
{
  "id": "exit_success",
  "type": "builtin.exit",
  "status": "succeeded",
  "output": "$.context"
}
```

Valid statuses: `succeeded`, `failed`, `canceled`. The UI does not need to show
an exit card for every workflow, but backend-authored definitions may use exit
to force terminal status and output.

### Throw Error

```json
{
  "id": "fail_invalid_asset",
  "type": "builtin.throw_error",
  "message": "Asset is missing owner",
  "code": "asset_owner_missing",
  "details": { "assetId": "$.context.asset.id" }
}
```

Use this for controlled failures. The run fails with node-specific error
details that are visible in run detail and timeline events.

### Sleep

```json
{
  "id": "wait_for_index",
  "type": "builtin.sleep",
  "delayMs": 1000,
  "reason": "Wait for eventual consistency"
}
```

`delayMs` must be 1-300000. Use sparingly for rate limits or eventual
consistency; do not hide missing synchronization with long sleeps.

### Logs

Use log nodes for operator-visible trace messages:

```json
{
  "id": "log_customer",
  "type": "builtin.log.info",
  "message": "Customer normalized",
  "payload": "$.context.customer"
}
```

Valid log types:

- `builtin.log.info`
- `builtin.log.debug`
- `builtin.log.warn`
- `builtin.log.error`

Log nodes can also have `assign` when the structured log payload or output
needs to be captured into context.

### Python

Python steps execute isolated code with JSON `input` and set `output`:

```json
{
  "id": "py_score",
  "type": "builtin.python",
  "input": { "customer": "$.context.customer" },
  "code": "output = {'score': input['customer'].get('riskScore', 0)}",
  "timeoutMs": 45000,
  "reset": true,
  "assign": {
    "score": "$.steps.py_score.output.score"
  }
}
```

Timeout must be an integer from 100 to 300000 ms.

### MCP Tool

```json
{
  "id": "mcp_echo",
  "type": "mcp.tool",
  "server": "demo",
  "tool": "echo",
  "input": { "message": "$.input.customer.name" },
  "timeoutMs": 30000,
  "assign": {
    "mcpEcho": {
      "from": "$.steps.mcp_echo.output",
      "mode": "replace"
    }
  }
}
```

Use current MCP inventory where available. Do not invent server/tool ids in
production workflows.

### Agent Call

```json
{
  "id": "agent_review",
  "type": "agent.call",
  "agentId": "agent_demo",
  "prompt": "Review workflow input",
  "input": { "customer": "$.context.customer" },
  "timeoutMs": 60000,
  "assign": {
    "agentReview": "$.steps.agent_review.output"
  }
}
```

Agent ids must be real for deployed validation. Use test/dummy agents only in
mocked or demo harnesses.

Do not author `agent.task` nodes in the first workflow release. Durable
agent-task creation, waiting, and resume semantics are a follow-up contract;
the current schema and UI import/export validation reject `agent.task`.

## Variables And Assignments

Workflow variables live in run `context`. Read from:

- `$.input`
- `$.context`
- `$.steps.<nodeId>.output`
- `item` inside foreach bodies

Assignment target keys are context paths:

```json
{
  "assign": {
    "customer.id": "$.input.customer.id",
    "customer": {
      "from": "$.steps.normalize.output",
      "mode": "replace"
    },
    "audit.events": {
      "from": "$.steps.log_event.output",
      "mode": "append"
    }
  }
}
```

Modes:

- `replace` is the default.
- `merge` requires object-compatible values.
- `append` appends to list-like values.

Assignments run only after the step succeeds. Failed steps do not mutate
context.

## Flow Control

Use flow-control nodes to make routing explicit and inspectable:

- `builtin.if`: choose `then` for true and `else` for false.
- `builtin.foreach`: run a body for every item and assign the aggregate output.
- `builtin.parallel`: run independent branch bodies with optional concurrency
  and fail-fast control.
- `builtin.exit`: force a terminal status/output in backend-authored
  definitions.
- `builtin.throw_error`: fail intentionally with structured details.
- `builtin.sleep`: pause briefly for rate limit or eventual consistency.
- `builtin.set` and assign maps: write values into run context.
- `builtin.transform`: normalize, parse, convert, or reshape values.
- `builtin.log.debug/info/warn/error`: write structured timeline logs.

## Transform Operations

`builtin.transform` operation fields may use literal JSON values or references
like `$.input`, `$.context`, `$.steps.<nodeId>.output`, and foreach item
variables. Assign the transform output back to the same context key when you
want an overwrite:

```json
{
  "id": "normalize_customer",
  "type": "builtin.transform",
  "transform": {
    "kind": "string.replace",
    "value": "$.context.customer.name",
    "search": "  ",
    "replacement": " ",
    "all": true
  },
  "assign": {
    "customer.name": {
      "from": "$.steps.normalize_customer.output",
      "mode": "replace"
    }
  }
}
```

Supported operations:

- `object_pick`: fields `source` and `fields`; returns selected object fields.
- `string.replace`: fields `value`, `search`, `replacement`, optional `all`.
- `string.regex_replace`: fields `value`, `pattern`, `replacement`, optional
  `flags`.
- `string.regex_match`: fields `value`, `pattern`, optional `flags`; returns
  `{ matched, match, index, groups, namedGroups }` when matched and
  `{ matched: false, groups: [], namedGroups: {} }` when not.
- `json.parse`: field `value`; parses a JSON string into JSON.
- `json.stringify`: field `value`, optional `pretty`.
- `csv.parse`: field `value`, optional `delimiter`, `headers`, `maxRows`;
  defaults to comma delimiter, headers enabled, and 10000 max rows.
- `csv.stringify`: field `value`, optional `delimiter`, `headers`,
  `includeHeaders`, `maxRows`.
- `ip.parse`: field `value`; returns version, address, normalized, integer,
  and octets/hextets.
- `ip.is_ipv4` and `ip.is_ipv6`: field `value`; return booleans.
- `ip.in_subnet`: fields `value` and `cidr`; returns a boolean.
- `ip.netmask`: fields `prefix` and `version`; returns a netmask string.
- `ip.network`: field `cidr`; returns version, address, prefix, and cidr.
- `uri.parse`: field `value`, optional `base`; returns href, protocol, scheme,
  origin, host, hostname, port, pathname, path, search, query, queryList, hash,
  fragment, username null, password null, and `hasCredentials`. Credentials are
  redacted from `href`.

Transform guardrails:

- Unsupported `kind` values fail the step with a controlled error.
- Invalid regex, JSON, CSV, IP, CIDR, or URI input fails the step with
  operation-specific details.
- CSV input and transform output have size guardrails; inspect artifacts when a
  large field is pruned.

## UI Workflow

Human operators can use the UI to create and test workflows. Workflow-authoring
agents should create workflow definitions through the API or import/export JSON
path, then use Playwright only when validating UI behavior.

1. Open `/workflows`.
2. Create or select a workflow. New workflow creation should first choose a
   trigger. For now, choose a manual trigger.
3. Use canvas cards and the right inspector for human editing.
4. Add steps from the `+` buttons under cards or true/false/branch route
   buttons so the route reference is created with the new node.
5. Click **Save** to persist draft changes.
6. Fill **Run input** in Test Configuration.
7. Click **Test** for draft execution.
8. Inspect Run History and the selected run detail.
9. Open each relevant step and inspect input, output, logs, and errors.
10. Click **Publish** after a passing test.
11. Click trigger-card **Run** for published runnable triggers.
12. Use **Export** for `openacme.workflow.definition.v1` snapshots.
13. Use **Import workflow file** to create a new draft from a snapshot.

Import is intentionally non-destructive in the first workflow release. Imported
files always create a new `wf_import_...` draft, even when the exported
`workflow.id` matches an existing workflow. Do not rely on import for overwrite
or merge behavior.

Current UI local prevalidation covers node references, node shape, trigger
shape, trigger identity, import/export shape, save, publish, test/live, and
trigger-card run paths. Server validation remains authoritative.

## API Workflow

First-release workflow definitions and run history are global. Do not send
`teamId`, `agentId`, or `ownerId` filters to workflow list APIs; those scoping
contracts are future work.

Agents must discover external callable inventory through the workflow API
before authoring nodes that call external capabilities. Do not assume the
authoring agent already knows every installed MCP server, tool name, tool
description, or parameter schema.

The workflow API inventory endpoints are the runtime source of truth. Refresh
them before creating or validating an external-call node because connected MCP
servers and their tool schemas can change between authoring sessions.

Every human UI operation must have an agent path:

- Human **New**: agent calls `POST /api/workflows`.
- Human **Edit cards / JSON**: agent edits the workflow definition JSON.
- Human canvas drag/layout: agent may preserve or update optional
  `ui.canvas.nodes.<nodeId>.position`, but usually omits `ui`.
- Human MCP tool picker/inventory: agent calls `GET /api/workflows/mcp/tools`.
- Human agent picker/inventory: agent calls `GET /api/workflows/agents`.
- Human **Save**: agent calls `PATCH /api/workflows/:workflowId`.
- Human **Test**: agent calls `POST /api/workflows/:workflowId/runs/test`.
- Human **Publish**: agent calls `POST /api/workflows/:workflowId/publish`.
- Human **Delete**: agent calls `DELETE /api/workflows/:workflowId`; this
  archives the definition, hides it from the default list, and preserves run
  history.
- Human trigger-card **Run**: agent calls
  `POST /api/workflows/:workflowId/triggers/:triggerId/runs`.
- Human **Runs / history**: agent calls `GET /api/workflows/:workflowId/runs`
  or `GET /api/workflow-runs`.
- Human Run Console step inspection: agent calls
  `GET /api/workflow-runs/:runId` and reads `steps[]` plus `events[]`.
- Human **Cancel**: agent calls `POST /api/workflow-runs/:runId/cancel`.
- Human **Rerun**: agent calls `POST /api/workflow-runs/:runId/rerun`.
- Human **Export**: agent serializes an
  `openacme.workflow.definition.v1` snapshot from the workflow definition.
- Human **Import**: agent posts a new draft using a `wf_import_...` id after
  validating the snapshot; import does not overwrite or merge.

Create:

```http
POST /api/workflows
```

Draft update:

```http
PATCH /api/workflows/:workflowId
```

`PATCH /api/workflows/:workflowId` accepts optional `ui` metadata. Send
`ui: null` to clear visual layout without changing execution behavior.

Archive/delete:

```http
DELETE /api/workflows/:workflowId
```

Default workflow lists hide archived definitions. To inspect archived
definitions intentionally:

```http
GET /api/workflows?status=archived
```

MCP tool inventory:

```http
GET /api/workflows/mcp/tools
```

The response is:

```json
{
  "tools": [
    {
      "server": "crm",
      "tool": "lookup",
      "name": "mcp_crm__lookup",
      "description": "Lookup customer",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" }
        },
        "required": ["id"]
      }
    }
  ]
}
```

Use `server` and `tool` exactly in `mcp.tool` nodes. Use `description` to pick
the intended capability and `inputSchema` to build the node `input` object from
`$.input`, `$.context`, `$.steps`, or foreach `item` references. If the needed
tool is absent from the inventory, stop and report the missing capability
instead of inventing ids or parameters.

An authoring agent does not need prior knowledge of every MCP tool. It should
derive the available capabilities from this response, then map workflow values
into the JSON object required by each selected tool's `inputSchema`.

Agent inventory:

```http
GET /api/workflows/agents
```

Use the returned agent ids for `agent.call` nodes. Do not guess agent ids from
display names.

Publish:

```http
POST /api/workflows/:workflowId/publish
```

Draft test run:

```http
POST /api/workflows/:workflowId/runs/test
```

Live run:

```http
POST /api/workflows/:workflowId/runs/live
```

Trigger run:

```http
POST /api/workflows/:workflowId/triggers/:triggerId/runs
```

Run detail:

```http
GET /api/workflow-runs/:runId
```

Cancel:

```http
POST /api/workflow-runs/:runId/cancel
```

Rerun:

```http
POST /api/workflow-runs/:runId/rerun
```

Run history:

```http
GET /api/workflows/:workflowId/runs
GET /api/workflow-runs
```

Useful run-history filters include `status`, `mode`, `workflowId`,
`triggerId`, `createdFrom`, `createdTo`, `limit`, and `offset`. Use these
instead of scraping the UI when a user asks for the last runs, failed runs,
test-only runs, or runs in a time window.

## API Run Inspection

Workflow-authoring agents should inspect runs through API responses, not
Playwright.

List recent runs for one workflow:

```http
GET /api/workflows/:workflowId/runs?limit=25
```

List failed runs for one workflow:

```http
GET /api/workflows/:workflowId/runs?status=failed&limit=25
```

List recent runs globally:

```http
GET /api/workflow-runs?limit=25
```

List failed runs globally:

```http
GET /api/workflow-runs?status=failed&limit=25
```

Get one run with step attempts and events:

```http
GET /api/workflow-runs/:runId
```

In the run detail response:

- `run.status` is the terminal or current run state.
- `run.input` is the submitted run input.
- `run.context` is the final or current workflow context.
- `steps[]` contains per-step attempts. Find by `nodeId`; foreach body steps
  can have multiple attempts.
- `steps[].input`, `steps[].output`, `steps[].error`, `steps[].logsSummary`,
  and `steps[].contextDiff` are the primary debugging fields.
- `durationMs` is persisted for runs and step attempts. Use it for elapsed-time
  evidence instead of calculating from display text.
- `events[]` contains the ordered audit trail. Use `kind: "step_failed"` for
  error chronology, `kind: "branch_selected"` for if routing, `kind: "log"` for
  builtin log nodes, and the `parallel_*` event kinds for parallel branch
  execution.

Step lookup recipe:

1. Fetch `GET /api/workflow-runs/:runId`.
2. Find attempts with `steps.filter(step => step.nodeId === "<nodeId>")`.
3. For foreach body steps, expect multiple attempts with the same `nodeId`.
4. Read `input`, `output`, `error`, `logsSummary`, and `contextDiff`.
5. If the field is an artifact reference or a pruned marker, fetch the artifact
   endpoint before claiming the value is unavailable.
6. Cross-check timeline events for the same `stepRunId` when diagnosing order,
   branch selection, parallel branch status, or structured logs.

Parallel output inspection:

- Read the parent parallel step output at
  `$.steps.<parallelNodeId>.output`.
- Use `branches.<branchId>.status` and `branches.<branchId>.error` to find
  failed branches.
- Use `branches.<branchId>.steps` for branch-local step outputs and
  `branches.<branchId>.context` for branch-local assigned variables.
- If `failFast` is false, the workflow may succeed with
  `failedCount > 0`; inspect the aggregate before treating success as
  all-branches-success.

When a step field contains an artifact reference, fetch it through:

```http
GET /api/workflow-runs/:runId/artifacts/:artifactId
```

## Run Console Inspection

For every test or live validation, capture:

- Workflow id and version/source.
- Run id.
- Trigger kind and trigger id.
- Run mode: `test` or `live`.
- Final run status.
- Step statuses and failed/skipped branches.
- Selected step input, output, error, logs, and context diff.
- Timeline events, especially `step_failed`, `branch_selected`, and
  `run_completed`.
- Final context values proving the workflow goal.
- Artifact links or pruned artifact messages for large payloads.

## Validation Checklist

Before closing a workflow authoring task:

- Safe ids for workflow, triggers, and nodes.
- No duplicate node ids.
- No duplicate trigger ids.
- No duplicate normalized webhook paths.
- `builtin.if` true/false route references point to existing node ids.
- `builtin.foreach` body references point to existing node ids.
- `builtin.parallel` branch ids are unique and branch node references point to
  existing node ids.
- New workflow definitions use `builtin.if` rather than `builtin.if_else`.
- Required node fields are present.
- Assignment targets are dotted context paths.
- `append` targets are arrays or missing; `merge` targets and values are
  objects.
- Trigger schemas match intended run input.
- MCP tools and agent calls are selected from current API inventory.
- Save succeeds.
- Test run succeeds or fails intentionally with inspected evidence.
- Publish succeeds only after test evidence.
- Published trigger run succeeds when the workflow has a runnable trigger.
- Run console or API evidence records run id, status, duration, step
  input/output/log/error, selected route, final context, and artifacts.
- Deployed smoke uses `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`
  and a non-3456 port such as `3458`.

## Example Definition

```json
{
  "id": "wf_customer_review",
  "name": "Customer Review",
  "inputSchema": {
    "type": "object",
    "required": ["customer"],
    "properties": {
      "customer": {
        "type": "object",
        "required": ["id", "name"],
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "riskScore": { "type": "number" }
        }
      }
    }
  },
  "triggers": [
    {
      "id": "manual_review",
      "kind": "manual",
      "enabled": true,
      "inputSchema": {
        "type": "object",
        "required": ["approvalNote"],
        "properties": { "approvalNote": { "type": "string" } }
      }
    }
  ],
  "nodes": [
    {
      "id": "set_customer",
      "type": "builtin.set",
      "assign": { "customer": "$.input.customer" }
    },
    {
      "id": "risk_gate",
      "type": "builtin.if",
      "condition": "$.context.customer.riskScore >= 70",
      "then": ["log_review"],
      "else": ["exit_success"]
    },
    {
      "id": "log_review",
      "type": "builtin.log.info",
      "message": "Manual review required",
      "payload": "$.context.customer"
    },
    {
      "id": "exit_success",
      "type": "builtin.exit",
      "status": "succeeded",
      "output": "$.context.customer"
    }
  ]
}
```
