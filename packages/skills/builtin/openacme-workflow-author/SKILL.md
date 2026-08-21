---
name: openacme-workflow-author
description: Create, edit, save, test, publish, import, export, and validate OpenAcme workflow definitions. Use when an agent needs to author workflows with built-in steps, MCP tools, agent calls, flow control, variables/assignments, triggers, run-console validation, or deployed smoke checks in the OpenAcme repo.
---

# OpenAcme Workflow Author

Use this skill to build OpenAcme workflows without rediscovering the workflow
schema, tool surface, UI/API flow, or validation practice.

## Start Here

1. When first-class `workflow_*` tools are available, use them as the source of
   truth for authoring. Start with `workflow_help`, then
   `workflow_card_catalog`.
2. Use `workflow_tool_inventory` before MCP or Hosted Tool cards and
   `workflow_agent_inventory` before agent-call cards. Do not assume an agent
   already knows every MCP tool, hosted tool, tool description, input schema,
   or callable agent id.
3. Inspect platform source files only when you are developing the workflow
   platform itself, not when authoring routine workflow definitions.
4. For detailed authoring rules, read
   `references/workflow-authoring.md`.
5. If tool-backed help is wrong or incomplete and you are the Workflow Engineer
   or an admin context, correct it with `workflow_help_upsert`.

## Authoring Loop

Human UI workflows and agent workflows must have parity. If a human can do a
workflow lifecycle operation in `/workflows`, an agent should know the
first-class `workflow_*` tool path for the same operation. Do not leave an
operation documented only as a UI click.

Use this loop for every workflow you create or materially edit:

1. Define the user goal, trigger type, expected final context/output, and the
   workflow input contract as JSON Schema. Use normal JSON Schema object
   patterns for nested data; arrays of complex objects must define
   `items.type = "object"`, `items.required`, and `items.properties`.
2. Call `workflow_help` for overview, reference syntax, schema, run evidence,
   and promotion guidance. Request parameter-specific help when an input schema
   or card field is unclear.
3. Call `workflow_card_catalog` before choosing cards. Treat its card types,
   `configSchema`, `defaultConfig`, `routePorts`, `outputSchema`, and examples
   as the source of truth for authoring.
4. Draft the workflow as JSON first. Use safe ids:
   `[A-Za-z0-9][A-Za-z0-9_.-]*`.
5. Discover external inventory before using MCP tools, Hosted Tools, or agent
   calls: `workflow_tool_inventory` for MCP `server`, `tool`, `description`,
   and `inputSchema`, plus hosted `toolName`, `description`, and `inputSchema`;
   `workflow_agent_inventory` for callable agents. Treat these responses as the
   runtime source of truth and refresh them before authoring or validating
   external-call nodes. Do not assume an agent already knows all available MCP
   or hosted tools.
6. Prefer deterministic cards and flow control. Call agents only when the
   requested task needs judgment or deterministic transforms/tools cannot
   satisfy the requirement.
7. Add nodes in execution order, then add explicit route references:
   `builtin.if` true/false, `builtin.switch` case/default, `builtin.foreach`
   body, and `builtin.parallel` branch references. Use `builtin.if` for new
   branching workflows; do not create new `builtin.if_else` definitions.
   Do not rely on adjacent `nodes[]` entries for execution. Normal card-to-card
   continuation must be stored as `source.next = ["target"]`; without that edge,
   the later card is not part of the execution chain.
8. Use the canonical reference roots: `$.workflowTrigger.input` for the
   run-start payload, `$.workflowTrigger.meta` for trigger provenance,
   `$.context` for run variables, and `$.steps.<nodeId>.input/output/status/error`
   for per-card evidence.
9. Step ids are human-editable stable slugs. Labels may contain spaces; when a
   label changes, the UI derives a clean id and updates `$.steps.<oldId>`
   references automatically.
10. Treat every step output as inspectable under `$.steps.<nodeId>.output`, but
   use the node-type-specific fields from the standard output contract in
   `references/workflow-authoring.md`. For example, transformer values are at
   `$.steps.<nodeId>.output.value`, MCP raw results are at
   `$.steps.<nodeId>.output.result`, and agent free-text responses are at
   `$.steps.<nodeId>.output.response`.
   Normalize uncertain output with a concrete transformer node such as
   `builtin.transform.object_pick`, `builtin.transform.json_parse`, or
   `builtin.transform.uri_parse`. The node type must match `transform.kind`.
   Persist reusable variables with an explicit `builtin.set` node.
11. Make the caller-facing workflow output explicit with `builtin.output.set`
    when the workflow will be consumed by another agent, UI, or API caller.
12. Call `workflow_validate` before saving. Use
   `{ "mode": "candidate", "candidate": <create body> }` before create,
   `{ "mode": "saved", "workflow_id": "<id>" }` for an existing draft, or
   `{ "mode": "definition", "definition": <full definition> }` for a stored or
   exported definition. Fix every issue before continuing.
13. Save the draft through `workflow_create`, `workflow_update`, or
    `workflow_import`. Human operators may use the UI; workflow-authoring
    agents should not use Playwright to create definitions.
14. Run risky or newly configured cards with `workflow_card_test_run` before
    relying on full-run behavior.
15. Use `workflow_test_run({ "stop_after_step_id": "<id>" })` to test up to a
    checkpoint without executing the rest of the workflow.
16. Run a full draft test through `workflow_test_run` and inspect summary-first
    evidence through
    `workflow_run_get`.
17. Fix step input/output, variables, and trigger input until the run trace is
    explainable.
18. Publish through `workflow_publish` only after validation and a successful
    full test run for the current draft. Partial stop-after tests do not satisfy
    the publish gate.
19. Export through `workflow_export` when a reusable artifact is needed.
20. Use `workflow_run_list`, `workflow_run_get`, `workflow_run_cancel`,
    `workflow_run_rerun`, and `workflow_artifact_get` for run history,
    cancellation, reruns, and large output inspection.
21. Update docs or task notes with exact tool calls, run ids, and evidence.

## Normal Agent Consumption

Normal agents that only need to use workflows should receive the consumer tool
subset, not the authoring tools:

- `workflow_help`
- `workflow_callable_list`
- `workflow_callable_get`
- `workflow_run`
- `workflow_run_get`
- `workflow_artifact_get`

They should discover published callables with `workflow_callable_list`, inspect
input/output contracts with `workflow_callable_get`, run only published
workflows through `workflow_run`, then inspect summary-first evidence with
`workflow_run_get`. They must not receive `workflow_create`, `workflow_update`,
`workflow_delete`, `workflow_publish`, `workflow_test_run`,
`workflow_card_test_run`, or `workflow_help_upsert` unless they are acting as
Workflow Engineer or an admin authoring context.

## Required Validation

Before calling work done:

- Run schema/package validation for workflow contract changes:
  `pnpm --filter @openacme/workflows test -- schemas.test.ts`
- Run web validation for UI authoring changes:
  `pnpm --filter web check-types`
  and `pnpm --filter web build`
- For workflow UI behavior, run focused Playwright first:
  `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
- Widen to:
  `pnpm --dir apps/web exec playwright test workflows.spec.ts`
- For Milestone 2+ or release-bound work, run a deployed smoke on a non-3456
  port with the isolated workflow data dir:
  `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`

Do not use port `3456` for workflow test environments. Prefer `3998` for the
Playwright harness and `3458` for deployed smoke checks unless the user chooses
another non-3456 port. Use
`OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow` for this branch
unless the user explicitly chooses another isolated test data dir.

Playwright is a validation tool for product UI regressions and deployed
operator-visible behavior. It is not the normal workflow creation mechanism for
agents.

## Save, Test, Publish, Run

- **Save Draft** persists current `name`, `description`, `inputSchema`,
  `triggers`, `nodes`, and optional `ui` metadata into the draft definition.
- **Test** creates a draft-mode run from current editor input.
- **Publish** creates an immutable published version from the draft.
- **Delete** archives the workflow definition so it leaves the default list
  while prior run history remains inspectable.
- **Trigger-card Run** runs a published runnable trigger.
- **Export** writes an `openacme.workflow.definition.v1` JSON definition.
- **Import** creates a new draft workflow from an export; it should not mutate
  the current workflow. There is no overwrite or merge import mode in the first
  workflow release.

Optional UI metadata is for visual layout only:

- Agents should omit `ui` unless they are preserving or intentionally updating
  a visual canvas layout.
- The supported shape is
  `ui.canvas.nodes.<nodeId>.position = { "x": number, "y": number }`.
- `ui` does not affect execution order, branch/foreach behavior, triggers,
  assignments, MCP calls, agent calls, or Python execution.
- `PATCH /api/workflows/:id` accepts `ui: null` to clear visual metadata.
- `DELETE /api/workflows/:id` archives the definition. Use
  `GET /api/workflows?status=archived` only when explicitly inspecting archived
  workflows; default `GET /api/workflows` hides them.
- Export/import preserves `ui` when present, but agent-authored workflows remain
  valid without it.

All run paths should be verified through the Run Console: check run status,
trigger snapshot, step rail, selected step input/output/error, logs, timeline,
final context, and artifacts or pruned artifact messages when present.
Agents should verify the same evidence through `GET /api/workflow-runs/:runId`
and artifact APIs. For failed or historical runs, list via
`GET /api/workflow-runs?status=failed&limit=25` or
`GET /api/workflows/:workflowId/runs?status=failed&limit=25`, then inspect the
specific run detail.

## Guardrails

- Keep `AgentManager` and `WorkflowManager` concerns separate; workflow
  orchestration should not be hidden inside the agent manager.
- Treat the server and `packages/workflows` schemas as the authoritative
  contract. UI validation improves operator feedback but is not the source of
  truth.
- Do not invent new node or trigger aliases. Use current schema values.
- Do not author `agent.task` nodes for the first workflow release. Use
  `agent.call`; durable task wait/resume is a follow-up contract.
- Treat workflow definitions and run history as global in the first release.
  Do not send `teamId`, `agentId`, or `ownerId` filters to workflow list APIs.
- Do not use `~/.openacme` for workflow deployment tests in this branch; use
  `/Users/alenbohcelyan/.openacme-the-workflow`.
- Do not skip docs. Record the slice, commands, run ids, ports, and residual
  risk in `docs/workflow-engine-plan.md` or the task-specific doc.
