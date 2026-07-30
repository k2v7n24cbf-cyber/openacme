# Workflow Engine Planning Brief

Branch: `local-stage-the-workflows`

Data dir for all manual/runtime work: `~/.openacme-the-workflow`

Primary architecture note: `docs/workflow-engine-plan.md`

## Prepared State

- Local worktree `worktrees/local-stage` is on branch
  `local-stage-the-workflows`.
- The branch was created from `local-stage`.
- Isolated runtime data dir exists at `~/.openacme-the-workflow`.
- Isolated config sets `server.host = 127.0.0.1` and `server.port = 3458`.
- `~/.openacme` is out of scope for workflow development and smoke tests.

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

## Decisions To Make Before Code

1. Ownership scope:
   Should workflows be global, team-scoped, or agent-owned in the first
   release?

2. First editor shape:
   Should MVP be a vertical card/list builder, or do we require a canvas from
   day one?

3. Builtin taxonomy:
   Confirm the stored type family:
   `builtin.*`, `mcp.*`, and `agent.*`.

4. Python isolation:
   Should `builtin.python` state live per run, per step, or per workflow worker?

5. Agent call semantics:
   Should the first release support only `agent.call`, or also durable
   `agent.task` waiting/resume?

6. Workflow triggers:
   First release is manual-run only. Keep trigger storage/schema explicit so
   scheduled, task, event, and webhook triggers can be added later without
   changing the run contract.

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
   Confirm immutable published versions with mutable drafts.

10. Expression language:
    Confirm constrained expressions first, with no arbitrary JavaScript.

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

Start coding with Milestone 1 only. It settles the sibling boundary with
`AgentManager`, gives later storage and UI slices a stable contract, and avoids
building a visual editor before the runtime/audit contract is trustworthy.

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
workflow, edit cards through the JSON-backed card list, save/publish, run test
and live executions, reopen history, inspect step input/output/error/context
diffs/logs, and verify a failed run in Playwright. Rich per-node forms and drag
reordering are future hardening, not M4 blockers. The card list now exposes
assignment summaries and primary assignment edit controls so operators can see
and change direct variable sets, transformer write-back targets, source
expressions, and write mode without opening raw node JSON. Transform cards also
support structured input JSON map and transform JSON editing for
`builtin.transform`. It also supports Move up, Move down, and Delete card
actions over the same JSON-backed draft, so basic list editing no longer
requires hand-editing the raw node array. Basic MCP and agent cards now also
expose structured server/tool, agent id, prompt, timeout, and input JSON map
controls, with inventory pickers when discovered options are available. IF and
IF Else cards can also be appended and configured through structured
condition/branch target controls over the same JSON-backed draft. Log cards now
support structured level, message, and payload editing for
`builtin.log.info/debug/error`, and Exit cards support structured status/output
editing for `builtin.exit`. Foreach cards support structured items, item
variable, body node list, and concurrency editing for `builtin.foreach` while
the runtime cap remains sequential. The authoring path now validates duplicate
node ids and missing IF/IF Else/Foreach target references before save, publish,
or run.

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
