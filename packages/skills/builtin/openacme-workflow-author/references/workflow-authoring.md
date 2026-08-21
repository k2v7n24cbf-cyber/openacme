# OpenAcme Workflow Authoring Reference

## Table Of Contents

- Definition shape
- Trigger types
- Node families
- References, step ids, and variables
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
references, variables, run history, and step output paths depend on them.

`nodes[]` is definition inventory/editor order, not an implicit execution
chain. Add explicit continuation edges with `next`:

```json
[
  {
    "id": "start",
    "type": "builtin.log.info",
    "message": "Start",
    "next": ["normalize"]
  },
  {
    "id": "normalize",
    "type": "builtin.transform.value_resolve",
    "transform": { "kind": "value.resolve", "value": "$.workflowTrigger.input" }
  }
]
```

If `start.next` is omitted, `normalize` will not run merely because it appears
after `start` in `nodes[]`.

Step ids are the keys used in `$.steps.<stepId>.*` references. Human labels may
contain spaces, but ids must be clean slugs. In the UI, changing a label derives
a new slug id and rewrites existing `$.steps.<oldId>` references plus route and
canvas metadata. Agents editing JSON directly must perform the same reference
rewrite when renaming ids.

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
references, triggers, context writes, MCP calls, agent calls, and Python execution
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

Use standard JSON Schema for every workflow or trigger `inputSchema`. Do not
invent custom verification or blueprint objects. Complex arrays must describe
their item object shape explicitly:

```json
{
  "type": "object",
  "required": ["assets"],
  "properties": {
    "assets": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id", "hostname", "vulnerabilities"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "hostname": { "type": "string" },
          "vulnerabilities": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["qid", "severity"],
              "properties": {
                "qid": { "type": "string" },
                "severity": { "type": "integer", "minimum": 1, "maximum": 5 },
                "title": { "type": "string" }
              }
            }
          }
        }
      }
    }
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
  "assign": { "customer": "$.workflowTrigger.input.customer" }
}
```

### `builtin.output.set`

Set the workflow's caller-facing final output explicitly:

```json
{
  "id": "set_final_output",
  "type": "builtin.output.set",
  "path": "result",
  "value": "$.steps.normalize.output.value",
  "mode": "replace"
}
```

`path` is a dotted output path such as `result`, `result.summary`, or
`assets.prioritized`. Valid modes are `replace`, `merge`, and `append`. Use
`builtin.output.set` whenever another agent, workflow, UI, or API caller needs
a stable output contract. When `outputSchema` is declared, validation expects
required top-level fields to be covered by `builtin.output.set` cards.

### Transformer Nodes

Use concrete transformer node types; do not use a generic `builtin.transform`
node. The transformed value is available at `$.steps.<stepId>.output.value`;
add an explicit `builtin.set` step afterwards when the normalized value should
become a context variable:

```json
[
  {
    "id": "normalize",
    "type": "builtin.transform.object_pick",
    "input": { "customer": "$.context.customer" },
    "transform": {
      "kind": "object_pick",
      "source": "customer",
      "fields": ["id", "name", "riskScore"]
    }
  },
  {
    "id": "set_normalized_customer",
    "type": "builtin.set",
    "assign": {
      "customer": {
        "from": "$.steps.normalize.output.value",
        "mode": "replace"
      }
    }
  }
]
```

`transform` must be an operation object with a `kind` matching the node type.
For example, `builtin.transform.uri_parse` must use
`{ "kind": "uri.parse", ... }`.

Human UI authoring exposes transform operations as separate cards under the
`Transformers` add-step family, such as `String Replace`, `Regex Match`,
`JSON Parse`, `CSV Parse`, `IP Network`, and `URI Parse`. These save as concrete
node types such as `builtin.transform.string_replace`,
`builtin.transform.json_parse`, and `builtin.transform.uri_parse`. The UI should
use operation-specific inputs, textareas, selects, and toggles instead of
exposing a raw transform JSON editor.

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
route. These arrays are route entry points, not path inventories. Add-step
actions from the true/false route should set the matching array to the selected
entry node id, usually a single value. Continue from that entry with
`entry.next = ["next_step"]`.

Normal continuation after a routed card is still explicit. For example, if
`risk_gate.then` starts at `log_review` and the flow should continue to
`notify_owner`, set `log_review.next = ["notify_owner"]` or set
`risk_gate.next = ["notify_owner"]` when the intended UX is a parent-level join
after the selected branch completes.

### Switch Case

Use `builtin.switch` when a value can route to multiple named cases plus a
default route:

```json
{
  "id": "route_by_kind",
  "type": "builtin.switch",
  "value": "$.workflowTrigger.input.kind",
  "cases": [
    { "id": "case_a", "label": "Case A", "value": "a", "nodes": ["log_a"] },
    { "id": "case_b", "label": "Case B", "value": "b", "nodes": ["log_b"] }
  ],
  "default": ["log_default"]
}
```

Case `value` is JSON, so strings must stay quoted in raw definitions. Human UI
forms should make the case id, label, and match value editable. The case
`nodes` arrays and the `default` array are route entry points, not normal
switch settings and not path inventories; the UI should not ask the operator to
type them. Canvas add/connect actions own those arrays. Agents editing JSON
directly must update the matching case/default route entry when they create,
remove, or reconnect switch routes, then use explicit `next` edges for any
continuation.

### Foreach

```json
{
  "id": "each_asset",
  "type": "builtin.foreach",
  "items": "$.workflowTrigger.input.assets",
  "itemVar": "asset",
  "body": ["score_asset"]
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
  "failFast": true
}
```

Parallel behavior:

- Each branch starts from a cloned parent context and cloned step-output state.
- Branch-local context writes stay inside the branch result.
- Parent flow continues from the parallel node. If the aggregate should become
  a reusable context variable, add a `builtin.set` node after the parallel card
  and read from `$.steps.parallel_enrichment.output`.
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

Log node input, output, and emitted logs are inspectable in run history. If the
structured log payload or output also needs to become a reusable variable, add a
following `builtin.set` node.

### Python

Python steps execute isolated code with JSON `input` and set `output`:

```json
{
  "id": "py_score",
  "type": "builtin.python",
  "input": { "customer": "$.context.customer" },
  "code": "output = {'score': input['customer'].get('riskScore', 0)}",
  "timeoutMs": 45000,
  "reset": true
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
  "input": { "message": "$.workflowTrigger.input.customer.name" },
  "timeoutMs": 30000
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
  "timeoutMs": 60000
}
```

Agent ids must be real for deployed validation. Use test/dummy agents only in
mocked or demo harnesses.

Do not author `agent.task` nodes in the first workflow release. Durable
agent-task creation, waiting, and resume semantics are a follow-up contract;
the current schema and UI import/export validation reject `agent.task`.

## References, Step Ids, And Variables

Workflow variables live in run `context`. Read from:

- `$.workflowTrigger.input` for the run-start payload
- `$.workflowTrigger.meta` for trigger provenance such as kind, trigger id,
  request id, or schedule time
- `$.context`
- `$.steps.<nodeId>.input`
- `$.steps.<nodeId>.output`
- `$.steps.<nodeId>.status`
- `$.steps.<nodeId>.error`
- `item` inside foreach bodies

Workflow trigger input must be read through `$.workflowTrigger.input`.
Per-card execution input is available separately at `$.steps.<nodeId>.input`.

Canonical reference families:

- `$.workflowTrigger.input.<path>`: run-start payload, no matter whether the
  workflow was started manually, by a scheduled trigger, or by a future event
  trigger.
- `$.workflowTrigger.meta.<path>`: trigger provenance such as kind, trigger id,
  requested-by, request id, or schedule time.
- `$.context.<path>`: variables explicitly persisted by previous steps.
- `$.steps.<stepId>.input.<path>`: the resolved input object sent to that step.
- `$.steps.<stepId>.output.<path>`: that step's standard JSON output.
- `$.steps.<stepId>.status`: current or terminal step status.
- `$.steps.<stepId>.error.<path>`: structured step error when present.

Standard step output contract:

| Node type                           | Output shape                                                                                                                                                     | Common reference                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `builtin.transform.<operation>`      | `{ "value": <transformedValue> }`                                                                                                                                | `$.steps.<id>.output.value`               |
| `builtin.set`                       | `{ "assigned": { "<context.path>": <writtenValue> } }`                                                                                                           | `$.steps.<id>.output.assigned.<path>`     |
| `builtin.output.set`                | `{ "path": string, "value": <resolvedValue>, "mode": "replace" \| "merge" \| "append" }`                                                                         | `$.steps.<id>.output.value`               |
| `builtin.if`                        | `{ "result": boolean, "selected": string[], "skipped": string[] }`                                                                                               | `$.steps.<id>.output.result`              |
| `builtin.switch`                    | `{ "value": <switchValue>, "case": string, "matched": boolean, "selected": string[], "skipped": string[] }`                                                      | `$.steps.<id>.output.case`                |
| `builtin.foreach`                   | `{ "count": number, "succeededCount": number, "failedCount": number, "items": [...] }`                                                                           | `$.steps.<id>.output.items`               |
| `builtin.parallel`                  | `{ "count": number, "succeededCount": number, "failedCount": number, "canceledCount": number, "failFast": boolean, "branches": {...}, "branchOrder": string[] }` | `$.steps.<id>.output.branches.<branchId>` |
| `builtin.log.info/debug/warn/error` | `{ "message": string, "payload"?: <resolvedPayload> }`                                                                                                           | `$.steps.<id>.output.payload`             |
| `builtin.sleep`                     | `{ "delayMs": number, "reason"?: string }`                                                                                                                       | `$.steps.<id>.output.delayMs`             |
| `builtin.exit`                      | `{ "status": "succeeded" \| "failed" \| "canceled", "output"?: <terminalOutput> }`                                                                               | `$.steps.<id>.output.output`              |
| `builtin.throw_error`               | No success output; inspect `$.steps.<id>.error`                                                                                                                  | `$.steps.<id>.error.message`              |
| `builtin.python`                    | `{ "value": <pythonReturn>, "stdout"?: string, "stderr"?: string }`                                                                                              | `$.steps.<id>.output.value`               |
| `mcp.tool`                          | `{ "server": string, "tool": string, "result": <rawToolOutput> }`                                                                                                | `$.steps.<id>.output.result`              |
| `hosted.tool`                       | `{ "toolName": string, "result": <rawHostedToolOutput> }`                                                                                                        | `$.steps.<id>.output.result`              |
| `agent.call`                        | `{ "response": string, "sessionId"?: string, "assistantMessageId"?: string, ... }` for normal free-text agent replies                                            | `$.steps.<id>.output.response`            |

Type interpretation rules:

- `status` enum values are `succeeded`, `failed`, and `canceled` for
  `builtin.exit`; step/run status additionally includes `queued`, `running`,
  `waiting`, and `skipped` where applicable.
- `selected`, `skipped`, `branchOrder`, and route node lists are string arrays
  of step ids.
- `count`, `succeededCount`, `failedCount`, `canceledCount`, and `delayMs` are
  numbers.
- `result`, `matched`, and `failFast` are booleans.
- `value`, `payload`, `result`, `assigned`, `items`, `branches`, and
  `output` are JSON values whose nested shape depends on the configured
  transform, tool, agent, Python code, or workflow authoring choice.
- UI and agent tooling should render known primitive fields as read-only
  inputs and long strings, arrays, or objects as read-only textareas while
  retaining raw JSON inspection for debugging and artifacts.

Persist reusable variables with `builtin.set`:

```json
{
  "id": "set_customer",
  "type": "builtin.set",
  "assign": {
    "customer.id": "$.workflowTrigger.input.customer.id"
  }
}
```

`builtin.set` target keys are dotted context paths. Supported modes:

- `replace` is the default.
- `merge` requires object-compatible values.
- `append` appends to list-like values.

For tool, agent, Python, and transformer cards, do not rely on hidden generic
assignment UI. Use the standard output field for the card type. If a downstream
workflow needs a stable context variable, add a concrete transformer node to
normalize the result when needed and then a `builtin.set` node to write
`$.context.<name>`.

Context writes run only after the writing step succeeds. Failed steps do not
mutate context.

Autocomplete sources for reference fields should come from this same model:
top-level families, the trigger input schema, known context variables written by
`builtin.set`, current workflow step ids, known step input/output schemas, MCP
tool input schemas, and agent-call input/output metadata when available.

## Flow Control

Use flow-control nodes to make routing explicit and inspectable:

- `builtin.if`: choose `then` for true and `else` for false.
- `builtin.switch`: choose one case route or the default route.
- `builtin.foreach`: run a body for every item and assign the aggregate output.
- `builtin.parallel`: run independent branch bodies with optional concurrency
  and fail-fast control.
- `builtin.exit`: force a terminal status/output in backend-authored
  definitions.
- `builtin.throw_error`: fail intentionally with structured details.
- `builtin.sleep`: pause briefly for rate limit or eventual consistency.
- `builtin.set`: write values into run context.
- `builtin.output.set`: write explicit caller-facing workflow output.
- `builtin.transform.<operation>`: normalize, parse, convert, or reshape values
  with a concrete transformer node type.
- `builtin.log.debug/info/warn/error`: write structured timeline logs.

## Transform Operations

Transformer operation fields may use literal JSON values or references like
`$.workflowTrigger.input`, `$.workflowTrigger.meta`, `$.context`,
`$.steps.<nodeId>.input`, `$.steps.<nodeId>.output.value`, and foreach item
variables. Store transform output with a following `builtin.set` node when you
want a reusable normalized value or an overwrite:

```json
[
  {
    "id": "normalize_customer_name",
    "type": "builtin.transform.string_replace",
    "transform": {
      "kind": "string.replace",
      "value": "$.context.customer.name",
      "search": "  ",
      "replacement": " ",
      "all": true
    }
  },
  {
    "id": "set_customer_name",
    "type": "builtin.set",
    "assign": {
      "customer.name": {
        "from": "$.steps.normalize_customer_name.output.value",
        "mode": "replace"
      }
    }
  }
]
```

Supported operations:

- `value.resolve`: field `value`; resolves a reference or literal JSON value.
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

UI transformer cards map to the same operation kinds:

- `Value Resolve` -> node type `builtin.transform.value_resolve`, kind
  `value.resolve`
- `Object Pick` -> node type `builtin.transform.object_pick`, kind
  `object_pick`
- `String Replace` -> `string.replace`
- `Regex Replace` -> `string.regex_replace`
- `Regex Match` -> `string.regex_match`
- `JSON Parse` -> `json.parse`
- `JSON Stringify` -> `json.stringify`
- `CSV Parse` -> `csv.parse`
- `CSV Stringify` -> `csv.stringify`
- `IP Parse` -> `ip.parse`
- `Is IPv4` -> `ip.is_ipv4`
- `Is IPv6` -> `ip.is_ipv6`
- `In Subnet` -> `ip.in_subnet`
- `IP Netmask` -> `ip.netmask`
- `IP Network` -> `ip.network`
- `URI Parse` -> node type `builtin.transform.uri_parse`, kind `uri.parse`

Agents must author the concrete transformer node types directly. Do not create
generic `builtin.transform` nodes.

Transform guardrails:

- Unsupported transformer node types or node type / `transform.kind` mismatches
  fail schema validation before the run starts.
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
3. Use canvas cards and the right inspector for human editing. The inspector
   should prefer explicit fields, textareas, selects, and toggles; do not ask
   human operators to edit raw JSON for transformer operation configuration.
4. Add steps from the `+` buttons under cards or true/false/branch route
   buttons so the route reference is created with the new node.
5. For Switch, edit case id/label/match value in the inspector, but manage
   case/default membership through canvas links and route `+` buttons.
6. Click **Save** to persist draft changes.
7. Fill **Run input** in Test Configuration.
8. Click **Test** for draft execution.
9. Inspect Run History and the selected run detail.
10. Open each relevant step and inspect input, output, logs, and errors.
11. Click **Publish** after a passing test.
12. Click trigger-card **Run** for published runnable triggers.
13. Use **Export** for `openacme.workflow.definition.v1` snapshots.
14. Use **Import workflow file** to create a new draft from a snapshot.

Import is intentionally non-destructive in the first workflow release. Imported
files always create a new `wf_import_...` draft, even when the exported
`workflow.id` matches an existing workflow. Do not rely on import for overwrite
or merge behavior.

Current UI local prevalidation covers node references, node shape, trigger
shape, trigger identity, import/export shape, save, publish, test/live, and
trigger-card run paths. Server validation remains authoritative.

## Workflow Tool Workflow

Agents should use the first-class `workflow_*` tools as the primary authoring
surface:

- `workflow_card_catalog`: discover built-in, flow-control, transformer, log,
  MCP wrapper, Hosted Tool wrapper, and agent-call cards. Use the returned
  `configSchema`,
  `defaultConfig`, `routePorts`, `outputSchema`, and `examples` before drafting
  nodes.
- `workflow_help`: get overview, card-specific, schema, reference syntax, run
  evidence, and promotion gate guidance. Use `parameters[]` when a specific
  field or schema path is unclear.
- `workflow_help_upsert`: correct or extend reusable workflow help when running
  as Workflow Engineer or an admin context.
- `workflow_tool_inventory`: discover callable MCP workflow tools and hosted
  tools plus their parameter schemas before authoring `mcp.tool` or
  `hosted.tool` nodes.
- `workflow_agent_inventory`: discover callable agents before authoring
  `agent.call` nodes.
- `workflow_validate`: validate before saving or publishing. Use
  `{ "mode": "candidate", "candidate": <create body> }` before create,
  `{ "mode": "saved", "workflow_id": "<id>" }` for an existing workflow, or
  `{ "mode": "definition", "definition": <full definition> }` for a stored or
  exported definition. Do not call it with an empty `{}` candidate.
- `workflow_create`, `workflow_update`, `workflow_delete`,
  `workflow_publish`, `workflow_export`, `workflow_import`: manage definition
  lifecycle without raw transport work.
- `workflow_card_test_run`: run one candidate, saved-workflow, or previous-run
  card in isolation for card-level TDD.
- `workflow_test_run`, `workflow_run_list`, `workflow_run_get`,
  `workflow_run_cancel`, `workflow_run_rerun`, `workflow_artifact_get`: execute
  tests and inspect run history, step input/output/error/logs, final context,
  and spilled artifacts.
  Use `workflow_test_run({ "stop_after_step_id": "<stepId>" })` to run a
  draft only up to a checkpoint during development. A stop-after run is partial
  evidence and does not satisfy the publish gate.
  Use summary-first run inspection: call
  `workflow_run_get({ "run_id": "<runId>", "detail": "summary" })` before
  asking for targeted step evidence with `detail: "step"` and `step_id`.
  Reserve `detail: "full"` for debugging exports or UI parity checks.

Every saved or published agent-authored workflow should have this evidence:

- `workflow_card_catalog` was used for card capabilities.
- `workflow_help` was used for unfamiliar cards, references, schemas, run
  evidence, or promotion questions.
- `workflow_tool_inventory` or `workflow_agent_inventory` was used before any
  external call node, including `mcp.tool`, `hosted.tool`, and `agent.call`.
- `workflow_validate` returned `ok: true`.
- `workflow_card_test_run` was used for risky card configuration or external
  input/output uncertainty.
- `workflow_test_run` produced a full current-draft run id.
- `workflow_run_get` confirmed the expected status and step evidence.
- `workflow_publish` succeeded only after validation and a successful full test
  run for the current draft when publishing was requested.

Normal agents that consume workflows instead of authoring them should use only
the consumer-safe subset:

- `workflow_help`: read reference, schema, output, run evidence, and promotion
  guidance.
- `workflow_callable_list`: list published callable workflows. Drafts and
  archived workflows are excluded.
- `workflow_callable_get`: inspect one published workflow contract, including
  description, enabled triggers, input schema, and output schema. It does not
  expose the draft node graph.
- `workflow_run`: run a published workflow through an enabled manual trigger.
  It never runs draft definitions.
- `workflow_run_get`: inspect run summary first, then targeted step evidence
  with `detail: "step"` and `step_id` when needed.
- `workflow_artifact_get`: fetch spilled run artifacts when run or step output
  is too large for inline display.

Consumer agents must not receive mutation or authoring tools such as
`workflow_create`, `workflow_update`, `workflow_delete`, `workflow_publish`,
`workflow_test_run`, `workflow_card_test_run`, or `workflow_help_upsert` unless
they are explicitly acting as Workflow Engineer or an admin authoring context.

For log cards, `message` is runtime-resolved. Use a direct reference when the
whole message should be a value, for example
`"message": "$.workflowTrigger.input.message"`. Use template syntax for mixed
text, for example
`"message": "Received {{ $.workflowTrigger.input.message }}"`. The run trace
shows the resolved message in step input, step output, and log events; the
definition snapshot preserves the original config.

## API Workflow

First-release workflow definitions and run history are global. Do not send
`teamId`, `agentId`, or `ownerId` filters to workflow list APIs; those scoping
contracts are future work.

Workflow HTTP endpoints remain the transport/API surface behind the product UI
and are useful for debugging platform behavior.

The workflow API inventory endpoints are the same runtime source of truth as
the workflow inventory tools. Refresh inventory before creating or validating
an external-call node because connected MCP servers and their tool schemas can
change between authoring sessions.

Every human UI operation must have an agent path:

- Human **New**: agent calls `POST /api/workflows`.
- Human **Edit cards/forms**: agent edits the workflow definition JSON through
  the API/import path.
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
`$.workflowTrigger.input`, `$.workflowTrigger.meta`, `$.context`, `$.steps`, or
foreach `item` references. If the needed tool is absent from the inventory, stop
and report the missing capability
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
- `definition`, when present, is the workflow definition snapshot that actually
  executed for this run. Prefer it over the current draft when rendering or
  auditing historical runs.
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
      "assign": { "customer": "$.workflowTrigger.input.customer" }
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
