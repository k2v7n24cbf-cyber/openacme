---
name: openacme-workflow-author
description: Create, edit, save, test, publish, import, export, and validate OpenAcme workflow definitions. Use when an agent needs to author workflows with built-in steps, MCP tools, agent calls, flow control, variables/assignments, triggers, run-console validation, or deployed smoke checks in the OpenAcme repo.
---

# OpenAcme Workflow Author

Use this skill to build OpenAcme workflows in the platform repository without
rediscovering the workflow schema, UI/API flow, or validation practice.

## Start Here

1. Work from the repo root or the active worktree.
2. Read the current workflow contracts before editing:
   - `docs/workflow-engine-plan.md`
   - `packages/workflows/src/schemas.ts`
   - `packages/workflows/src/validation.ts`
   - `packages/server/src/routes/workflows.ts`
   - `apps/web/app/routes/workflows.tsx`
3. For detailed authoring rules, read
   `references/workflow-authoring.md`.
4. Use `rg` to confirm current names and endpoints; workflow code is moving
   quickly.

## Authoring Loop

Human UI workflows and agent workflows must have parity. If a human can do a
workflow lifecycle operation in `/workflows`, an agent should know the API or
JSON import/export path for the same operation. Do not leave an operation
documented only as a UI click.

Use this loop for every workflow you create or materially edit:

1. Define the user goal, input JSON shape, trigger type, and expected final
   context/output.
2. Draft the workflow as JSON first. Use safe ids:
   `[A-Za-z0-9][A-Za-z0-9_.-]*`.
3. Discover external inventory before using MCP tools or agent calls:
   `GET /api/workflows/mcp/tools` for MCP `server`, `tool`, `description`, and
   `inputSchema`; `GET /api/workflows/agents` for callable agents. Treat these
   responses as the runtime source of truth and refresh them before authoring or
   validating external-call nodes. Do not assume an agent already knows all
   available MCP tools.
4. Add nodes in execution order, then add branch/foreach references.
5. Use explicit `assign` maps to set variables in run `context`.
6. Save the draft through the API or import/export JSON path. Human operators
   may use the UI; workflow-authoring agents should not use Playwright to
   create definitions.
7. Run a draft test run and inspect the run console.
8. Fix step input/output, assignments, and trigger input until the run trace is
   explainable.
9. Publish only after local validation and a passing test run.
10. Run the published trigger path when the workflow is meant to be live.
11. Export the definition when a reusable artifact is needed.
12. Update docs or task notes with exact commands, run ids, and evidence.

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
another non-3456 port.

Playwright is a validation tool for product UI regressions and deployed
operator-visible behavior. It is not the normal workflow creation mechanism for
agents.

## Save, Test, Publish, Run

- **Save Draft** persists current `name`, `description`, `inputSchema`,
  `triggers`, `nodes`, and optional `ui` metadata into the draft definition.
- **Test** creates a draft-mode run from current editor input.
- **Publish** creates an immutable published version from the draft.
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
- Export/import preserves `ui` when present, but agent-authored workflows remain
  valid without it.

All run paths should be verified through the Run Console: check run status,
trigger snapshot, step rail, selected step input/output/error, logs, timeline,
final context, and artifacts or pruned artifact messages when present.
Agents should verify the same evidence through `GET /api/workflow-runs/:runId`
and artifact APIs.

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
