# Workflow Engine Planning Brief

Branch: `local-stage-the-workflows`

Data dir for all manual/runtime work: `~/.openacme-the-workflow`

Primary architecture note: `docs/workflow-engine-plan.md`

Production rollout runbook: `docs/workflow-production-rollout.md`

Release readiness matrix: `docs/workflow-release-readiness.md`

Current workflow milestone status:

- M0-M8 first-release workflow runtime, persistence, API, triggers, MCP,
  agent-call, foreach, Python, run history, and run inspection are complete.
- M9 visual canvas authoring is complete and pushed on
  `local-stage-the-workflows` at commit `6216f7d`.
- The primary human authoring surface is now the `/workflows` canvas with node
  palette, visual branch/foreach wiring, right-side inspector settings, run
  overlays, run evidence selection, and optional persisted layout metadata.
- Agent workflow authoring remains API/import-export driven through the
  `openacme-workflow-author` skill. Agents should not use Playwright to create
  workflows.
- Production rollout must use the dedicated runbook and requires explicit
  operator approval before touching `/Users/alenbohcelyan/.openacme`.

## Prepared State

- Local worktree `worktrees/local-stage` is on branch
  `local-stage-the-workflows`.
- The branch was created from `local-stage`.
- Isolated runtime data dir exists at `~/.openacme-the-workflow`.
- Isolated config sets `server.host = 127.0.0.1` and `server.port = 3458`.
- `~/.openacme` is out of scope for workflow development and smoke tests.
- Port `3456` is out of scope for workflow development and workflow smoke
  tests.

## Commit And Push Practice

- Prefer batching small workflow documentation and follow-up cleanup changes
  into one local commit/push cycle, because the repository push hook runs the
  full build and server e2e suite.
- A local branch may temporarily be ahead of
  `origin/local-stage-the-workflows` while a batch is still open. Production
  rollout candidates must still come only from pushed commits whose hooks have
  completed successfully.
- Before a final batch push, rerun the smallest honest focused validation for
  the changed surface. For workflow UI/runtime smoke, keep using port `3458`
  and `/Users/alenbohcelyan/.openacme-the-workflow`.

Batch close-out checklist:

1. Confirm `git status --short --branch` shows only intended tracked workflow
   changes plus the known unrelated untracked `output/`.
2. Re-run the focused validation for the files changed in the batch.
3. If workflow UI/runtime behavior changed, re-run the deployed-style
   Playwright smoke on `3458` with
   `/Users/alenbohcelyan/.openacme-the-workflow`.
4. Commit the complete batch together.
5. Push once, then wait for the full push-hook build and server e2e result.
6. Promote the pushed commit to rollout candidate only after the hook suite
   accepts it.

## Baseline Runtime Command

Use this when we are ready to run the dev server:

```sh
cd /Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage
OPENACME_DATA_DIR="$HOME/.openacme-the-workflow" pnpm dev
```

Use this compiled-server smoke when the dev watcher is not required or the
local `tsx`/esbuild watcher is unhealthy:

```sh
cd /Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage
OPENACME_DATA_DIR="$HOME/.openacme-the-workflow" node packages/server/dist/index.js
curl -sS http://127.0.0.1:3458/api/health
```

Use this only for a no-service daemon smoke after a build:

```sh
cd /Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage
pnpm agent start --data-dir "$HOME/.openacme-the-workflow" --no-service --no-browser
```

## Locked Decisions

1. Ownership scope:
   Workflows and workflow run history are global in the first release. Do not
   send `teamId`, `agentId`, or `ownerId` filters to workflow list APIs.

2. First editor shape:
   M4 shipped with a JSON-backed structured card editor. M9 completed the
   primary visual canvas authoring surface. The card/JSON path remains an
   advanced fallback and import/export/debug escape hatch.

3. Builtin taxonomy:
   Stored node type families are `builtin.*`, `mcp.*`, and `agent.*`.

4. Python isolation:
   `builtin.python` runs through a dedicated `PythonExecutionPort` using
   per-step subprocess isolation.

5. Agent call semantics:
   The first release supports synchronous `agent.call`. Durable `agent.task`
   wait/resume is explicitly deferred and must remain rejected with the
   documented first-release message.

6. Workflow triggers:
   Manual, scheduled, and webhook trigger foundations exist. Manual and
   configured scheduled/webhook trigger runs use the shared persisted run path.
   Task trigger dispatch remains deferred.

7. Run audit and UI:
   Test runs and live runs are both durable. The UI must support run history,
   run detail, step-by-step logs, input/output inspection, success/failure
   state, error details, and re-run from prior input.

8. Variables and mapping:
   Workflow variables live in run context. Operators can set variables with a
   standalone `builtin.set` card or with an output assignment section on any
   executable card. `builtin.transform` can read a variable and write the
   transformed output back to the same variable; default write mode is replace,
   while merge/append must be explicit.

9. Storage versioning:
   Published workflow versions are immutable snapshots. Draft definitions remain
   mutable.

10. Expression language:
    Workflow expressions are constrained. Do not add arbitrary JavaScript
    expression execution.

11. Visual layout metadata:
    Workflow execution remains owned by `triggers` and `nodes`. Optional
    `definition.ui.canvas.nodes.<nodeId>.position` metadata is visual-only,
    can be omitted by agents, and can be cleared with `ui: null`.

## Recommended Milestone Order

1. Milestone 0 - Planning Baseline.
2. Milestone 1 - Architecture Skeleton And Schemas.
3. Milestone 2 - Persistence And Audit Store.
4. Milestone 3 - Builtin Runner MVP.
5. Milestone 4 - Manual API And Run Console UI.
6. Milestone 5 - MCP Steps.
7. Milestone 6 - Agent Calls.
8. Milestone 7 - Foreach And Python.
9. Milestone 8 - Future Trigger Expansion.
10. Milestone 9 - Canvas Authoring UI.

The current implementation has completed this order through Milestone 9. Future
work should open a new milestone in `docs/workflow-engine-plan.md` before code
changes start.

Milestone 4 is the first point where the operator should be able to run a draft
from the UI and inspect a persisted test run end to end.

Milestone 2 and later require deployed validation against the isolated running
runtime at `http://127.0.0.1:3458`. Unit tests and mocked seams are necessary
but not sufficient once a milestone changes DB migrations, stores, HTTP routes,
runtime execution, or UI behavior; the running deployed version must produce
the acceptance evidence. Each slice close-out records the exact deployed
command, result, isolated data dir, and post-smoke listener check.

For Milestone 2, deployed validation may use the built workflow store directly
against `/Users/alenbohcelyan/.openacme-the-workflow/state.db` while the
compiled server is running, because workflow HTTP routes do not exist yet. For
Milestone 4 and later, deployed validation must exercise HTTP/API and UI paths,
not direct DB access.

Milestone 3 uses the same temporary internal harness pattern: the compiled
server must be running on `127.0.0.1:3458`, then built workflow/db packages can
execute the builtin runner and persist draft test plus published live traces
into the deployed `state.db`. Milestone 4 replaces this with real HTTP/API and
UI validation.

Milestone 4 API slice is complete when real HTTP routes can create/update/list
workflows, publish, run draft tests, run published live workflows, reopen run
detail, list runs, rerun from prior input, and reject cancellation for terminal
runs. M4 is not complete until the web Workflows route, run history, run
detail console, failed-run inspection, and Playwright smoke are done.

Milestone 4 MVP UI is complete when `/workflows` lets an operator create a
workflow, edit structured workflow cards, save/publish, run test and live
executions, reopen history, inspect step input/output/error/context diffs/logs,
and verify a failed run in Playwright. The M4 card editor remains an advanced
fallback.

Milestone 9 canvas authoring is complete when `/workflows` lets an operator
create nodes from the palette, edit all selected-node settings from the
right-side inspector, wire branch and foreach references visually, reorder
linear node order, save/publish/test, inspect run overlays on the canvas,
select run evidence from either the canvas or run console, export/import
definitions including optional layout metadata, and persist dragged node
positions without changing workflow execution semantics.

Milestone 5 core MCP slice is complete when workflow execution has a dedicated
MCP port, not an AgentManager or dispatcher dependency; `mcp.tool` runs through
that port; discovered MCP tools are exposed through workflow-safe API metadata;
the workflow UI can append an MCP card from discovered tools; MCP cards render
simple schema-driven input rows for discovered object input schemas while raw
Input JSON remains the complex-schema fallback; focused tests prove success,
failure, and assignment; and a deployed compiled-server smoke calls a real
SDK-backed fake MCP tool and persists the run trace.

Milestone 6 core agent-call slice is complete when workflow execution has a
dedicated `AgentCallPort`, not an AgentManager or dispatcher dependency inside
node handlers; `agent.call` can call an OpenAcme agent through the
`WorkflowAgentRuntime` adapter; discovered agents are exposed through
workflow-safe API metadata; the workflow UI can append an agent call card;
agent pickers disable discovered agents that do not allow instant messages;
focused tests prove prompt templating, assignment, and failure persistence; and
a deployed compiled-server smoke calls a real AgentManager-backed stub-model
agent and persists the workflow trace including response, linked session id, and
`step_output`.

Milestone 7 core foreach/Python slice is complete when `builtin.foreach`
executes body nodes sequentially with explicit `concurrency: 1`, records
item-indexed body attempts, preserves completed item context on partial
failure, and `builtin.python` runs through a dedicated `PythonExecutionPort`
using per-step subprocess isolation. The workflow UI can append foreach and
Python cards; Python cards support structured input JSON map, timeout, reset,
and code editing.
Focused tests prove success, empty collection, partial failure, concurrency cap,
stdout/stderr/value assignment, failure detail persistence; and deployed
compiled-server smoke proves real Python subprocess execution plus foreach item
traces against `~/.openacme-the-workflow`.

Milestone 8 core trigger foundation is complete when trigger metadata can be
listed, enabled manual triggers can run through the same persisted workflow run
path as live manual runs, each run stores the configured trigger snapshot, and
disabled future trigger kinds are rejected without creating runs. The workflow
UI lists configured triggers, marks runnable/disabled state, can edit trigger
definition JSON through the draft save path, and can launch enabled manual
triggers into the existing run console/history. Scheduled, task, and webhook
dispatchers remain future slices; M8 only locks the safe contract and deployed
validation against `~/.openacme-the-workflow`.

Workflow cards may edit an optional display `label` while keeping node `id`
as reference-level JSON metadata. This keeps branch/body/assignment references
stable until a dedicated rename/refactor flow exists.

Run cancellation hardening is complete for persisted non-terminal runs: the API
returns full run detail, records a `run_canceled` audit event, clears active
node/waiting state, and the Run Console exposes a Cancel action for
non-terminal detail. True interruption of already executing Python, MCP, or
agent steps remains future WorkflowDispatcher/worker lifecycle work.

Global run history hardening is complete for the current MVP: the API supports
workflow/mode/status/trigger/date-range run filters, `/workflow-runs` lists
runs across workflows, failed runs can be filtered and opened directly, and the
detail view shows step input/output/error/context diff, timeline events,
trigger, run input, and final context. The global detail view can also rerun a
persisted run from its prior input and keep the new attempt selected for
inspection. Run detail observability now also covers run duration,
started/ended timestamps, definition source, step attempt/duration labels, and
timeline level filtering in both `/workflows` and `/workflow-runs`.

## OpenAcme Seams To Reuse

- Config loading and data-dir resolution from `@openacme/config`.
- SQLite/Drizzle migration pattern from `@openacme/db`.
- Server route mounting pattern from `@openacme/server`.
- Tool-host/MCP substrate for execution ports, not as the public workflow DSL.
- Existing agent/session/task APIs through narrow ports.

## Early Acceptance Bar

Before moving beyond Milestone 1:

- Types compile for touched packages.
- Workflow schemas reject malformed definitions.
- Server can construct and stop the new workflow components without changing
  existing agent/task dispatcher behavior.
- The planned persistence contract includes durable test/live runs, step
  attempts, and append-only run events.
- Variable assignment is explicit and inspectable through run context and step
  context diffs.
- From Milestone 2 onward, every milestone records the exact deployed
  validation command and result against `~/.openacme-the-workflow`.
- No command or test mutates `~/.openacme`.
