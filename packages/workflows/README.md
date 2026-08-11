# @openacme/workflows

Workflow definition schemas and runtime seams for OpenAcme.

This package owns the workflow DSL, validation, deterministic runner, and
dispatcher orchestration contracts. It executes workflow control-flow and
builtin runtime semantics through explicit ports for persistence, events, MCP
tools, agent calls, and Python execution.

The package does not own OpenAcme server routing, SQLite schema definitions, UI
state, or concrete MCP/agent/Python adapters. Those live in the server, DB, and
web packages so the workflow core remains transport-independent and testable.

## Input Contract

Workflow and trigger `inputSchema` values use standard JSON Schema object
syntax. Nested payloads must be described with normal `properties`, `required`,
and `items` structures; for example an `assets` array of asset objects must use
`assets.type = "array"` and `assets.items.type = "object"` with its own
`required` and `properties`. The workflow package validates both the schema
shape and the run input value before execution.

## Step Output Contract

Every successful step records `$.steps.<stepId>.output` as a JSON object with a
node-type-specific stable shape. Common fields:

- `builtin.transform` and transformer UI cards: `output.value`
- `builtin.python`: `output.value`, optional `output.stdout`, `output.stderr`
- `mcp.tool`: `output.server`, `output.tool`, `output.result`
- `agent.call`: `output.response`, optional `output.sessionId`,
  `output.assistantMessageId`
- `builtin.set`: `output.assigned`
- `builtin.if`: `output.result`, `output.selected`, `output.skipped`
- `builtin.switch`: `output.value`, `output.case`, `output.matched`,
  `output.selected`, `output.skipped`
- `builtin.foreach`: `output.count`, `output.succeededCount`,
  `output.failedCount`, `output.items`
- `builtin.parallel`: `output.count`, `output.succeededCount`,
  `output.failedCount`, `output.canceledCount`, `output.branches`,
  `output.branchOrder`
- `builtin.log.*`: `output.message`, optional `output.payload`
- `builtin.sleep`: `output.delayMs`, optional `output.reason`
- `builtin.exit`: `output.status`, optional `output.output`

`builtin.throw_error` has no success output; inspect `$.steps.<stepId>.error`.
