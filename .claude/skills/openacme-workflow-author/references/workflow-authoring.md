# OpenAcme Workflow Authoring Reference

## Table Of Contents

- Definition shape
- Trigger types
- Node families
- Variables and assignments
- Flow control
- Logs and errors
- MCP tools
- Agent calls
- Python execution
- UI workflow
- API workflow
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

### Branching

If:

```json
{
  "id": "branch_ready",
  "type": "builtin.if",
  "condition": "$.input.ready",
  "then": ["log_ready"]
}
```

If/else:

```json
{
  "id": "risk_gate",
  "type": "builtin.if_else",
  "condition": "$.context.customer.riskScore >= 70",
  "then": ["manual_review"],
  "else": ["auto_approve"]
}
```

### Foreach

Foreach runs a body over `items`; current concurrency is definition-bound to 1:

```json
{
  "id": "each_customer",
  "type": "builtin.foreach",
  "items": "$.input.customers",
  "itemVar": "customer",
  "body": ["score_customer"],
  "assign": {
    "scores": {
      "from": "$.steps.each_customer.output",
      "mode": "replace"
    }
  }
}
```

### Exit

```json
{
  "id": "exit_success",
  "type": "builtin.exit",
  "status": "succeeded",
  "output": "$.context"
}
```

Valid statuses: `succeeded`, `failed`, `canceled`.

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
- `builtin.log.error`

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

## UI Workflow

Human operators can use the UI to create and test workflows. Workflow-authoring
agents should create workflow definitions through the API or import/export JSON
path, then use Playwright only when validating UI behavior.

1. Open `/workflows`.
2. Create or select a workflow.
3. Edit `Input Schema JSON`, `Triggers JSON`, and `Nodes JSON` directly or use
   structured cards.
4. Click **Save** to persist draft changes.
5. Fill **Run input**.
6. Click **Test** for draft execution.
7. Inspect **Run Console**.
8. Click **Publish** after a passing test.
9. Click trigger-card **Run** for published runnable triggers.
10. Use **Export** for `openacme.workflow.definition.v1` snapshots.
11. Use **Import workflow file** to create a new draft from a snapshot.

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
- `events[]` contains the ordered audit trail. Use `kind: "step_failed"` for
  error chronology, `kind: "branch_selected"` for flow control, and
  `kind: "log"` for builtin log nodes.

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
- Branch and foreach references point to existing node ids.
- Required node fields are present.
- Assignment targets are dotted context paths.
- Trigger schemas match intended run input.
- Save succeeds.
- Test run succeeds or fails intentionally with inspected evidence.
- Publish succeeds only after test evidence.
- Published trigger run succeeds when the workflow has a runnable trigger.
- Run console evidence is recorded.
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
      "type": "builtin.if_else",
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
