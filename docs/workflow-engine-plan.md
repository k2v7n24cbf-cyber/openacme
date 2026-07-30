# Workflow Engine Plan

Branch: `local-stage-the-workflows`

Base branch: `local-stage`

Runtime data directory: `~/.openacme-the-workflow`

## Objective

Add a first-class workflow engine to OpenAcme without folding workflow runtime
semantics into the existing agent/task dispatcher. Workflows should let an
operator define dynamic step cards in the web UI, run built-in workflow
primitives, call MCP tools, and call OpenAcme agents.

The runtime must be deterministic enough to audit and resume. The UI is an
editor for a persisted workflow definition; it is not the execution engine.

## Non-Goals

- Do not run workflow steps inside the existing `Dispatcher`.
- Do not model workflow built-ins as existing OpenAcme agent built-in tools.
- Do not use `~/.openacme` for development, smoke testing, or deployment of
  this branch.
- Do not require a free-form canvas before the engine exists. A structured
  card/list editor is enough for the first release.
- Do not add arbitrary JavaScript expressions as the first expression language.

## Runtime Boundary

`AgentManager` and `WorkflowManager` should be siblings under a server runtime
composition root.

Target shape:

```text
ServerRuntime
  AgentManager
  WorkflowManager
  Dispatcher
  WorkflowDispatcher
  ToolHostManager
  stores
  broadcaster/event bus
```

`Dispatcher` remains responsible for agent/task/session wake-up. A separate
`WorkflowDispatcher` is responsible for queued, waiting, delayed, and resumed
workflow runs.

`WorkflowRunner` interprets one run until it succeeds, fails, cancels, or blocks
on an external event.

## Step Families

Workflow step types are grouped by source:

- `builtin.*` - workflow-native primitives.
- `mcp.*` - MCP server tool calls.
- `agent.*` - OpenAcme agent orchestration.

The public workflow DSL should not expose OpenAcme agent built-in tools such as
`execute_code`, `task_create`, or `shell` as generic workflow tools.

### Builtins

Initial built-ins:

- `builtin.if`
- `builtin.if_else`
- `builtin.foreach`
- `builtin.exit`
- `builtin.log.info`
- `builtin.log.debug`
- `builtin.log.error`
- `builtin.set`
- `builtin.transform`
- `builtin.python`

`builtin.set` is the variable-setting flow controller. It writes values into
the workflow context using expressions over run input, previous step outputs,
and current loop item state.

`builtin.transform` computes a new value from existing input/context/step
outputs. It can return output like any other card and can assign that output
back into the same variable or a different variable.

`builtin.python` is a workflow primitive. The implementation may reuse the
existing Python REPL executor internally, but the workflow definition must not
store it as a call to the agent tool named `execute_code`.

### MCP

MCP steps call discovered MCP tools. Runtime storage should keep a stable
canonical form:

```json
{
  "kind": "mcp",
  "server": "slack",
  "tool": "send_message"
}
```

The UI can render that as `mcp.slack.send_message`.

### Agents

Initial agent support:

- `agent.call` - synchronous bounded agent consultation.

Deferred agent support:

- `agent.task` - create/track durable work and resume the workflow when the
  task reaches a terminal status.

Workflow code should call agents through a narrow port, not by reaching through
`AgentManager` internals.

```ts
interface AgentCallPort {
  listAgents(): AgentSummary[];
  callAgent(req: AgentCallRequest): Promise<AgentCallResult>;
  createAgentTask(req: AgentTaskRequest): Promise<{ taskId: string }>;
}
```

## Definition Model

Persist workflow definitions separately from runs. Published workflow versions
are immutable; draft edits create or update the draft, not already-running
versions.

Minimum shape:

```ts
interface WorkflowDefinition {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  name: string;
  description?: string;
  inputSchema?: unknown;
  triggers: WorkflowTrigger[];
  nodes: WorkflowNode[];
  createdAt: string;
  updatedAt: string;
}
```

The first UI can be a vertical card builder. The engine should still store a
graph-capable structure so a later canvas does not require a runtime rewrite.

## Trigger Model

The first release started with manual triggers only. The runtime and storage
model triggers explicitly so scheduled, task, webhook, and event triggers can
be added without changing the run contract.

Initial trigger shape:

```ts
type WorkflowTrigger =
  | {
      id: string;
      kind: "manual";
      enabled: true;
      inputSchema?: unknown;
    }
  | {
      id: string;
      kind: "scheduled";
      enabled: boolean;
      schedule: { kind: "cron"; expr: string; tz?: string };
      input?: unknown;
    }
  | {
      id: string;
      kind: "task";
      enabled: boolean;
      filter: unknown;
    }
  | {
      id: string;
      kind: "webhook";
      enabled: boolean;
      path?: string;
      inputSchema?: unknown;
      secretSha256?: string;
    };
```

`kind: "manual"` is executable through operator run APIs. Webhook triggers are
executable through the authenticated trigger-run API and public webhook ingress
once their input validation and run snapshot semantics are implemented.
Scheduled triggers may be enabled only through dispatcher-owned due scans; the
operator trigger-run API must still reject them so scheduled execution remains
owned by `WorkflowDispatcher`. Task triggers may appear in schema/types as
disabled or deferred shapes, but the server must reject enabling them until
their event subscription semantics exist.

Manual trigger behavior:

- A human clicks Run or calls the manual-run API.
- The request supplies `workflow_id`, published `version` or draft execution
  mode, optional `trigger_id`, and JSON input.
- The server validates input, creates a `workflow_run`, and enqueues it.
- The resulting run stores the trigger snapshot so later edits do not rewrite
  audit history.
- Definition triggers and run trigger snapshots are distinct contracts:
  definition triggers describe what can start a workflow; run trigger snapshots
  describe what actually started this run, for example `requestedBy` and the
  submitted manual input.

Future trigger behavior:

- Scheduled triggers should be owned by `WorkflowDispatcher`, not the existing
  agent/task `Dispatcher`. The dispatcher scans due enabled schedules, enqueues
  runs through the same published run creation path, and does not execute cards
  inline inside a timer callback.
- Scheduled triggers may define static trigger `input`; when omitted, scheduled
  runs use `{}`.
- Task/event triggers should subscribe through an event boundary and enqueue
  workflow runs; they should not directly execute steps inside the event
  handler.
- Webhook triggers should validate request input and enqueue runs through the
  same run creation path as manual triggers. The first webhook slice uses the
  authenticated trigger-run API and does not add an unauthenticated public
  ingress or secret verification contract.
- Public webhook ingress should use a narrow unauthenticated endpoint that
  resolves the published workflow and trigger explicitly, verifies a shared
  secret from `x-openacme-webhook-secret` against a stored `secretSha256`, and
  then uses the same run creation path as the authenticated trigger-run API.
  The public endpoint accepts the request JSON body as workflow input directly;
  it does not execute steps inside the HTTP handler through a separate path.

## Run Model

Workflow run state belongs in SQLite.

Minimum run status:

- `queued`
- `running`
- `waiting`
- `succeeded`
- `failed`
- `canceled`

Store one row per run and one row per step attempt. Step rows are the audit
source for the run detail screen.

All runs are durable. Test runs and non-test runs use the same storage and
trace model so every execution can be inspected later. A test run is not a
temporary preview; it is a persisted run with `mode: "test"`.

Minimum run fields:

- `id`
- `workflow_id`
- `workflow_version`
- `definition_source`: `draft` or `published`
- `mode`: `test` or `live`
- `trigger`
- `status`
- `input`
- `context`
- `current_node_id`
- `waiting_reason`
- `created_at`
- `started_at`
- `ended_at`

Minimum step attempt fields:

- `id`
- `run_id`
- `node_id`
- `attempt`
- `status`: `queued`, `running`, `succeeded`, `failed`, `skipped`, `canceled`
- `started_at`
- `ended_at`
- `duration_ms`
- `input`
- `output`
- `error`
- `logs_summary`
- `context_diff`

Minimum run event fields:

- `id`
- `run_id`
- `step_run_id`
- `sequence`
- `level`: `debug`, `info`, `error`, or `system`
- `kind`: `run_started`, `step_started`, `step_output`, `step_failed`,
  `step_completed`, `branch_selected`, `log`, `run_completed`, `run_failed`,
  `run_canceled`
- `message`
- `payload`
- `created_at`

`workflow_step_attempts` holds the latest inspectable state of each step
attempt. `workflow_run_events` is the append-only timeline. The UI should
render both: the compact step list from step attempts and the full
chronological log from events.

Step input/output retention rules:

- Store structured JSON input and output for every step attempt.
- Redact secrets before persistence.
- Store output excerpts inline and spill large payloads to workflow artifact
  files if needed.
- Preserve error type/message/stack-safe details for failed steps.
- Keep skipped branch information so the operator can see why a step did not
  run.

Workflow artifact file retention rules:

- Artifact metadata and inline artifact references are audit records. Retention
  cleanup must not delete run rows, step attempts, events, metadata rows, or the
  redacted artifact reference embedded in JSON trace fields.
- Cleanup is file-oriented: delete physical files under the configured
  workflow artifact root when their artifact metadata `created_at` is older
  than an explicit cutoff.
- Cleanup must resolve every metadata path inside the configured artifact root
  before deleting. Unsafe paths are skipped and reported, never followed.
- Missing files are reported separately and do not fail the cleanup operation.
- After cleanup, run detail can still show artifact metadata and previews, but
  artifact content/download routes return `artifact_not_found` for deleted
  files.
- This first retention slice is an explicit store/runtime operation. It does
  not add an operator UI, HTTP admin route, scheduled retention job, or policy
  configuration knob.

Workflow external-step cancel signal rules:

- Cancel remains store-first: `POST /api/workflow-runs/:id/cancel` persists the
  run and current step as `canceled` before any in-flight adapter reacts.
- HTTP-started workflow executions maintain an in-process abort controller keyed
  by run id. Canceling one of those runs aborts that controller after durable
  cancellation is written.
- `WorkflowRunner` forwards the run abort signal to external execution ports.
  The first runtime slice applies this to `mcp.tool` calls. The Python slice
  extends the same signal to `builtin.python` and kills the active subprocess on
  abort. The agent slice forwards the same signal to `agent.call` and combines
  it with the existing agent timeout controller.
- MCP adapter cancellation is a workflow await boundary: aborting the signal
  rejects the workflow MCP call promptly and prevents late MCP output from
  being committed. Low-level MCP transport cleanup remains best-effort through
  the existing client lifecycle and timeout handling.
- Python adapter cancellation is a process boundary: aborting the signal kills
  the per-step subprocess and rejects the workflow Python call promptly with
  best-effort stdout/stderr details captured at the process boundary.
- Agent adapter cancellation is an agent-turn boundary: aborting the signal
  cancels the active agent stream through the existing `AgentManager.askAgent`
  abort path and persists a failed agent message for the target session.
- Scheduled dispatcher-originated runs and process-restart recovery do not have
  a live in-process abort controller in this slice. Their durable cancellation
  behavior remains the existing late-completion preservation.

Run mode semantics:

- `mode: "test"` can execute the current draft definition from the editor.
- `mode: "live"` executes a published immutable version.
- Both modes are queryable in run history.
- The run list should filter by mode, status, workflow, trigger, and date
  range.

## Variables And Mapping

Workflow variables live in run `context`. Step outputs remain addressable
through `$.steps.<nodeId>.output`, but commonly reused values should be copied
into named context variables through explicit mapping.

There are two supported ways to set variables:

1. A standalone `builtin.set` card.
2. An optional output assignment section on any executable card.

`builtin.transform` is the normal card for "read variable, transform it, write
it back." The assignment can target the same context path that the transform
read from.

Standalone set example:

```json
{
  "id": "set_customer_id",
  "type": "builtin.set",
  "assign": {
    "customerId": "$.steps.lookup_customer.output.id",
    "riskScore": "$.steps.score_customer.output.score"
  }
}
```

Executable-card output assignment example:

```json
{
  "id": "lookup_customer",
  "type": "mcp.crm.get_customer",
  "input": {
    "email": "$.input.email"
  },
  "assign": {
    "customer": "$.steps.lookup_customer.output",
    "customerId": "$.steps.lookup_customer.output.id"
  }
}
```

Transform-and-save-back example:

```json
{
  "id": "normalize_customer",
  "type": "builtin.transform",
  "input": {
    "customer": "$.context.customer"
  },
  "transform": {
    "kind": "object_pick",
    "fields": ["id", "name", "riskScore"]
  },
  "assign": {
    "customer": {
      "from": "$.steps.normalize_customer.output",
      "mode": "replace"
    }
  }
}
```

Assignment rules:

- Assignments run only after the step succeeds.
- A failed step does not mutate context unless an explicit future
  error-handling policy says otherwise.
- Assignment keys are context paths, not arbitrary code.
- Assignments can write nested paths such as `customer.id`.
- Assignments may target the same context variable that the step read from.
- The default write mode is `replace`.
- `merge` and `append` must be explicit write modes; they are never inferred.
- Replacing a variable records the before/after diff in the step trace.
- Assignment expressions can read `$.input`, `$.context`, previous
  `$.steps.*.output`, and `item` inside `foreach`.
- The UI must show each card's output assignment section so the operator can
  see which variables the card updates.
- Run detail must show context changes for each step so later inspection can
  explain where a variable came from.

The final run context is persisted on the run row. Per-step context diffs
should be recorded in run events or step metadata so debugging a past run does
not require replaying it.

## Expression Language

Start with a constrained expression language that can be validated and audited.

Required references:

- `$.input`
- `$.context`
- `$.steps.<nodeId>.output`
- `item` inside `foreach`

Required operators:

- equality and inequality
- numeric comparison
- boolean `and`, `or`, `not`
- `exists`
- `contains`
- `length`

Avoid arbitrary JavaScript until sandboxing, secrets, determinism, and audit
rules are explicit.

## UI Plan

Initial web surface:

- Workflows route in the main web app.
- Workflow list with draft/published status.
- Structured card editor.
- Right-side step configuration panel.
- Test Run button in the editor for draft execution.
- Run button for published manual runs.
- Run history for every test and live run.
- Run detail view with step trace, full event log, input/output, status, and
  errors.

Editor groups:

- Flow Control
- Builtins
- MCP
- Agents
- Logs

Flow Control and Logs are UI groups; their stored type remains `builtin.*`.

### Run Console

The run detail screen is a required MVP surface, not a later observability
feature.

Required run detail layout:

- Header: workflow name, version/source, mode, trigger, status, duration,
  started time, ended time.
- Left/primary rail: ordered step attempts with status, duration, retry count,
  and selected/skipped branch state.
- Detail panel for selected step: configured node type, resolved input,
  output, error, and logs.
- Timeline panel: chronological `workflow_run_events` with level filters.
- Raw JSON disclosure for run input, final context, step input, step output,
  and error payload.

Required statuses:

- Run: queued, running, waiting, succeeded, failed, canceled.
- Step: queued, running, succeeded, failed, skipped, canceled.

Required actions:

- Start test run from draft.
- Start live manual run from published version.
- Open a past run from workflow history.
- Re-run from a past run's input, creating a new persisted run.
- Cancel a running run.

Run history is global and per-workflow:

- Workflow detail shows that workflow's runs.
- A top-level Runs view can list all workflow runs across workflows.
- Test runs are visible by default but visually distinguishable from live runs.
- Failed runs must be easy to filter and inspect.

## Deployment Boundary

This branch uses a separate runtime data directory:

```sh
OPENACME_DATA_DIR="$HOME/.openacme-the-workflow" pnpm dev
```

or, for a no-service local daemon smoke:

```sh
pnpm agent start --data-dir "$HOME/.openacme-the-workflow" --no-service --no-browser
```

Before first run, configure `~/.openacme-the-workflow/config.yaml` with a port
that does not collide with the existing local production daemon. The default
production runtime remains `~/.openacme` on `127.0.0.1:3456`; this workflow
branch must not mutate it.

Suggested isolated config:

```yaml
server:
  host: 127.0.0.1
  port: 3458
```

## Deployed Validation Practice

Milestone 2 and later require validation against a running OpenAcme instance,
not only package-level unit tests. A milestone or slice is not accepted from
local/unit proof alone once it touches persistence, execution, HTTP, or UI
behavior; the running deployed version must produce the acceptance evidence.
This is a release-practice rule, not a best-effort smoke: the deployed check is
part of the slice's definition of done from Milestone 2 onward.
In practice, that means each Milestone 2+ test plan has a real deployed-product
gate after focused TDD proof; the slice is not closed until the isolated
deployed runtime shows the behavior through the strongest available boundary.
The target is always the isolated workflow runtime:

```text
data dir: /Users/alenbohcelyan/.openacme-the-workflow
URL:      http://127.0.0.1:3458
```

Use two validation layers:

1. Focused tests first: package unit tests, store tests, route tests, typecheck,
   and focused runner tests.
2. Deployed smoke second: start the actual dev server, compiled server, or
   no-service daemon against `~/.openacme-the-workflow` and prove the feature
   through the strongest available surface for that milestone: deployed DB for
   M2-M3, HTTP/API for M4 route work, and Playwright UI for M4+ operator
   behavior.

TDD cadence:

1. Write or tighten the smallest focused test that proves the contract.
2. Confirm it fails for the expected reason when the bug or missing behavior is
   observable locally.
3. Implement the bounded slice and make focused tests pass.
4. Run the relevant wider package checks.
5. Run the deployed smoke against the isolated workflow runtime and verify the
   same behavior through the running product boundary.

The deployed smoke must not use in-memory-only test fixtures as its proof. It
may seed data through test harness code, but acceptance evidence must come from
the real deployed store, HTTP route, scheduler path, or UI route used by the
milestone.

Recommended deployed commands:

```sh
OPENACME_DATA_DIR="$HOME/.openacme-the-workflow" pnpm dev
```

or, after a build when the bundled daemon path matters:

```sh
pnpm agent restart --data-dir "$HOME/.openacme-the-workflow" --no-service --no-browser
curl -sS --max-time 10 http://127.0.0.1:3458/api/health
```

Milestone validation floor:

- Milestone 2: no-service daemon or dev server boots, applies migrations to
  `~/.openacme-the-workflow/state.db`, `/api/health` returns success, and a
  targeted DB/API check proves workflow tables and store reads/writes work
  against the deployed runtime DB. Until workflow HTTP routes exist, this check
  may use the built store directly against the running instance's `state.db`;
  from Milestone 4 onward it must move to API/UI validation.
- Milestone 3: deployed process can execute a manual test workflow through a
  temporary internal/API harness and persist run, step, event, input/output,
  error, and context-diff records.
- Milestone 4: deployed web UI is exercised with Playwright against
  `http://127.0.0.1:3458`, including successful and failing test runs opened
  from history.
- Milestone 5 and later: each new runtime capability is proven once through
  focused tests and once through the deployed process, with the run console or
  API showing the persisted trace.
- UI/operator slices in Milestone 4 and later must use the deployed Playwright
  harness whenever the behavior is visible in the running product. The harness
  should boot the built server/web output, point at
  `~/.openacme-the-workflow`, exercise the actual route, and close with port
  checks for `3458` and any Playwright web port such as `3998`.
- Milestone 2 and later slice close-out records must include the exact deployed
  command, result, isolated data dir, and whether any runtime listener was left
  behind.

Rules:

- Never use `~/.openacme` for workflow milestone validation.
- Do not mark a milestone accepted from mocked/unit proof alone once the
  milestone changes DB, HTTP routes, runtime execution, or UI behavior.
- Record the exact deployed validation command and result in this plan before
  closing the milestone.

## Milestone Plan

Development should move in strict milestones. Each milestone records its tests
before implementation, updates this plan with the accepted behavior, and leaves
the branch runnable against `~/.openacme-the-workflow`.

### Milestone 0 - Planning Baseline

Goal: freeze the initial architecture, runtime boundary, and deployment slot
before code changes.

Scope:

- Branch `local-stage-the-workflows` from `local-stage`.
- Use `~/.openacme-the-workflow` for all runtime work.
- Document `WorkflowManager` as a sibling of `AgentManager`.
- Document `WorkflowDispatcher` as separate from the existing agent/task
  `Dispatcher`.
- Document manual-only trigger MVP with trigger-shaped storage.
- Document durable test/live run history, run console, variables, mapping, and
  transform-save-back behavior.

TDD / validation:

- Markdown plan files pass Prettier.
- Config loader reads `~/.openacme-the-workflow/config.yaml`.
- Port `3458` is reserved for this branch and does not collide with
  production `3456`.

Acceptance:

- No code is required for this milestone.
- `~/.openacme` is not read, written, or restarted.
- Planning brief identifies unresolved decisions before implementation starts.

Status: complete.

### Milestone 1 - Architecture Skeleton And Schemas

Goal: add workflow package/module boundaries and typed schemas with no runtime
side effects.

Scope:

- Add workflow definition, trigger, node, run, step attempt, run event, and
  assignment schemas.
- Add empty `WorkflowManager`, `WorkflowRunner`, and `WorkflowDispatcher`
  seams.
- Add narrow execution ports for future MCP, agent, Python, and event writes.
- Wire construction and shutdown under a server runtime seam without starting
  workflow ticks.
- Keep existing agent/task `Dispatcher` behavior unchanged.

Non-goals:

- No DB migration.
- No web UI.
- No executable workflow steps.
- No MCP or agent execution.

TDD / validation:

- Schema unit tests reject malformed definitions, invalid node kinds, invalid
  trigger enablement, invalid assignment paths, and invalid run statuses.
- Tests prove only `manual` triggers can be enabled in MVP.
- Typecheck affected packages.
- Server construction test proves workflow components can be created/stopped
  without starting workflow execution.

Acceptance:

- Schemas encode `builtin.*`, `mcp.*`, and `agent.*` node families.
- `builtin.set`, `builtin.transform`, `builtin.if_else`, `builtin.log.*`, and
  `builtin.exit` are valid schema nodes.
- Test/live run mode, draft/published definition source, and trigger snapshot
  are represented.
- No command or test mutates `~/.openacme`.

Validation record:

- `pnpm --filter @openacme/workflows test` - passed, 5 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server test -- runtime.test.ts` - passed, 2 tests.
- `CI=1 pnpm install --no-frozen-lockfile` updated workspace links and
  `pnpm-lock.yaml`, then failed in `apps/docs` postinstall because esbuild
  host version `0.28.1` did not match binary version `0.25.12`. This did not
  block focused workflow/server validation.

Status: complete.

### Milestone 2 - Persistence And Audit Store

Goal: persist workflow definitions, immutable versions, durable test/live runs,
step attempts, and append-only run events.

Scope:

- Add Drizzle schema and migration for:
  - workflow definitions
  - workflow versions
  - workflow runs
  - workflow step attempts
  - workflow run events
  - optional workflow artifacts for spilled large inputs/outputs
- Add workflow stores behind narrow APIs.
- Store final run context on the run row.
- Store step input/output/error and context diffs.
- Store run events with stable sequence ordering.
- Add list/filter APIs for workflow-scoped and global run history.

Non-goals:

- No runtime interpreter beyond store-level tests.
- No UI.
- No MCP, agent, foreach, or Python execution.

TDD / validation:

- `@openacme/db` clean bootstrap test proves tables and indexes exist.
- Store tests cover definition draft CRUD, publish/version immutability, run
  creation, test/live mode persistence, step attempt writes, event ordering,
  context diff persistence, and run filtering.
- Store tests prove published versions are immutable while drafts remain
  editable.
- Redaction tests prove secret-looking values are not persisted in raw step
  trace fields.
- Deployed validation against `~/.openacme-the-workflow` proves the running
  process applies migrations, reports `/api/health`, and can read workflow
  store state from the deployed DB.

Acceptance:

- Every run is durable, including test runs.
- Past runs can be queried without replaying workflow logic.
- Step input/output and errors are inspectable from storage.
- Failed/skipped/succeeded step states are persisted.
- Deployed validation command and result are recorded before closing the
  milestone.
- `~/.openacme-the-workflow` remains the only manual runtime target.

Validation record:

- `pnpm --filter @openacme/workflows test` - passed, 5 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 5 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- Deployed validation:
  - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow node packages/server/dist/index.js`
    started the compiled server on `http://127.0.0.1:3458`.
  - `curl -sS http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":1,"skills":2}`.
  - A built-store round-trip against
    `/Users/alenbohcelyan/.openacme-the-workflow/state.db` created a workflow
    draft, published immutable version `2`, created a persisted `mode: "test"`
    run, recorded a succeeded step attempt, appended a log event, and verified
    redaction for `authorization`, `token`, and `apiKey` fields.
- The first deployed round-trip caught a schema/store mismatch where
  `workflow_runs.trigger_json` was using definition-trigger shape instead of
  run-trigger shape. The fix split `WorkflowRunTrigger` from
  `WorkflowTrigger`, defaulted manual run snapshots, and added `contextDiff` to
  the step attempt schema.
- `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow pnpm --filter @openacme/server dev`
  is currently not the preferred deployed smoke path because `tsx watch` hits
  the local esbuild host/binary mismatch. The compiled server path above is the
  accepted M2 deployed validation path.

Status: complete.

### Milestone 3 - Builtin Runner MVP

Goal: execute manual workflows with deterministic built-in nodes and complete
audit traces.

Scope:

- Add constrained expression evaluator.
- Implement `builtin.set`.
- Implement `builtin.transform` with same-variable assignment support.
- Implement `builtin.if` and `builtin.if_else`.
- Implement `builtin.log.info`, `builtin.log.debug`, and `builtin.log.error`.
- Implement `builtin.exit`.
- Implement assignment write modes:
  - `replace` as default
  - explicit `merge`
  - explicit `append`
- Persist run events for run start/end, step start/end, branch selection,
  logs, context diffs, failure, and exit.
- Enforce manual trigger execution only.

Non-goals:

- No MCP calls.
- No agent calls.
- No `foreach`.
- No Python.
- No visual editor.

TDD / validation:

- Runner tests for successful linear runs.
- Runner tests for branch selection and skipped steps.
- Runner tests for failed expression evaluation.
- Runner tests for `builtin.exit` success/failure.
- Runner tests for log event ordering and levels.
- Runner tests for assigning one step output into a context variable.
- Runner tests for transform reading `$.context.foo` and writing back to
  `foo`.
- Runner tests for `replace`, `merge`, and `append` semantics.
- Runner tests prove failed steps do not mutate context by default.
- Deployed validation against `~/.openacme-the-workflow` executes at least one
  successful and one failing manual test workflow through the deployed process
  and confirms persisted run/step/event records.

Acceptance:

- A manual test run can execute from a draft definition.
- A live run can execute from a published immutable version.
- Every step writes inspectable input/output/error and events.
- Final context and per-step context diffs explain where variables came from.
- Failed runs remain inspectable through persisted state.
- Deployed validation command and result are recorded before closing the
  milestone.

Validation record:

- `pnpm --filter @openacme/workflows test` - passed, 10 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts` - passed, 5
  tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- Deployed validation:
  - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow node packages/server/dist/index.js`
    started the compiled server on `http://127.0.0.1:3458`.
  - `curl -sS http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":1,"skills":2}`.
  - A temporary internal harness using built packages
    `packages/workflows/dist/index.js` and `packages/db/dist/index.js` created
    one draft test run and one published live run against
    `/Users/alenbohcelyan/.openacme-the-workflow/state.db`.
  - The draft test run persisted `status: "succeeded"`, `mode: "test"`,
    normalized customer context, branch-selected high-risk path, skipped
    low-risk step, step attempts, `step_output`, `branch_selected`, `log`, and
    `run_completed` events.
  - The published live run persisted `status: "succeeded"`, `mode: "live"`,
    immutable version `2`, normalized customer context, branch-selected
    low-risk path, skipped high-risk step, step attempts, and full event trace.
- The deployed smoke is intentionally not an HTTP/API validation yet because
  workflow routes and run console are Milestone 4 scope. M3 acceptance uses the
  compiled running server plus internal runner/store harness as the temporary
  deployed process proof.

Status: complete for the builtin runner/persistence slice. The next milestone
work is Milestone 4 API/UI; if we decide to split M3 further, the only
remaining M3-like hardening is cancellation/current-node updates inside a real
dispatcher loop.

### Milestone 4 - Manual API And Run Console UI

Goal: make workflows operable from the web app with test runs, live manual
runs, run history, and step-by-step inspection.

Scope:

- Server routes for:
  - workflow list/detail
  - draft create/update
  - publish
  - test run from draft
  - live manual run from published version
  - run list/filter
  - run detail with steps/events/artifacts
  - cancel running run
  - re-run from prior input
- Web route for Workflows.
- Workflow list with draft/published status.
- Vertical card editor for MVP.
- Right-side card configuration panel.
- Test Run button in editor.
- Published Run button.
- Workflow-scoped run history.
- Run detail console with step rail, selected-step input/output/error, event
  timeline, raw JSON disclosures, status filters, and failed-run filtering.

Non-goals:

- No free-form canvas requirement.
- No scheduled/task/webhook triggers.
- No MCP/agent execution unless previous milestone already exposes fake/demo
  nodes.

TDD / validation:

- Server route tests for draft CRUD, publish, test run, live run, run history,
  run detail, cancel, and re-run-from-input.
- Web typecheck.
- Component tests or focused route tests for run status and step status
  rendering where local patterns support it.
- Playwright smoke against `~/.openacme-the-workflow`:
  - create or load a draft workflow
  - run a test execution
  - open it from history
  - verify step input/output appears
  - create a failing run
  - verify error details and timeline events appear
  - re-run from prior input
- Deployed validation keeps the server running on
  `http://127.0.0.1:3458` while Playwright drives the real UI.

Acceptance:

- Operators can test a draft without publishing it.
- Test runs are visible in history by default and visually distinct from live
  runs.
- Every run can be reopened later.
- A failed run shows the failed step, error payload, logs, and prior successful
  step outputs.
- UI does not require reading raw DB files to debug a workflow run.
- Deployed validation command and result are recorded before closing the
  milestone.

API slice validation record:

- Implemented server routes:
  - `GET /api/workflows`
  - `POST /api/workflows`
  - `GET /api/workflows/:id`
  - `PATCH /api/workflows/:id`
  - `POST /api/workflows/:id/publish`
  - `POST /api/workflows/:id/runs/test`
  - `POST /api/workflows/:id/runs/live`
  - `GET /api/workflows/:id/runs`
  - `GET /api/workflow-runs`
  - `GET /api/workflow-runs/:id`
  - `POST /api/workflow-runs/:id/rerun`
  - `POST /api/workflow-runs/:id/cancel`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts` - passed,
  3 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/workflows test` - passed, 10 tests.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 6 tests.
- Deployed API validation:
  - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow node packages/server/dist/index.js`
    started the compiled server on `http://127.0.0.1:3458`.
  - `curl -sS http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":1,"skills":2}`.
  - A real HTTP smoke created workflow
    `m4-api-validation-ms6qxvsu`, ran a draft `mode: "test"` execution,
    published immutable version `2`, ran a `mode: "live"` execution, reopened
    run detail with steps/events, reran from prior input, and verified the
    detail payload contains redacted trace data.

UI slice validation record:

- Implemented web route `GET /workflows` in the React app.
- Added Workflows to the desktop sidebar and mobile tab bar.
- The route renders:
  - workflow definition list with draft/published/version state
  - workflow editor with name, description, node cards, node JSON, and run
    input JSON
  - card append actions for `builtin.set`, `builtin.transform`,
    `builtin.log.info`, and `builtin.exit`
  - Save, Publish, Test, Live, Cancel, and Rerun actions
  - workflow-scoped run history
  - run detail console with run status, mode, version, step rail, selected-step
    input/output/error/context diff, timeline, run input, and final context
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed.
- Deployed UI validation:
  - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow node packages/server/dist/index.js`
    served the built web app and APIs on `http://127.0.0.1:3458`.
  - `curl -sS http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":1,"skills":2}`.
  - `curl -sS -I http://127.0.0.1:3458/workflows` returned HTTP `200`.
  - Playwright opened `http://127.0.0.1:3458/workflows` and verified the
    Workflows nav item, New/Save/Publish/Test/Live actions, definition list,
    card editor, run history, run console, step rail, timeline, selected-step
    context diff, run input, and final context.
  - Playwright created a new workflow from the UI and verified the selected URL
    changed to the new workflow id.
  - Playwright ran a successful draft test run from the UI and verified the run
    detail console rendered `succeeded`, step attempts, `run_completed`, and
    final context.
  - Playwright edited the draft to a failing workflow, saved it, ran a failed
    test, selected the failed step, and verified the error payload
    `Reference not found: $.context.customer.missing` rendered in the run
    console.
  - Screenshots were saved to:
    - `output/playwright/workflows-m4-ui.png`
    - `output/playwright/workflows-m4-failed-run.png`

Cancellation hardening record:

- `POST /api/workflow-runs/:id/cancel` now returns the full run detail payload,
  clears `currentNodeId`/`waitingReason`, sets `endedAt`, and appends a
  `run_canceled` audit event for non-terminal runs.
- Terminal runs still return `409 run_not_cancelable`.
- The Run Console renders a Cancel action for non-terminal runs and refreshes
  the selected detail/history from the cancel response.
- This slice covers persisted run cancellation. Interrupting an already
  executing long-running Python, MCP, or agent step remains future
  WorkflowDispatcher/worker lifecycle work.

Focused validation:

- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs packages/workflows/src/schemas.ts packages/db/src/stores/workflow-store.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflows.tsx`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts runner.test.ts`
  - passed, 19 tests.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
  - passed, 10 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DDUNTkN4.js` and `workflows-CGcD27xk.js`.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code `0`.
  - The script booted built `packages/server/dist` through the real Hono
    app/node-server path, wrote to the isolated deployment data dir, seeded
    workflow `wf_cancel_deployed_ms6twnug`, seeded non-terminal run
    `run_cancel_deployed_ms6twnug`, canceled it through HTTP, verified status
    `canceled`, verified event sequence `run_started`, `run_canceled`,
    verified a second cancel returns `409 run_not_cancelable`, and reopened the
    persisted run detail.
  - `~/.openacme` was not used.
  - Post-smoke port check showed no listener on `3458`.

Global run history hardening record:

- `GET /api/workflow-runs` and `GET /api/workflows/:id/runs` now honor the
  `status` query filter in addition to existing workflow and mode filters.
- Added top-level `/workflow-runs` web route for global workflow run history.
  The view lists runs across workflows, filters by workflow/mode/status, opens
  persisted run details, shows step input/output/error/context diff, renders
  timeline events, exposes raw trigger/run input/final context, and links back
  to the workflow-scoped console.
- Added a desktop sidebar Runs entry and a Workflows header link to the global
  run history.
- Failed runs are directly inspectable through `status=failed` and remain
  visually distinct from successful/test/live runs.
- Global run detail can rerun the selected persisted run from its prior input
  through the existing `POST /api/workflow-runs/:id/rerun` API and keeps the
  newly created run selected in history.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/app/components/Sidebar.tsx apps/web/app/lib/CurrentViewContext.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
  - passed, 10 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-UdLVhifV.js` and `workflows-CU3j8q4v.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The test booted the built server dist plus built web bundle through
    `packages/server/test/e2e/support/boot-web.mjs`, seeded one succeeded run
    and one failed run through HTTP, opened `/workflow-runs?status=failed`,
    verified the succeeded workflow was filtered out, opened the failed run
    detail, and verified failed step, `step_failed` event, and error payload
    `Reference not found: $.context.customer.missing`.
  - Post-smoke port check showed no listener on `3998`.

Global rerun hardening record:

- `/workflow-runs` now exposes a Rerun action beside Cancel/Open workflow in
  the persisted run detail header.
- The action reuses the existing rerun API, creates a new run from the prior
  input, selects the new run, refreshes visible history when it still matches
  active filters, and shifts filters only when needed to keep the new run
  visible.
- The deployed Playwright smoke now verifies that a failed global run can be
  rerun from its prior input, that the selected URL moves to a new run id, that
  the failed history contains both attempts, and that the rerun preserves the
  original input/error inspection path.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BKMHZNer.js` and `workflows-B58GuCb_.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, seeded one succeeded run and one failed run through HTTP, opened
    `/workflow-runs?status=failed`, filtered out the succeeded run, inspected
    failed step/error/timeline detail, reran the failed run from prior input,
    and verified the second failed attempt remained inspectable.
  - Post-smoke port check showed no listener on `3998`.

Run detail observability hardening record:

- The workflow-scoped Run Console and global `/workflow-runs` detail header now
  show run duration, started time, ended time, and definition source.
- Step rails show attempt count and per-step duration, using persisted
  `durationMs` when present and falling back to timestamp deltas for older
  traces.
- Timeline panels support a level filter across `all`, `debug`, `info`,
  `error`, and `system`, including an empty filtered state.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BwUVWTMZ.js` and `workflows-CGOQe3q4.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke verified global failed-run filtering, failed
    run detail inspection, visible run duration metadata, `step_failed` error
    detail, and the timeline `error` level filter hiding `run_started`.
  - Post-smoke port check showed no listener on `3998`.

Step logs observability hardening record:

- `WorkflowRunner` now writes per-step `logsSummary` for log-producing steps
  using the step's persisted log events.
- `builtin.python` step attempts also summarize stdout/stderr in
  `logsSummary.python` on success and failure, so operators do not need to
  infer Python logs only from the output or error payload.
- The workflow-scoped Run Console and global `/workflow-runs` selected-step
  detail now render a `Logs` raw JSON block beside input, output, error, and
  context diff.
- The deployed Playwright smoke now seeds a failed run with a successful log
  step before the failure and verifies the persisted logs are visible when the
  past run is reopened from global history.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 14 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BbijPgDI.js` and `workflows-CpzJUSyf.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test after tightening two strict selectors exposed by
    the smoke.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, seeded one succeeded run and one failed run through HTTP, opened
    `/workflow-runs?status=failed`, verified the successful workflow stayed
    filtered out, confirmed the selected log step renders `Logs` with
    `"About to inspect failed customer"` and customer payload, then selected
    the failed step and verified `step_failed`, the timeline error filter,
    rerun-from-prior-input, and persisted failed input/error inspection.
  - Post-smoke port check showed no listener on `3998`.

Workflow-scoped run console logs validation record:

- Raw JSON blocks in both `/workflows` and `/workflow-runs` now expose stable
  accessible group labels such as `Input JSON`, `Output JSON`, `Error JSON`,
  `Logs JSON`, and `Context diff JSON`.
- The workflow-scoped Playwright smoke now seeds an executed
  `builtin.log.info` step before `builtin.exit`, runs the published manual
  trigger from `/workflows`, selects the persisted `log_customer` step in the
  Run Console, and verifies `Logs JSON` contains both the log message and
  customer payload.
- The global run history smoke was tightened to select the `Trigger` filter by
  exact textbox role, because the new `Trigger JSON` group is intentionally
  addressable as a separate inspectable JSON block.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflows.spec.ts apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-doIFyXfh.js` and `workflows-B0k_7v99.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted the built server dist plus built web
    bundle, exercised card editing/save/publish/manual trigger execution,
    selected the workflow-scoped `log_customer` step, and verified persisted
    `Logs JSON` in the Run Console.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test when run serially after the workflow-scoped smoke.
  - A parallel attempt briefly failed before route load because both smoke
    commands tried to own the same Playwright webServer port; rerunning the
    global smoke alone passed.
  - Post-smoke port check showed no listener on `3998`.

Timeline event payload visibility record:

- Timeline rows in both `/workflows` and `/workflow-runs` now render each
  persisted `workflow_run_events.payload` as a compact raw JSON disclosure when
  payload exists.
- Each event payload block has a stable accessible group label such as
  `Event #6 payload JSON`, making event inspection testable without matching
  incidental duplicated text across selected-step error/output panels.
- The global run history smoke now verifies the selected step `Error JSON`
  separately from the `step_failed` timeline event payload, proving both
  inspection paths remain available for a past failed run.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DYWUV7Xb.js` and `workflows-CHe8TCrE.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test after tightening the selected-step error selector
    to `Error JSON` because the new event payload disclosure intentionally
    exposes the same persisted error text in the timeline.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened a failed run from global history, verified `Error JSON`,
    filtered the timeline to `error`, and verified the `step_failed` event
    payload JSON contains `Reference not found: $.context.customer.missing`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test, proving the same timeline payload UI change did
    not regress the workflow-scoped Run Console flow.
  - Post-smoke port check showed no listener on `3998`.

Workflow-scoped trigger snapshot visibility record:

- The workflow-scoped Run Console now renders the persisted run trigger
  snapshot as `Trigger JSON`, matching the global `/workflow-runs` detail
  surface.
- The `/workflows` Playwright smoke now runs configured manual trigger
  `manual_review`, keeps the persisted run selected in the Run Console, and
  verifies the on-screen `Trigger JSON` contains `manual_review`.
- This closes the workflow-scoped side of the run detail header/raw-disclosure
  contract without changing trigger storage or execution routing.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DWUdSJPt.js` and `workflows-CH-XOysv.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, exercised card editing/save/publish/manual trigger execution,
    verified workflow-scoped `Logs JSON`, and verified workflow-scoped
    `Trigger JSON` contains `manual_review`.
  - Post-smoke port check showed no listener on `3998`.

Selected step node type visibility record:

- The selected-step detail panel in both `/workflows` and `/workflow-runs` now
  renders `Selected step metadata` with node id, configured node type, attempt,
  and status.
- Node type is derived from the persisted `step_started` event payload for the
  matching `stepRunId`, keeping this slice UI-only and avoiding a step attempt
  storage migration.
- The deployed global run history smoke verifies a failed `builtin.transform`
  step exposes `type builtin.transform`; the workflow-scoped smoke verifies a
  persisted log step exposes `type builtin.log.info`.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflows.spec.ts apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-D4yZEMMm.js` and `workflows-B2IdySA6.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, reopened a failed run from global history, selected
    `missing_customer`, and verified `Selected step metadata` shows
    `type builtin.transform`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The workflow-scoped deployed smoke selected `log_customer` in the Run
    Console and verified `Selected step metadata` shows `type builtin.log.info`.
  - Post-smoke port check showed no listener on `3998`.

Timeline event timestamp visibility record:

- Timeline rows in both `/workflows` and `/workflow-runs` now show each event's
  persisted `createdAt` timestamp beside the sequence number.
- Each timestamp span has a stable accessible label such as
  `Event #6 timestamp`, so deployed smoke can prove the chronological event
  log carries both order and wall-clock time.
- The global run history smoke now verifies an error-filtered timeline event
  exposes a timestamp before checking its `step_failed` payload JSON.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-yoK0_xZL.js` and `workflows-BmLCYVOp.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened a failed run from global history, filtered timeline events
    to `error`, verified `Event #... timestamp`, and verified the event payload
    JSON remains inspectable.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test, proving the same timestamp timeline rendering did
    not regress the workflow-scoped Run Console flow.
  - Post-smoke port check showed no listener on `3998`.

Timeline event step association visibility record:

- Timeline rows in both `/workflows` and `/workflow-runs` now show
  `step <nodeId>` when an event is bound to a persisted step attempt via
  `stepRunId`.
- The label is derived by joining `event.stepRunId` to `detail.steps`, not from
  the event payload, so the UI uses the run detail contract as the source of
  truth for step identity.
- The global run history smoke filters to `error`, verifies the `step_failed`
  timeline event remains visible, and proves that the associated step label is
  `step missing_customer`.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed, unchanged after formatting.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-LMKFB2B1.js` and `workflows-5alwWRXj.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened a failed run from global history, filtered timeline events
    to `error`, verified `step_failed`, and verified the timeline row shows
    `step missing_customer`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test, proving the step association timeline rendering
    did not regress the workflow-scoped Run Console flow.
  - Post-smoke port check showed no listener on `3998`.

Selected step timing metadata hardening record:

- The workflow-scoped Run Console and global `/workflow-runs` selected-step
  metadata panel now shows the selected attempt's duration, started time, and
  ended time beside node id, node type, attempt, and status.
- Duration uses the persisted `durationMs` when available and falls back to the
  persisted start/end timestamps, matching the existing step rail behavior.
- The selected-step panel now gives operators the same timing evidence while
  inspecting input, output, error, logs, and context diff for one step.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflows.spec.ts apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BRkduvCZ.js` and `workflows-7KryfIdS.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened a failed run from global history, selected
    `missing_customer`, and verified selected-step metadata shows duration,
    started time, and ended time.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The workflow-scoped deployed smoke selected `log_customer` in the Run
    Console and verified selected-step metadata shows duration, started time,
    and ended time.
  - Post-smoke port check showed no listener on `3998`.

Selected step label audit hardening record:

- Workflow execution now records optional card labels in the persisted
  `step_started` event payload as `nodeLabel`.
- The workflow-scoped Run Console and global `/workflow-runs` selected-step
  metadata panel read that persisted label and show `label <nodeLabel>` beside
  node id, node type, attempt, status, and timing details.
- The label is intentionally sourced from the run's audit event, not from the
  mutable draft/editor state, so reopening a past run shows the label that was
  configured when that run executed.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflows.spec.ts apps/web/e2e/workflow-runs.spec.ts`
  - passed, unchanged after formatting.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 14 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CAcTvEye.js` and `workflows-HCxVmO2S.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, created a failed run with label `Missing customer lookup`, opened
    it from global history, selected `missing_customer`, and verified selected
    step metadata shows the persisted label.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The workflow-scoped deployed smoke ran manual trigger `manual_review`,
    selected `log_customer` in the Run Console, and verified selected-step
    metadata shows label `Log normalized customer`.
  - Post-smoke port check showed no listener on `3998`.

Branch step state visibility hardening record:

- The workflow-scoped Run Console and global `/workflow-runs` step rail now
  derive branch membership from persisted `branch_selected` events and show
  `branch selected` or `branch skipped` on affected step attempts.
- Selected-step metadata now shows the same branch state plus the persisted
  branch condition, so inspecting a selected or skipped step explains which
  branch decision caused that attempt state.
- This is UI-only over existing run events and skipped step attempts; it does
  not add new runtime branch storage or change branch execution semantics.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed, unchanged after formatting.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-D_X1Oe3p.js` and `workflows-D6HXGi3T.js`.
- `pnpm exec prettier --write apps/web/e2e/workflows.spec.ts`
  - passed after narrowing the workflow-scoped Run Console test locator to a
    single `aside`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, created a failed run with an `if_else` branch, verified
    `missing_customer` shows `branch selected`, verified `low_customer` shows
    `branch skipped`, selected `missing_customer`, and verified selected-step
    metadata shows the branch condition.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed because the smoke's Run Console locator could resolve the
    wrong selected-step metadata after detail refresh.
  - after narrowing the locator to the Run Console `aside`, the same deployed
    smoke passed, 1 Chromium test, proving the workflow-scoped manual trigger
    flow still works with the shared branch-state render helper.
  - Post-smoke port check showed no listener on `3998`.

Run history row metadata hardening record:

- Global `/workflow-runs` history rows and workflow-scoped Run Console history
  rows now show the persisted trigger id, workflow version, and definition
  source without requiring the operator to open each run detail first.
- The row metadata is derived from the existing durable run list contract:
  `run.trigger.triggerId`, `workflowVersion`, and `definitionSource`.
- This keeps test/live runs more scannable in both global and per-workflow
  history while preserving the full trigger snapshot JSON in run detail.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflows.spec.ts apps/web/e2e/workflow-runs.spec.ts`
  - passed, unchanged after formatting.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BLn9hrb1.js` and `workflows-3bFYY2PF.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened the global failed-run history, and verified the failed run
    row shows `trigger manual`, `v1`, and `draft`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The workflow-scoped deployed smoke ran published manual trigger
    `manual_review` and verified the Run Console history row shows
    `trigger manual_review`, `v2`, and `published`.
  - Post-smoke port check showed no listener on `3998`.

Run current/waiting header visibility record:

- Global `/workflow-runs` detail headers and workflow-scoped Run Console
  headers now show the persisted `currentNodeId` and `waitingReason` fields.
- Terminal runs render `current none` and `waiting none`; future queued,
  running, or waiting runs can expose their current node and wait reason from
  the same durable run row contract.
- This is UI-only over existing run storage fields and does not change runner
  scheduling, waiting, or current-node update semantics.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflows.spec.ts apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DNswqrNy.js` and `workflows-kE2MRAxL.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened a failed run from global history, and verified the detail
    header shows `current none` and `waiting none`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The workflow-scoped deployed smoke ran manual trigger `manual_review` and
    verified the Run Console header shows `current none` and `waiting none`.
  - Post-smoke port check showed no listener on `3998`.

Card assignment visibility hardening record:

- Workflow card rows now render an `Assignments` summary when a node has an
  `assign` map, showing each target variable, source expression, and explicit
  write mode when present.
- The summary covers direct variable setting such as
  `customer <- $.input.customer` and transformer-style replacement such as
  `customer <- $.steps.normalize.output` with `mode replace`.
- This is still a read-only structured summary over the JSON-backed editor; it
  does not introduce richer per-node forms or drag reordering.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced `workflows-OmRQx76N.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, seeded a workflow with direct set and transform replacement
    assignments, verified both assignment summaries in the card list, published
    the workflow, ran configured manual trigger `manual_review`, and verified
    the persisted trigger snapshot.
  - Post-smoke port check showed no listener on `3998`.

Card reorder/delete hardening record:

- Workflow cards now expose icon actions to move a node up, move a node down,
  and delete a node from the JSON-backed draft without manually editing the raw
  node array.
- The actions preserve the canonical `nodesDraft` JSON as the single source of
  truth and regenerate formatted JSON after each card operation.
- This is a stable list-editor control, not drag/drop canvas behavior.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced `workflows-DxB9Pv98.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, verified Move up/Move down update the node order in `Nodes JSON`,
    verified appending and deleting a log card mutates the draft JSON, then
    published the seeded workflow and ran configured manual trigger
    `manual_review`.
  - Post-smoke port check showed no listener on `3998`.

Card assignment edit hardening record:

- Workflow cards with an `assign` map now expose structured controls for the
  primary assignment target, source expression, and write mode.
- Editing these fields updates the same canonical `nodesDraft` JSON used by
  save/publish/run paths; string assignments preserve their compact shape until
  an explicit mode is selected.
- The first structured edit surface focuses on one primary assignment per card.
  Multi-assignment editing remains available through raw node JSON until richer
  per-node forms are built.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced `workflows-CFKvKCcL.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited the transform card assignment target, source, and mode,
    verified each mutation in `Nodes JSON`, restored the seeded assignment,
    exercised Move/Delete card actions, then published and ran manual trigger
    `manual_review`.
  - Post-smoke port check showed no listener on `3998`.

Card transform config hardening record:

- `builtin.transform` cards now expose structured Input JSON and Transform JSON
  controls.
- Input JSON writes only JSON objects into the shared node `input` map, matching
  `AssignableNodeBase.input`. Transform JSON accepts any valid JSON value, so
  string path expressions can be represented as JSON strings while object DSL
  transforms such as `object_pick` remain editable without opening raw node
  JSON.
- This keeps the card editor JSON-backed and does not introduce a richer visual
  transform builder. It closes the common same-variable workflow path where a
  transform reads a context variable, changes the transform DSL, and writes back
  through the existing assignment controls.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-td_9HxB1.js` and `workflows-nFpTBQgs.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited the seeded transform card input JSON and transform JSON
    through structured controls, verified each mutation in `Nodes JSON`, then
    continued through assignment mode edits, publish, and manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card MCP/agent config hardening record:

- `mcp.tool` cards now expose structured Server and Tool controls that update
  the canonical `nodesDraft` JSON without opening the raw editor.
- `agent.call` cards now expose structured Agent and Prompt controls over the
  same draft source of truth.
- When MCP tool or agent inventory is available, cards also show a compact
  picker for selecting from discovered options. Manual text inputs remain
  available so draft definitions can still point at not-yet-discovered
  development targets.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-PnG0JmV1.js` and `workflows-DykRfe25.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, seeded post-exit `mcp.tool` and `agent.call` cards, edited MCP
    server/tool plus agent id/prompt through structured controls, verified each
    mutation in `Nodes JSON`, restored the seeded values, exercised assignment
    mode and Move/Delete card actions, then published and ran manual trigger
    `manual_review`.
  - Post-smoke port check showed no listener on `3998`.

Card MCP/agent input map hardening record:

- `mcp.tool` and `agent.call` cards now expose structured Input JSON controls
  backed by the shared node `input` map.
- The controls accept JSON objects only, matching `AssignableNodeBase.input` and
  avoiding UI-authored schema-invalid array/string inputs. Values such as
  `{ "message": "$.context.customer.id" }` are written into the canonical
  `nodesDraft` JSON as objects.
- This remains a JSON-backed input-map editor. Schema-derived per-field forms
  for individual MCP tool schemas remain future M5 UI hardening.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BLSJYf7a.js` and `workflows-DjjgdaeZ.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited MCP input JSON and agent input JSON through structured card
    controls, verified each mutation in `Nodes JSON`, then continued through
    the existing publish and manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card MCP/agent timeout hardening record:

- `mcp.tool` and `agent.call` cards now expose structured Timeout ms controls
  backed by the existing node `timeoutMs` field.
- `mcp.tool` timeout editing follows the schema-supported range
  `100..300000` ms. Empty, invalid, too-small, or too-large values remove the
  optional field so the runtime default can apply.
- `agent.call` timeout editing accepts positive integer milliseconds and removes
  the optional field for empty or invalid values. The runner already passes
  `timeoutMs` through `AgentCallPort`; this slice only exposes that existing
  bounded-call contract in the JSON-backed card editor.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CKrqtl1c.js` and `workflows-B17cDrfU.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited MCP and agent timeout values through structured card
    controls, verified each mutation in `Nodes JSON`, then continued through
    the existing input-map edits, publish, and manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card foreach config hardening record:

- `builtin.foreach` cards now expose structured Items, Item Var, Body, and
  Concurrency controls.
- Items and Item Var update the existing expression/string DSL fields. Body is
  edited as a comma-separated node id list and written back to the canonical
  `nodesDraft` JSON as a string array. Concurrency is written as a positive
  integer and empty/invalid input removes the optional field.
- The UI does not change the runtime cap: workflow execution still accepts only
  `concurrency: 1` until a later runtime scheduling slice expands foreach
  concurrency.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-C8yY8HWe.js` and `workflows-DlQb-eRM.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, appended a foreach card, edited items, item variable, body node
    list, and concurrency through structured controls, verified each mutation
    in `Nodes JSON`, then continued through publish and manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card Python config hardening record:

- `builtin.python` cards now expose structured Input, Timeout, Reset, and Code
  controls.
- Input writes only JSON objects into the shared node `input` map, matching
  `AssignableNodeBase.input` and keeping saved drafts schema-valid.
- Timeout writes optional numeric `timeoutMs`; empty, invalid, or below-minimum
  values remove the optional field. Reset writes or removes the optional
  boolean. Code updates the required Python DSL field in the canonical
  `nodesDraft` JSON.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-D2MBIjhL.js` and `workflows-Bnhl8r91.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, appended a Python card, edited input, timeout, reset, and code
    through structured controls, verified each mutation in `Nodes JSON`, then
    continued through publish and manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card exit config hardening record:

- `builtin.exit` cards now expose structured Status and Output controls.
- Status is limited to the schema-supported `succeeded`, `failed`, and
  `canceled` values. Output updates the existing DSL field in the canonical
  `nodesDraft` JSON and remains an expression/string authoring field at this
  JSON-backed editor layer.
- The deployed smoke edits a seeded exit card to failed, restores it to
  succeeded, changes output, restores output, and then proves the workflow can
  still publish and run through the manual trigger path.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-D0cloELa.js` and `workflows-BJVhvKLo.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited exit status and output through structured controls, verified
    each mutation in `Nodes JSON`, restored the succeeded exit contract, then
    continued through MCP/agent/log/branch card edits, publish, and manual
    trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card log config hardening record:

- `builtin.log.info`, `builtin.log.debug`, and `builtin.log.error` cards now
  expose structured Level, Message, and Payload controls.
- The Level selector rewrites the node type only to valid log node types.
  Message and Payload update the existing DSL fields in the canonical
  `nodesDraft` JSON. Payload remains an expression/string field at this layer,
  matching the current JSON-backed card editor scope.
- This gives the flow-control/log card group a real authoring surface without
  introducing a custom log-specific runtime path.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CZGQ2pAa.js` and `workflows-Dj3T6wqj.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, appended a log card, changed it to `builtin.log.error`, edited
    message and payload through structured controls, verified each mutation in
    `Nodes JSON`, then continued through delete, IF/IF Else edit, publish, and
    manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Card branch flow-control hardening record:

- The workflow card toolbar now exposes IF and IF Else flow-control cards,
  backed by the existing `builtin.if` and `builtin.if_else` DSL node types.
- Branch cards expose structured Condition, Then, and Else controls. Then/Else
  values are edited as comma-separated node id lists and written back to the
  canonical `nodesDraft` JSON as string arrays.
- The controls intentionally stay JSON-backed and do not introduce a graph
  canvas. Cross-node branch/foreach reference validation is closed by the node
  reference validation hardening record below.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CdI1BecJ.js` and `workflows-CN7oS7Fi.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, appended IF Else and IF cards, edited branch condition and target
    node lists through structured controls, verified each mutation in
    `Nodes JSON`, then published and ran manual trigger `manual_review`.
  - Post-smoke port check showed no listener on `3998`.

Run history trigger/date filter hardening record:

- Workflow-scoped and global run list APIs now accept `triggerId`,
  `createdFrom`, and `createdTo` filters in addition to workflow, mode, status,
  and limit.
- Date-only filters expand to UTC day bounds before reaching the store.
  Invalid dates return `400` with a field-specific error, and invalid
  `triggerId` values are rejected before querying.
- `/workflow-runs` exposes Trigger, Created from, and Created to filters as
  URL-backed controls. Rerun selection keeps the new attempt visible when it
  matches active filters and clears trigger/date filters only when needed.

Focused validation:

- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
  - passed, 10 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BIHTgsuB.js` and `workflows-TmGmFg8W.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened
    `/workflow-runs?status=failed&triggerId=manual&createdFrom=2000-01-01&createdTo=2999-01-01`,
    verified failed-run filtering by trigger/date, switched the trigger filter
    to a non-matching value and saw an empty state, restored the matching
    trigger, inspected failed step/error/timeline detail, reran the failed run,
    and verified the second failed attempt remained inspectable.
  - Post-smoke port check showed no listener on `3998`.

Trigger JSON draft hardening record:

- `/workflows` now keeps a `triggersDraft` JSON editor sourced from the
  selected workflow definition's `triggers` array.
- Save validates that trigger draft JSON is an array of objects, then sends it
  through the existing `PATCH /api/workflows/:id` `triggers` path. The server
  remains the strict owner of trigger schema validation, so manual triggers must
  stay enabled and future scheduled/task/webhook trigger metadata must stay
  disabled.
- The deployed smoke also exposed and fixed a save-path mismatch where the
  Python card input editor could write a string expression even though
  `builtin.python.input` is stored as an input map. Python input now writes a
  JSON object like the other executable input-map controls.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-C4ktS0M0.js` and `workflows-BtG1v99U.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited Triggers JSON to add disabled webhook metadata and change
    the disabled scheduled cron expression, saved the draft through the UI,
    verified the persisted future trigger appeared disabled, published the
    workflow, ran enabled manual trigger `manual_review`, and confirmed the
    persisted run trigger snapshot.
  - Post-smoke port check showed no listener on `3998`.

Card node label hardening record:

- `/workflows` card editor now exposes the optional node `label` field without
  requiring raw node JSON edits.
- Blank label input removes the optional `label` field from the draft node.
- Node `id` remains non-editable in the structured card UI because branch
  targets, foreach bodies, assignments, and step-output references still depend
  on stable ids. Rename/refactor behavior remains a future explicit flow.
- The deployed smoke edits the `set_customer` card label, verifies the backing
  `Nodes JSON` draft gained `label: "Load customer"`, and verifies the visible
  card controls use the new label before saving, publishing, and running the
  manual trigger.
- Initial deployed smoke exposed a Playwright selector ambiguity because the
  same label also appears inside `Nodes JSON`; the assertion now targets the
  visible card control instead of page-wide text.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts docs/workflow-engine-planning-brief.md docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-D_Ykp634.js` and `workflows-CvzIhk55.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited the `set_customer` label through the card UI, verified the
    JSON-backed draft mutation, continued through trigger JSON, assignment,
    transform, MCP, agent, and run-console edits, saved the workflow, published
    it, ran enabled manual trigger `manual_review`, and confirmed the persisted
    run trigger snapshot.
  - Post-smoke port check showed no listener on `3998`.

Node reference validation hardening record:

- `@openacme/workflows` now exposes `validateWorkflowNodeReferences` for
  cross-node definition checks that are intentionally outside single-node
  schema shape validation.
- The validator rejects duplicate node ids and missing targets in
  `builtin.if.then`, `builtin.if_else.then`, `builtin.if_else.else`, and
  `builtin.foreach.body`.
- Workflow HTTP create/update reject invalid references before persistence.
  Publish, test run, live run, trigger run, and rerun also validate the selected
  definition before creating a run, so older invalid drafts cannot leak into run
  history.
- `/workflows` mirrors the same authoring rule in the JSON-backed card editor:
  the Cards badge changes to `invalid refs`, the missing reference message is
  visible, and Save/Publish/Test/Live actions stop before hitting the API.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/validation.ts packages/workflows/src/index.ts packages/workflows/test/schemas.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
  - passed, 11 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BXn0NVGw.js` and `workflows-BDWzohe7.js`.

Deployed UI/API validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, verified invalid workflow create returns `400` for a missing branch
    target, edited an IF Else card to show `invalid refs` for
    `missing_step`, restored valid targets, continued through trigger JSON,
    assignment, transform, MCP, agent, and run-console edits, saved the
    workflow, published it, ran enabled manual trigger `manual_review`, and
    confirmed the persisted run trigger snapshot.
  - Post-smoke port check showed no listener on `3998`.

Status: complete for the M4 MVP route/API/run-console scope. The structured
card editor is deliberately JSON-backed in this milestone; richer per-node
forms, drag/canvas editing, and true in-flight step interruption remain future
UI/runtime hardening.

### Milestone 5 - MCP Steps

Goal: call MCP tools from workflow runs without exposing OpenAcme agent
built-in tools as workflow tools.

Scope:

- MCP discovery surface for workflow editor.
- MCP execution port independent of `AgentManager` internals.
- Schema-driven input form for MCP tools.
- Canonical storage as `{ kind: "mcp", server, tool }`.
- Step trace redaction for MCP input/output.
- Failure capture for MCP connection and tool execution errors.

Non-goals:

- No agent built-in tools as generic workflow tools.
- No workflow-owned MCP server configuration editor unless required by the
  existing config surface.

TDD / validation:

- Unit/integration test with local fake MCP server.
- Tests prove schema discovery populates editor/API metadata.
- Tests prove successful MCP output can be assigned into context variables.
- Tests prove failed MCP calls persist failed step state and error details.
- Redaction tests prove secrets do not leak into run events or step outputs.
- Deployed validation against `~/.openacme-the-workflow` runs an MCP-backed
  workflow and opens or queries the persisted trace.

Acceptance:

- A workflow can call a real MCP tool through the workflow runtime.
- MCP calls are visible in the run console with resolved input, output/error,
  and duration.
- MCP failures fail or branch according to the workflow's configured policy.
- Deployed validation command and result are recorded before closing the
  milestone.

Validation record:

- Implemented workflow MCP execution without exposing agent built-in tools as
  workflow tools:
  - `MCPClient.callToolDirect(server, tool, args)` executes a selected MCP
    server/tool without going through the agent-facing tool registry dispatch.
  - `WorkflowMcpRuntime` owns a workflow-specific MCP client under
    `ServerRuntime`, backed by global `mcp.json` and a private `ToolRegistry`.
  - `WorkflowRunner` executes `mcp.tool` nodes through `McpExecutionPort`,
    records resolved input, output/error, `step_output`, `step_completed`, and
    context diff, and supports assigning MCP output into workflow variables.
  - `GET /api/workflows/mcp/tools` returns workflow-safe MCP discovery metadata
    for the editor.
  - `/workflows` loads MCP discovery metadata and can append an `mcp.tool` card
    from the discovered server/tool list.
- Focused validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts` - passed, 7
    tests.
  - `pnpm --filter @openacme/workflows check-types` - passed.
  - `pnpm --filter @openacme/workflows build` - passed.
  - `pnpm --filter @openacme/mcp-client check-types` - passed.
  - `pnpm --filter @openacme/mcp-client build` - passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
    - passed, 7 tests.
  - `pnpm --filter @openacme/server check-types` - passed.
  - `pnpm --filter @openacme/server build` - passed.
  - `pnpm --filter web check-types` - passed.
  - `pnpm --filter web build` - passed.
- Real MCP e2e validation:
  - `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/workflows-mcp.e2e.ts`
    - passed, 1 test, using the SDK-backed fake streamable HTTP MCP server.
  - The first run failed under sandbox with `listen EPERM 127.0.0.1`; rerunning
    escalated was required because the test binds loopback ports for both
    OpenAcme and the fake MCP server.
- Deployed validation:
  - Started the SDK-backed fake MCP HTTP server from
    `packages/server/test/e2e/support/mcp-http-server.mjs`, which served
    `http://127.0.0.1:61087/mcp`.
  - Wrote `/Users/alenbohcelyan/.openacme-the-workflow/mcp.json` with the
    `e2e` server pointing at `http://127.0.0.1:61087/mcp`.
  - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow node packages/server/dist/index.js`
    started the compiled server on `http://127.0.0.1:3458`.
  - `curl -sS --max-time 10 http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":1,"skills":2}`.
  - `curl -sS --max-time 20 http://127.0.0.1:3458/api/workflows/mcp/tools`
    returned discovered MCP tool `mcp_e2e__echo` with its JSON schema.
  - A real HTTP smoke created workflow `wf_mcp_deployed_ms6s24if`, ran draft
    test run `5abd1e82-3a7e-4a6c-8a95-f1d247bda458`, and verified run
    `status: "succeeded"`, context `{ "echoResult": "echo: deployed ping" }`,
    step output `"echo: deployed ping"`, persisted `step_output`,
    `step_completed`, `run_completed`, and context diff for `echoResult`.
  - Both the compiled OpenAcme server and fake MCP server were stopped after
    validation; ports `3458` and `61087` were empty.
  - The temporary fake MCP entry was then removed from
    `/Users/alenbohcelyan/.openacme-the-workflow/mcp.json`, leaving
    `{ "mcpServers": {} }` for the next milestone.

Status: complete for the M5 core MCP runtime/API/UI-discovery scope. Complex
JSON Schema form widgets, failure-policy UI, and MCP-specific run-console
duration polish remain future hardening.

MCP schema input authoring hardening record:

- `mcp.tool` cards now read the selected discovered tool's object
  `inputSchema` and render simple schema-driven input rows for top-level
  properties.
- Editing a schema row writes the property expression into the canonical
  `nodesDraft` `input` map, so the existing save/publish/run paths keep using
  the same JSON-backed workflow definition.
- The raw Input JSON editor remains the fallback and source of truth for
  complex schemas, nested objects, arrays, non-string JSON values, and tools
  without discovery metadata.
- The Playwright boot server now exposes a workflow-safe `demo/echo` MCP
  discovery fixture with an object input schema, keeping this UI validation
  inside the workflow MCP port rather than the agent built-in tool registry.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts packages/server/test/e2e/support/boot-web.mjs`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-COyQEtD5.js` and `workflows-CvD_j5eo.js`.
- `pnpm --filter @openacme/server build` - passed.

Deployed UI/API validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, discovered the `demo/echo` MCP tool schema through the workflow MCP
    metadata port, rendered the MCP Schema Input section for the seeded
    `mcp_echo` card, verified the existing `message` expression populated the
    schema row, edited that row, verified the canonical `Nodes JSON` input map
    changed, then continued through raw MCP input JSON fallback, publish, and
    manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

### Milestone 6 - Agent Calls

Goal: allow workflows to call OpenAcme agents through a narrow orchestration
port.

Scope:

- Implement `agent.call`.
- Add agent picker/config UI.
- Add prompt/input templating for agent calls.
- Add timeout and cancellation handling.
- Persist agent call request summary, response, errors, and linked session id
  where applicable.
- Map agent result into workflow context through `assign`.

Non-goals:

- Durable `agent.task` wait/resume unless explicitly pulled into this
  milestone after design approval.
- No direct access to `AgentManager` internals from workflow node handlers.

TDD / validation:

- Unit tests with stubbed `AgentCallPort`.
- Integration tests with the existing stub model seam where practical.
- Tests prove timeout/cancel writes failed/canceled step state.
- Tests prove agent output assignment updates context.
- Manual smoke against `~/.openacme-the-workflow`.
- Deployed validation opens or queries the persisted workflow trace for the
  agent call, not only the agent session.

Acceptance:

- A workflow can ask an agent for a bounded result.
- Agent call traces are inspectable from workflow run detail.
- Agent call failures do not disappear into session logs only; they are visible
  on the workflow step.
- Deployed validation command and result are recorded before closing the
  milestone.

M6 implementation record:

- `agent.call` now runs through `AgentCallPort`, with `WorkflowAgentRuntime`
  adapting to the existing `AgentManager` agent ask seam. Workflow node
  handlers do not reach into `AgentManager` directly.
- `GET /api/workflows/agents` exposes workflow-safe agent metadata for the
  editor. The `/workflows` UI loads those agents and can append an `agent.call`
  card from the picker or generic card toolbar.
- Agent prompts support simple `{{ $.path }}` interpolation, agent input maps
  through the normal expression resolver, and agent output is assignable into
  workflow context with existing assignment modes.
- Successful agent call step output includes response, linked agent session id,
  and assistant message id when available. Agent call errors are persisted on
  the workflow step and run events.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/ports.ts packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts packages/server/src/agent-manager.ts packages/server/src/workflow-agent-runtime.ts packages/server/src/runtime.ts packages/server/src/routes/workflows.ts packages/server/test/runtime.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/workflows-agent.e2e.ts apps/web/app/routes/workflows.tsx`
  - passed; all files unchanged after formatting.
- `pnpm --filter @openacme/workflows test -- runner.test.ts` - passed, 8
  tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 9 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced `workflows-0qixoo8A.js`.

Real agent e2e validation:

- `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/workflows-agent.e2e.ts`
  - passed, 1 test.
  - The e2e server used the real Hono app plus node-server, an actual
    `AgentManager`, and the existing stub model seam. The test created a
    `support` agent, discovered it through `/api/workflows/agents`, executed an
    `agent.call` workflow test run, and reopened `/api/workflow-runs/:id` to
    verify persisted response, session id, and `step_output`.
  - Sandbox escalation was required because the e2e server binds a loopback
    port.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-agent-deployed-smoke.mjs`
  - passed.
  - The script booted built `packages/server/dist` through the real Hono
    app/node-server path with the stub model seam, wrote to the isolated
    deployment data dir, created workflow `wf_agent_deployed_ms6sk69k`, ran test
    run `e7414ca7-b6b2-4766-986c-fc18d18047e6`, and verified
    `status: "succeeded"`, response `"deployed workflow support ok"`, linked
    agent session id `77b26534-f667-47aa-96f0-121760454ecc`, persisted step
    output, and persisted `step_output` event.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

M6 closeout refresh record:

- Current focused validation confirms the two first-release `agent.call`
  runtime contracts:
  successful bounded agent calls assign persisted output into workflow context,
  and canceled in-flight agent calls preserve the canceled workflow outcome
  even if late agent output arrives.
- The deployed smoke now also proves the cancellation path, not only the
  successful agent call path, through the built server and isolated deployment
  data directory.
- This closes M6 for the first-release synchronous `agent.call` contract.
  Durable `agent.task` wait/resume remains explicitly deferred and guarded by
  schema/UI validation.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "calls agents|fails agent"`
  - passed, 2 focused Vitest tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "agent.call"`
  - passed, 2 focused Vitest tests covering HTTP success trace and
    cancellation propagation.
- `pnpm --filter @openacme/server build`
  - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-agent-deployed-smoke.mjs`
  - sandbox run failed because SQLite could not open
    `/Users/alenbohcelyan/.openacme-the-workflow/state.db` from the restricted
    filesystem.
  - rerun outside the sandbox passed with exit code `0` against the isolated
    workflow data dir.
  - Workflow: `wf_agent_deployed_ms7u9p39`.
  - Run: `76a81375-f552-461f-bdbc-f2ccf7a4e1e3`.
  - Run status: `succeeded`.
  - Response: `deployed workflow support ok`.
  - Linked agent session id:
    `b6ed495b-ed04-4de8-8617-c56ea666967f`.
  - Agent cancel workflow: `wf_agent_deployed_ms7u9p39_cancel`.
  - Agent cancel run: `f673b8c0-cc4d-4a94-a7e1-68714611c995`.
  - Agent cancel status: `canceled`.
  - `~/.openacme` was not used.

Status: complete for the M6 first-release synchronous `agent.call` scope.

Agent picker availability hardening record:

- `agent.call` card pickers now respect workflow-safe agent metadata:
  discovered agents with `instantMessagesEnabled === false` are rendered as
  disabled options and cannot be selected from the picker.
- The generic Agents toolbar already disabled unavailable agents; this slice
  closes the card-level picker path so the editor does not encourage selecting
  an agent that would reject synchronous workflow calls.
- Manual Agent id text input remains available for development targets and
  existing definitions. Runtime remains the final owner of agent availability
  errors.
- The Playwright boot server now seeds one enabled agent and one disabled
  agent so deployed UI validation covers both toolbar and card picker states.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts packages/server/test/e2e/support/boot-web.mjs`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-R6iwsbMo.js` and `workflows-CELFGDPk.js`.
- `pnpm --filter @openacme/server build` - passed.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, verified the disabled agent toolbar button is disabled, opened the
    `agent.call` card picker, verified the disabled agent option is disabled,
    confirmed the existing agent id stayed unchanged, then continued through
    MCP schema input, trigger JSON, assignment, transform, publish, and manual
    trigger run.
  - Post-smoke port check showed no listener on `3998`.

Run detail redaction visibility hardening record:

- Run detail JSON blocks now detect persisted `"[redacted]"` markers and show a
  compact `redacted` badge in the block header.
- The badge is rendered in both global `/workflow-runs` details and the
  workflow-scoped Run Console, using the existing durable redaction contract
  from workflow storage. Runtime redaction behavior is unchanged.
- The deployed global run smoke seeds a secret-looking `apiKey` in run input
  and proves the UI shows the redacted marker in run input and log output while
  the raw value is not visible in run input or selected-step input.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DDUNTkN4.js` and `workflows-CGcD27xk.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, opened a failed run from global history, verified redaction badges
    and `"[redacted]"` values, and confirmed the raw secret string was absent.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The workflow-scoped deployed smoke covers the shared JSON block component
    while continuing through card editing, publish, and manual trigger run.
  - Post-smoke port check showed no listener on `3998`.

Workflow definition export hardening record:

- `/workflows` now exposes an `Export` action for the selected workflow.
- Export validates the current editor draft using the same node JSON, trigger
  JSON, node-reference, and name checks as save/publish before creating a file.
- The exported file is a definition-only JSON snapshot with format
  `openacme.workflow.definition.v1`, `exportedAt`, and `workflow` metadata
  containing `id`, `version`, `status`, `name`, `description`, `triggers`, and
  `nodes`.
- Export intentionally does not include run history, step traces, artifacts, or
  persisted run inputs/outputs. Import/conflict behavior remains a separate
  explicit slice.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CgBtSXc2.js` and `workflows-CccotCy1.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited and saved a workflow draft, clicked `Export`, verified the
    suggested filename, parsed the downloaded JSON file, and confirmed the
    exported format, workflow id/version/status/name, webhook trigger metadata,
    and edited node label before continuing through publish and manual trigger
    run.
  - Post-smoke port check showed no listener on `3998`.

Workflow definition import-as-new-draft hardening record:

- `/workflows` now exposes an `Import` action that accepts exported workflow
  definition JSON files.
- Import supports the `openacme.workflow.definition.v1` format and validates
  workflow metadata, name, trigger object array, node object array, and node
  references before creating anything.
- Imported files always create a new draft workflow id with `wf_import_...`.
  Import does not overwrite an existing draft, publish a version, import run
  history, or restore step traces/artifacts.
- The imported draft preserves name, description, triggers, and nodes from the
  exported definition snapshot and then selects the imported workflow in the
  editor.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-B5Qlz9WC.js` and `workflows-GUnKgrR4.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, exported a workflow definition JSON file, completed publish and
    manual trigger run validation, then imported the downloaded file through
    the UI and verified the selected workflow id changed to `wf_import_...`
    while the imported name, webhook trigger, and edited node label were
    preserved.
  - Post-smoke port check showed no listener on `3998`.

Workflow input schema authoring and roundtrip record:

- `/workflows` now exposes `Input Schema JSON` for the selected workflow draft.
- Save sends `inputSchema` through the existing workflow update API. Empty input
  schema JSON or explicit `null` clears the schema; any other valid JSON value
  is persisted as definition metadata.
- Definition export now includes `workflow.inputSchema` when present, and
  import-as-new-draft preserves the exported input schema.
- This slice does not enforce runtime run-input validation yet; it closes the
  editor/storage/export/import metadata gap so a later validation slice has a
  durable schema source.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DeWQg45a.js` and `workflows-BfLwZdby.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited `Input Schema JSON`, saved the workflow draft, exported the
    definition, verified the downloaded JSON retained `inputSchema.required`,
    imported the same file as a new draft, and verified the imported editor kept
    the schema while continuing through the existing publish/manual trigger
    path.
  - Post-smoke port check showed no listener on `3998`.

Runtime input schema validation record:

- Workflow run creation now validates `definition.inputSchema` before creating
  the durable run row.
- Validation is owned by the server workflow route seam used by draft test
  runs, published live runs, manual trigger runs, and reruns. Invalid input
  returns `400` and does not create run, step, or event records.
- The first supported JSON Schema subset covers `type`, `required`,
  `properties`, `additionalProperties: false`, `items`, `enum`, and `const`.
  Unsupported schema keywords remain metadata-only until explicitly added.
- This keeps input validation outside the runner interpreter while preserving
  the existing run/audit contract for accepted runs.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 14 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DeWQg45a.js` and `workflows-BfLwZdby.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, saved a workflow with `Input Schema JSON`, published it, attempted
    a manual trigger run with `{}` input, verified
    `Input does not match schema: $.customer is required`, then restored valid
    input and completed the trigger run through the existing Run Console.
  - Post-smoke port check showed no listener on `3998`.

Manual trigger input schema validation record:

- Manual trigger run creation now validates the selected published version's
  workflow-level `inputSchema` first and the same published trigger snapshot's
  `inputSchema` second.
- Invalid trigger input returns `400` before durable run creation. No run, step,
  or event records are created for rejected trigger inputs.
- Trigger-level schema validation is currently scoped to `kind: "manual"`.
  Scheduled and webhook trigger input contracts remain metadata-only until their
  dispatchers are implemented.
- Error ordering is intentional: workflow input schema remains the global
  contract for all run entrypoints; manual trigger schema is an additional
  entrypoint-specific contract once the global input is valid.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 14 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DeWQg45a.js` and `workflows-BfLwZdby.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, published the workflow, attempted a manual trigger run with `{}`
    and verified `Input does not match schema: $.customer is required`, then
    supplied valid workflow input without `approvalNote` and verified
    `Trigger input does not match schema: $.approvalNote is required`, then
    supplied both required inputs and completed the run through Run Console.
  - Post-smoke port check showed no listener on `3998`.

Manual trigger input schema visibility and roundtrip record:

- `/workflows` trigger cards now show an `input schema` badge when a trigger
  definition carries `inputSchema`.
- The workflow definition export/import smoke now asserts manual trigger
  `inputSchema.required` survives export and import-as-new-draft. This keeps
  trigger-specific input contracts visible without implementing scheduled or
  webhook dispatchers.
- This slice does not add structured trigger schema editing yet; the canonical
  authoring surface remains `Triggers JSON` and the server schema remains the
  validation owner.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-B2JG3l3j.js` and `workflows-Dvwb1Vo6.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, verified the manual trigger card shows `input schema`, exported the
    definition and asserted the manual trigger schema persisted, imported the
    file as a new draft, and verified the imported manual trigger still shows
    the schema badge while the existing publish/manual trigger run path passed.
  - Post-smoke port check showed no listener on `3998`.

Structured manual trigger input schema editor record:

- Manual trigger cards now include an `Input Schema JSON` textarea backed by the
  canonical `triggersDraft` JSON.
- Editing valid JSON updates both the structured trigger card and the raw
  `Triggers JSON` authoring surface. Empty input or `null` removes
  `inputSchema`; invalid JSON leaves the last valid trigger draft unchanged.
- The editor is scoped to manual triggers. Scheduled and webhook trigger schema
  authoring remains metadata-only until their dispatcher semantics are
  implemented.
- During deployed smoke validation, the run console exposed a separate UI bug:
  refreshing run detail after selecting a step could reset `selectedStepId` to
  the first step while focus stayed on the clicked row. `loadRunDetail` now
  preserves the current selected step when the refreshed run still contains it,
  falling back to the first step only when necessary.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-De0DEdeB.js` and `workflows-C1jYdcXC.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited manual trigger schema through the structured trigger card,
    verified the canonical `Triggers JSON` draft changed, restored
    `approvalNote`, saved/exported/imported the definition, and completed the
    publish/manual trigger/run-console path.
  - The same smoke verified selected step metadata remains on `log_customer`
    after run-detail refreshes instead of snapping back to `set_customer`.
  - Post-smoke port check showed no listener on `3998`.

Structured future trigger metadata editor record:

- Scheduled trigger cards now expose structured Cron and TZ inputs that update
  the canonical `Triggers JSON` draft while preserving `enabled: false`.
- Webhook trigger cards now expose a structured Path input that updates the
  canonical `Triggers JSON` draft while preserving `enabled: false`; clearing
  the field removes the optional path.
- This slice intentionally does not make scheduled or webhook triggers runnable
  and does not introduce a dispatcher. It only makes deferred trigger metadata
  inspectable and editable without relying solely on raw JSON.
- The deployed smoke waits for the post-save workflow refresh before editing
  webhook path metadata, matching the real UI lifecycle where Save reloads the
  selected workflow from the server.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CgpAkxRv.js` and `workflows-BPPJtmQB.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited scheduled cron/timezone metadata through structured trigger
    fields, saved the workflow, edited webhook path metadata through the
    structured card, verified export/import preserved those metadata fields,
    and completed the existing publish/manual trigger/run-console path.
  - Post-smoke port check showed no listener on `3998`.

Structured task trigger metadata editor record:

- Task trigger cards now expose a structured `Filter JSON` textarea backed by
  the canonical `Triggers JSON` draft while preserving `enabled: false`.
- Valid JSON updates the task trigger `filter`; invalid JSON leaves the last
  valid trigger draft unchanged.
- This slice intentionally does not make task triggers runnable and does not
  introduce a dispatcher. It only makes deferred task-trigger metadata
  inspectable and editable without relying solely on raw JSON.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-R-KmOX18.js` and `workflows-DJuCiBHI.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited task trigger filter metadata through the structured trigger
    card, verified the canonical `Triggers JSON` draft changed, verified
    export/import preserved that metadata field, and completed the existing
    publish/manual trigger/run-console path.
  - Post-smoke port check showed no listener on `3998`.

### Milestone 7 - Foreach And Python

Goal: add controlled iteration and Python execution after the core audit and UI
loop is proven.

Scope:

- Implement `builtin.foreach` with sequential default.
- Add explicit concurrency limit.
- Persist per-item step attempts or item-level child attempts.
- Implement `builtin.python`.
- Decide and document Python state isolation before implementation:
  - M7 selects per-step subprocess isolation.
  - Python state does not persist across workflow steps or across foreach
    items.
  - `reset` is accepted for definition clarity but is effectively already true
    under per-step isolation.
  - Timeout kills the subprocess; the failed workflow step records stdout/stderr
    collected before termination where available.
- Add timeout and reset behavior for Python.

Non-goals:

- No arbitrary JavaScript expression execution.
- No unbounded foreach concurrency.

TDD / validation:

- Runner tests for foreach success.
- Runner tests for empty collection behavior.
- Runner tests for partial failure behavior.
- Runner tests for concurrency cap.
- Runner tests for per-item input/output trace.
- Python tests for timeout, reset, stdout/stderr/value, failure, and selected
  isolation model.
- Deployed validation against `~/.openacme-the-workflow` runs a foreach and
  Python workflow and verifies persisted item/step traces.

Acceptance:

- Iteration is observable item by item.
- Python execution is deterministic enough to debug from run trace.
- Large Python output follows the same redaction/spill rules as other steps.
- Deployed validation command and result are recorded before closing the
  milestone.

M7 implementation record:

- `builtin.foreach` now executes body nodes sequentially with explicit
  `concurrency: 1`. Values above `1` are rejected instead of silently allowing
  unbounded parallelism.
- Foreach body nodes use item-indexed attempts, so repeated body steps are
  inspectable as attempt `1`, `2`, and so on. Parent foreach output records
  `count` plus per-item status and changed body step outputs.
- Foreach item variables support the default `item` and custom `itemVar`
  references such as `customer.id` inside body node input maps, assignments,
  transforms, branch conditions, and string templates.
- Partial foreach failures fail the run, preserve context from completed items,
  and keep the failing child step visible in the persisted trace.
- `builtin.python` now runs through `PythonExecutionPort`. The default server
  adapter is `WorkflowPythonRuntime`, a workflow sibling runtime that spawns a
  fresh Python subprocess per step.
- M7 selects per-step Python state isolation. Python variables/imports do not
  persist across steps, runs, or foreach items. `reset` is accepted for
  definition clarity and is already satisfied by the selected isolation model.
- Python step output is persisted as `{ value, stdout, stderr }`; assignment can
  target `$.steps.<node>.output.value`. Python failures and timeouts persist
  error details, including captured stdout/stderr where available.
- `/workflows` can append `builtin.foreach` and `builtin.python` cards from the
  JSON-backed card toolbar.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts packages/server/src/workflow-python-runtime.ts packages/server/src/runtime.ts packages/server/test/runtime.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/workflows-python.e2e.ts packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs apps/web/app/routes/workflows.tsx docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts` - passed, 14
  tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 10 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced `workflows-UeaPVJA2.js`.

Real Python e2e validation:

- `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/workflows-python.e2e.ts`
  - passed, 2 tests.
  - The e2e server used the real Hono app plus node-server and the default
    `WorkflowPythonRuntime`. It verified Python stdout/value/stderr output,
    per-step state isolation, foreach item attempts, persisted run detail,
    Python exception details, and timeout failure details.
  - Sandbox escalation was required because the e2e server binds a loopback
    port.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0`.
  - The script booted built `packages/server/dist` through the real Hono
    app/node-server path, wrote to the isolated deployment data dir, created
    workflow `wf_python_deployed_ms6t9402`, ran test run
    `ecd4d5b6-3443-43a8-a0ee-627755b96f83`, and verified
    `status: "succeeded"`, context `{ "tripled": 12, "shifted": [11, 12] }`,
    Python stdout trace, foreach parent output, and two persisted per-item
    Python attempts.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

M7 closeout refresh record:

- The M7 acceptance item "Large Python output follows the same
  redaction/spill rules as other steps" is now directly covered by a route
  regression, not only by the generic MCP-backed step-output spill test.
- `packages/server/test/workflow-routes.test.ts` now executes a
  `builtin.python` workflow step through the workflow Python port, returns a
  large output object with a secret-looking key, and proves the persisted run
  detail exposes a `step_output` artifact reference.
- The same regression reads the artifact content route and download route,
  verifying redacted JSON includes `apiKey: "[redacted]"`, includes Python
  stdout, and omits the raw secret-looking value.
- The current foreach concurrency contract is schema-owned:
  `builtin.foreach.concurrency` values above `1` are rejected before runner
  execution. The runner regression now asserts that schema-boundary error
  instead of the older runner-level failure shape.
- This closes M7 for the first-release foreach/Python scope. Parallel foreach,
  shared Python process state, arbitrary JavaScript expressions, and richer
  Python package/runtime configuration remain out of scope.

TDD note:

- The focused Python output spill route test first failed only because it
  expected the artifact preview to contain stdout. The actual preview contract
  starts at the beginning of the spilled JSON, so a large `value.records`
  string can push stdout outside the preview window. The test now checks
  preview shape while verifying full stdout through artifact content/download.
- The wider workflows suite then exposed stale test drift: the foreach
  concurrency cap had moved to schema validation, but the runner test still
  expected a runner-produced failed step. The test was updated to assert the
  current schema-boundary `too_big` issue for `nodes[0].concurrency`.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large Python workflow outputs"`
  - failed before assertion correction on over-specific artifact preview
    contents.
  - passed after correction, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/test/runner.test.ts packages/server/test/workflow-routes.test.ts`
  - passed.

Wide validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
  - failed before runner test correction on stale foreach concurrency
    expectations.
  - passed after correction, 34 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter @openacme/server check-types`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 36 Vitest tests across workflow routes, runtime, and Python
    runtime.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7ufuo2`.
  - Run: `3d036f52-241a-4cd7-b0fc-1cd449496330`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7ufuo2_cancel`.
  - Python cancel run: `e638c314-18d6-46b3-97af-2b669aabe407`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.

Status: complete for the M7 first-release foreach/Python scope.

### Milestone 8 - Future Trigger Expansion

Goal: add non-manual triggers without changing the run/audit contract.

Scope candidates:

- Scheduled trigger.
- Task/event trigger.
- Webhook trigger.

Required rule:

- Future triggers enqueue workflow runs through the same run creation path as
  manual runs. They do not execute steps inside an event handler.

TDD / validation:

- Trigger-specific scheduling/routing tests.
- Tests prove trigger snapshot is persisted on each run.
- Tests prove disabled triggers do not enqueue runs.
- Deployed validation proves the new trigger enqueues through the running
  workflow dispatcher and reuses the existing run console/history.

Acceptance:

- New trigger kinds reuse the existing run history, run detail, step trace,
  and cancellation surfaces.
- Deployed validation command and result are recorded before closing the
  milestone.

M8 implementation record:

- Trigger definitions remain part of `WorkflowDefinition.triggers`. The first
  runnable trigger contract was manual-only; scheduled, task, and webhook
  triggers were initially accepted as disabled definition metadata for future
  expansion.
- `GET /api/workflows/:id/triggers` returns trigger metadata plus a computed
  `runnable` flag. Manual enabled triggers are runnable; disabled/future
  triggers are visible but not runnable.
- `POST /api/workflows/:id/triggers/:triggerId/runs` runs an enabled manual
  trigger against a published workflow version and reuses the existing
  `executeWorkflowRun` path, so run history, run detail, step attempts, events,
  and cancellation behavior stay unchanged.
- Trigger runs persist a `WorkflowRunTrigger` snapshot with the configured
  trigger id, requested operator, and input payload.
- Disabled/future trigger requests return `409` and do not create runs. M8 did
  not start scheduled/task/webhook dispatchers in the first slice; each trigger
  kind is expanded by a trigger-specific slice.
- `/workflows` now lists configured trigger metadata, shows runnable versus
  disabled/future trigger state, and lets operators run enabled manual triggers
  from the same input draft into the existing run console/history view.

Focused validation:

- `pnpm exec prettier --write docs/workflow-engine-plan.md docs/workflow-engine-planning-brief.md apps/web/e2e/workflows.spec.ts apps/web/app/routes/workflows.tsx`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The test booted the built server dist plus built web bundle through
    `packages/server/test/e2e/support/boot-web.mjs`, seeded a workflow with
    manual and disabled scheduled triggers, verified draft trigger runs are
    disabled in `/workflows`, published the workflow, ran manual trigger
    `manual_review` from the UI, and confirmed the persisted run trigger
    snapshot.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 11 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code `0`.
  - The script booted built `packages/server/dist` through the real Hono
    app/node-server path, wrote to the isolated deployment data dir, created
    workflow `wf_trigger_deployed_ms6tfjvc`, published it, listed trigger
    metadata, ran manual trigger `manual_review`, and verified persisted run
    `c3e7ff4c-e6a0-49f4-aa93-847952106503` with trigger snapshot fields
    `kind: manual`, `triggerId: manual_review`, and `requestedBy: operator`.
  - The same smoke attempted disabled scheduled trigger `nightly`, verified
    `409 trigger_kind_not_runnable`, and confirmed run count stayed `1`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Webhook trigger run API slice record:

- Webhook trigger definitions can now be enabled while scheduled and task
  triggers remain deferred and must still be stored disabled.
- Webhook trigger definitions may carry `inputSchema`; trigger-run creation
  validates workflow-level input first and webhook trigger-level input second
  before creating a durable run.
- `GET /api/workflows/:id/triggers` marks enabled webhook triggers as
  `runnable: true`.
- `POST /api/workflows/:id/triggers/:triggerId/runs` now supports enabled
  webhook triggers through the same published-version `executeWorkflowRun` path
  as manual triggers. The resulting run stores a webhook trigger snapshot with
  `kind: "webhook"`, the configured `triggerId`, and optional
  `x-openacme-webhook-request-id`.
- Invalid webhook input is rejected before durable run creation. Disabled
  scheduled triggers still return `409 trigger_kind_not_runnable`, and no
  scheduler, task-event dispatcher, unauthenticated public webhook ingress, or
  secret verification contract is introduced in this slice.

Focused validation:

- `pnpm exec prettier --write docs/workflow-engine-plan.md packages/workflows/src/schemas.ts packages/workflows/test/schemas.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts` - passed, 7
  tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 15 tests.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code `0`.
  - The script booted built `packages/server/dist` through the real Hono
    app/node-server path, wrote to the isolated deployment data dir, created
    workflow `wf_trigger_deployed_ms71l9ah`, published it, listed trigger
    metadata, ran manual trigger `manual_review`, ran enabled webhook trigger
    `incoming_customer`, and verified persisted webhook run
    `de584948-0ab3-4166-899e-ff7985b0ef78` with trigger snapshot fields
    `kind: webhook`, `triggerId: incoming_customer`, and
    `requestId: req_deployed_webhook_1`.
  - The same smoke rejected invalid webhook input before run creation,
    attempted disabled scheduled trigger `nightly`, verified
    `409 trigger_kind_not_runnable`, and confirmed run count stayed `2`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Webhook trigger UI operation slice record:

- `/workflows` now treats enabled webhook triggers as runnable in locally
  derived trigger card state, matching `GET /api/workflows/:id/triggers`.
- Webhook trigger cards expose the same structured `Input Schema JSON` editor
  as manual triggers, backed by canonical `Triggers JSON`.
- Editing a webhook path now preserves the trigger's current `enabled` value.
  Deployed UI smoke caught the old metadata-only behavior where changing the
  path forced `enabled: false` and made the exported/published webhook trigger
  non-runnable.
- The workflow UI smoke now publishes an enabled webhook trigger, verifies
  trigger-level input schema rejection from the UI, runs the webhook trigger
  successfully, verifies Run Console trigger JSON shows `kind: "webhook"` and
  the configured trigger id, and confirms workflow run history contains both
  manual and webhook trigger runs.
- This slice still uses the authenticated operator trigger-run path. It does
  not add unauthenticated public webhook ingress, webhook secrets, scheduler, or
  task-event dispatch.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-OgX5Fk-W.js` and `workflows-CNeWHwOK.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited enabled webhook trigger metadata and input schema through
    `/workflows`, verified export/import preserved the webhook trigger schema,
    published the workflow, rejected invalid webhook input without creating a
    run, ran enabled webhook trigger `incoming`, and verified Run Console plus
    workflow run history show both `manual_review` and `incoming` trigger runs.
  - A prior deployed smoke failure exposed a test locator ambiguity after Run
    Console rendered `Run input JSON`; the smoke now targets the actual `Run
input` textbox for subsequent trigger runs.
  - Post-smoke port check showed no listener on `3998`.

Public webhook ingress slice record:

- `POST /api/workflow-webhooks/:workflowId/:triggerId` is now an explicitly
  public webhook ingress path that bypasses operator session auth and
  authenticates with a per-trigger shared secret.
- Webhook trigger definitions may carry `secretSha256`, a 64-character SHA-256
  hex digest. Raw webhook secrets are not stored in workflow definitions.
- Public webhook requests send their secret in `x-openacme-webhook-secret`.
  The server compares the SHA-256 digest using timing-safe comparison. Missing
  or wrong secrets return `401 webhook_secret_invalid`; enabled webhook
  triggers without `secretSha256` return `409 webhook_secret_required` from
  the public ingress.
- The public endpoint accepts the request JSON body directly as workflow input,
  validates workflow-level input first and trigger-level input second, and then
  uses the same published-version `executeWorkflowRun` path as manual and
  authenticated webhook trigger runs.
- Public webhook runs store the same webhook trigger snapshot contract with
  `kind: "webhook"`, configured `triggerId`, and optional
  `x-openacme-webhook-request-id`.
- `GET /api/workflows/:id/triggers` omits `secretSha256` from trigger metadata
  views. At this slice boundary, scheduled/task dispatchers and path-based
  webhook routing remained outside this slice; later slice records close the
  scheduled dispatcher and webhook path-routing gaps.

Focused validation:

- `pnpm exec prettier --write packages/server/src/middleware/auth.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/workflows/src/schemas.ts packages/workflows/test/schemas.test.ts docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts` - passed, 7
  tests.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 16 tests.
- `pnpm --filter @openacme/server build` - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code `0`.
  - The script booted built `packages/server/dist` through the real Hono
    app/node-server path, wrote to the isolated deployment data dir, created
    workflow `wf_trigger_deployed_ms71z5uv`, published it, ran manual trigger
    `manual_review`, ran authenticated webhook trigger `incoming_customer`, and
    ran unauthenticated public webhook ingress
    `/api/workflow-webhooks/wf_trigger_deployed_ms71z5uv/incoming_customer`.
  - The deployed public run
    `d105572e-b0e8-4645-afe2-579552fe147b` persisted trigger snapshot fields
    `kind: webhook`, `triggerId: incoming_customer`, and
    `requestId: req_public_webhook_1`.
  - The same smoke rejected a wrong public webhook secret with
    `401 webhook_secret_invalid`, rejected invalid authenticated webhook input
    before run creation, attempted disabled scheduled trigger `nightly`,
    verified `409 trigger_kind_not_runnable`, and confirmed run count stayed
    `3`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Webhook secret hash UI authoring slice record:

- Webhook trigger cards now expose a structured `Secret SHA-256` input backed
  by canonical `Triggers JSON`.
- The UI continues to store and export only `secretSha256`; it does not accept
  or persist raw webhook secrets.
- Trigger metadata from `GET /api/workflows/:id/triggers` still omits
  `secretSha256`. `/workflows` merges authoring-only fields from the selected
  workflow definition into trigger card state so the structured editor remains
  populated after save/import while runtime metadata stays sanitized.
- The workflow UI smoke now edits the webhook secret digest, verifies
  `Triggers JSON`, export, and import preserve it, and then continues through
  the existing publish/manual/webhook trigger run-console path.
- Deployed UI smoke caught the first implementation bug: the sanitized
  `/triggers` response replaced trigger card state after import, blanking the
  `Secret SHA-256` field. The final implementation preserves authoring fields
  locally without changing the public metadata response.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-C6AFVVGH.js` and `workflows-H4h8qhHN.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited webhook path, input schema, and secret SHA-256 metadata
    through `/workflows`, verified export/import preserved the digest, then
    published and ran both manual and webhook triggers through Run Console.
  - Post-smoke port check showed no listener on `3998`.

Scheduled dispatcher due-scan slice record:

- Scheduled trigger definitions can now be enabled while task triggers remain
  deferred and must still be stored disabled.
- Enabled scheduled triggers are not runnable through
  `POST /api/workflows/:id/triggers/:triggerId/runs`; that operator API still
  returns `409 trigger_kind_not_runnable` so scheduled execution stays owned by
  `WorkflowDispatcher`.
- `WorkflowManager` now owns a `WorkflowDispatcher` sibling seam. Server runtime
  exposes `dispatchDueScheduledWorkflowTriggers`, which scans published
  workflow versions, evaluates cron schedules at the current minute, and calls
  the same `executePublishedTriggerRun` path used by manual/webhook trigger
  runs.
- Scheduled runs persist a `WorkflowRunTrigger` snapshot with `kind:
"scheduled"`, the configured `triggerId`, and a minute-rounded `scheduledAt`
  timestamp.
- Duplicate scans for the same workflow version, trigger id, and `scheduledAt`
  are skipped by consulting persisted run history. This slice does not add a
  background interval loop or a dedicated scheduler state table.
- Invalid cron expressions are reported as `invalid_schedule` skips for that
  trigger without blocking other due trigger dispatches.

Focused validation:

- `pnpm --filter @openacme/workflows test -- dispatcher.test.ts schemas.test.ts`
  - passed, 9 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 17 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
  - The deployed smoke created workflow `wf_trigger_deployed_ms72lzzi`,
    published it, ran manual trigger `manual_review`, authenticated webhook
    trigger `incoming_customer`, public webhook ingress
    `/api/workflow-webhooks/wf_trigger_deployed_ms72lzzi/incoming_customer`,
    and scheduled dispatcher trigger `nightly`.
  - Scheduled run `d5ca92b3-9d64-48c5-a50a-1de89226f46a` persisted trigger
    snapshot fields `kind: scheduled`, `triggerId: nightly`, and `scheduledAt:
2026-07-30T02:00:00.000Z`.
  - The same smoke verified direct scheduled trigger API execution returns
    `409 trigger_kind_not_runnable`, duplicate due scan skips `nightly` as
    `already_dispatched`, disabled scheduled trigger `disabled_nightly` remains
    skipped, and run count stays `4`.
  - First deployed smoke attempt caught a real scenario issue: scheduled
    dispatcher input defaulted to `{}` while the smoke workflow expected
    `$.input.customer`, producing a failed persisted run. The smoke now passes
    scheduled input explicitly.
- Post-smoke port checks showed no listener on `3458` or `61087`.

Scheduled runtime poller lifecycle slice record:

- Scheduled trigger definitions now support optional static `input` metadata.
  Dispatcher execution uses the trigger's configured `input` first, then the
  explicit test/smoke override, then `{}`.
- `ServerRuntime` now owns workflow dispatcher lifecycle methods:
  `startWorkflowDispatcher`, `stopWorkflowDispatcher`, and
  `isWorkflowDispatcherRunning`.
- `startWorkflowDispatcher` performs one immediate due scan, then schedules a
  60s unref'd interval by default. Tests can override interval and clock
  through `workflowDispatcherIntervalMs` and `workflowDispatcherNow`.
- `ServerRuntime.close` stops the workflow dispatcher before closing stores, so
  a timer cannot dispatch against a closed workflow DB.
- The server entrypoint starts the workflow dispatcher alongside the existing
  agent/task dispatcher. `createApp()` still constructs runtime without starting
  background dispatchers, preserving test and embedded-app control.
- This slice does not add a scheduler state table. Duplicate protection remains
  based on persisted run history for workflow id, published version, trigger id,
  and minute-rounded `scheduledAt`.

Focused validation:

- `pnpm --filter @openacme/workflows test -- dispatcher.test.ts schemas.test.ts`
  - passed, 9 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 18 tests.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0.
  - The deployed smoke created workflow `wf_trigger_deployed_ms72u2bw`,
    published it, ran manual trigger `manual_review`, authenticated webhook
    trigger `incoming_customer`, public webhook ingress
    `/api/workflow-webhooks/wf_trigger_deployed_ms72u2bw/incoming_customer`,
    and then started the runtime workflow dispatcher poller.
  - The poller created scheduled run
    `1b5836ea-c4ee-441b-82ea-136636f8e603` with persisted trigger snapshot
    fields `kind: scheduled`, `triggerId: nightly`, and `scheduledAt:
2026-07-30T02:00:00.000Z`.
  - The same smoke verified direct scheduled trigger API execution returns
    `409 trigger_kind_not_runnable`, a duplicate due scan skips `nightly` as
    `already_dispatched`, disabled scheduled trigger `disabled_nightly` remains
    skipped, and run count stays `4`.
  - The smoke support script now bounds `server.close()` with a timeout after
    observing a hang despite the listener being gone; the final validation
    command completed with exit code 0.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Scheduled trigger input UI authoring slice record:

- Scheduled trigger cards now expose an `Input JSON` textarea backed by the
  canonical `Triggers JSON` draft.
- Editing scheduled cron or timezone now preserves the trigger's current
  `enabled` value. This matters now that scheduled triggers can be enabled and
  owned by the runtime workflow dispatcher.
- Empty scheduled input or `null` removes the trigger `input`; valid JSON
  writes it back to the scheduled trigger definition.
- The workflow UI smoke now edits scheduled cron, timezone, and input through
  structured trigger controls, verifies canonical `Triggers JSON` changes,
  verifies export preserves enabled scheduled input metadata, imports the
  definition as a new draft, and verifies the scheduled input editor is restored.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-Bq-jRFqV.js` and `workflows-BwR6fV9T.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, edited scheduled trigger input metadata through `/workflows`,
    verified export/import preserved the configured scheduled input, then
    continued through the existing publish/manual/webhook trigger run-console
    path.
  - Post-smoke port check showed no listener on `3998`.

Trigger enabled card control slice record:

- Trigger cards now expose an `enabled` checkbox in the card header.
- Manual triggers render checked and disabled because schema requires manual
  triggers to stay enabled. Task triggers render unchecked and disabled because
  task trigger dispatch semantics remain deferred.
- Scheduled and webhook triggers can be enabled or disabled from the structured
  card UI. The checkbox writes directly to the canonical `Triggers JSON` draft.
- Raw `Triggers JSON` edits now refresh structured trigger card state whenever
  the draft parses as a trigger array. Invalid JSON remains editable as raw
  draft text without replacing the last valid structured card state.
- Deployed UI smoke caught the first implementation bug: after editing raw
  `Triggers JSON`, the textarea showed `enabled: true` for a scheduled trigger
  while the structured checkbox stayed unchecked because the textarea change
  handler updated only `triggersDraft`, not trigger card summaries. The final
  implementation keeps both views synchronized.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BFPXElOr.js` and `workflows-LtJ5JHL4.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed on `nightly trigger enabled` staying unchecked after raw
    `Triggers JSON` set `enabled: true`; this identified the stale structured
    trigger state bug.
  - final run passed, 1 Chromium test.
  - The deployed Playwright smoke booted built server dist plus built web
    bundle, toggled scheduled and webhook trigger enabled state from structured
    cards, verified canonical `Triggers JSON` changed, verified export/import
    preserved enabled scheduled metadata, then continued through the existing
    publish/manual/webhook trigger run-console path.
  - Post-smoke port check showed no listener on `3998`.

Public webhook path routing slice record:

- Public webhook ingress now supports path-based routing through
  `POST /api/workflow-webhooks/:workflowId/by-path/*`.
- The route resolves enabled published webhook triggers by their configured
  `path` metadata. Matching normalizes leading and trailing slashes, so
  `crm/customer`, `/crm/customer`, and `/crm/customer/` identify the same
  configured path.
- Path ingress uses the same public webhook execution helper as the existing
  trigger-id ingress. Secret validation, trigger enabled checks,
  workflow-level input schema validation, trigger-level input schema
  validation, persisted run detail, and webhook trigger snapshots are
  identical across both ingress styles.
- Missing path matches return `404 trigger_not_found` without creating a run.
  Ambiguous published webhook paths return `409 webhook_path_ambiguous`
  without creating a run.
- The existing trigger-id route
  `POST /api/workflow-webhooks/:workflowId/:triggerId` remains available; this
  slice adds the path route without changing its contract.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 19 tests.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0.
  - The deployed smoke created workflow `wf_trigger_deployed_ms73c2sc`,
    published it, ran manual trigger `manual_review`, authenticated webhook
    trigger `incoming_customer`, public trigger-id webhook ingress
    `/api/workflow-webhooks/wf_trigger_deployed_ms73c2sc/incoming_customer`,
    public path webhook ingress
    `/api/workflow-webhooks/wf_trigger_deployed_ms73c2sc/by-path/crm/customer`,
    and scheduled dispatcher trigger `nightly`.
  - The deployed path-ingress run
    `089ad5ce-f6df-4589-934a-03128f533e4b` persisted trigger snapshot fields:
    `kind: webhook`, `triggerId: incoming_customer`, and
    `requestId: req_public_webhook_path_1`.
  - The same smoke verified a missing webhook path returns
    `404 trigger_not_found`, a wrong public webhook secret returns
    `401 webhook_secret_invalid`, invalid authenticated webhook input is
    rejected before run creation, direct scheduled trigger API execution
    returns `409 trigger_kind_not_runnable`, duplicate scheduled scans skip
    already dispatched triggers, and final run count is `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Trigger identity validation slice record:

- `@openacme/workflows` now exposes `validateWorkflowTriggers`.
- Workflow trigger ids must be unique within a definition. Duplicate ids are
  rejected before API create, update, publish, and run creation can persist or
  execute the definition.
- Configured webhook trigger paths must be unique after leading/trailing slash
  normalization. This prevents path-based public webhook ingress from selecting
  an arbitrary trigger when definitions are authored through raw `Triggers
JSON` or direct API calls.
- The public path-ingress route keeps its `409 webhook_path_ambiguous` safety
  net for already-persisted or externally seeded invalid published definitions,
  but normal API save/publish paths now fail earlier with
  `Duplicate workflow webhook path: <path>`.
- Task triggers remain schema-deferred: `kind: "task"` still requires
  `enabled: false` until event subscription semantics are implemented.

TDD note:

- The new server route test first failed because duplicate trigger ids were
  accepted with `201`. After wiring trigger validation into create/update,
  publish, and run-before-execute, the focused server suite passed.
- The first implementation pass also exposed that `@openacme/server` resolves
  `@openacme/workflows` through the built package output during tests and
  type-check. Rebuilding `@openacme/workflows` made the new export visible to
  server tests.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/validation.ts packages/workflows/src/index.ts packages/workflows/test/schemas.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 8 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0.
  - The deployed smoke rejected duplicate trigger id definition create with
    `400 Duplicate workflow trigger id: manual`.
  - The same smoke rejected duplicate normalized webhook path definition create
    with `400 Duplicate workflow webhook path: crm/customer`.
  - It then created workflow `wf_trigger_deployed_ms73mr7p`, published it, ran
    manual trigger `manual_review`, authenticated webhook trigger
    `incoming_customer`, public trigger-id webhook ingress, public path webhook
    ingress, and scheduled dispatcher trigger `nightly`.
  - The deployed path-ingress run
    `01288583-94e6-49d1-adc1-9a0d0a2e5a57` persisted trigger snapshot fields:
    `kind: webhook`, `triggerId: incoming_customer`, and
    `requestId: req_public_webhook_path_1`.
  - Final run count remained `5`; invalid duplicate-definition attempts did
    not create runs.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Trigger identity UI validation slice record:

- The deployed workflow UI smoke now exercises server-owned trigger identity
  validation from the raw `Triggers JSON` authoring path.
- The test enters a duplicate trigger id draft, clicks Save, and verifies the
  server error `Duplicate workflow trigger id: manual_review` is visible to the
  operator.
- The same test enters duplicate normalized webhook paths, clicks Save, and
  verifies `Duplicate workflow webhook path: crm/customer` is visible.
- After each rejected draft, the smoke restores the valid trigger draft and
  continues through the existing scheduled/webhook card editing, save, export,
  import, publish, trigger run, and Run Console history flow. This proves the
  error handling path does not poison the rest of the authoring session.

Focused validation:

- `pnpm exec prettier --write apps/web/e2e/workflows.spec.ts` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BFPXElOr.js` and `workflows-LtJ5JHL4.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 1 Chromium test.
  - The deployed smoke booted built server dist plus built web bundle, verified
    both duplicate trigger identity errors from Save, restored valid trigger
    JSON, and completed the existing publish/manual/webhook trigger run-console
    path.
  - Post-smoke port check showed no listener on `3998`.

Trigger identity export/import prevalidation slice record:

- `/workflows` now validates trigger identity before client-side Export creates
  a definition file. Duplicate trigger ids or duplicate normalized webhook paths
  show the same operator-facing messages as server validation and do not start
  a browser download.
- Import validation now applies the same trigger identity check before creating
  a new draft. Invalid imported files stop in the file parser with a toast
  instead of making a doomed create request.
- Save remains server-owned for trigger identity validation. This keeps the
  authoring save path aligned with the runtime schema owner while closing the
  two client-only file boundaries.

TDD note:

- The first deployed Playwright run failed because the validator had been wired
  into `saveDraft` instead of `exportWorkflowDefinition`; clicking Export did
  not surface the expected `crm/export-only` error. The final implementation
  moved the check to Export and kept Save on the server validation path.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-yADk36bP.js` and `workflows-Bb2BErDb.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed on the missing Export validation toast, identifying the
    miswired validation call.
  - final run passed, 1 Chromium test.
  - The deployed smoke booted built server dist plus built web bundle, verified
    invalid trigger identity blocks Export without a download, verified invalid
    imported trigger identity keeps the current workflow selected, restored a
    valid definition, and completed the existing publish/manual/webhook trigger
    run-console path.
  - Post-smoke port check showed no listener on `3998`.

Trigger shape export/import prevalidation slice record:

- `/workflows` now validates first-release trigger shape invariants before
  client-side Export creates a definition file and before Import creates a new
  draft workflow.
- The guard catches trigger ids, supported trigger kinds, manual enabled state,
  scheduled cron schedule shape, deferred task enabled state plus filter
  presence, webhook enabled/path shape, and webhook `secretSha256` digest shape.
- The server `@openacme/workflows` schema remains canonical. This client guard
  exists only at the file boundary so operators get immediate feedback and do
  not download or import definition files that the server would reject later.
- Save, Publish, and Run still rely on server validation.

TDD note:

- The deployed workflow UI smoke now includes a bad task trigger with
  `enabled: true` in both Export and Import paths.
- Export must show
  `Task trigger task_export_invalid must stay disabled until task dispatch is implemented`
  and must not emit a download.
- Import must show
  `Task trigger task_import_invalid must stay disabled until task dispatch is implemented`
  and must keep the currently selected workflow id unchanged.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-apVHGBFh.js` and `workflows-CtolRoWx.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 1 Chromium test.
  - The deployed smoke booted built server dist plus built web bundle, verified
    invalid trigger shape blocks Export without a download, verified invalid
    imported trigger shape keeps the current workflow selected, and completed
    the existing publish/manual/webhook trigger run-console path.
  - Post-smoke port check showed no listener on `3998`.

Public webhook input schema deployed validation slice record:

- The compiled deployed trigger smoke now verifies public webhook ingress uses
  the same trigger input schema validation seam as authenticated operator
  webhook trigger runs.
- Both public ingress forms are covered:
  `/api/workflow-webhooks/:workflowId/:triggerId` and
  `/api/workflow-webhooks/:workflowId/by-path/*`.
- Invalid public webhook payloads with `source: "manual"` return
  `400 Trigger input does not match schema: $.source must equal "crm"` before
  durable run creation.
- The final persisted run list remains exactly the accepted manual, operator
  webhook, public trigger-id webhook, public path webhook, and scheduled run.
  Invalid public webhook schema attempts do not create run, step, or event
  records.
- This supersedes the older manual-trigger-only note for webhook trigger input
  contracts. Scheduled triggers still do not have trigger-level `inputSchema`;
  their static trigger `input` is validated by the workflow-level schema during
  scheduled dispatch.

Focused validation:

- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - first run failed in the sandbox because
    `/Users/alenbohcelyan/.openacme-the-workflow/state.db` could not be opened.
  - rerun with approved access to the isolated workflow data dir passed with
    exit code 0.
  - Created workflow `wf_trigger_deployed_ms74aprh`.
  - Verified public invalid trigger-id webhook input and public invalid path
    webhook input returned the trigger schema error before run creation.
  - Completed manual trigger, operator webhook, public trigger-id webhook,
    public path webhook, and scheduled dispatcher runs.
  - Final run count remained `5`; invalid public webhook schema attempts did
    not create runs.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

External node inventory authoring guard slice record:

- The `/workflows` card editor no longer creates placeholder external nodes
  when MCP tool or enabled agent inventory is unavailable.
- The generic `MCP Tool` append action is disabled until at least one workflow
  MCP tool is listed; the generic `Agent Call` append action is disabled until
  at least one enabled agent is listed.
- The append helper also guards the action path directly, so accidental calls
  cannot add `server/tool` or `agent` placeholder definitions.
- Existing concrete inventory buttons remain unchanged: listed MCP tools append
  their real server/tool ids, enabled agents append their real agent id, and
  disabled agents remain visible but disabled.

TDD note:

- The deployed workflow UI smoke now intercepts MCP/agent inventory APIs to
  return empty lists and verifies the generic external node actions are
  disabled without adding placeholder node text to the editor.
- The existing seeded-inventory workflow smoke still verifies the normal
  trigger/run console path and keeps the disabled `Paused` agent button
  covered.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-B46UjUL8.js` and `workflows-CC_IEYTw.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 2 Chromium tests.
  - The deployed smoke booted built server dist plus built web bundle, verified
    empty external inventory disables placeholder-producing node actions, then
    completed the existing workflow trigger/run console smoke.
  - Post-smoke port check showed no listener on `3998`.

Scheduled dispatcher execution failure isolation slice record:

- `WorkflowDispatcher.dispatchScheduledDue` now isolates execution failures per
  due scheduled trigger.
- A trigger whose `execute` callback fails is recorded in `skipped` with
  `reason: "execution_failed"` and the error message; the dispatcher then
  continues scanning later due triggers in the same pass.
- This prevents one bad scheduled trigger input, such as a static trigger
  `input` that violates the workflow-level `inputSchema`, from blocking other
  due scheduled workflow runs.
- The slice does not add a scheduler state table, retry policy, or durable
  failure row. Invalid scheduled inputs still do not create run, step, or event
  records.

TDD note:

- `@openacme/workflows` now has a dispatcher unit test where `bad_input`
  throws from `execute`, `good_input` still dispatches, and the failed trigger
  is reported as `execution_failed`.
- The server scheduled-dispatch route test now publishes a workflow with
  `invalid_nightly` static input missing `$.customer.name`; the first scan
  skips that trigger with the schema error while still dispatching `nightly`.
- The deployed trigger smoke now proves the same behavior through the compiled
  server and isolated workflow data dir.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/dispatcher.ts packages/workflows/test/dispatcher.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/workflows test -- dispatcher.test.ts`
  - passed, 3 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - first run failed in the sandbox because
    `/Users/alenbohcelyan/.openacme-the-workflow/state.db` could not be opened.
  - rerun with approved access to the isolated workflow data dir passed with
    exit code 0.
  - Created workflow `wf_trigger_deployed_ms74nha2`.
  - Verified `invalid_nightly` was skipped with `reason: "execution_failed"`
    and error `Input does not match schema: $.customer.name is required`.
  - Verified valid scheduled trigger `nightly` still dispatched in the same
    scheduler pass and duplicate scan reported it as `already_dispatched`.
  - Final run count remained `5`; invalid scheduled input did not create a run.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

M8 closeout refresh record:

- M8 trigger expansion now has direct route-level trace parity assertions for
  scheduled, authenticated webhook, public webhook, and public path webhook
  runs.
- The scheduled dispatcher route regression now reopens the scheduled run
  through `GET /api/workflow-runs/:runId` and asserts the persisted trigger
  snapshot, live mode, succeeded `exit` step, and audit events.
- The authenticated webhook route regression now reopens the run detail and
  asserts the persisted webhook trigger snapshot, ordered step statuses, and a
  completed run event.
- The public webhook ingress route regression now reopens both trigger-id and
  path-routed public webhook runs and asserts the same persisted trigger,
  step-trace, and event visibility contract.
- This closes the first-release M8 trigger scope: manual, authenticated
  webhook, public webhook, path-routed public webhook, and scheduled dispatcher
  triggers all reuse the same durable run history, run detail, step attempt,
  event, artifact, and validation surfaces. Task/event triggers remain
  explicitly deferred until their subscription and resume semantics are
  designed.

TDD note:

- The focused M8 route test was tightened first to require run-detail
  inspection after non-manual trigger execution.
- The first focused run failed only on an over-specific scheduled event order
  expectation: persisted scheduled run detail contained both `run_completed`
  and `step_completed`, with `step_completed` recorded after the terminal exit
  event. The final assertion checks for the required audit event set instead of
  depending on incidental event ordering.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "dispatches enabled scheduled|runs enabled webhook|accepts public webhook"`
  - failed before assertion correction on over-specific scheduled event order.
  - passed after correction, 3 focused Vitest tests.
- `pnpm exec prettier --write packages/server/test/workflow-routes.test.ts`
  - passed.

Wide validation:

- `pnpm --filter @openacme/workflows test -- dispatcher.test.ts schemas.test.ts`
  - passed, 16 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter @openacme/server check-types`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 36 Vitest tests across workflow routes, runtime, and Python
    runtime.

Deployed trigger validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7uky4v`.
  - Manual trigger run: `476b5d55-5885-466a-8683-7d48fd73511b`.
  - Run input spill run: `fb64bf23-ad23-444a-bf37-019fa453bab9`.
  - Authenticated webhook run: `4a7a173c-48ca-47c7-906b-9b0d1d2707e9`.
  - Public trigger-id webhook run: `734b634f-f239-4f63-a2b7-ae1e5afdf210`.
  - Public path webhook run: `58d57ced-6f7c-40ba-9130-7a2c612d6b61`.
  - Scheduled dispatcher run: `42d62903-bf6d-4279-bc16-6d06220ce53c`.
  - Verified trigger snapshots for manual, authenticated webhook, public
    webhook, public path webhook, and scheduled runs.
  - Verified artifact prune result
    `{ scannedArtifacts: 12, deletedFiles: 1, missingFiles: 11, skippedUnsafePaths: 0 }`.
  - Final run count remained `5` for accepted trigger executions.
  - `~/.openacme` was not used.

Status: complete for the M8 first-release trigger expansion scope.

Global run detail deep-link hardening slice record:

- `/workflow-runs?run=<runId>` now opens the persisted run detail directly
  through `GET /api/workflow-runs/:id`, even when the selected run is not part
  of the current list response because of active filters or list limits.
- The global run list still honors workflow/mode/status/trigger/date filters;
  direct run detail loading only affects the selected detail panel and URL
  state.
- If the direct run id cannot be loaded, the page clears the stale `run` query
  parameter and falls back to the filtered list behavior.
- This improves the long-term inspection contract: a copied run URL or link
  from another workflow surface can reopen the persisted run without requiring
  the operator to first match the exact filter set that would include it.

TDD note:

- The deployed global run history smoke now opens a failed run by id while the
  list is filtered to `status=succeeded`.
- The page must keep the `run` query parameter, render the failed run id in the
  detail panel, and keep the succeeded filtered list visible before continuing
  through the normal failed-run filter/detail/rerun assertions.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-mR8yY6rf.js` and `workflows-BzVps4Rg.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 1 Chromium test.
  - The deployed smoke booted built server dist plus built web bundle, verified
    direct run deep-link detail loading outside the active filtered list, and
    completed the existing failed-run inspection/rerun path.
  - Post-smoke port check showed no listener on `3998`.

Workflow-scoped run console ownership guard slice record:

- The `/workflows` editor run console now treats selected run detail as
  workflow-scoped state.
- When `/workflows?id=<workflowId>&run=<runId>` points at a run owned by a
  different workflow, the editor refuses to render that foreign run in the
  selected workflow console.
- The stale `run` query parameter is cleared and the console falls back to the
  selected workflow's own run history behavior.
- The global `/workflow-runs` surface keeps its broader deep-link behavior:
  copied run links can still open a run detail even when current list filters do
  not include it. This guard only applies to the workflow editor surface where
  the run console is subordinate to the selected workflow definition.

TDD note:

- The deployed workflow UI smoke now creates two workflows, creates a test run
  on the foreign workflow, opens the primary workflow editor with the foreign
  run id in the URL, and verifies the URL drops the `run` parameter while the
  console shows no selected run.
- The existing empty-inventory guard and manual trigger/run console smoke still
  run in the same deployed UI suite.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-mPWQ62mU.js` and `workflows-BVZ1jGJt.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 3 Chromium tests.
  - The deployed smoke booted built server dist plus built web bundle, verified
    foreign workflow run deep-links are rejected by the workflow-scoped console,
    preserved the empty external inventory guard, and completed the manual
    trigger/run console workflow.
  - Post-smoke port check showed no listener on `3998`.

Global run history pagination slice record:

- The workflow run store now supports offset-based run history pages through
  `listRunsPage` while preserving the existing `listRuns` array-returning API.
- `/api/workflow-runs` and `/api/workflows/:id/runs` now accept `offset` in
  addition to the existing `limit` and return pagination metadata:
  `limit`, `offset`, `hasMore`, and `nextOffset`.
- Existing API consumers that only read `runs` remain compatible because the
  response still contains the same `runs` field.
- Run ordering is now deterministic for pagination with
  `created_at DESC, id DESC`.
- The global `/workflow-runs` UI loads 25 runs initially and exposes a
  history-list `Load more` action when older filtered runs exist. Loading more
  appends unique runs to the list without changing the selected run detail.
- Direct run deep-links still work independently of the paged list: a copied
  run id can load its detail even if it is outside the first page.

TDD note:

- The DB store test now creates three runs and verifies first and second page
  metadata plus newest-first ordering.
- The server route test now verifies global and workflow-scoped run-list
  pagination metadata and offset behavior.
- The deployed global run history smoke now seeds 27 runs, confirms an older
  run is absent from the first UI page, clicks `Load more`, and verifies that
  older run becomes visible.

Focused validation:

- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts`
  - passed, 6 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - first run failed because the server test consumed stale built
    `@openacme/db` output that did not yet include `listRunsPage`.
  - rerun after `pnpm --filter @openacme/db build` passed, 20 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-IPOPj-Ig.js` and `workflows-DzGqkdk1.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 2 Chromium tests.
  - The deployed smoke booted built server dist plus built web bundle, verified
    older global run history pages load through the UI, and completed the
    existing failed-run inspection/rerun path.
  - Post-smoke port check showed no listener on `3998`.

Workflow editor run console pagination slice record:

- The `/workflows` editor Run Console now uses the same paged run-list API
  contract as the global run history surface.
- The selected workflow's Run Console loads 25 runs initially and exposes a
  `Load more` action when older workflow-scoped test/live runs exist.
- Loading more appends unique older runs without changing the currently
  selected run detail or step focus.
- The existing workflow-scoped ownership guard remains intact: direct
  `/workflows?id=<workflowId>&run=<runId>` detail loading still rejects runs
  owned by another workflow.
- The Run Console panel now has an explicit accessible label so tests and
  future automation can target the actual console instead of matching incidental
  workflow names that contain the words "Run Console".

TDD note:

- The deployed workflow UI smoke now seeds 27 runs for one workflow, confirms
  an older run is absent from the first Run Console page, clicks `Load more`,
  and verifies the older run becomes available in the workflow-scoped history.
- The same deployed suite still covers foreign-run deep-link rejection, empty
  MCP/agent inventory guards, and manual trigger/run console execution.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; final build produced
  `workflow-runs-C0398vBq.js` and `workflows-DIwLwUvX.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding exposed a brittle locator: workflow names
    containing "Run Console" caused the test to select the definitions sidebar
    instead of the Run Console panel.
  - after adding an explicit Run Console label and updating the tests, the
    approved rerun passed, 4 Chromium tests.
  - The deployed smoke booted built server dist plus built web bundle, verified
    older workflow-scoped run pages load through the editor Run Console,
    preserved foreign-run deep-link rejection, preserved empty external
    inventory guards, and completed the manual trigger/run console workflow.
  - Post-smoke port check showed no listener on `3998`.

Run detail manual refresh slice record:

- The global `/workflow-runs` detail panel and workflow-scoped `/workflows` Run
  Console now expose a `Refresh` action for the currently selected run.
- Refresh reloads `GET /api/workflow-runs/:id`, updates the detail payload, and
  replaces the matching history row metadata when the run is present in the
  current list.
- This gives operators an explicit way to re-check running, waiting, canceled,
  or externally updated run state without changing filters, leaving the selected
  workflow, or relying on page reload.
- The slice does not add live streaming or automatic polling. Durable live step
  persistence for genuinely long-running workflow executions remains a future
  runtime/storage slice.

TDD note:

- The global run history smoke now clicks `Refresh` on a failed run detail and
  waits for the selected `GET /api/workflow-runs/:id` request to complete.
- The workflow editor smoke now clicks Run Console `Refresh` after a manual
  trigger run and verifies the selected run detail endpoint is reloaded.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-5iOoZPFB.js` and `workflows-id9cvphP.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts workflows.spec.ts`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 6 Chromium tests.
  - The deployed smoke booted built server dist plus built web bundle, verified
    global run detail refresh, workflow-scoped Run Console refresh, older global
    and workflow-scoped history page loading, foreign-run deep-link rejection,
    empty external inventory guards, and the manual trigger/run console flow.
  - Post-smoke port check showed no listener on `3998`.

Early durable workflow event persistence slice record:

- The server execution path now wires `WorkflowRunner` through a store-backed
  workflow event port, so run and step timeline events are persisted as the
  runner emits them instead of being inserted only from the final result.
- Final step attempts still persist after runner completion in this slice.
  Live streaming, automatic polling, and partial step-attempt updates remain
  separate runtime/UI slices.
- The final result event insertion loop was removed from the server route path
  so durable events are not duplicated after event-port persistence.
- `WorkflowEventPort` now uses the workflow schema event-kind union instead of
  a free-form string.
- `workflow_run_events.step_run_id` is now an audit soft reference. A forward
  migration rebuilds the event table without the step-attempt foreign key,
  because early `step_started` events can be durable before the corresponding
  step attempt row exists.
- The deployed trigger smoke now asserts contiguous event sequences and a
  terminal run event for manual, authenticated webhook, and public webhook
  trigger runs.

TDD note:

- Runner TDD proves the event port sees `run_started` and `step_started`
  before an MCP tool call returns.
- Server route TDD proves an MCP HTTP run returns a non-duplicated durable
  event timeline with sequences `1..5`.
- Deployed validation is required for this slice because it changes both
  runtime execution timing and existing deployed SQLite migration state.

Focused validation:

- `pnpm exec prettier --write --ignore-unknown packages/db/src/schema.ts packages/db/drizzle/0018_mean_paibok.sql packages/db/drizzle/meta/0018_snapshot.json packages/db/drizzle/meta/_journal.json packages/workflows/src/ports.ts packages/server/src/routes/workflows.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs packages/server/test/workflow-routes.test.ts packages/workflows/test/runner.test.ts docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 15 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - first deployed run failed with `FOREIGN KEY constraint failed`, proving the
    existing isolated deployed DB still had the old event-to-step-attempt FK
    from an already-applied migration.
  - after adding the forward migration, the next deployed run applied it to
    `/Users/alenbohcelyan/.openacme-the-workflow`, created workflow
    `wf_trigger_deployed_ms767299`, ran manual, authenticated webhook, public
    webhook, path webhook, and scheduled trigger flows, and verified event
    sequence assertions for the manual/webhook response paths.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Durable current-node tracking slice record:

- The server workflow execution path now updates `workflow_runs.current_node_id`
  from the same event-port stream that persists durable timeline events.
- `step_started` sets the current node before an external MCP/agent/Python call
  can run. Step completion, step failure, and terminal run events clear the
  current node and waiting reason.
- Final run state updates also clear `currentNodeId` and `waitingReason`, so
  terminal run detail remains explicit as `current none` and `waiting none`.
- This slice only tracks the active node in the run row. It does not add
  partial step-attempt persistence, automatic UI polling, or interrupting
  in-flight external calls.

TDD note:

- The MCP HTTP route test now observes the run row from inside the MCP tool
  call and expects `status: "running"` with
  `currentNodeId: "crm_lookup"` before the tool returns.
- The same test expects the returned terminal run detail to clear
  `currentNodeId` back to `null`.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs MCP workflow steps through HTTP with persisted trace"`
  - first run failed with `currentNodeId: null`, proving the missing current
    node update.
  - passed after wiring server progress updates from workflow events.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed against the isolated workflow runtime, created workflow
    `wf_trigger_deployed_ms76d9nx`, ran manual, authenticated webhook, public
    webhook, path webhook, and scheduled trigger flows, and preserved the
    deployed event-sequence assertions from the prior slice.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Partial running step-attempt persistence slice record:

- `step_started` event handling now creates a durable
  `workflow_step_attempts` row with `status: "running"` before the external
  MCP/agent/Python call can execute.
- `recordStepAttempt` now updates an existing step attempt for the same
  `id` or `(run_id, node_id, attempt)` instead of assuming final step
  persistence is always the first write.
- Final runner output still owns resolved step input/output/error/log summary
  and context diff. The running placeholder is intentionally minimal and is
  replaced by the final attempt record after runner completion.
- This slice enables the Run Console step rail to have durable in-progress
  state once the UI reloads or polls. It does not add automatic polling,
  streaming, or true interruption of in-flight external calls.

TDD note:

- The MCP HTTP route test now observes the store from inside the MCP tool call
  and expects the run to expose both `currentNodeId: "crm_lookup"` and a
  durable step attempt `{ nodeId: "crm_lookup", status: "running" }` before
  the tool returns.
- The same test still verifies the final response contains a single succeeded
  `crm_lookup` step with output and the non-duplicated event sequence.

Focused validation:

- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs MCP workflow steps through HTTP with persisted trace"`
  - first run failed with `steps: []` during the MCP call, proving the missing
    running step-attempt persistence.
  - passed after adding the running placeholder and explicit store upsert.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed against the isolated workflow runtime, created workflow
    `wf_trigger_deployed_ms76knjw`, ran manual, authenticated webhook, public
    webhook, path webhook, and scheduled trigger flows, and preserved the
    deployed event-sequence assertions.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Non-terminal run detail auto-refresh slice record:

- Global `/workflow-runs` detail and workflow-scoped `/workflows` Run Console
  now automatically refresh the selected run detail while its status is
  `queued`, `running`, or `waiting`.
- Auto-refresh uses the existing `GET /api/workflow-runs/:id` endpoint and
  stops once the selected run reaches `succeeded`, `failed`, or `canceled`.
- Manual `Refresh` remains available. This slice does not add server push,
  streaming, or a new subscription endpoint.
- The behavior closes the UI loop opened by durable current-node and running
  step-attempt persistence: once an operator leaves a running run detail open,
  the header and step rail can progress without a page reload.

TDD note:

- The global run history Playwright test mocks a selected `running` detail,
  verifies `current lookup` and a `lookup running` step are rendered, then
  verifies the interval reload updates the same detail to `succeeded`,
  `current none`, and `lookup succeeded`.
- The workflow-scoped Run Console Playwright test covers the same transition
  through `/workflows?id=<workflowId>&run=<runId>`. It keeps the first two
  detail responses non-terminal to avoid relying on duplicate initial load
  timing, then expects the interval reload to render the terminal detail.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DvzAaoTq.js` and `workflows-_9cliyC8.js`.
- `pnpm --dir apps/web exec playwright test -g "auto-refreshes non-terminal"`
  - first run failed in the sandbox because the Playwright webServer could not
    bind `127.0.0.1:3998` with `EPERM`.
  - rerun with approved server binding passed, 2 Chromium tests.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts workflows.spec.ts`
  - passed with approved server binding, 8 Chromium tests.
  - The deployed suite covered global run history pagination, global
    non-terminal detail auto-refresh, failed-run inspection, workflow-scoped
    run ownership, workflow-scoped history pagination, workflow Run Console
    non-terminal auto-refresh, empty external inventory guards, and manual
    trigger/run console execution.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow event observer isolation slice record:

- Store-backed workflow event persistence is now the primary event write path.
  Optional observer event ports are best-effort sinks and no longer run before
  the durable store append.
- If an observer `events.append` throws, the workflow run continues and the
  durable event timeline remains intact. Store append or progress-update
  failures still fail the run path because they are part of the canonical audit
  state.
- This keeps tests and future event-bus integrations from accidentally
  weakening the run audit contract.

TDD note:

- A server route test now injects an observer event port that throws
  `observer_down` for every event.
- Before the fix, the workflow run returned `400`.
- After the fix, the same run returns `201`, status `succeeded`, persisted
  context, and durable event sequence `run_started`, `step_started`,
  `step_completed`, `run_completed`.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "keeps durable event persistence independent"`
  - first run failed with HTTP `400`, proving observer failure was coupled to
    workflow execution.
  - passed after making observer delivery best-effort after durable persistence.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed against the isolated workflow runtime, created workflow
    `wf_trigger_deployed_ms76y5c9`, ran manual, authenticated webhook, public
    webhook, path webhook, and scheduled trigger flows, and preserved deployed
    event-sequence assertions.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Global run detail selected-step refresh preservation slice record:

- Global `/workflow-runs` detail now preserves the selected step across manual
  refresh and auto-refresh when the refreshed detail still contains that step.
- If the selected step no longer exists, the route falls back to the first
  returned step as before.
- This matches the workflow-scoped Run Console behavior and prevents a running
  or recently completed detail from jumping back to the first step while an
  operator is inspecting a later step's input/output.

TDD note:

- The global run history auto-refresh Playwright test now uses a two-step run:
  `lookup` and `notify`.
- The test selects `notify` while the run is still non-terminal, then waits for
  auto-refresh to return a terminal run with `notify` output.
- Before the route fix, the focused test failed because the refreshed detail
  reset selected metadata back to `node lookup`.
- After preserving the current selected step id when it still exists, the same
  test keeps `node notify` selected and shows the refreshed `notify` output.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DxYEIIE7.js` and `workflows-BCSB47Eu.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "auto-refreshes non-terminal global run details"`
  - first run before implementation failed with selected metadata resetting to
    `node lookup`, proving the regression.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed with approved server binding, 3 Chromium tests.
  - The deployed suite covered global history pagination, non-terminal detail
    auto-refresh with selected-step preservation, and failed-run inspection.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Global run detail selected-step cancel preservation slice record:

- Global `/workflow-runs` detail now uses the same selected-step retention rule
  after `Cancel` that it uses for manual refresh and auto-refresh.
- If the cancel response still contains the currently selected step, the
  selected detail panel stays on that step. If not, the route falls back to the
  first returned step.
- This prevents an operator who cancels a running workflow while inspecting a
  later queued/running step from being moved back to the first step.

TDD note:

- A global run history Playwright test now mocks a two-step running run,
  selects `notify`, cancels the run through `POST /api/workflow-runs/:id/cancel`,
  and expects selected-step metadata to remain `node notify`.
- Initial test attempts first exposed ambiguous `Cancel` and `Run canceled`
  locators, which were tightened before accepting the regression proof.
- Before implementation, the focused test failed with selected metadata reset
  to `node lookup`, proving the cancel action still used the old first-step
  reset path.
- After changing the global route to retain the current selected step id when
  present, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-C-ZlwC19.js` and `workflows-CxxB3ZBE.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "keeps selected global run step after cancel"`
  - failed before implementation with selected metadata reset to `node lookup`.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed with approved server binding, 4 Chromium tests.
  - The deployed suite covered global history pagination, non-terminal detail
    auto-refresh, selected-step preservation after cancel, and failed-run
    inspection.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow-scoped Run Console selected-step cancel preservation slice record:

- Workflow-scoped `/workflows` Run Console now uses the same selected-step
  retention rule after `Cancel`, draft test run, live run, trigger run, and
  rerun responses that it uses for detail refresh.
- If the response still contains the currently selected step, the selected
  detail panel stays on that step. If not, the route falls back to the first
  returned step.
- This aligns workflow-scoped inspection with the global run history behavior
  and prevents canceling a run from moving the operator back to the first step
  while they are inspecting a later step.

TDD note:

- A workflow-scoped Run Console Playwright test now mocks a two-step running
  run, selects `notify`, cancels through `POST /api/workflow-runs/:id/cancel`,
  and expects selected-step metadata to remain `node notify`.
- Before implementation, the focused test failed with selected metadata reset
  to `node lookup`, proving the workflow-scoped cancel action still used the
  old first-step reset path.
- After changing `/workflows` to retain the current selected step id when it
  is still present, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-B1-xTVnL.js` and `workflows-imNEibV7.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "keeps selected workflow run console step after cancel"`
  - failed before implementation with selected metadata reset to `node lookup`.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed with approved server binding, 6 Chromium tests.
  - The deployed suite covered run ownership deep-link rejection,
    workflow-scoped history pagination, non-terminal Run Console auto-refresh,
    selected-step preservation after cancel, empty external inventory guards,
    and configured manual trigger execution from the console.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Global run history loaded-page cancel preservation slice record:

- Global `/workflow-runs` now preserves already loaded run history pages after
  canceling the selected run.
- The cancel path no longer refetches the first run-history page after
  `POST /api/workflow-runs/:id/cancel`. It updates the returned run in the
  currently loaded list, removes it if it no longer matches the active filters,
  or prepends it if it was not already loaded.
- The detail panel and URL still stay on the canceled run, and the selected
  step retention behavior from the prior slice remains in force.
- Pagination state is intentionally left unchanged so an operator inspecting
  older loaded rows does not lose that context after cancel.

TDD note:

- A global run history Playwright test now mocks two loaded pages, opens the
  selected running run, clicks `Load more`, cancels the run, and expects the
  older second-page row to remain visible while the selected row changes to
  `canceled`.
- The first focused run needed locator tightening because the selected run id
  appears in both the list row and the detail header.
- Before implementation, the focused test failed because the older second-page
  row disappeared after cancel, proving the route still collapsed history back
  to the first page.
- After replacing the cancel-time first-page reload with loaded-list
  reconciliation, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DyQiq7tA.js` and `workflows-BNxjzjRa.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "keeps loaded global run pages after cancel"`
  - failed before implementation because `run_global_cancel_loaded_pages_older`
    was no longer visible after cancel.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed with approved server binding, 5 Chromium tests.
  - The deployed suite covered global history pagination, non-terminal detail
    auto-refresh, selected-step preservation after cancel, loaded-page
    preservation after cancel, and failed-run inspection.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow-scoped Run Console loaded-page cancel preservation slice record:

- Workflow-scoped `/workflows` Run Console now preserves already loaded run
  history pages after canceling the selected run.
- The cancel path no longer refetches the first workflow-scoped history page
  after `POST /api/workflow-runs/:id/cancel`. It updates the returned run in
  the currently loaded list, removes it if it does not belong to the selected
  workflow, or prepends it if it was not already loaded.
- The detail panel and route search stay on the selected workflow/run, and the
  selected-step retention behavior from the prior slice remains in force.
- Pagination state is intentionally left unchanged so an operator inspecting
  older loaded rows in the Run Console does not lose that context after cancel.

TDD note:

- A workflow-scoped Run Console Playwright test now mocks two loaded pages,
  opens the selected running run, clicks `Load more`, cancels the run, and
  expects the older second-page row to remain visible while the detail panel
  shows `canceled`.
- The first focused run exposed that history rows do not render status text,
  only status icons, so the test was tightened to assert `canceled` in the
  detail panel and keep the row-preservation assertion on the older history
  row.
- Before implementation, the focused test failed because the older second-page
  row disappeared after cancel, proving the route still collapsed
  workflow-scoped history back to the first page.
- After replacing the cancel-time first-page reload with loaded-list
  reconciliation, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DW5lWT80.js` and `workflows-D17uWQPK.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "keeps loaded workflow run console pages after cancel"`
  - failed before implementation because
    `run_console_cancel_loaded_pages_older` was no longer visible after cancel.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed with approved server binding, 7 Chromium tests.
  - The deployed suite covered run ownership deep-link rejection,
    workflow-scoped history pagination, non-terminal Run Console auto-refresh,
    selected-step preservation after cancel, loaded-page preservation after
    cancel, empty external inventory guards, and configured manual trigger
    execution from the console.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow-scoped Run Console loaded-page rerun preservation slice record:

- Workflow-scoped `/workflows` Run Console now preserves already loaded run
  history pages after rerunning the selected run.
- The rerun path no longer refetches the first workflow-scoped history page
  after `POST /api/workflow-runs/:id/rerun`. It inserts or updates the returned
  rerun in the currently loaded list, removes it if it does not belong to the
  selected workflow, and keeps existing older loaded rows in place.
- Because rerun changes the selected `run` query parameter, the route now
  suppresses only the immediate internal search-change reload created by that
  local rerun action. External run deep-links still use the normal
  `selectWorkflow`/`loadRuns` path.
- The detail panel and route search move to the new rerun id, and selected-step
  retention remains in force for the returned detail payload.

TDD note:

- A workflow-scoped Run Console Playwright test now mocks two loaded pages,
  opens a source run, clicks `Load more`, reruns the source run, and expects
  both the new rerun row and the older second-page row to remain visible.
- The first test attempt exposed an id prefix collision between the rerun id and
  `newest` fixture id; after giving the rerun row a distinct id, the focused
  test proved the real regression.
- Before implementation, the focused test failed because the older second-page
  row disappeared after rerun. A first implementation that only reconciled the
  list still failed because the rerun URL change triggered the existing
  search-effect reload and collapsed history back to the first page.
- After adding one-shot suppression for the local rerun search update, the same
  focused test passed while external deep-link behavior stayed covered by the
  workflow suite.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BGI0Ij-p.js` and `workflows-vKuzWUIj.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "keeps loaded workflow run console pages after rerun"`
  - failed before implementation because
    `run_console_rerun_loaded_pages_older` was no longer visible after rerun.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed with approved server binding, 8 Chromium tests.
  - The deployed suite covered run ownership deep-link rejection,
    workflow-scoped history pagination, non-terminal Run Console auto-refresh,
    selected-step preservation after cancel, loaded-page preservation after
    cancel, loaded-page preservation after rerun, empty external inventory
    guards, and configured manual trigger execution from the console.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow-scoped Run Console loaded-page test-run preservation slice record:

- Workflow-scoped `/workflows` Run Console now preserves already loaded run
  history pages after starting a draft test run from the toolbar.
- The shared test/live run path no longer refetches the first workflow-scoped
  history page after `POST /api/workflows/:id/runs/test` or
  `POST /api/workflows/:id/runs/live`. It inserts or updates the returned run
  in the currently loaded list and keeps existing older loaded rows in place.
- Because test/live run creation changes the selected `run` query parameter,
  the route uses the same one-shot internal search-change suppression introduced
  for rerun. External run deep-links still use the normal
  `selectWorkflow`/`loadRuns` path.
- The detail panel and route search move to the new run id, and selected-step
  retention remains in force for the returned detail payload.

TDD note:

- A workflow-scoped Run Console Playwright test now mocks two loaded pages,
  opens a source run, clicks `Load more`, starts a toolbar `Test` run, and
  expects both the new test-run row and the older second-page row to remain
  visible.
- Before implementation, the focused test failed because the older second-page
  row disappeared after the test run, proving the shared test/live path still
  collapsed workflow-scoped history back to the first page.
- After replacing the test/live run-time first-page reload with loaded-list
  reconciliation plus one-shot search suppression, the same focused test
  passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DHmJmuZk.js` and `workflows-wujAaVWa.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "keeps loaded workflow run console pages after test run"`
  - failed before implementation because
    `run_console_test_loaded_pages_older` was no longer visible after the test
    run.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed with approved server binding, 9 Chromium tests.
  - The deployed suite covered run ownership deep-link rejection,
    workflow-scoped history pagination, non-terminal Run Console auto-refresh,
    selected-step preservation after cancel, loaded-page preservation after
    cancel, loaded-page preservation after rerun, loaded-page preservation
    after toolbar test run, empty external inventory guards, and configured
    manual trigger execution from the console.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow-scoped Run Console loaded-page trigger-run preservation slice record:

- Workflow-scoped `/workflows` Run Console now preserves already loaded run
  history pages after running an enabled trigger from the trigger card.
- The trigger run path no longer refetches the first workflow-scoped history
  page after `POST /api/workflows/:id/triggers/:triggerId/runs`. It inserts or
  updates the returned run in the currently loaded list and keeps existing
  older loaded rows in place.
- Because trigger run creation changes the selected `run` query parameter, the
  route uses the same one-shot internal search-change suppression as rerun and
  toolbar test/live runs. External run deep-links still use the normal
  `selectWorkflow`/`loadRuns` path.
- The detail panel and route search move to the new trigger run id, and
  selected-step retention remains in force for the returned detail payload.

TDD note:

- A workflow-scoped Run Console Playwright test now mocks two loaded pages,
  opens a source run, clicks `Load more`, runs trigger `manual_review`, and
  expects both the new trigger-run row and the older second-page row to remain
  visible.
- The first focused run exposed that the mocked `/triggers` summary must include
  `runnable: true`; without it the real UI correctly disabled the trigger Run
  button.
- Before implementation, the focused test failed because the older second-page
  row disappeared after the trigger run, proving the trigger path still
  collapsed workflow-scoped history back to the first page.
- After replacing the trigger run-time first-page reload with loaded-list
  reconciliation plus one-shot search suppression, the same focused test
  passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-f7Co-Ko5.js` and `workflows-DqPLFLHo.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "keeps loaded workflow run console pages after trigger run"`
  - failed before implementation because
    `run_console_trigger_loaded_pages_older` was no longer visible after the
    trigger run.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed with approved server binding, 10 Chromium tests.
  - The deployed suite covered run ownership deep-link rejection,
    workflow-scoped history pagination, non-terminal Run Console auto-refresh,
    selected-step preservation after cancel, loaded-page preservation after
    cancel, loaded-page preservation after rerun, loaded-page preservation
    after toolbar test run, loaded-page preservation after trigger run, empty
    external inventory guards, and configured manual trigger execution from the
    console.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Global run history loaded-page rerun preservation slice record:

- Global `/workflow-runs` now preserves already loaded run history pages after
  rerunning a selected run from the global Run History detail panel.
- When the returned rerun still matches the active global filters, the route
  inserts or updates that returned run in the currently loaded list and keeps
  existing older loaded rows in place.
- Because rerun changes the selected `run` query parameter, the route suppresses
  only the immediate internal search-change reload for that exact filter/run
  search key. External filter changes, deep-link changes, and reruns that no
  longer match the active filters still use the normal first-page reload path.
- The detail panel and route search move to the new run id, and selected-step
  retention remains in force for the returned detail payload.

TDD note:

- A global Run History Playwright test now mocks two loaded pages, opens a
  source run, clicks `Load more`, clicks `Rerun`, and expects both the new
  rerun row and the older second-page row to remain visible.
- Before implementation, the focused test failed because the older second-page
  row disappeared after rerun, proving the global route's `run` query change
  collapsed loaded history back to the first page.
- After adding loaded-list reconciliation plus one-shot internal search
  suppression to the global rerun path, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CCEntmgQ.js` and `workflows-Bz2-Ms8F.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "keeps loaded global run pages after rerun"`
  - failed before implementation because
    `run_global_rerun_loaded_pages_older` was no longer visible after the
    rerun.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed with approved server binding, 6 Chromium tests.
  - The deployed suite covered global history pagination, non-terminal global
    detail auto-refresh, selected-step preservation after cancel, loaded-page
    preservation after cancel, loaded-page preservation after rerun, and global
    filtering into failed run detail.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Global run history auto-refresh filter reconciliation slice record:

- Global `/workflow-runs` now keeps the loaded run list aligned with active
  filters when non-terminal detail auto-refresh changes the selected run status.
- The detail panel remains open on the selected run after refresh, but the
  history row is removed if the updated run no longer matches the current
  workflow, mode, status, trigger, or date-range filters.
- Direct run deep-link behavior remains unchanged: a selected run can still be
  inspected even when it is outside the active filtered list.
- This extends the same filter-aware loaded-list reconciliation rule already
  used by cancel and rerun to the background detail-refresh path.

TDD note:

- A global Run History Playwright test now opens a running run under
  `status=running`, lets auto-refresh return the same run as `succeeded`, and
  expects the detail panel to show the succeeded run while the history row is
  removed from the filtered list.
- Before implementation, the focused test failed because
  `run_global_auto_refresh_filter` remained visible as a history row after the
  detail had refreshed to `succeeded`.
- After changing `loadRunDetail` to reconcile the returned run against active
  filters, the focused test passed against the rebuilt web bundle.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CESUt186.js` and `workflows-CUVP8QIq.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "removes global run rows that no longer match filters after auto-refresh"`
  - failed before implementation because
    `run_global_auto_refresh_filter` still had one matching history-row button
    after the run refreshed from `running` to `succeeded`.
  - passed after implementation and rebuilding the web bundle, 1 Chromium
    test.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed with approved server binding, 7 Chromium tests.
  - The deployed suite covered global history pagination, non-terminal global
    detail auto-refresh, auto-refresh filter reconciliation, selected-step
    preservation after cancel, loaded-page preservation after cancel,
    loaded-page preservation after rerun, and global filtering into failed run
    detail.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow run triggerId pagination exactness slice record:

- Workflow run history filtering now matches `triggerId` only against the
  top-level run trigger snapshot field at `$.triggerId`.
- The store no longer uses a broad `LIKE` prefilter over the whole
  `trigger_json` payload for trigger filtering. This prevents nested workflow
  input such as `{ "triggerId": "manual_review" }` from being treated as a run
  started by trigger `manual_review`.
- Pagination now remains stable when newer non-matching runs contain nested
  trigger-like keys in their submitted input. A page can no longer be filled
  with SQL false positives that are later removed by JS filtering, which
  previously could hide older true matches or produce a non-advancing
  `nextOffset`.
- The defensive JS exact filter remains in place after the SQL JSON-path
  filter.

TDD note:

- A `WorkflowStore` test now creates two newer false-positive runs whose
  top-level trigger id is `manual_review` but whose submitted manual input
  contains nested `triggerId: "manual"`, followed by an older true top-level
  `manual` run.
- Before implementation, `listRunsPage({ triggerId: "manual", limit: 1 })`
  returned an empty page because the SQL `LIKE` prefilter selected only the
  false positives before the exact JS filter removed them.
- After changing the SQL predicate to
  `json_extract(trigger_json, '$.triggerId') = @triggerId`, the focused store
  test returned only `run_manual_match` with `hasMore: false` and
  `nextOffset: null`.

Focused validation:

- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "paginates triggerId filters by the top-level trigger snapshot id"`
  - failed before implementation with `page.runs` equal to `[]`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms79irzs`.
  - The smoke added nested `triggerId: "manual_review"` values to non-manual
    webhook/public webhook inputs, then verified
    `/api/workflows/:id/runs?triggerId=manual_review&limit=1` returned only the
    real top-level manual trigger run
    `a6aab245-5543-4f6c-a790-b9fd39bdc555` with `hasMore: false` and
    `nextOffset: null`.
  - The same smoke completed the existing manual trigger, authenticated webhook,
    public trigger-id webhook, public path webhook, and scheduled dispatcher
    paths; final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run list invalid filter rejection slice record:

- Workflow run list APIs now reject invalid `mode` and `status` query filters
  instead of silently ignoring them.
- The global `/api/workflow-runs` and workflow-scoped
  `/api/workflows/:id/runs` endpoints share the same parser contract:
  unsupported `mode` returns `400 invalid mode`, unsupported `status` returns
  `400 invalid status`, and absent filters still behave as unfiltered queries.
- This aligns mode/status with the existing strict handling for invalid
  `triggerId`, `createdFrom`, and `createdTo` filters, and prevents direct API
  callers from accidentally receiving broad run history when they supplied a
  typo such as `mode=preview` or `status=complete`.

TDD note:

- The workflow route trigger/filter test now asserts
  `/api/workflow-runs?mode=preview` returns `400 invalid mode` and
  `/api/workflows/:id/runs?status=complete` returns `400 invalid status`.
- Before implementation, the focused route test failed because
  `mode=preview` returned `200`, proving the parser silently dropped invalid
  mode values.
- After checking query-param presence before applying parsed mode/status
  filters, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with `mode=preview` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms79peml`.
  - The smoke verified `/api/workflow-runs?mode=preview` returned
    `400 invalid mode` and `/api/workflows/:id/runs?status=complete` returned
    `400 invalid status` while still completing the existing manual, webhook,
    public webhook, public path webhook, scheduled dispatcher, and triggerId
    pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Global workflow run list workflowId validation slice record:

- Global `/api/workflow-runs` now validates the optional `workflowId` query
  filter with the same safe id contract used by workflow-scoped route params.
- Invalid global workflow filters return `400 invalid workflowId` instead of
  being passed through to the store as a broad or impossible string filter.
- This keeps the global run history API aligned with the workflow-scoped
  `/api/workflows/:id/runs` route, which already rejected invalid `:id`
  path params.

TDD note:

- The workflow route trigger/filter test now asserts
  `/api/workflow-runs?workflowId=bad/id` returns `400 invalid workflowId`.
- Before implementation, the focused route test failed because the invalid
  query filter returned `200`, proving the global route accepted workflow ids
  that the scoped route would reject.
- After adding the SAFE_ID guard to the global run list route, the same focused
  test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with `workflowId=bad/id` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms79v5to`.
  - The smoke verified `/api/workflow-runs?workflowId=bad/id` returned
    `400 invalid workflowId` while still completing the existing manual,
    webhook, public webhook, public path webhook, scheduled dispatcher,
    invalid mode/status, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Draft test run version rejection slice record:

- `/api/workflows/:id/runs/test` now rejects request bodies that include
  `version`.
- Draft test execution is explicitly bound to the current draft definition
  source. Published version selection belongs to live runs and trigger runs,
  not draft tests.
- The route returns `400 test_run_version_not_supported` before loading or
  executing the draft, so invalid test run bodies do not create persisted run
  history.

TDD note:

- The workflow route run-detail test now asserts
  `/api/workflows/:id/runs/test` with `{ version: 2 }` returns
  `400 test_run_version_not_supported`.
- Before implementation, the focused route test failed because the endpoint
  returned `201`, proving that draft test runs silently ignored the version
  selector.
- After adding the route guard, the same focused test passed while published
  live runs retained their existing version-aware execution path.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs draft tests and published live runs with inspectable detail"`
  - failed before implementation with the draft test version request returning
    `201`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7a200z`.
  - The smoke verified draft test run bodies with `version: 2` return
    `400 test_run_version_not_supported` in
    `invalidRunBodies.draftTestVersion`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, and triggerId pagination checks.
  - Final run count remained `5`, proving the rejected draft test body did not
    create a persisted run.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow definition route-safe id validation slice record:

- Workflow node ids and trigger ids are now validated with the same route-safe
  id contract used by workflow route params and run filters:
  `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.
- The validation lives in the existing `@openacme/workflows`
  `validateWorkflowNodeReferences` and `validateWorkflowTriggers` seams, so the
  server applies it consistently before create, update, publish, test run, live
  run, trigger run, and rerun execution paths that validate definitions.
- Invalid ids such as `load/customer` and `manual/review` now return
  `400 Invalid workflow node id: load/customer` or
  `400 Invalid workflow trigger id: manual/review` before any workflow
  definition is persisted by the API.
- This keeps persisted workflow definitions aligned with route-addressable
  trigger ids, run filters, run snapshots, and step trace identifiers.

TDD note:

- The workflows schema tests first asserted route-unsafe node and trigger ids
  are rejected by the validation seams.
- Before implementation, those focused tests failed because both validators
  returned `{ ok: true }`.
- Server route tests then proved the API gap: creating definitions with
  `load/customer` or `manual/review` returned `201`.
- After adding the safe-id validation and rebuilding `@openacme/workflows`, the
  same focused workflow and server tests passed.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/validation.ts packages/workflows/test/schemas.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts -t "route-unsafe"`
  - failed before implementation with both validators returning `{ ok: true }`.
  - passed after implementation, 2 focused Vitest tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "rejects invalid cross-node references before publish or run creation"`
  - failed before implementation with invalid node id create returning `201`.
  - passed after implementation and `@openacme/workflows` build, 1 focused
    Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "rejects duplicate trigger ids and duplicate webhook paths before publish or run creation"`
  - failed before implementation with invalid trigger id create returning `201`.
  - passed after implementation and `@openacme/workflows` build, 1 focused
    Vitest test.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts dispatcher.test.ts runner.test.ts`
  - passed, 28 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7ac043`.
  - The smoke verified route-unsafe node and trigger ids return the expected
    `400` errors in `invalidDefinitionIds.node` and
    `invalidDefinitionIds.trigger`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, draft test body, and triggerId pagination
    checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow create route-safe id validation slice record:

- `POST /api/workflows` now validates an explicit request body `id` with the
  same route-safe id contract used by workflow path params.
- Invalid explicit workflow ids such as `bad/id` return `400 invalid id` before
  the draft is persisted.
- Omitted ids still use the existing generated id path; scoped workflow routes,
  global run filters, public webhook routes, and run history remain aligned
  because API-created workflows can no longer be created with route-unsafe ids.

TDD note:

- The workflow draft CRUD route test now asserts `POST /api/workflows` with
  `{ id: "bad/id" }` returns `400 invalid id`.
- Before implementation, the focused test failed because the endpoint returned
  `201`, proving the create route accepted workflow ids that later scoped
  routes would reject.
- After adding the body id guard, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "creates, lists, updates, and publishes workflow drafts"`
  - failed before implementation with the unsafe explicit id create returning
    `201`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7ahfcz`.
  - The smoke verified unsafe explicit workflow ids return `400 invalid id` in
    `invalidDefinitionIds.workflow`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid definition id, draft test body, and
    triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow list pagination query validation slice record:

- Workflow definition list, global run list, and workflow-scoped run list
  endpoints now reject malformed pagination query values before querying.
- `limit=abc`, `limit=1abc`, `offset=abc`, and `offset=1abc` style values
  return `400 invalid limit` or `400 invalid offset` instead of being silently
  parsed with fallback or partial integer parsing.
- Valid integer values initially kept bounded clamp behavior; the later
  pagination bounds slice replaces that with explicit out-of-range rejection.
- This keeps run-history and workflow-list APIs aligned with the strict invalid
  filter handling already used for `mode`, `status`, `workflowId`,
  `triggerId`, and date filters.

TDD note:

- The trigger/filter route test now asserts `/api/workflow-runs?limit=abc`
  returns `400 invalid limit` and
  `/api/workflows/:id/runs?offset=1abc` returns `400 invalid offset`.
- Before implementation, the focused test failed because
  `/api/workflow-runs?limit=abc` returned `200`, proving malformed pagination
  was silently accepted.
- The workflow draft CRUD route test also asserts
  `/api/workflows?limit=abc` returns `400 invalid limit`.
- After routing list endpoints through the shared pagination parser, the focused
  tests passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with global `limit=abc` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "creates, lists, updates, and publishes workflow drafts"`
  - passed after adding workflow definition list pagination coverage, 1 focused
    Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7apr8m`.
  - The smoke verified malformed pagination values return the expected `400`
    errors in `invalidPagination.definitionLimit`,
    `invalidPagination.globalRunLimit`, and
    `invalidPagination.workflowRunOffset`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid definition id, draft test body, and
    triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run date-only filter validation slice record:

- Workflow run list date filters now reject invalid date-only calendar values
  instead of letting native JavaScript `Date` parsing normalize them.
- `createdFrom=2026-02-31` now returns `400 invalid createdFrom` instead of
  being normalized into March and applied as a broad or misleading filter.
- Valid `YYYY-MM-DD` values still expand to UTC day boundaries:
  `00:00:00.000Z` for `createdFrom` and `23:59:59.999Z` for `createdTo`.
- Timestamp-style filter values continue to use the existing native timestamp
  parse path.

TDD note:

- The trigger/filter route test now asserts
  `/api/workflow-runs?createdFrom=2026-02-31` returns
  `400 invalid createdFrom`.
- Before implementation, the focused test failed because the endpoint returned
  `200`, proving native date normalization accepted the invalid calendar day.
- After adding strict `YYYY-MM-DD` round-trip validation, the same focused test
  passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with `createdFrom=2026-02-31` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7av58z`.
  - The smoke verified invalid date-only filters return
    `400 invalid createdFrom` in `invalidFilters.globalCreatedFrom`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid pagination, invalid definition id,
    draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run timestamp filter validation slice record:

- Workflow run list timestamp filters now reject invalid ISO-like calendar days
  instead of letting native JavaScript `Date` parsing normalize them.
- `createdTo=2026-02-31T00:00:00Z` now returns `400 invalid createdTo`
  instead of being normalized to March and applied as a misleading upper bound.
- Date-only and timestamp-style filters now both enforce that the submitted
  `YYYY-MM-DD` date component is a real calendar day.
- This preserves the existing accepted timestamp parse path while preventing
  invalid calendar dates from widening or shifting run history filters.

TDD note:

- The trigger/filter route test now asserts
  `/api/workflows/:id/runs?createdTo=2026-02-31T00:00:00Z` returns
  `400 invalid createdTo`.
- Before implementation, the focused test failed because the endpoint returned
  `200`, proving native timestamp normalization accepted the invalid calendar
  day.
- After adding timestamp date-part round-trip validation, the same focused test
  passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with
    `createdTo=2026-02-31T00:00:00Z` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7b0ni9`.
  - The smoke verified invalid timestamp filters return
    `400 invalid createdTo` in `invalidFilters.workflowCreatedTo`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid pagination, invalid definition id,
    draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run timestamp offset filter acceptance slice record:

- Timestamp filter validation now accepts valid timezone-offset timestamps even
  when converting the instant to UTC changes the day.
- `createdFrom=2026-02-28T23:30:00-02:00` now returns `200` instead of being
  rejected because the parsed UTC instant falls on `2026-03-01`.
- Invalid calendar days such as `2026-02-31T00:00:00Z` remain rejected. The
  parser validates the submitted date component as a real calendar day without
  requiring it to match the parsed UTC day.
- This corrects the previous timestamp validation slice so valid client
  timezone offsets do not break run history filters.

TDD note:

- The trigger/filter route test now asserts
  `/api/workflow-runs?createdFrom=2026-02-28T23:30:00-02:00` returns `200`
  while the existing invalid timestamp assertion still returns
  `400 invalid createdTo`.
- Before implementation, the focused test failed because the valid offset
  timestamp returned `400`.
- After replacing UTC date-part round-trip validation with submitted calendar
  date validation, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with
    `createdFrom=2026-02-28T23:30:00-02:00` returning `400`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7b70zv`.
  - The smoke verified the valid offset timestamp filter returns `200` in
    `validFilters.offsetCreatedFrom` while the invalid timestamp filter still
    returns `400 invalid createdTo` in `invalidFilters.workflowCreatedTo`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid pagination, invalid definition id,
    draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run date-time separator validation slice record:

- Workflow run list date-time filters that begin with `YYYY-MM-DD` must either
  be date-only values or use an ISO-style `T` date-time separator.
- `createdFrom=2026-02-28 23:30:00` now returns
  `400 invalid createdFrom` instead of being accepted by native JavaScript
  `Date` parsing as a local-time value.
- Date-only values such as `2026-02-28` and valid `T` timestamp values remain
  supported, including timezone-offset timestamps such as
  `2026-02-28T23:30:00-02:00`.
- This keeps run history filtering deterministic across local timezones and
  avoids silently widening or shifting date-range searches.

TDD note:

- The trigger/filter route test first asserted
  `/api/workflow-runs?createdFrom=2026-02-28%2023%3A30%3A00` should return
  `400 invalid createdFrom`.
- Before implementation, the focused test failed because native `Date` parsing
  accepted the space-separated date-time and the route returned `200`.
- After adding a separator guard before timestamp parsing, the same focused
  test passed while the valid offset timestamp assertion continued to return
  `200`.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with
    `createdFrom=2026-02-28 23:30:00` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7bdk4l`.
  - The smoke verified the space-separated timestamp filter returns
    `400 invalid createdFrom` in
    `invalidFilters.globalCreatedFromSeparator`.
  - The smoke also verified the valid offset timestamp filter still returns
    `200` in `validFilters.offsetCreatedFrom`.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid pagination, invalid definition id,
    draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run date-range ordering validation slice record:

- Workflow run list date filters now reject a reversed date range when both
  `createdFrom` and `createdTo` are provided.
- `createdFrom=2030-01-02&createdTo=2030-01-01` now returns
  `400 invalid date range` instead of silently returning a successful empty
  result set.
- The guard is owned by the shared run-list filter parser, so it applies to
  both global and workflow-scoped run history routes.
- This keeps operator mistakes visible and prevents the run console from
  presenting a filter error as if no runs existed.

TDD note:

- The trigger/filter route test first asserted
  `/api/workflow-runs?createdFrom=2030-01-02&createdTo=2030-01-01` should
  return `400 invalid date range`.
- Before implementation, the focused test failed because the route accepted the
  reversed range and returned `200`.
- After adding the shared `createdFrom > createdTo` guard, the same focused
  test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with the reversed range returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7bifgk`.
  - The smoke verified the reversed date range returns
    `400 invalid date range` in `invalidFilters.globalDateRange`.
  - The smoke also preserved existing run filter assertions, including
    `400 invalid createdFrom` for invalid date-only filters,
    `400 invalid createdFrom` for space-separated timestamps, and `200` for a
    valid timezone-offset timestamp.
  - The same smoke completed the existing manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid filter, invalid pagination, invalid definition id,
    draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run pagination bounds validation slice record:

- Workflow pagination query parameters now reject numeric values outside their
  supported bounds instead of silently clamping them.
- `limit=0` now returns `400 invalid limit`; valid limits remain `1..500`.
- `offset=-1` now returns `400 invalid offset`; valid offsets remain
  `0..1000000`.
- The shared pagination parser still supplies defaults when the parameter is
  omitted, but any provided value must be a whole number inside the accepted
  range.
- This prevents the run console and API clients from hiding invalid operator
  input behind a successful, rewritten query.

TDD note:

- The trigger/filter route test first asserted `/api/workflow-runs?limit=0`
  should return `400 invalid limit` and
  `/api/workflows/:id/runs?offset=-1` should return `400 invalid offset`.
- Before implementation, the focused test failed because `limit=0` was clamped
  to `1` and returned `200`.
- After replacing silent clamping with explicit bounds rejection, the same
  focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with `limit=0` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7bn03q`.
  - The smoke verified out-of-range pagination returns
    `400 invalid limit` in `invalidPagination.globalRunLimitRange` and
    `400 invalid offset` in `invalidPagination.workflowRunOffsetRange`.
  - The same smoke preserved malformed pagination, invalid filters, manual
    trigger, authenticated webhook, public trigger-id webhook, public path
    webhook, scheduled dispatcher, invalid definition id, draft test body, and
    triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run duplicate query parameter validation slice record:

- Workflow run list query parameters now reject duplicate singleton values
  instead of silently using the first `URLSearchParams.get()` result.
- Duplicate `mode`, `workflowId`, `limit`, and `offset` values return the same
  field-specific `400` errors as malformed values:
  `invalid mode`, `invalid workflowId`, `invalid limit`, or `invalid offset`.
- The shared query helper now reads all submitted values for a singleton
  parameter and marks the parameter invalid when more than one value is
  provided.
- This prevents run-history links and UI requests from hiding ambiguous
  operator intent behind an apparently successful filtered result.

TDD note:

- The trigger/filter route test first asserted
  `/api/workflow-runs?mode=test&mode=live`,
  `/api/workflow-runs?workflowId=wf_triggers&workflowId=wf_other`,
  `/api/workflow-runs?limit=1&limit=2`, and
  `/api/workflows/:id/runs?offset=0&offset=1` should return field-specific
  `400` errors.
- Before implementation, the focused test failed because duplicate `mode` was
  accepted and returned `200`.
- After replacing first-value query reads with singleton-aware parsing, the
  same focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with duplicate `mode` returning `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7btzny`.
  - The smoke verified duplicate singleton query parameters return
    `400 invalid mode` in `invalidFilters.globalModeDuplicate`,
    `400 invalid workflowId` in
    `invalidFilters.globalWorkflowIdDuplicate`,
    `400 invalid limit` in `invalidPagination.globalRunLimitDuplicate`, and
    `400 invalid offset` in
    `invalidPagination.workflowRunOffsetDuplicate`.
  - The same smoke preserved malformed pagination, out-of-range pagination,
    invalid filters, manual trigger, authenticated webhook, public trigger-id
    webhook, public path webhook, scheduled dispatcher, invalid definition id,
    draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow definition duplicate status query validation slice record:

- Workflow definition list query parameters now reject duplicate `status`
  values instead of silently using the first submitted value.
- `/api/workflows?status=draft&status=published` now returns
  `400 invalid status`.
- The definition list route now uses the same singleton-aware query helper as
  workflow run history, so list endpoints share the same ambiguity policy for
  singleton filters.
- This prevents workflow list links and UI requests from hiding conflicting
  operator intent behind an apparently successful filtered result.

TDD note:

- The workflow draft CRUD route test first asserted
  `/api/workflows?status=draft&status=published` should return
  `400 invalid status`.
- Before implementation, the focused test failed because the route accepted
  duplicate `status` and returned `200`.
- After moving definition status parsing to the shared singleton query helper,
  the same focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "creates, lists, updates, and publishes workflow drafts"`
  - failed before implementation with duplicate definition `status` returning
    `200`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7by13i`.
  - The smoke verified duplicate definition `status` returns
    `400 invalid status` in
    `invalidPagination.definitionStatusDuplicate`.
  - The same smoke preserved duplicate run filters, malformed pagination,
    out-of-range pagination, invalid filters, manual trigger, authenticated
    webhook, public trigger-id webhook, public path webhook, scheduled
    dispatcher, invalid definition id, draft test body, and triggerId
    pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow trigger route id error specificity slice record:

- Workflow trigger-run routes now distinguish unsafe workflow ids from unsafe
  trigger ids.
- `POST /api/workflows/:id/triggers/:triggerId/runs` returns
  `400 invalid id` only when `:id` is unsafe and returns
  `400 invalid triggerId` when `:triggerId` is unsafe.
- `POST /api/workflow-webhooks/:id/:triggerId` uses the same field-specific
  route validation for public webhook trigger-id ingress.
- This keeps operator/API diagnostics aligned with the route-safe trigger id
  validation already used for workflow definitions.

TDD note:

- The manual trigger route test first asserted
  `/api/workflows/:id/triggers/manual:review/runs` should return
  `400 invalid triggerId`.
- The public webhook ingress test first asserted
  `/api/workflow-webhooks/:id/incoming:customer` should also return
  `400 invalid triggerId`.
- Before implementation, the focused manual-trigger test failed because the
  route returned `400 invalid id`.
- After splitting workflow id and trigger id route validation, both focused
  tests passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with unsafe trigger route id returning
    `400 invalid id`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "accepts public webhook ingress only with the configured trigger secret"`
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7c54a6`.
  - The smoke verified unsafe authenticated trigger route ids return
    `400 invalid triggerId` in
    `invalidDefinitionIds.authenticatedTriggerRoute`.
  - The smoke verified unsafe public webhook trigger route ids return
    `400 invalid triggerId` in
    `invalidDefinitionIds.publicTriggerRoute`.
  - The same smoke preserved duplicate definition status, duplicate run
    filters, malformed pagination, out-of-range pagination, invalid filters,
    manual trigger, authenticated webhook, public trigger-id webhook, public
    path webhook, scheduled dispatcher, invalid definition id, draft test body,
    and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow-scoped run list workflowId error specificity slice record:

- Workflow-scoped run history now returns a field-specific error when the route
  workflow id is unsafe.
- `GET /api/workflows/:id/runs` returns `400 invalid workflowId` when `:id`
  is not route-safe.
- Global run history already used `400 invalid workflowId` for the
  `workflowId` query filter; this slice aligns the workflow-scoped history
  route with that API contract.
- Other workflow definition routes keep their existing `400 invalid id`
  behavior because their route parameter is the definition id itself, not a run
  history workflow filter.

TDD note:

- The trigger/filter route test first asserted
  `/api/workflows/wf:triggers/runs` should return
  `400 invalid workflowId`.
- Before implementation, the focused test failed because the scoped run list
  returned `400 invalid id`.
- After changing the workflow-scoped run list guard to return
  `invalid workflowId`, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs enabled manual triggers and rejects disabled future triggers without creating runs"`
  - failed before implementation with scoped run list unsafe workflow id
    returning `400 invalid id`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_trigger_deployed_ms7caap2`.
  - The smoke verified unsafe workflow-scoped run-list ids return
    `400 invalid workflowId` in `invalidFilters.scopedWorkflowId`.
  - The same smoke preserved trigger route id specificity, duplicate definition
    status, duplicate run filters, malformed pagination, out-of-range
    pagination, invalid filters, manual trigger, authenticated webhook, public
    trigger-id webhook, public path webhook, scheduled dispatcher, invalid
    definition id, draft test body, and triggerId pagination checks.
  - Final run count remained `5`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow cancel current-step attempt closure slice record:

- Canceling a non-terminal workflow run now closes the current non-terminal
  step attempt for `run.currentNodeId`.
- The current step attempt is rewritten with `status: "canceled"`, `endedAt`,
  and `durationMs`, while preserving its existing input, output, error,
  logs summary, and context diff fields.
- Run-level cancel behavior is unchanged: the run moves to `canceled`,
  `currentNodeId` and `waitingReason` are cleared, and the `run_canceled`
  audit event is still recorded.
- This keeps the run console honest after an operator cancels an in-flight run:
  the run no longer shows `canceled` while the selected/current step still
  appears `running`.

TDD note:

- The route test seeded a running run with `currentNodeId: "set_customer"` and
  a matching running step attempt.
- Before implementation, the focused cancel test failed because the step
  attempt remained `running` with no `endedAt` or `durationMs`.
- After adding current-step closure in the cancel path, the focused test passed
  and the wider route/runtime suite stayed green.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "cancels non-terminal runs and records an audit event"`
  - failed before implementation because the seeded current step remained
    `running`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Created workflow `wf_cancel_deployed_ms7cjzle`.
  - Seeded non-terminal run `run_cancel_deployed_ms7cjzle` with a running
    `set_customer` step attempt.
  - Canceled the run through the real HTTP route and verified persisted run
    status `canceled`, persisted step status `canceled`, event sequence
    `run_started`, `run_canceled`, and second cancel response
    `409 run_not_cancelable`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow cancel late-completion preservation slice record:

- If a workflow run is canceled while an external node is still awaiting
  completion, late runner output no longer overwrites the persisted cancellation
  state.
- The durable event port now ignores runner events for runs that are already in
  a terminal state, preventing post-cancel `step_output`, `step_completed`, or
  `run_completed` events from appearing after `run_canceled`.
- After `WorkflowRunner.run()` returns, the route execution path re-reads the
  stored run. If it is already terminal, the route returns the stored run detail
  instead of recording returned step attempts or applying the runner's final
  status.
- This slice preserves operator-visible truthfulness for in-flight cancellation.
  It does not yet abort the underlying external MCP/agent/Python operation; it
  prevents that operation's late completion from changing the persisted workflow
  outcome.

TDD note:

- The route test starts an `mcp.tool` run, cancels the same run through the real
  cancel route while the MCP port is executing, then lets the port return a
  successful output.
- Before implementation, the focused test failed because the original run
  response came back with `status: "succeeded"` after cancel.
- After implementation, the response and persisted detail remain
  `status: "canceled"`, the current step remains `status: "canceled"`, and the
  event sequence stops at `run_started`, `step_started`, `run_canceled`.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "preserves cancellation when execution finishes after cancel"`
  - failed before implementation because the canceled run was overwritten to
    `succeeded`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke preserved the prior seeded-cancel proof with workflow
    `wf_cancel_deployed_ms7crvu8` and run
    `run_cancel_deployed_ms7crvu8`.
  - The same smoke created workflow `wf_cancel_late_deployed_ms7crvu8`, started
    HTTP test run `68dae526-ac66-4091-9f4a-02e65111e87d`, canceled it from
    inside the executing MCP port through the real HTTP cancel route, let the
    MCP port return output, and verified persisted run status `canceled`,
    persisted step status `canceled`, and event sequence `run_started`,
    `step_started`, `run_canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow running-step input persistence slice record:

- `step_started` events now include the node's resolved input when a node has an
  input expression.
- The server event adapter records that input on the durable running step
  attempt as soon as the step starts.
- If the run is canceled while the step is still in flight, the canceled step
  keeps the resolved input in run detail and persisted history.
- This improves run console truthfulness for canceled external-node executions:
  an operator can still inspect what input was sent even when the step never
  reaches `step_output` or `step_completed`.

TDD note:

- The route test first expected an in-flight canceled `mcp.tool` step to include
  input `{ id: "cust_cancel" }` in both the immediate response and persisted run
  detail.
- Before implementation, the focused test failed because the canceled step had
  status and timing fields but no `input`.
- After implementation, `WorkflowRunner` emits resolved input on `step_started`,
  the route adapter persists it on the running attempt, and cancel preserves it.
- The workflows package test expectation for `step_started` payload was updated
  to lock this as a runner-level contract.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "preserves cancellation when execution finishes after cancel"`
  - failed before implementation because the canceled step had no input.
  - passed after rebuilding `@openacme/workflows`, 1 focused Vitest test.
- `pnpm --filter @openacme/workflows test`
  - passed, 28 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_cancel_late_deployed_ms7czzb4`, started HTTP
    test run `65ed519d-bb4d-4a74-9aae-b5a497a99dc5`, canceled it from inside
    the executing MCP port through the real HTTP cancel route, let the MCP port
    return output, and verified persisted run status `canceled`, persisted step
    status `canceled`, persisted step input `{ "id": "cust_late_cancel" }`, and
    event sequence `run_started`, `step_started`, `run_canceled`.
  - The same smoke preserved the prior seeded-cancel proof with workflow
    `wf_cancel_deployed_ms7czzb4` and run
    `run_cancel_deployed_ms7czzb4`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Timeline event payload JSON block redaction slice record:

- Timeline event payload disclosures in both global `/workflow-runs` and the
  workflow-scoped Run Console now reuse the shared `JsonBlock` renderer.
- Event payload blocks keep the same accessible labels, such as
  `Event #3 payload JSON`, while also showing a visible `Event #3 payload`
  header.
- Redacted markers inside event payloads now receive the same `redacted` badge
  behavior as run input, step input/output, error, logs, and context-diff JSON
  blocks.
- This matters more after running-step input persistence because `step_started`
  and log event payloads can carry redacted operator input; the timeline should
  make that redaction explicit without exposing raw secret values.

TDD note:

- The global run-history Playwright smoke first expected a redacted event
  payload block to contain a visible `Event #... payload` heading while still
  omitting the raw `raw-run-api-key` value.
- Before implementation, the focused deployed Playwright test failed because
  the event payload group rendered only the raw JSON `<pre>` body.
- After switching timeline payload rendering to `JsonBlock`, the same focused
  deployed Playwright test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BKALWpvF.js` and `workflows-LnUKu_yP.js`.
- `pnpm --filter @openacme/server build` - passed.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "filters global workflow run history and opens failed run details"`
  - failed before implementation because the redacted event payload group did
    not contain the visible `Event #... payload` heading.
  - passed after implementation, 1 Chromium test.
  - The deployed smoke opened the failed global run, verified the redacted event
    payload block, confirmed the raw `raw-run-api-key` value was absent, and
    preserved failed-step/timeline/rerun coverage.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 10 Chromium tests.
  - The workflow-scoped deployed suite covered run ownership deep-link
    rejection, history pagination, non-terminal Run Console auto-refresh,
    selected-step preservation after cancel, loaded-page preservation after
    cancel/rerun/test/trigger run, empty external inventory guards, and
    configured manual trigger execution.
  - Post-smoke port checks showed no listener on `3998` or `3458`.

Workflow run trigger input redaction slice record:

- Workflow run trigger snapshots are now redacted before persistence.
- This specifically covers `run.trigger.input`, which can duplicate the run
  input used by manual, webhook, scheduled, rerun, and internal trigger paths.
- The existing run input, step input, event payload, context, error, log, and
  context-diff redaction behavior remains unchanged.
- This closes a persisted detail leak found after running-step input
  persistence: step input and event payload were redacted, but the trigger
  snapshot still carried raw secret-looking keys.

TDD note:

- The route test first added raw `apiKey: "raw-cancel-api-key"` to an in-flight
  external-step run and expected the immediate and persisted run detail to omit
  the raw value while preserving `"[redacted]"` in trigger input, step input, and
  `step_started` event payload input.
- Before implementation, the focused route test failed because
  `run.trigger.input.apiKey` still contained `raw-cancel-api-key`.
- After redacting trigger snapshots in `WorkflowStore.createRun`, the focused
  route test passed.
- The DB store redaction test was extended to assert trigger snapshot input
  redaction directly.

Focused validation:

- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "redacts secret-looking keys"`
  - passed, 1 focused Vitest test.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "preserves cancellation when execution finishes after cancel"`
  - failed before implementation because `run.trigger.input.apiKey` leaked
    `raw-cancel-api-key`.
  - passed after rebuilding `@openacme/db`, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_cancel_late_deployed_ms7dgu9i`, started HTTP
    test run `15867de0-6331-4e28-9c93-648ed9ca2176`, canceled it from inside
    the executing MCP port through the real HTTP cancel route, let the MCP port
    return output, and verified persisted run status `canceled`, trigger input
    `{ "customerId": "cust_late_cancel", "apiKey": "[redacted]" }`, step status
    `canceled`, step input `{ "id": "cust_late_cancel", "apiKey": "[redacted]" }`,
    and event sequence `run_started`, `step_started`, `run_canceled`.
  - The same smoke preserved the prior seeded-cancel proof with workflow
    `wf_cancel_deployed_ms7dgu9i` and run
    `run_cancel_deployed_ms7dgu9i`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow run trigger read-path redaction slice record:

- Workflow run trigger snapshots are now redacted on read as well as on create.
- `runFromRow` applies the same secret-key redaction to parsed
  `workflow_runs.trigger_json` before returning `getRun`, `listRuns`, or paged
  run-history results.
- This is a defensive read-path contract for already-existing or externally
  repaired rows that may contain raw trigger input. It does not mutate the SQL
  row; it prevents raw values from leaving the store/API surface.
- The deployed cancel smoke harness also now bounds `server.close()` with the
  existing 2-second shutdown pattern, after one successful smoke emitted `ok`
  JSON but left the exec session waiting even though no listener remained.

TDD note:

- The DB redaction test first created a safe run, then directly rewrote
  `workflow_runs.trigger_json` to contain
  `apiKey: "raw-legacy-trigger-key"`.
- Before implementation, `store.getRun("run_secret")` returned that raw trigger
  input.
- After applying read-time trigger redaction in `runFromRow`, `getRun` and
  `listRuns` return `apiKey: "[redacted]"` and no raw value leaves the store.

Focused validation:

- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "redacts secret-looking keys"`
  - failed before implementation because `getRun` returned
    `raw-legacy-trigger-key`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_cancel_late_deployed_ms7dpt65`, started HTTP
    test run `06c47732-973b-4ae5-adc8-3df938ebbbbe`, canceled it from inside
    the executing MCP port through the real HTTP cancel route, let the MCP port
    return output, and verified persisted run status `canceled`, trigger input
    `{ "customerId": "cust_late_cancel", "apiKey": "[redacted]" }`, step status
    `canceled`, step input `{ "id": "cust_late_cancel", "apiKey": "[redacted]" }`,
    and event sequence `run_started`, `step_started`, `run_canceled`.
  - The same smoke preserved the prior seeded-cancel proof with workflow
    `wf_cancel_deployed_ms7dpt65` and run
    `run_cancel_deployed_ms7dpt65`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow audit JSON read-path redaction slice record:

- Workflow run, step attempt, and run event audit JSON is now redacted on read
  as well as before persistence.
- `runFromRow` now redacts parsed `workflow_runs.trigger_json`,
  `input_json`, and `context_json`.
- `stepFromRow` now redacts parsed step `input_json`, `output_json`,
  `error_json`, `logs_summary_json`, and `context_diff_json`.
- `eventFromRow` now redacts parsed `workflow_run_events.payload_json`.
- Workflow definition JSON remains unchanged; the read-path hardening is scoped
  to durable run audit surfaces returned by run history/detail APIs.
- This closes the legacy/raw-row gap where an already-existing or externally
  repaired audit row could bypass the write-path redaction and leak raw
  secret-looking keys from store/API reads.

TDD note:

- The DB redaction test first wrote normal run, step, and event audit records
  through the store, then directly rewrote the underlying SQL JSON columns with
  raw values such as `raw-legacy-run-key`,
  `raw-legacy-context-password`, `raw-legacy-step-auth`,
  `raw-legacy-output-key`, `raw-legacy-error-secret`,
  `raw-legacy-log-token`, `raw-legacy-diff-password`, and
  `raw-legacy-event-auth`.
- Before implementation, the focused test failed because
  `store.getRun("run_secret")` returned raw `input_json` and `context_json`.
- After implementation, `getRun`, `listRuns`, `listStepAttempts`, and
  `listRunEvents` all return `"[redacted]"` for secret-looking keys and no
  raw `raw-` value leaves the store.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "redacts secret-looking keys"`
  - failed before implementation because legacy run input/context JSON leaked
    raw values.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- workflow-store.test.ts`
  - passed, 7 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_cancel_late_deployed_ms7dz444`, started HTTP
    test run `de89fb35-3de7-408b-bfb1-bfaff78f40f1`, canceled it from inside
    the executing MCP port through the real HTTP cancel route, let the MCP port
    return output, and verified persisted run status `canceled`, trigger input
    `{ "customerId": "cust_late_cancel", "apiKey": "[redacted]" }`, step status
    `canceled`, step input `{ "id": "cust_late_cancel", "apiKey": "[redacted]" }`,
    and event sequence `run_started`, `step_started`, `run_canceled`.
  - The same smoke preserved the prior seeded-cancel proof with workflow
    `wf_cancel_deployed_ms7dz444` and run
    `run_cancel_deployed_ms7dz444`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Foreach output assignment slice record:

- `builtin.foreach` now supports the same optional `assign` section as other
  executable output-producing cards.
- The foreach schema accepts assignment maps while keeping the existing
  `items`, `itemVar`, `body`, and `concurrency` contract unchanged.
- After a foreach step succeeds, the runner records
  `$.steps.<foreachNode>.output`, then applies `assign` through the shared
  assignment helper. This means a foreach summary can be written into the same
  workflow context as MCP, agent, transform, and Python outputs.
- The step attempt context diff records the foreach assignment, so the Run
  Console can explain where the summary variable came from.
- Failure behavior is unchanged: if a foreach item fails, the foreach step does
  not reach its successful output assignment path.

TDD note:

- The schema test first added an `assign` map targeting
  `foreachSummary: "$.steps.each_customer.output"` to a `builtin.foreach` node
  in a valid definition.
- Before implementation, the focused schema test failed with
  `Unrecognized key: "assign"` on the foreach node.
- The runner test then expected a successful foreach card to assign its output
  summary into `context.foreachSummary` and record the corresponding
  `contextDiff`.
- After implementation, both focused tests passed.

Focused validation:

- `pnpm --filter @openacme/workflows test -- schemas.test.ts -t "accepts a manual-trigger draft"`
  - failed before implementation because `builtin.foreach` rejected `assign`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "runs foreach sequentially"`
  - failed before implementation because `builtin.foreach` rejected `assign`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/schemas.ts packages/workflows/src/runner.ts packages/workflows/test/schemas.test.ts packages/workflows/test/runner.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test`
  - passed, 28 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - first run produced the expected successful JSON payload but had to be
    interrupted because the smoke harness waited indefinitely for
    `server.close()`. That run was not counted as accepted validation.
  - after adding the same bounded `server.close()` pattern used by the cancel
    smoke, the deployed Python/foreach smoke passed with exit code 0.
  - The accepted smoke created workflow `wf_python_deployed_ms7e93af`, ran HTTP
    test run `ff09b335-4103-47a3-b87e-6a403744d523`, and verified persisted
    status `succeeded`.
  - The run context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2`; the smoke also verified the foreach step
    `contextDiff.foreachSummary.after.count` and reopened persisted run detail
    to confirm the assignment survived storage/API reads.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Log output assignment slice record:

- `builtin.log.info`, `builtin.log.debug`, and `builtin.log.error` now support
  the same optional `assign` section as other executable output-producing
  cards.
- The log schema accepts assignment maps while keeping the existing
  `message`, optional `payload`, and log level contract unchanged.
- The runner records each log card's output at `$.steps.<logNode>.output`
  before applying assignments. For payload logs, the output shape is
  `{ "message": "...", "payload": ... }`; message-only logs keep the existing
  `{ "message": "..." }` shape.
- The log event is still appended as the card's primary audit side effect. The
  assignment then maps the already-recorded log output into workflow context
  and the step attempt `contextDiff` records the variable change.
- This keeps `builtin.log.*` aligned with transform, MCP, agent, Python, and
  foreach assignment behavior without adding assignment semantics to branch or
  exit nodes in this slice.

TDD note:

- The schema test first added an `assign` map targeting
  `loggedCustomer: "$.steps.audit_log.output.payload"` to a
  `builtin.log.info` node in a valid definition.
- Before implementation, the focused schema test failed with
  `Unrecognized key: "assign"` on the log node.
- The runner test then expected a log card to write
  `context.loggedCustomer`, preserve the log summary payload, and record a
  `contextDiff` for the assignment.
- Before implementation, the focused runner test failed for the same schema
  rejection before execution.
- After implementation, both focused tests passed.

Focused validation:

- `pnpm --filter @openacme/workflows test -- schemas.test.ts -t "accepts a manual-trigger draft"`
  - failed before implementation because `builtin.log.info` rejected `assign`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "executes set, transform, log"`
  - failed before implementation because `builtin.log.info` rejected `assign`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/schemas.ts packages/workflows/src/runner.ts packages/workflows/test/schemas.test.ts packages/workflows/test/runner.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test`
  - passed, 28 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7ehcyy` and ran manual
    trigger run `5a5757e7-f6d3-4986-9285-370fa647015d`.
  - The workflow included `audit_log` as `builtin.log.info` with
    `assign.loggedCustomer` sourced from
    `$.steps.audit_log.output.payload`.
  - The smoke verified the manual run context includes
    `loggedCustomer.id: "cust_trigger"` and the audit log step
    `contextDiff.loggedCustomer.after.id: "cust_trigger"`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `3622e99a-b1b9-48ff-ad61-67f48656b26b`, public webhook run
    `d365fa83-df6e-413b-aabe-a8cb26375dd8`, public path webhook run
    `4785858a-5a5c-4c5a-bb8f-9835cb1f5a77`, scheduled dispatcher run
    `fb6b3ac6-bc8c-4fd4-b10e-89f42a976faf`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Quoted boolean operator condition slice record:

- Workflow condition parsing now treats boolean `and` / `or` as operators only
  when they appear outside quoted string literals and outside function-call
  parentheses.
- This fixes branch expressions such as
  `contains($.input.note, "red or blue") or contains($.input.note, "review and hold")`.
  The words `or` and `and` inside the quoted search strings no longer split the
  expression into unrelated operands.
- The change is scoped to the workflow runner's boolean operator splitter. The
  existing expression language remains constrained: equality, numeric
  comparison, boolean `and`/`or`/`not`, `exists`, `contains`, and `length`.
- Parenthesized grouping is still not introduced in this slice; parentheses
  are respected so function-call arguments are not split.

TDD note:

- The runner test first added an `if_else` condition containing both
  `"red or blue"` and `"review and hold"` as quoted string operands.
- Before implementation, the focused test failed because the regex-based
  splitter treated the `or` inside `"red or blue"` as a top-level boolean
  operator, so the branch incorrectly selected `then`.
- After replacing the regex split with a quote-aware, parenthesis-depth-aware
  scanner, the same test selected the `else` branch as expected.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "quoted condition strings"`
  - failed before implementation because the quoted `or` caused the wrong
    branch to run.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test`
  - passed, 29 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - first run reached the correct runtime behavior but failed the smoke
    assertion because the harness assumed a fixed step-attempt order for
    selected and skipped branch nodes. That run was not counted as accepted
    validation.
  - after making the harness assertion order-independent, the deployed trigger
    smoke passed with exit code 0.
  - The accepted smoke created workflow `wf_trigger_deployed_ms7eqjwq` and ran
    manual trigger run `adb12071-bb42-498e-aa5f-e1c7e333df09`.
  - The workflow included `quoted_condition` with
    `contains($.input.customer.name, "Trigger or Ada") or contains($.input.customer.name, "Review and Hold")`.
    The smoke verified `quoted_match` was skipped and `quoted_miss` succeeded,
    proving quoted `or`/`and` text did not become top-level boolean operators.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `948b4b98-4296-4b0e-a072-0d9c7bce5d80`, public webhook run
    `3b597275-00b4-4c11-9a9d-4015ab66f31c`, public path webhook run
    `d6cb453a-d619-499f-a8ee-96558cb4c859`, scheduled dispatcher run
    `32906e30-4898-4b32-b294-3e64f0da20d4`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Quoted comma `contains` argument slice record:

- `contains(collection, needle)` now splits its arguments on top-level commas
  only. Commas inside quoted string literals or nested function-call
  parentheses no longer corrupt the argument boundary.
- This fixes expressions such as `contains($.input.note, "red, blue")`, where
  the comma belongs to the string operand and not to the function call syntax.
- The change is scoped to `contains` argument parsing in the workflow runner.
  The expression language remains constrained and still avoids arbitrary
  JavaScript.

TDD note:

- The runner test first added an `if_else` condition using
  `contains($.input.note, "red, blue")` and input text containing that exact
  phrase.
- Before implementation, the focused test failed with run status `failed`
  because the regex-based parser split the quoted comma as if it separated
  function arguments.
- After adding a quote-aware, parenthesis-depth-aware argument splitter for
  `contains`, the same test succeeded and selected the expected branch.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "commas inside quoted strings"`
  - failed before implementation because the quoted comma made the run fail.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test`
  - passed, 30 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7evzgt` and ran manual
    trigger run `3b53113f-8858-43ab-bf37-ee4a3395e103`.
  - The workflow included `comma_condition` with
    `contains($.input.customer.name, "Trigger, Ada")`.
  - The smoke verified `comma_match` was skipped and `comma_miss` succeeded,
    proving the quoted comma was parsed as part of the `needle` string and the
    expression evaluated normally instead of failing the run.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `a81e3087-e974-4103-a5f4-7a74f090c2ee`, public webhook run
    `08881a9d-f89d-426a-b03c-d2841678ef83`, public path webhook run
    `f6633155-206f-438d-9d0a-7ca6af6447f1`, scheduled dispatcher run
    `174d2ee1-ae18-4910-b177-2a25091f3e43`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Quoted comparison operator slice record:

- Workflow comparison parsing now treats `==`, `!=`, `>=`, `<=`, `>`, and `<`
  as comparison operators only when they appear outside quoted string literals
  and outside function-call parentheses.
- This fixes expressions such as `"a >= b" == $.input.note`, where `>=` is
  text inside the left operand and `==` is the actual comparison operator.
- The change is scoped to the workflow runner's comparison parser. The
  expression language remains constrained and still avoids arbitrary
  JavaScript.

TDD note:

- The runner test first added an `if_else` condition using
  `"a >= b" == $.input.note` with input note `a >= b`.
- Before implementation, the focused test failed with run status `failed`
  because the regex-based parser treated the quoted `>=` as the top-level
  numeric comparison operator.
- After replacing the comparison regex with a quote-aware,
  parenthesis-depth-aware scanner, the same test succeeded and selected the
  expected branch.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "comparison operators inside quoted strings"`
  - failed before implementation because the quoted comparison operator made
    the run fail.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test`
  - passed, 31 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7f25po` and ran manual
    trigger run `19b2cae1-bb1d-4c71-a7a6-29679935664d`.
  - The workflow included `comparison_condition` with
    `"Trigger >= Ada" == $.input.customer.name`.
  - The smoke verified `comparison_match` was skipped and `comparison_miss`
    succeeded, proving the quoted `>=` text was parsed as part of the left
    string operand and the expression evaluated normally instead of failing the
    run.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `ddcd377c-449e-4d58-8e6b-ed3d8a347090`, public webhook run
    `26c7d660-83e9-474e-9674-6d271fb1c0b2`, public path webhook run
    `1660c833-6554-4592-8cf8-2447a1ab31e1`, scheduled dispatcher run
    `bb1b9d87-47fc-427a-83d2-6c1403ce6388`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Parenthesized not condition slice record:

- Workflow condition evaluation now supports `not(...)` in addition to the
  existing `not <expression>` form.
- The parser only treats `not(...)` as a unary condition call when the outer
  parentheses are balanced and close at the end of the expression. Nested
  function calls and quoted strings inside the argument remain part of the
  argument.
- This keeps boolean `not` ergonomic for card-authored conditions without
  expanding the workflow expression language into arbitrary JavaScript or
  introducing general parenthesized grouping.

TDD note:

- The runner test first added an `if_else` condition using
  `not(contains($.input.note, "blocked"))` with input note `blocked`.
- Before implementation, the focused test failed because the expression fell
  through as a truthy literal string and selected the `then` branch.
- After adding a quote-aware, parenthesis-depth-aware single-argument call
  parser for `not`, the same test selected the expected `else` branch.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "supports parenthesized not conditions"`
  - failed before implementation because `not(...)` selected the wrong branch.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/workflows test`
  - passed, 32 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7fbjau` and ran manual
    trigger run `96d12c1f-897d-4078-8eb7-c884cfe09814`.
  - The workflow included `not_condition` with
    `not(contains($.input.customer.name, "Trigger Ada"))`.
  - The smoke verified `not_match` was skipped and `not_miss` succeeded,
    proving the parenthesized `not` condition was evaluated through the
    running HTTP workflow path.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `426bd13b-ee93-4c6b-bca4-53feca478438`, public webhook run
    `378f6b9d-80d6-4e57-9475-1b99706f16bc`, public path webhook run
    `83273219-dfe9-49c2-ba9f-108fa188bf48`, scheduled dispatcher run
    `e0e86351-8154-494b-9a83-d2e3d86c75e7`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow artifact metadata detail slice record:

- `WorkflowStore` now exposes durable artifact metadata operations:
  `recordArtifact` and `listArtifacts`.
- Artifact metadata is stored in the existing `workflow_artifacts` table and
  returned in deterministic `createdAt, id` order for a run.
- Run detail responses now include `artifacts` alongside `run`, `steps`, and
  `events`, so the UI/API has a stable seam for spilled large inputs/outputs.
- This slice records artifact metadata only. Automatic large-payload spilling
  and artifact file lifecycle remain a follow-up slice.

TDD note:

- The DB store test first expected `store.recordArtifact` and
  `store.listArtifacts` to persist metadata for a step output artifact.
- The route test first seeded artifact metadata after a successful test run
  and expected `GET /api/workflow-runs/:id` to return it in `artifacts`.
- Before implementation, both focused tests failed because the workflow store
  did not expose artifact metadata operations.
- After implementation, the focused DB/API tests passed. The server focused
  test required rebuilding `@openacme/db` first because the server test imports
  the package build output.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "artifact metadata"`
  - failed before implementation with `store.recordArtifact is not a function`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "runs draft tests and published live runs"`
  - failed before implementation with
    `runtime.workflowStore.recordArtifact is not a function`.
  - passed after implementation after `@openacme/db` build output was updated.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/src/index.ts packages/db/test/workflow-store.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 9 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 22 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7fmc0z` and ran manual
    trigger run `09ffcfd8-63bd-48eb-9d71-0cca55ca77f9`.
  - The smoke wrote artifact metadata through the deployed runtime store for
    the manual trigger run's `exit` step, then fetched
    `GET /api/workflow-runs/09ffcfd8-63bd-48eb-9d71-0cca55ca77f9`.
  - The run detail response included artifact id
    `wf_trigger_deployed_ms7fmc0z_artifact_output`, kind `step_output`, path
    `workflows/wf_trigger_deployed_ms7fmc0z/09ffcfd8-63bd-48eb-9d71-0cca55ca77f9/exit-output.json`,
    and preview `{"customer":"cust_trigger"}`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `2168e61d-1fb9-491b-8898-1b6c4b53e171`, public webhook run
    `178ecc95-886a-45d2-a52c-facd30961d3f`, public path webhook run
    `16607cbd-205e-4eb2-b952-722b1526af1f`, scheduled dispatcher run
    `1f31ae04-5403-4f47-9f1b-dfb0ad4169ba`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow large step output spill slice record:

- `WorkflowStore.recordStepAttempt` now spills oversized step `input` and
  `output` JSON values when the store is configured with an artifact root.
- Server runtime configures workflow artifacts under
  `<dataDir>/workflow-artifacts`, keeping workflow spill files isolated from
  generic chat attachments.
- Spilled values are redacted before writing to disk. The inline step field is
  replaced by an artifact reference containing `id`, `kind`, relative `path`,
  `preview`, and `byteLength`.
- Spill metadata is recorded in `workflow_artifacts` through the existing
  artifact detail seam, and run detail continues to expose the `artifacts`
  array.
- This slice covers step input/output spill. Event payload, final run context,
  error payload, logs summary, cleanup/retention policy, and direct artifact
  download routes remain follow-up slices.

TDD note:

- The DB store test first created a low spill threshold and recorded a step
  with a large output containing secret-looking keys.
- Before implementation, the focused test failed because the full redacted
  output stayed inline and no artifact file or metadata was created.
- After implementation, the step output became an artifact reference, the
  artifact metadata row was persisted, and the artifact file contained redacted
  JSON without the raw secret.
- The route test then proved `ServerRuntime` wires the artifact root by running
  a workflow whose MCP step returns a large output and verifying run detail plus
  the file under the test `dataDir`.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large step outputs"`
  - failed before implementation because output remained inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow step outputs"`
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/src/index.ts packages/db/test/workflow-store.test.ts packages/server/src/runtime.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 10 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 23 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7fxhtw` and ran manual
    trigger run `acc97760-e76d-4541-acd4-a658c05bc7cf`.
  - The smoke updated the run's `exit` step with a large output containing
    `apiKey: "raw-deployed-spill-key"`.
  - `GET /api/workflow-runs/acc97760-e76d-4541-acd4-a658c05bc7cf` returned the
    `exit` step output as a `step_output` artifact reference whose path starts
    with
    `runs/acc97760-e76d-4541-acd4-a658c05bc7cf/steps/` and ends with
    `/output.json`.
  - The same run detail included matching `workflow_artifacts` metadata, and
    the file under
    `/Users/alenbohcelyan/.openacme-the-workflow/workflow-artifacts` existed
    with redacted JSON containing `"[redacted]"` and not containing
    `raw-deployed-spill-key`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `52ad2c02-2e8f-4518-b06a-7d054c898f4b`, public webhook run
    `0babd71a-8c56-4840-9885-6f58418985cb`, public path webhook run
    `471d718a-f39a-4f31-8367-672cc9b8471a`, scheduled dispatcher run
    `4d992170-60fd-4321-b448-755da56dcc3c`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow event payload spill slice record:

- `WorkflowStore.appendRunEvent` now spills oversized event `payload` JSON when
  the store is configured with an artifact root.
- Event payload spill uses the same redaction-before-write rule as step
  input/output spill.
- The inline event payload is replaced by an artifact reference containing
  `id`, `kind: "event_payload"`, relative `path`, `preview`, and `byteLength`.
- Artifact files are stored under
  `<dataDir>/workflow-artifacts/runs/<runId>/events/<eventId>/payload.json`.
- Artifact metadata keeps `stepRunId` when the event is step-scoped, so run
  detail can connect timeline payload artifacts back to a step attempt.
- This slice covers event payload spill. Final run context, error payload,
  logs summary, cleanup/retention policy, and direct artifact download routes
  remain follow-up slices.

TDD note:

- The DB store test first appended a `step_output` event with a large payload
  containing a secret-looking key.
- Before implementation, the focused DB test failed because the full redacted
  payload stayed inline and no artifact file or metadata was created.
- The route test extended the existing large MCP output run to require the
  `step_output` timeline event payload to spill as `event_payload` in addition
  to the step output artifact.
- Before implementation, the route focused test failed because the event
  payload had no artifact reference.
- After implementation, both focused tests passed and the artifact files
  contained redacted JSON without raw secret values.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large event payloads"`
  - failed before implementation because event payload remained inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow step outputs"`
  - failed before implementation because the `step_output` event payload had no
    artifact reference.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 11 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 23 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7g63ar` and ran manual
    trigger run `1e2e9160-cceb-4a5a-a947-d2c773ee6559`.
  - The smoke appended `step_output` event
    `wf_trigger_deployed_ms7g63ar_event_payload` with a large payload
    containing `apiKey: "raw-deployed-event-key"`.
  - `GET /api/workflow-runs/1e2e9160-cceb-4a5a-a947-d2c773ee6559` returned the
    appended event payload as an `event_payload` artifact reference whose path
    starts with
    `runs/1e2e9160-cceb-4a5a-a947-d2c773ee6559/events/` and ends with
    `/payload.json`.
  - The same run detail included matching `workflow_artifacts` metadata linked
    to the `exit` step attempt, and the file under
    `/Users/alenbohcelyan/.openacme-the-workflow/workflow-artifacts` existed
    with redacted JSON containing `"[redacted]"` and not containing
    `raw-deployed-event-key`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `5c0f3ec3-aaee-4725-b695-f962da23390d`, public webhook run
    `62f2f432-e307-45d3-97a0-08832803e840`, public path webhook run
    `b4764a45-83a1-4e65-a5d0-f376838953f3`, scheduled dispatcher run
    `7793c4fa-3564-4319-9902-cecbde48f750`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow step error spill slice record:

- `WorkflowStore.recordStepAttempt` now spills oversized step `error` JSON when
  the store is configured with an artifact root.
- Step error spill uses redaction before artifact file write, matching step
  input/output and event payload spill behavior.
- The inline step `error` is replaced by an artifact reference containing
  `id`, `kind: "step_error"`, relative `path`, `preview`, and `byteLength`.
- Artifact files are stored under
  `<dataDir>/workflow-artifacts/runs/<runId>/steps/<stepRunId>/error.json`.
- This slice covers persisted step error spill only. Final run context spill,
  logs summary spill, cleanup/retention policy, and direct artifact download
  routes remain follow-up slices.
- The deployed smoke updates existing step metadata only to prove deployed
  persistence and HTTP read-back. Runtime failure semantics are covered by the
  route test that executes an MCP step whose tool call throws.

TDD note:

- The DB store test first recorded a failed step with a large `error` object
  containing a secret-looking key.
- Before implementation, the focused DB test failed because the full redacted
  error stayed inline and no `step_error` artifact file or metadata was
  created.
- The route test then executed an MCP-backed workflow whose tool call throws a
  large structured error and required the failed step detail to expose a
  `step_error` artifact reference.
- Before implementation, the route focused test failed because the failed step
  had no error artifact reference.
- After implementation, both focused tests passed and the artifact files
  contained redacted JSON without raw secret values.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large step errors"`
  - failed before implementation because step error remained inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow step errors"`
  - failed before implementation because the failed MCP step had no error
    artifact reference.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 12 tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 24 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7gftom` and ran manual
    trigger run `75349b9b-df43-41db-ba9b-8d31a1f00145`.
  - The smoke updated the deployed `exit` step metadata with a large error
    containing `apiKey: "raw-deployed-error-key"`.
  - `GET /api/workflow-runs/75349b9b-df43-41db-ba9b-8d31a1f00145` returned the
    step error as a `step_error` artifact reference whose path starts with
    `runs/75349b9b-df43-41db-ba9b-8d31a1f00145/steps/` and ends with
    `/error.json`.
  - The same run detail included matching `workflow_artifacts` metadata, and
    the file under
    `/Users/alenbohcelyan/.openacme-the-workflow/workflow-artifacts` existed
    with redacted JSON containing `"[redacted]"` and not containing
    `raw-deployed-error-key`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `90e81419-4973-491b-ba0a-5c586ce883e4`, public webhook run
    `af4de52b-ea40-47d4-85cf-540e62a71269`, public path webhook run
    `470a6a59-40f0-4225-b31d-c06549cf2960`, scheduled dispatcher run
    `528a3153-1fc3-49db-bb50-010048951599`, invalid trigger/input guards,
    run filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow final run context spill slice record:

- `WorkflowStore.createRun` and `WorkflowStore.updateRunState` now spill
  oversized run `context` JSON when the store is configured with an artifact
  root.
- Run context spill uses redaction before artifact file write, matching step
  trace and timeline payload spill behavior.
- The inline run `context` is replaced by an artifact reference containing
  `id`, `kind: "run_context"`, relative `path`, `preview`, and `byteLength`.
- Artifact files are stored under
  `<dataDir>/workflow-artifacts/runs/<runId>/context.json`.
- Artifact metadata is stored with `stepRunId: null`, because final context is
  run-scoped rather than step-scoped.
- This slice covers final run context spill only. Logs summary spill,
  cleanup/retention policy, and direct artifact download routes remain
  follow-up slices.

TDD note:

- The DB store test first updated a run to `succeeded` with a large final
  context containing a secret-looking key.
- Before implementation, the focused DB test failed because the full redacted
  context stayed inline and no `run_context` artifact file or metadata was
  created.
- The route test then executed an MCP-backed workflow that assigned a large
  step output into run context and required the run detail response to expose a
  `run_context` artifact reference.
- Before implementation, the route focused test failed because
  `run.context.artifact` was missing.
- After implementation, both focused tests passed and the artifact files
  contained redacted JSON without raw secret values.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large final run context"`
  - failed before implementation because run context remained inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large final workflow context"`
  - failed before implementation because the API run detail had no context
    artifact reference.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 13 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 25 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7gowj2` and ran manual
    trigger run `e39ae0db-4e65-4e76-a7d6-6347af8966d2`.
  - The smoke updated the deployed run final context with a large JSON payload
    containing `apiKey: "raw-deployed-context-key"`.
  - `GET /api/workflow-runs/e39ae0db-4e65-4e76-a7d6-6347af8966d2` returned the
    final context as a `run_context` artifact reference at
    `runs/e39ae0db-4e65-4e76-a7d6-6347af8966d2/context.json`.
  - The same run detail included matching `workflow_artifacts` metadata with
    `stepRunId: null`, and the file under
    `/Users/alenbohcelyan/.openacme-the-workflow/workflow-artifacts` existed
    with redacted JSON containing `"[redacted]"` and not containing
    `raw-deployed-context-key`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `24d8daeb-778c-4596-bd8c-65fffe8148e3`, public webhook run
    `f33572e2-d8ec-486e-9075-3f8394289ce6`, public path webhook run
    `350e6cf8-aaed-412e-820a-7de35142bf68`, scheduled dispatcher run
    `fef034a7-4302-4377-8948-fe0419ee931e`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow step logs summary spill slice record:

- `WorkflowStore.recordStepAttempt` now spills oversized step `logsSummary`
  JSON when the store is configured with an artifact root.
- Logs summary spill uses redaction before artifact file write, matching step
  input/output/error, event payload, and run context spill behavior.
- The inline step `logsSummary` is replaced by an artifact reference containing
  `id`, `kind: "step_logs_summary"`, relative `path`, `preview`, and
  `byteLength`.
- Artifact files are stored under
  `<dataDir>/workflow-artifacts/runs/<runId>/steps/<stepRunId>/logs-summary.json`.
- This slice covers persisted step logs summary spill only. Cleanup/retention
  policy and direct artifact download routes remain follow-up slices.
- The deployed smoke updates existing step metadata only to prove deployed
  persistence and HTTP read-back. Runtime log production semantics remain
  covered by the runner/API tests that create `logsSummary` for log-producing
  steps.

TDD note:

- The DB store test first recorded a succeeded step with a large `logsSummary`
  object containing a secret-looking key.
- Before implementation, the focused DB test failed because the full redacted
  logs summary stayed inline and no `step_logs_summary` artifact file or
  metadata was created.
- The route test then ran a simple workflow, updated its persisted step
  metadata with a large logs summary, and required the run detail response to
  expose a `step_logs_summary` artifact reference.
- Before implementation, the route focused test failed because
  `steps[0].logsSummary.artifact` was missing.
- After implementation, both focused tests passed and the artifact files
  contained redacted JSON without raw secret values.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large step logs summaries"`
  - failed before implementation because step logs summary remained inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow step logs summaries"`
  - failed before implementation because the API run detail had no logs summary
    artifact reference.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 14 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 26 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7gx954` and ran manual
    trigger run `da020056-d09f-4d7f-a521-0fe9f315383a`.
  - The smoke updated the deployed `exit` step metadata with a large
    `logsSummary` containing `apiKey: "raw-deployed-logs-key"`.
  - `GET /api/workflow-runs/da020056-d09f-4d7f-a521-0fe9f315383a` returned the
    step logs summary as a `step_logs_summary` artifact reference whose path
    starts with
    `runs/da020056-d09f-4d7f-a521-0fe9f315383a/steps/` and ends with
    `/logs-summary.json`.
  - The same run detail included matching `workflow_artifacts` metadata linked
    to the `exit` step attempt, and the file under
    `/Users/alenbohcelyan/.openacme-the-workflow/workflow-artifacts` existed
    with redacted JSON containing `"[redacted]"` and not containing
    `raw-deployed-logs-key`.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `f4c718dc-53ba-4859-ba71-d2f1b2ae2ba7`, public webhook run
    `ef51231b-cfc5-46b4-bb75-c508bd31fc58`, public path webhook run
    `4d1b3ecd-ea09-4dae-9840-9fa5aafda45d`, scheduled dispatcher run
    `d55b4fb0-0bf3-4870-b243-ec4c31f08964`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Workflow artifact content API slice record:

- `WorkflowStore` now exposes `readArtifactContent(runId, artifactId)` for
  run-owned artifact content lookup.
- Artifact content reads are resolved inside the configured artifact root.
  Metadata paths that escape `<dataDir>/workflow-artifacts`, point to missing
  files, or contain invalid JSON are treated as not found.
- The authenticated API now exposes
  `GET /api/workflow-runs/:id/artifacts/:artifactId`.
- The route returns `{ artifact, content }` only when the run exists and the
  artifact metadata belongs to that run. Missing runs return `not_found`;
  missing, cross-run, unreadable, or unsafe artifacts return
  `artifact_not_found`.
- Artifact content is returned as JSON. This slice does not add browser file
  attachment headers or UI download buttons; those remain follow-up operator UI
  work and are addressed by the later artifact download route and Run Console
  action slice.
- Cleanup/retention policy remains a follow-up slice.

TDD note:

- The route test first ran a workflow that produced a large spilled output and
  required `GET /api/workflow-runs/:id/artifacts/:artifactId` to return the
  redacted artifact JSON content.
- Before implementation, the focused route test failed because the route did
  not exist and returned a non-JSON 404 response.
- After implementation, the route test proved successful content read-back,
  cross-run artifact ownership rejection, and unsafe metadata path rejection.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "serves workflow artifact content"`
  - failed before implementation because the content route did not exist.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs packages/db/src/stores/workflow-store.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 14 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 27 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7h5868` and ran manual
    trigger run `afe0d998-0956-4563-9373-953001b96acf`.
  - The smoke updated the deployed `exit` step with a large spilled output
    containing `apiKey: "raw-deployed-spill-key"`.
  - `GET /api/workflow-runs/afe0d998-0956-4563-9373-953001b96acf/artifacts/<spilledOutputId>`
    returned the artifact metadata plus redacted JSON content with
    `apiKey: "[redacted]"` and without `raw-deployed-spill-key`.
  - The same smoke verified a missing run returns `not_found` for the artifact
    content route.
  - The same smoke preserved the existing trigger coverage: authenticated
    webhook run `435424b3-09fb-45b2-a348-eee4e75e49bf`, public webhook run
    `f7b5d4ef-d9d9-4acf-8453-34fa43d68d97`, public path webhook run
    `4ed27c57-b987-463a-ab34-cecccf908d1c`, scheduled dispatcher run
    `7961d414-0c5e-44f1-8821-87043a9f3d9a`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `61087`.

Run Console artifact content expansion UI slice record:

- Global `/workflow-runs` Run Console JSON blocks now detect workflow artifact
  references and can load the persisted JSON through
  `GET /api/workflow-runs/:id/artifacts/:artifactId`.
- Workflow-scoped `/workflows` Run Console JSON blocks use the same artifact
  expansion behavior, so spilled step input/output, logs summary, event
  payload, trigger payload, run input, final context, and context diff values
  remain inspectable from the operator console.
- The UI keeps the persisted artifact reference visible until the operator asks
  to load the artifact. After loading, the JSON block displays the returned
  artifact content and preserves the existing redaction indicator.
- Load failures stay local to the JSON block and also raise the existing toast
  error path.

TDD note:

- The global Run Console Playwright test first mocked a step output artifact
  reference and required an operator click on `Load artifact` to retrieve the
  redacted content API response.
- Before implementation, the focused Playwright test failed because there was
  no `Load artifact` affordance in the JSON block.
- After implementation, the focused Playwright test still failed once because
  the suite serves the built `apps/web/out` bundle; rebuilding the web output
  made the implemented route code visible to Playwright.
- The same UI behavior was mirrored into the workflow-scoped Run Console.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --dir apps/web check-types` - passed.
- `pnpm --dir apps/web build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "loads artifact content from the global run JSON block"`
  - failed before implementation because `Load artifact` was missing.
  - passed after implementation and web rebuild, 1 focused Playwright test.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 8 Playwright tests.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "Run Console|run console|loads older workflow-scoped|keeps selected workflow run step|filters workflow-scoped"`
  - passed, 7 Playwright tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7hl2st` and ran manual
    trigger run `9ebf69d6-28a2-426a-8320-20627cf8f002`.
  - The same deployed smoke exercised authenticated webhook run
    `8ae59dc9-41a6-4407-bc40-7f4b701810d5`, public webhook run
    `beb836e4-5a7e-4887-bcc2-778276c10ecf`, public path webhook run
    `cc474591-f4ee-4ce3-befc-5076e66c3632`, scheduled dispatcher run
    `7965b883-602c-465f-9a93-e75edb94131a`, invalid trigger/input guards, run
    filtering, pagination validation, duplicate scheduled-scan guards, and the
    artifact content API path consumed by the Run Console.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow artifact download route and Run Console action slice record:

- The authenticated API now exposes
  `GET /api/workflow-runs/:id/artifacts/:artifactId/download`.
- The download route reuses the same run-owned `readArtifactContent` path as
  the content API, so missing runs still return `not_found` and missing,
  cross-run, unreadable, or unsafe artifacts still return `artifact_not_found`.
- Successful downloads return the redacted artifact JSON content as
  `application/json; charset=utf-8` with `X-Content-Type-Options: nosniff` and
  an attachment filename of `<artifactId>.json`.
- Global `/workflow-runs` and workflow-scoped `/workflows` Run Console JSON
  blocks now expose two explicit artifact actions: `Load artifact` for inline
  inspection and `Download artifact` for browser download.
- The UI download action points directly at the run-owned download endpoint and
  keeps artifact loading independent from artifact downloading.

TDD note:

- The route test first extended the existing artifact content scenario to
  require `/download` to return attachment headers and redacted JSON content.
- Before implementation, the focused route test failed because the new URL fell
  through to the SPA HTML response instead of returning JSON.
- The global Run Console Playwright test then required a `Download artifact`
  action beside `Load artifact`.
- Before implementation, the focused Playwright test failed because the
  download button did not exist.
- After implementation, the Playwright test exposed two test-boundary details:
  `Download artifact` contains `Load artifact` as a substring for fuzzy role
  matching, so the load-button locator now uses `exact: true`; and Playwright
  download responses are not reliably exposed through `page.route`, so the UI
  test owns the download event/URL/filename proof while the server route test
  owns response header/body proof.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "serves workflow artifact content"`
  - failed before implementation because `/download` returned SPA HTML.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "loads artifact content from the global run JSON block"`
  - failed before implementation because `Download artifact` was missing.
  - passed after implementation, web rebuild, and test-boundary locator
    tightening, 1 focused Playwright test.
- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --dir apps/web check-types` - passed.
- `pnpm --dir apps/web build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 27 tests.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 8 Playwright tests.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "Run Console|run console|loads older workflow-scoped|keeps selected workflow run step|filters workflow-scoped"`
  - passed, 7 Playwright tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - The smoke created workflow `wf_trigger_deployed_ms7i5e3b` and ran manual
    trigger run `3afe9005-e069-4bc4-a9f4-54b83fb37e26`.
  - The deployed smoke verified the spilled step output artifact content route
    and the sibling `/download` route. The download route returned
    `application/json`, attachment disposition containing
    `<spilledOutputId>.json`, redacted `apiKey: "[redacted]"`, and no
    `raw-deployed-spill-key`.
  - The same deployed smoke exercised authenticated webhook run
    `0d6bffd4-8b19-4595-b391-e1818a53fd8b`, public webhook run
    `a87e8e48-7dae-4141-acbe-f1f788c8f031`, public path webhook run
    `0ccf1bb5-188c-442f-871c-b4e097bcc10e`, scheduled dispatcher run
    `2f3398f7-0ab2-4b9c-b412-c5a31f8cccba`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow run input spill slice record:

- `WorkflowStore.createRun` now spills oversized `run.input` JSON to workflow
  artifacts when the store has an artifact root and the serialized input
  exceeds the inline JSON limit.
- The persisted run input is replaced by a `run_input` artifact reference at
  `runs/<runId>/input.json`, with metadata in `workflow_artifacts` and the same
  redacted preview/byteLength shape used by step and context artifacts.
- The artifact content and download routes work for `run_input` artifacts
  through the existing run-owned `readArtifactContent` seam.
- Runtime execution still receives the full redacted input content. When the
  persisted run input is an artifact reference, `executeWorkflowRun` resolves
  the artifact content before invoking `WorkflowRunner`; the stored run detail
  remains artifact-backed for audit and UI inspection.

TDD note:

- The DB store test first created a low spill threshold and required a large
  run input with `apiKey: "raw-run-input-key"` to persist as a `run_input`
  artifact.
- Before implementation, the DB test failed because `run.input` stayed inline,
  although redacted.
- The server route test then ran a workflow with large run input and required
  `run.input.artifact`, `workflow_artifacts` metadata, artifact content,
  artifact download, and a `builtin.set` assignment from
  `$.input.customer.id` to prove the runner still sees real input content.
- Before implementation, the route test failed because `run.input.artifact`
  was missing.
- After the store change, the route test required a fresh `@openacme/db` build
  because the server package consumes the built DB output.
- Deployed smoke validation exposed the runtime-detail boundary: persisted
  input can now be an artifact reference, so the runner must resolve artifact
  content before execution. The deployed proof now uses a separate
  input-spill workflow so the main trigger smoke's run-list and pagination
  invariants remain stable.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large run inputs"`
  - failed before implementation because run input stayed inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow run inputs"`
  - failed before implementation because `run.input.artifact` was missing.
  - passed after implementation and DB build, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/test/workflow-store.test.ts packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 15 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 28 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Main trigger workflow: `wf_trigger_deployed_ms7iqe1n`.
  - Main manual run: `0f04e4e7-37b7-4038-a58e-dcbf3ec561d3`.
  - Run-input spill workflow:
    `wf_trigger_deployed_ms7iqe1n_input_spill`.
  - Run-input spill test run:
    `ca95fc3e-b430-42d0-85aa-c834483aa086`.
  - The deployed smoke verified the separate input-spill run persisted
    `run.input` as a `run_input` artifact at
    `runs/ca95fc3e-b430-42d0-85aa-c834483aa086/input.json`, executed
    `builtin.set` from `$.input.customer.id`, served redacted artifact content,
    and downloaded redacted JSON without `raw-deployed-run-input-key`.
  - The same deployed smoke preserved existing trigger coverage:
    authenticated webhook run `3bb91da3-e3dd-419a-93ed-2a674262f188`, public
    webhook run `fe51ab5b-a40c-42d3-8fcb-ca8a7ef27f64`, public path webhook
    run `007a5e46-32d6-4a5c-b3a7-6a8aecb002a8`, scheduled dispatcher run
    `df92ad2b-5cd7-4daf-9721-9ea323f06882`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow step context diff spill slice record:

- `WorkflowStore.recordStepAttempt` now spills oversized per-step
  `contextDiff` JSON to workflow artifacts when the store has an artifact root
  and the serialized context diff exceeds the inline JSON limit.
- The persisted step `contextDiff` is replaced by a `step_context_diff`
  artifact reference at `runs/<runId>/steps/<stepRunId>/context-diff.json`,
  with metadata in `workflow_artifacts`.
- Artifact content and download routes work for `step_context_diff` through
  the existing run-owned artifact seam; no UI-specific or route-specific
  special case was added.
- Step trace artifact paths continue to sanitize unsafe step run ID segments.
  Server tests assert the stable path contract by requiring the run prefix and
  `/context-diff.json` suffix instead of coupling to the unsanitized runtime
  step ID.

TDD note:

- The DB store test first required a large step `contextDiff` containing
  `apiKey: "raw-context-diff-key"` to persist as a `step_context_diff`
  artifact with redacted file content and metadata.
- Before implementation, the DB test failed because `contextDiff` stayed
  inline.
- The server route test then ran a workflow that assigns a large profile into
  context and required `step.contextDiff.artifact`, metadata, disk content,
  artifact content route, and artifact download route to all stay redacted.
- Before implementation, the server focused test failed because
  `contextDiff.artifact` was missing. After implementation it also exposed the
  path-sanitization expectation, which was tightened to the stable path
  contract.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "spills large step context diffs"`
  - failed before implementation because step context diff stayed inline.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow step context diffs"`
  - failed before implementation because `contextDiff.artifact` was missing.
  - passed after implementation and DB build, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts`
  - passed.
- `pnpm exec prettier --write packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 16 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 29 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Main trigger workflow: `wf_trigger_deployed_ms7j5c6i`.
  - Main manual run: `5fde7341-e68d-40d7-ac5a-bdcc78f3acdf`.
  - Run-input spill workflow:
    `wf_trigger_deployed_ms7j5c6i_input_spill`.
  - Run-input spill test run:
    `806b0c15-c4bb-4a79-a86c-a5a93ab58937`.
  - The deployed smoke verified a large deployed step `contextDiff` persisted
    as a `step_context_diff` artifact under
    `runs/5fde7341-e68d-40d7-ac5a-bdcc78f3acdf/steps/.../context-diff.json`,
    served redacted artifact content, and downloaded redacted JSON without
    `raw-deployed-context-diff-key`.
  - The same deployed smoke preserved existing trigger coverage:
    authenticated webhook run `bf339b67-aa37-42cd-b744-526580eb0770`, public
    webhook run `c8ab291c-cd0d-4304-9448-c65221becd03`, public path webhook
    run `80515854-ec55-423b-8dbe-6bda67cc2a16`, scheduled dispatcher run
    `7db565a1-1e92-4c8a-888f-f05a847f257a`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow artifact file retention slice record:

- `WorkflowStore` now exposes explicit artifact file retention through
  `pruneArtifactFiles({ createdBefore })`.
- The operation scans `workflow_artifacts` metadata older than the provided
  cutoff, resolves each path inside the configured workflow artifact root, and
  deletes only physical files under that root.
- The operation preserves audit metadata and inline artifact references in run,
  step, and event JSON. Run detail can still show artifact previews after
  pruning, while content/download routes return `artifact_not_found` for
  deleted files.
- Missing files are counted as `missingFiles`; unsafe paths and non-file paths
  are counted as `skippedUnsafePaths`. Neither case fails the prune operation.
- This slice intentionally does not add an HTTP admin route, operator UI,
  scheduled retention job, or config policy knob.

TDD note:

- The DB store test first created old and fresh spilled artifact files plus
  missing and unsafe metadata rows.
- Before implementation, the focused DB test failed because
  `spillStore.pruneArtifactFiles` did not exist.
- After implementation, the test proved that only the old physical artifact
  file is removed, fresh files remain readable, metadata rows are preserved,
  deleted content reads return null, and missing/unsafe paths are reported.

Focused validation:

- `pnpm --filter @openacme/db test -- workflow-store.test.ts -t "prunes old workflow artifact files"`
  - failed before implementation because `pruneArtifactFiles` was missing.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/db/src/stores/workflow-store.ts packages/db/src/index.ts packages/db/test/workflow-store.test.ts`
  - passed.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  - passed, 17 tests.
- `pnpm --filter @openacme/db check-types` - passed.
- `pnpm --filter @openacme/db build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 29 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Main trigger workflow: `wf_trigger_deployed_ms7jfefo`.
  - Main manual run: `345dc6ef-7462-484d-8d60-e21736cd436f`.
  - Run-input spill workflow:
    `wf_trigger_deployed_ms7jfefo_input_spill`.
  - Run-input spill test run:
    `b9f67166-0c6f-4036-ad03-07501050c1bb`.
  - The deployed smoke created an old event payload artifact
    `wf_trigger_deployed_ms7jfefo_retention_payload_payload`, verified content
    route redaction before prune, pruned artifact files through the deployed
    runtime store, verified the physical file was gone, verified artifact
    metadata still appeared in run detail, and verified both content and
    download routes returned `artifact_not_found` after prune.
  - The same deployed smoke preserved existing trigger coverage:
    authenticated webhook run `7e0b729b-81a9-4a96-9d42-f3da9d1788dd`, public
    webhook run `3c31a5da-215a-4b2c-966a-ca7dd4422a77`, public path webhook
    run `d0a35222-f13b-4b7d-8853-0cdbe1f772ba`, scheduled dispatcher run
    `3c0eb582-456e-4123-8fcc-7f8beb470e4a`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow artifact retention HTTP admin route slice record:

- `POST /api/workflow-artifacts/prune` exposes the existing
  `WorkflowStore.pruneArtifactFiles({ createdBefore })` operation through the
  workflow HTTP API.
- The route accepts only an ISO datetime `createdBefore` body and returns the
  store's scanned, deleted, missing, and skipped-unsafe-path counters.
- The route deletes only physical artifact files selected by existing metadata
  and keeps workflow runs, step attempts, events, artifact metadata, and inline
  artifact references intact.
- After HTTP prune, run detail can still show artifact metadata, while artifact
  content and download routes return `artifact_not_found` for deleted files.
- This slice intentionally does not add an operator UI, scheduled retention
  job, retention policy config knob, or metadata deletion.

TDD note:

- The focused route test first created a large deployed-store artifact through
  a workflow test run, then required `POST /api/workflow-artifacts/prune` to
  delete the artifact file, preserve run detail metadata, and make content and
  download routes return `artifact_not_found`.
- Before implementation, the test failed with `404` on the new prune route.
- After implementation, the focused test passed and invalid prune body
  validation returned `400 invalid body`.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "prunes old workflow artifact files through an admin API route"`
  - failed before implementation because the route did not exist.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 32 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Main trigger workflow: `wf_trigger_deployed_ms7ko2gp`.
  - Manual trigger run: `fb8f0ad8-bc04-4f5a-b3ea-12790ad7e682`.
  - The deployed smoke verified the retention artifact content route before
    prune, pruned through the authenticated HTTP endpoint
    `/api/workflow-artifacts/prune`, received prune result
    `scannedArtifacts: 2`, `deletedFiles: 1`, `missingFiles: 1`,
    `skippedUnsafePaths: 0`, verified the physical file was gone, verified
    artifact metadata still appeared in run detail, and verified content and
    download routes returned `artifact_not_found` after prune.
  - The same deployed smoke preserved existing trigger coverage: authenticated
    webhook run `99807177-7e42-4414-8ffe-53433f547d5a`, public webhook run
    `19d418ca-3269-4edf-afe9-7baf3520ae5e`, public path webhook run
    `56c29f83-a09f-4521-8225-fc0481e81cc7`, scheduled dispatcher run
    `e27f024d-a77a-429f-a672-ec974a697d56`, invalid trigger/input guards, run
    filtering, pagination validation, and duplicate scheduled-scan guards.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow MCP cancel signal propagation slice record:

- HTTP-started workflow runs now create an in-process abort controller keyed by
  run id while `executeWorkflowRun` is active.
- `POST /api/workflow-runs/:id/cancel` still writes durable run and current
  step cancellation first, then aborts the in-flight controller when one exists.
- `WorkflowRunner` accepts an optional run `AbortSignal` and forwards it to
  `mcp.tool` port calls. Normal MCP calls receive a non-aborted signal; canceled
  in-flight calls observe `signal.aborted === true` after the cancel response.
- `WorkflowMcpRuntime` races MCP tool execution with the workflow signal and
  rejects promptly with `Workflow MCP canceled` when the signal aborts. Durable
  late-completion preservation still prevents post-cancel MCP output from being
  committed.
- This slice does not add low-level MCP transport kill guarantees, Python
  subprocess interruption through workflow cancel, agent-call interruption, or
  scheduled-dispatcher recovery after process restart.

TDD note:

- The focused route test first tightened the existing late-cancel scenario to
  require the MCP call request to include a signal and for that signal to become
  aborted after the real cancel endpoint returns.
- Before implementation, the test failed with `{ beforeCancel: null,
afterCancel: null }`, proving no signal reached the MCP port.
- After implementation, the focused test passed. The wider route suite then
  exposed the normal MCP trace expectation because successful MCP calls now
  include a non-aborted signal; the test was updated to assert that contract
  explicitly.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "preserves cancellation when execution finishes after cancel"`
  - failed before implementation because the MCP request had no signal.
  - passed after implementation and rebuilding `@openacme/workflows`, 1
    focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/ports.ts packages/workflows/src/runner.ts packages/server/src/routes/workflows.ts packages/server/src/workflow-mcp-runtime.ts packages/server/test/workflow-routes.test.ts docs/workflow-engine-plan.md`
  - passed.
- `pnpm exec prettier --write packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs packages/server/test/workflow-routes.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 19 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 29 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Seeded cancel workflow: `wf_cancel_deployed_ms7jtzvb`.
  - Seeded cancel run: `run_cancel_deployed_ms7jtzvb`.
  - Late-cancel workflow: `wf_cancel_late_deployed_ms7jtzvb`.
  - Late-cancel run: `2540a8ea-3865-4c17-a7ed-df508bce9bcb`.
  - The deployed smoke verified durable cancel state, redacted trigger/step
    input, event sequence `run_started`, `step_started`, `run_canceled`, and
    MCP signal states `{ beforeCancel: false, afterCancel: true }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow Python cancel subprocess slice record:

- `PythonExecutionRequest` now carries the optional workflow `AbortSignal`, and
  `WorkflowRunner` forwards the active run signal to `builtin.python` steps.
- `WorkflowPythonRuntime` watches that signal while the per-step subprocess is
  running. On abort it kills the subprocess with `SIGKILL` and rejects with
  `Workflow Python canceled`.
- The error includes best-effort stdout/stderr details from the process
  boundary. The current Python bootstrap redirects user stdout/stderr into
  in-process buffers and emits them at normal completion, so a killed process
  may have empty captured output even if user code printed before cancellation.
- Durable cancellation remains store-first. If the cancel route has already
  marked the run and current step `canceled`, late Python failure or output does
  not overwrite persisted cancel state.
- This slice does not add `agent.call` interruption, scheduled-dispatcher
  restart recovery, or UI-specific Python cancel controls beyond the existing
  run cancel action.

TDD note:

- The focused Python runtime test first started a real subprocess that slept
  for one second, aborted the workflow signal after 250ms, and required the
  runtime to reject before the subprocess could return `output = 'late'`.
- Before implementation, the test failed because the runtime ignored the
  signal and resolved with `{ output: "late" }`.
- After implementation, the runtime test passed. An intermediate assertion that
  expected redirected Python stdout to be captured on kill was corrected to the
  actual bootstrap boundary: canceled subprocesses return best-effort process
  stdout/stderr details, which can be empty.
- The route test for foreach/Python was tightened to prove normal Python port
  calls receive a non-aborted workflow signal.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-python-runtime.test.ts`
  - failed before implementation because the sleeping subprocess ignored abort
    and returned `late`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/ports.ts packages/workflows/src/runner.ts packages/server/src/workflow-python-runtime.ts packages/server/test/workflow-python-runtime.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 19 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 30 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Normal Python workflow: `wf_python_deployed_ms7k2px6`.
  - Normal Python run: `99cdc373-1a1f-4913-9522-a03b24e3662c`.
  - Python cancel workflow: `wf_python_deployed_ms7k2px6_cancel`.
  - Python cancel run: `120147e0-3eb9-4b50-b53f-8d55ebcf86be`.
  - The deployed smoke verified normal Python stdout/value/foreach trace,
    started a long-running Python subprocess, canceled the run through the real
    HTTP cancel route while `currentNodeId` was `py_sleep`, and verified both
    the immediate run response and persisted detail stayed `canceled` without
    the late `context.late` assignment.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow agent-call cancel signal propagation slice record:

- `AgentCallRequest` now carries the optional workflow `AbortSignal`, and
  `WorkflowRunner` forwards the active run signal to `agent.call` steps.
- `WorkflowAgentRuntime` forwards that signal into `AgentManager` through
  `callAgentFromWorkflow`.
- `AgentManager.askAgent` now combines the workflow signal with its existing
  timeout controller. A workflow cancel aborts the same signal used by memory
  recall and `agent.runStream`; timeout behavior remains unchanged.
- When the workflow signal cancels the agent call, the agent session records a
  failed assistant message with `agent_ask canceled by workflow`; durable
  workflow cancellation remains store-first and late agent output is not written
  back into workflow context.
- The deployed smoke harness for workflow agent calls now uses the same bounded
  close pattern as the cancel/Python smokes so a canceled slow stream cannot
  leave the smoke process waiting after success output.
- This slice does not add `agent.task` wait/resume, scheduled-dispatcher
  recovery after process restart, or a separate UI control beyond existing run
  cancel.

TDD note:

- The focused route test first added an `agent.call` workflow whose fake agent
  port called the real cancel endpoint while the step was in flight and then
  inspected the request signal.
- Before implementation, the focused test failed with `{ beforeCancel: null,
afterCancel: null }`, proving the agent port received no workflow signal.
- After implementation and rebuilding `@openacme/workflows`, the test passed
  with `{ beforeCancel: false, afterCancel: true }`.
- The normal agent-call route test was also tightened to assert successful
  calls receive a non-aborted signal.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "propagates cancellation to agent.call"`
  - failed before implementation because the agent request had no signal.
  - passed after implementation and `@openacme/workflows` build, 1 focused
    Vitest test.
- `pnpm exec prettier --write packages/tools/src/builtins/agent.ts packages/workflows/src/ports.ts packages/workflows/src/runner.ts packages/server/src/workflow-agent-runtime.ts packages/server/src/agent-manager.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-agent-deployed-smoke.mjs docs/workflow-engine-plan.md`
  - passed.
- `pnpm --filter @openacme/tools check-types` - passed.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 19 tests.
- `pnpm --filter @openacme/tools build` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 31 tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-agent-deployed-smoke.mjs`
  - initially proved the deployed behavior but the smoke process stayed open
    after success output; the harness was updated to use bounded
    `server.close()` and `closeApp()` waits.
  - passed with exit code 0 after the bounded-close fix against the isolated
    workflow data dir.
  - Normal agent workflow: `wf_agent_deployed_ms7kf565`.
  - Normal agent run: `b47695bc-54eb-4545-837c-578fdde0e92f`.
  - Agent cancel workflow: `wf_agent_deployed_ms7kf565_cancel`.
  - Agent cancel run: `9ef9abd5-a11f-45ea-bc5a-8f2fe947c9ba`.
  - The deployed smoke verified normal AgentManager-backed workflow agent
    output, started a slow stub-model agent call, canceled the workflow through
    the real HTTP cancel route while the agent step was current, and verified
    both immediate and persisted run detail stayed `canceled` without the late
    `context.support` assignment.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow `builtin.exit` canceled audit semantics slice record:

- `builtin.exit` now records the exit step attempt status from the declared
  exit status instead of marking every explicit exit step as `succeeded`.
- `status: "canceled"` exits now append a `run_canceled` audit event with
  message `Workflow run canceled`. `status: "failed"` exits map to
  `run_failed`, and `status: "succeeded"` exits map to `run_completed`.
- Persisted run detail now aligns the run status, selected exit step status,
  and terminal timeline event for explicit canceled exits.
- This slice does not change the existing HTTP cancel route, in-flight abort
  signal propagation, run-console UI controls, or branch/foreach semantics.

TDD note:

- The runner test first required a `builtin.exit` node with
  `status: "canceled"` to produce run status `canceled`, exit step status
  `canceled`, and event sequence `run_started`, `step_started`,
  `run_canceled`, `step_completed`.
- Before implementation, the test failed because the exit step was persisted as
  `succeeded`. The previous terminal event mapping also treated canceled exit
  as a completed run.
- After implementation, the runner test passed. The HTTP route test initially
  still saw the stale `@openacme/workflows` build and failed with a succeeded
  exit step; rebuilding `@openacme/workflows` made the persisted route boundary
  pass.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "records canceled exit as a run_canceled event"`
  - failed before implementation because the exit step stayed `succeeded`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "persists canceled builtin.exit"`
  - failed before rebuilding `@openacme/workflows` because the server boundary
    used the stale workflow build.
  - passed after `@openacme/workflows` build, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 20 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 33 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Existing cancel workflow: `wf_cancel_deployed_ms7kxl4p`.
  - Late-cancel workflow: `wf_cancel_late_deployed_ms7kxl4p`.
  - Exit-canceled workflow: `wf_exit_canceled_deployed_ms7kxl4p`.
  - Exit-canceled run: `67d48190-2699-463f-9803-8d7e8a767f0f`.
  - The deployed smoke verified explicit `builtin.exit` canceled output through
    the real HTTP run path, then reloaded persisted run detail and confirmed
    run status `canceled`, exit step status `canceled`, and event sequence
    `run_started`, `step_started`, `run_canceled`, `step_completed`.
  - The same deployed smoke preserved existing durable cancel and late MCP
    cancel signal coverage, including signal state `{ beforeCancel: false,
afterCancel: true }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow `builtin.exit` failed step event semantics slice record:

- Explicit `builtin.exit` steps with `status: "failed"` now persist a failed
  exit step and append a `step_failed` audit event instead of ending the step
  with `step_completed`.
- The failed exit still writes the run-level `run_failed` terminal event from
  the exit card. The step-level terminal event now matches the persisted step
  status, so run detail and timeline filters agree.
- Non-failed explicit exits keep the existing step terminal behavior:
  `status: "succeeded"` and `status: "canceled"` still append
  `step_completed` with the corresponding status payload.
- This slice does not change runtime exception handling, HTTP cancel behavior,
  branch execution, or the run-console UI.

TDD note:

- The runner test first required `builtin.exit status: "failed"` to produce run
  status `failed`, exit step status `failed`, and event sequence
  `run_started`, `step_started`, `run_failed`, `step_failed`.
- Before implementation, the runner test failed because the final step event
  was `step_completed`.
- The HTTP route test then locked the same persisted detail boundary. Before
  rebuilding `@openacme/workflows`, it failed at the server boundary for the
  same stale `step_completed` event; after rebuild it passed.

Focused validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts -t "records failed exit as a step_failed audit event"`
  - failed before implementation because the failed exit wrote
    `step_completed`.
  - passed after implementation, 1 focused Vitest test.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "persists failed builtin.exit"`
  - failed before `@openacme/workflows` rebuild because the server boundary saw
    the stale `step_completed` event.
  - passed after rebuild, 1 focused Vitest test.
- `pnpm exec prettier --write packages/workflows/src/runner.ts packages/workflows/test/runner.test.ts packages/server/test/workflow-routes.test.ts packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed.
- `pnpm --filter @openacme/workflows test -- runner.test.ts`
  - passed, 21 tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 34 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-cancel-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Existing cancel workflow: `wf_cancel_deployed_ms7l4hv4`.
  - Late-cancel workflow: `wf_cancel_late_deployed_ms7l4hv4`.
  - Exit-canceled workflow: `wf_exit_canceled_deployed_ms7l4hv4`.
  - Exit-failed workflow: `wf_exit_failed_deployed_ms7l4hv4`.
  - Exit-failed run: `91dc9e3f-82e9-497c-9765-78f3e4efed02`.
  - The deployed smoke verified explicit `builtin.exit` failed output through
    the real HTTP run path, then reloaded persisted run detail and confirmed
    run status `failed`, exit step status `failed`, and event sequence
    `run_started`, `step_started`, `run_failed`, `step_failed`.
  - The same deployed smoke preserved explicit canceled exit coverage, durable
    cancel coverage, and late MCP cancel signal coverage.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Run Console pruned artifact UX and step-start artifact persistence slice record:

- Artifact content load failures now map the durable
  `artifact_not_found` API error to the operator-facing
  `Artifact unavailable` message in both global `/workflow-runs` and
  workflow-scoped `/workflows` JSON blocks.
- The JSON block keeps the original artifact reference visible after load
  failure, so retrospective run detail still shows artifact metadata and the
  missing content state rather than replacing the trace with a raw route error.
- The deployed smoke exposed a persistence-order edge case: a large
  `step_started` event payload can spill to a workflow artifact before the
  running step attempt row exists. Server event persistence now creates/updates
  the running step attempt from `step_started` before appending the event, so
  spilled event artifact metadata can safely retain `step_run_id`.
- This slice does not change artifact retention policy, prune eligibility,
  download semantics, redaction rules, or the stored `artifact_not_found` API
  contract.

TDD note:

- The first focused global run JSON block Playwright test used a mocked
  artifact content route and failed before implementation because the UI showed
  raw `artifact_not_found`.
- After the UI mapping fix, the focused test still failed until the web bundle
  was rebuilt; the built Playwright harness serves `apps/web/out`, not the
  source route directly.
- The first deployed real-API Playwright fixture used MCP echo with a large
  node input/output and failed at run creation with
  `FOREIGN KEY constraint failed`. That locked the server regression: spilled
  step-start event artifacts need the step attempt row before event append.
- After reordering event persistence and adding a server route regression test,
  the same MCP-backed deployed UI smoke passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts`
  - passed.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts -t "spills large workflow step outputs|persists spilled step-start payload artifacts|prunes workflow artifact files"`
  - passed, 2 focused artifact tests matched.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
  - passed, 35 tests.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-YB2XJAdf.js` and `workflows-Bk2-IKCS.js`.

Deployed UI validation:

- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "shows unavailable artifact errors"`
  - failed before the UI mapping fix because the global Run Console JSON block
    rendered raw `artifact_not_found`.
  - passed after rebuilding the web bundle.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "shows pruned artifact errors|shows unavailable artifact errors|loads artifact content"`
  - passed, 3 Chromium tests.
  - The deployed Playwright harness booted built server dist plus built web
    bundle, created an MCP echo workflow through the real HTTP API, ran it with
    large step input/output, verified step output artifact metadata, pruned
    artifact files through `POST /api/workflow-artifacts/prune`, confirmed the
    artifact content route returned `404 { error: "artifact_not_found" }`, and
    opened `/workflow-runs?run=<runId>` to verify `Artifact unavailable`
    without exposing the raw secret value.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 10 Chromium tests.
  - This preserved older-page loading, non-terminal auto-refresh, artifact
    load/download UI, pruned artifact UI, filter refresh, cancel selection,
    loaded-page stability after cancel/rerun, failed-run filtering, detail
    inspection, redaction, timeline filtering, and rerun behavior.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7lo3dj`.
  - Manual run: `835567dd-aa2d-4c32-a5fa-0a7c4ebb97d5`.
  - Run input spill workflow: `wf_trigger_deployed_ms7lo3dj_input_spill`.
  - Run input spill run: `560a1b50-e6c0-420f-bdf6-68c6d319b58a`.
  - Webhook run: `77189cf4-0bef-408a-aca2-9e56ee6b7750`.
  - Public webhook run: `3c7033f6-be0b-418e-95b3-c8f6d560d939`.
  - Scheduled run: `99d03017-53df-460d-929c-20a9423d35f9`.
  - Artifact prune result:
    `{ scannedArtifacts: 3, deletedFiles: 1, missingFiles: 2, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Workflow-scoped pruned artifact Run Console validation slice record:

- The workflow-scoped `/workflows` Run Console now has real-API deployed
  Playwright coverage for the same pruned artifact behavior as global
  `/workflow-runs`.
- The smoke creates a workflow through HTTP, runs an MCP step with large
  input/output so the selected step output spills to an artifact, prunes files
  through `POST /api/workflow-artifacts/prune`, confirms the artifact content
  route returns `404 { error: "artifact_not_found" }`, then opens
  `/workflows?id=<workflowId>&run=<runId>` and verifies the selected
  `Output JSON` block shows `Artifact unavailable` while keeping the artifact
  id visible.
- This slice intentionally adds coverage only. It does not change the shared
  JSON block implementation, artifact route contract, prune policy, download
  behavior, or workflow-scoped run selection rules.

TDD note:

- The new Playwright test was added before any product-code edit and passed
  against the current shared `artifactErrorMessage` implementation, proving the
  remaining gap was deployed workflow-scoped coverage rather than behavior.
- The test uses the built server/web harness and real HTTP APIs instead of
  mocked routes, so it exercises the runtime/store artifact spill, prune route,
  run detail reload, and workflow-scoped Run Console rendering together.

Focused validation:

- `pnpm exec prettier --write apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "shows pruned artifact errors"`
  - passed, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-YB2XJAdf.js` and `workflows-Bk2-IKCS.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 11 Chromium tests.
  - This preserved workflow run ownership guards, older-page loading,
    workflow-scoped pruned artifact UX, non-terminal auto-refresh, cancel
    selection, loaded-page stability after cancel/rerun/test run/trigger run,
    disabled external-node inventory behavior, and the full manual trigger
    editor/run-console smoke.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7lvxw6`.
  - Manual run: `1d8353c7-ce84-4c11-b339-72d52e2f8e05`.
  - Run input spill workflow: `wf_trigger_deployed_ms7lvxw6_input_spill`.
  - Run input spill run: `b8a91e7c-1c2e-4243-9c39-ea2b645ccabe`.
  - Webhook run: `364c832d-c383-4db1-9039-becbeafb4af5`.
  - Public webhook run: `4b3bb56e-598a-4b35-8801-fb60fe0a7beb`.
  - Scheduled run: `8ca405c9-6627-4097-a5fe-b3670cb69901`.
  - Artifact prune result:
    `{ scannedArtifacts: 4, deletedFiles: 1, missingFiles: 3, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.

Workflow-scoped Run Console history filters slice record:

- The workflow-scoped `/workflows` Run Console now exposes URL-backed history
  filters for run mode, status, trigger id, created-from date, and created-to
  date.
- The filters are sent to `GET /api/workflows/:id/runs`, so the scoped console
  uses the same server-side filtering semantics as the global run history
  surface while keeping workflow ownership scoped to the selected definition.
- Selecting a run, loading a run detail, rerunning, canceling, running a test,
  or firing a trigger preserves the active filter set in the URL.
- Newly reconciled run rows are inserted only when they match the active scoped
  filters. For example, a newly succeeded test run will not reappear in a
  `status=failed` history view after a detail refresh.
- This slice intentionally does not add new server filter semantics, saved
  filter presets, scheduled-trigger UI changes, or global `/workflow-runs`
  behavior changes.

TDD note:

- The focused Playwright test was added before the product-code edit and failed
  because the workflow-scoped Run Console did not expose a `Status` filter
  combobox yet.
- After adding the scoped controls, URL search plumbing, filtered API calls, and
  filter-aware list reconciliation, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-C9L85PWC.js` and `workflows-CGhavB_t.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "filters workflow-scoped run console history"`
  - first run failed as expected before implementation because the `Status`
    combobox was missing.
  - passed after implementation, 1 Chromium test.
  - The focused Playwright run is the deployed UI proof for this operator
    slice: `apps/web/playwright.config.ts` boots
    `packages/server/test/e2e/support/boot-web.mjs`, which runs the built
    server dist plus the built web bundle on `127.0.0.1:3998` before the test
    creates real workflow runs through HTTP and verifies the scoped Run Console
    filter controls in the browser.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 12 Chromium tests.
  - This preserved workflow run ownership guards, older-page loading,
    workflow-scoped pruned artifact UX, scoped history filtering,
    non-terminal auto-refresh, cancel selection, loaded-page stability after
    cancel/rerun/test run/trigger run, disabled external-node inventory
    behavior, and the full manual trigger editor/run-console smoke.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7maf6s`.
  - Manual live run: `8ef6ceb5-703b-47c1-98f9-ed2b3cca8bda`.
  - Run input spill workflow: `wf_trigger_deployed_ms7maf6s_input_spill`.
  - Run input spill run: `cf55c724-5468-40c4-b6e2-b2fac701d5e0`.
  - Webhook run: `32cd953f-3a48-4694-b317-679e326ca1e2`.
  - Public webhook run: `d3c6ed64-2d6e-4aac-b440-42f98958c781`.
  - Public webhook path run:
    `4b1c4983-d5cb-480c-b2e7-230dc5f079e0`.
  - Scheduled run: `0ae4bde8-3741-4b1d-a718-e16b5c1ec549`.
  - Artifact prune result:
    `{ scannedArtifacts: 5, deletedFiles: 1, missingFiles: 4, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Deployed UI validation addendum:

- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "filters workflow-scoped run console history"`
  - reran after the documentation audit and passed, 1 Chromium test.
  - This closes the Milestone 4 UI/operator validation gap for the scoped
    history filter slice by proving the behavior against the built server/web
    harness rather than relying only on the `~/.openacme-the-workflow` server
    smoke.

Run Console timeline filtered empty-state slice record:

- Global `/workflow-runs` and workflow-scoped `/workflows` Run Console timeline
  panels now render a filter-aware empty state when the selected timeline level
  has no matching events.
- The default all-level view still renders `No events`. Filtered views render
  the selected level explicitly, for example `No error events`.
- This avoids an operator ambiguity during run investigation: an empty filtered
  timeline now reads as "no events at this level" rather than "the run has no
  timeline."
- This slice intentionally does not change event storage, event ordering, run
  detail polling, timeline level options, or URL state for the timeline filter.

TDD note:

- The focused global Playwright test was updated first and failed because the
  deployed UI still rendered only the generic empty state.
- After adding `timelineEmptyMessage` to both Run Console routes and rebuilding
  the web bundle, the same focused global test passed. The workflow-scoped
  focused test also passed against the built harness.
- One parallel validation attempt failed with `EADDRINUSE` because two
  Playwright web servers tried to bind `127.0.0.1:3998`; the tests were then
  rerun serially.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-rxztvU-F.js` and `workflows-CU-uubO9.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "auto-refreshes non-terminal global run details"`
  - failed before the rebuild because the built UI still lacked the new empty
    state.
  - passed after rebuild, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "auto-refreshes non-terminal workflow run console details"`
  - passed, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 10 Chromium tests.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 12 Chromium tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7mmi18`.
  - Manual live run: `2217c4fa-97ff-4615-ad76-051010f366bb`.
  - Run input spill workflow: `wf_trigger_deployed_ms7mmi18_input_spill`.
  - Run input spill run: `2f790a38-1d0b-47f5-9596-f7dce642b637`.
  - Webhook run: `02aac502-ebfb-488c-844c-c37484728cf3`.
  - Public webhook run: `71edeb49-e141-4212-b3ce-2355e1d3d0c1`.
  - Public webhook path run:
    `22d9547e-6cb1-4342-8c4c-2831bbfeafee`.
  - Scheduled run: `4ccf17a6-0fe3-4b46-a7f7-bd630acbd341`.
  - Artifact prune result:
    `{ scannedArtifacts: 6, deletedFiles: 1, missingFiles: 5, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Run Console trigger-aware detail header slice record:

- Global `/workflow-runs` and workflow-scoped `/workflows` Run Console detail
  headers now expose the persisted run trigger id alongside duration, source,
  start/end time, current node, and waiting reason.
- The detail header section is now explicitly addressable as `Run detail
header`, so tests and future UI automation can verify the operator-facing run
  summary without matching incidental history rows or raw JSON disclosures.
- The global header continues to show the resolved workflow name from the
  workflow list. The workflow-scoped header now receives the selected workflow
  name from the parent route so the header remains self-contained inside the
  Run Console.
- This slice intentionally does not change trigger storage, trigger snapshot
  redaction, run history row rendering, raw Trigger JSON, or run list filters.

TDD note:

- The focused global Playwright test was updated before product-code changes
  and failed because no accessible `Run detail header` region existed.
- After adding the accessible detail header and `trigger <id>` metadata, the
  same focused global test passed.
- The first scoped focused rerun used the wrong seeded workflow-name
  expectation; after correcting the test to the actual fixture workflow name,
  the scoped smoke passed and verified `trigger manual_review` in the header.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-C5XovrPz.js` and `workflows-BKfMuGB8.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "filters global workflow run history and opens failed run details"`
  - failed before implementation because `Run detail header` was missing.
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after correcting the fixture name expectation, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 10 Chromium tests.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 12 Chromium tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7mxnby`.
  - Manual live run: `a5662bc9-7782-486a-bce4-124c56f43919`.
  - Run input spill workflow: `wf_trigger_deployed_ms7mxnby_input_spill`.
  - Run input spill run: `4f3f76f0-c101-4793-9383-2c9ed5bacf22`.
  - Webhook run: `fc31d2f4-d249-4cd7-b658-7ee7ef9843d4`.
  - Public webhook run: `ac423288-32c3-4c48-ad69-351ab786e7b3`.
  - Public webhook path run:
    `5f5bfabf-37b4-430a-99f1-1c27814d37d7`.
  - Scheduled run: `89668144-1d68-4907-8c95-ebd45cc47c2c`.
  - Artifact prune result:
    `{ scannedArtifacts: 7, deletedFiles: 1, missingFiles: 6, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.

Run Console step retry-count rail slice record:

- Global `/workflow-runs` and workflow-scoped `/workflows` Run Console step
  rails now show explicit retry count per step attempt.
- Retry count is derived from persisted attempt number as `max(attempt - 1, 0)`.
  First attempts render `retry 0`; later attempts will render their completed
  retry count without changing the underlying run or step attempt schema.
- This closes the Run Console rail requirement that step rows show status,
  duration, retry count, and selected/skipped branch state.
- This slice intentionally does not change retry execution policy, runner
  attempt numbering, step metadata, selected-step detail, event storage, or raw
  JSON disclosures.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed server smoke used `OPENACME_PORT=3458`. Port `3456` was not used for
  this slice; an existing `apps/cli/dist/index.js __serve` listener was observed
  there and left untouched.

TDD note:

- The focused global Playwright test was updated first and failed because the
  step rail still rendered `try 1` instead of `retry 0`.
- After adding `stepRetryCount` to both Run Console routes and rebuilding the
  web bundle, the same focused global test passed.
- The first scoped focused rerun showed that the row was correctly rendered as
  `log_customer retry 0 ... succeeded`; the test regex was too strict about
  whitespace and was corrected before the scoped test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflow-runs.tsx apps/web/app/routes/workflows.tsx apps/web/e2e/workflow-runs.spec.ts apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-BQGJOAFI.js` and `workflows-DPUfVsVB.js`.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts -g "filters global workflow run history and opens failed run details"`
  - failed before implementation because no row matched
    `missing_customer ... retry 0 ... failed`.
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after correcting the scoped regex, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts`
  - passed, 10 Chromium tests.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 12 Chromium tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7n75c9`.
  - Manual live run: `ec821b9b-e608-4a4c-92bf-a75e6de7ad1b`.
  - Run input spill workflow: `wf_trigger_deployed_ms7n75c9_input_spill`.
  - Run input spill run: `e3dbe578-dbba-44cf-9454-72b9c121506c`.
  - Webhook run: `54a70d1b-c1ee-450b-9ec7-fe3fa9f44da6`.
  - Public webhook run: `be8c40c7-9d0d-423b-862f-5502cca95acc`.
  - Public webhook path run:
    `50f117ef-7abe-45fd-a283-0179bcdd32e5`.
  - Scheduled run: `3b49f883-9da0-4aa8-ae3d-b2c6e837b0d0`.
  - Artifact prune result:
    `{ scannedArtifacts: 8, deletedFiles: 1, missingFiles: 7, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow-scoped empty step rail slice record:

- Workflow-scoped `/workflows` Run Console now renders `No step attempts` when
  a selected run detail contains no persisted step attempts.
- This matches the existing global `/workflow-runs` empty state and keeps the
  scoped console explicit for queued, synthetic, or partially recorded run
  details instead of showing a blank step rail.
- This slice intentionally does not change run detail APIs, step attempt
  persistence, selected-step resolution, global Run Console rendering, event
  empty states, or no-run history empty states.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed server smoke used `OPENACME_PORT=3458`. Port `3456` was not used for
  this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The focused workflow-scoped Playwright test was added first and failed
  because the scoped step rail rendered no empty-state text for an empty
  `steps` array.
- After adding the scoped `No step attempts` branch and rebuilding the web
  bundle, the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DaHic7Kt.js` and `workflows-01U8nrXw.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "shows empty workflow run console step rail"`
  - failed before implementation because `No step attempts` was missing.
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7neava`.
  - Manual live run: `d813483c-a145-4810-878c-04d0f856a581`.
  - Run input spill workflow: `wf_trigger_deployed_ms7neava_input_spill`.
  - Run input spill run: `267615f8-4ecf-4c0a-9bd7-1f06b4c16d23`.
  - Webhook run: `8890219d-163c-4f86-abe7-d697e5e46e5a`.
  - Public webhook run: `295955d9-02f5-4d91-91cc-22501aef47e9`.
  - Public webhook path run:
    `0c6e88c5-7b9b-43d9-b7b2-030141366de0`.
  - Scheduled run: `d7ac60e6-673b-4c6a-ad72-da7f72ced78d`.
  - Artifact prune result:
    `{ scannedArtifacts: 9, deletedFiles: 1, missingFiles: 8, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow-scoped selected-step empty-state parity slice record:

- Workflow-scoped `/workflows` Run Console now renders the `Selected Step`
  section whenever a run detail is loaded, even when no persisted step attempt
  is selected.
- Empty step details now show `No selected step`, matching the global
  `/workflow-runs` Run Console behavior and keeping the required selected-step
  detail panel explicit for queued, synthetic, or partially recorded run
  details.
- This slice intentionally does not change run detail APIs, step attempt
  persistence, selected-step resolution, global Run Console rendering, timeline
  empty states, retry-count rows, or run history filters.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed server smoke used `OPENACME_PORT=3458`. Port `3456` was not used for
  this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The focused workflow-scoped Playwright expectation was changed first and
  failed because the scoped Run Console did not render `No selected step` when
  `steps` was empty.
- After rendering the selected-step section with an empty-state fallback in the
  workflow-scoped console and rebuilding the web bundle, the same focused test
  passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-KaVoNMJ2.js` and `workflows-Cvd1Vpl5.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "shows empty workflow run console step rail"`
  - failed before implementation because `No selected step` was missing.
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7nm4y0`.
  - Manual live run: `4e7c318a-a905-49db-b740-303e6cbfcf7a`.
  - Run input spill workflow: `wf_trigger_deployed_ms7nm4y0_input_spill`.
  - Run input spill run: `f0ecc12e-697d-4aca-8f40-a18b08a4fc0f`.
  - Webhook run: `370457ea-7c44-4600-a575-b04252191351`.
  - Public webhook run: `6a5979db-6743-42cd-9c9f-8f73879bd5a8`.
  - Public webhook path run:
    `7b569a38-e4d8-4ef6-a96c-dae9e003fce5`.
  - Scheduled run: `958349ac-2263-4b25-9a26-14a60b35a0ff`.
  - Artifact prune result:
    `{ scannedArtifacts: 10, deletedFiles: 1, missingFiles: 9, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow-scoped Run Console history status badge slice record:

- Workflow-scoped `/workflows` Run Console history rows now render the run
  status badge next to the existing test/live mode badge.
- This aligns scoped history rows with the global `/workflow-runs` history rows
  and makes failed, succeeded, running, canceled, waiting, and queued runs
  directly scannable after filtering without relying on the selected detail
  header.
- This slice intentionally does not change run-list APIs, persisted run status
  semantics, global history rendering, filter query behavior, selected-step
  rendering, timeline rendering, or trigger labels.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed server smoke used `OPENACME_PORT=3458`. Port `3456` was not used for
  this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The focused workflow-scoped filter smoke expectation was changed first and
  failed because the filtered failed run row rendered `test`, timestamp, id,
  trigger, version, and source, but not `failed`.
- After adding the scoped run-row status badge and rebuilding the web bundle,
  the same focused test passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-DFzR73ZT.js` and `workflows-CzfO_QF9.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "filters workflow-scoped run console history"`
  - failed before implementation because the scoped history row did not include
    `failed`.
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed server validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_trigger_deployed_ms7nsrhe`.
  - Manual live run: `8042f26e-14cb-4535-9185-d9b34dc0f149`.
  - Run input spill workflow: `wf_trigger_deployed_ms7nsrhe_input_spill`.
  - Run input spill run: `0ec5bf80-d259-4e72-ab2d-cb2b562e2782`.
  - Webhook run: `a11432c2-e93d-4fe8-8b03-e488d6c646cd`.
  - Public webhook run: `12356aac-82c6-4a44-bb6d-5a69b441e19e`.
  - Public webhook path run:
    `37d4ecc4-28c2-41db-a6ae-4ffd8b18f144`.
  - Scheduled run: `0acf0614-f44f-463c-ab83-d78b5b818526`.
  - Artifact prune result:
    `{ scannedArtifacts: 11, deletedFiles: 1, missingFiles: 10, skippedUnsafePaths: 0 }`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Agent call timeout upper-bound hardening slice record:

- `agent.call.timeoutMs` is now bounded at `300000` milliseconds in the
  workflow DSL schema, matching the existing MCP and Python external-step
  timeout ceiling.
- The `/workflows` card editor applies the same upper bound when editing agent
  timeout values. Oversized values are not written into the canonical `Nodes
JSON`; the editor follows the existing invalid-timeout behavior and removes
  the optional `timeoutMs` field instead of persisting an unsafe value.
- This keeps synchronous workflow agent calls bounded at the definition/API
  boundary before runtime execution reaches `AgentCallPort`.
- This slice intentionally does not change default agent timeout behavior,
  `AgentManager` timeout internals, MCP/Python timeout rules, persisted run
  trace shape, cancellation propagation, or deployed agent smoke semantics.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed agent smoke used `OPENACME_PORT=3458`. Port `3456` was not used for
  this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The focused workflow schema test was added first and failed because
  `WorkflowNodeSchema` accepted `agent.call.timeoutMs: 300001`.
- The focused workflow UI test was tightened before implementation and failed
  because entering `600000` in the agent timeout field wrote that oversized
  value into `Nodes JSON`.
- After adding the schema max and reusing the same max in the UI timeout parser,
  both focused tests passed.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/schemas.ts packages/workflows/test/schemas.test.ts apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts -t "bounds agent call timeout values"`
  - failed before implementation because `300001` was accepted.
  - passed after implementation, 1 Vitest test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because `600000` was written into `Nodes JSON`.
  - passed after implementation and rebuilt web output, 1 Chromium test.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 11 Vitest tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-CdQom3KR.js` and `workflows-DDZ0UMEQ.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed agent validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-agent-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_agent_deployed_ms7o2yqb`.
  - Agent run: `f091c4ed-b158-4c37-b634-254e838ee9f8`.
  - Run status: `succeeded`.
  - Agent response: `deployed workflow support ok`.
  - Linked agent session id: `734f215a-7c5a-4eaf-bab8-71d184f84f98`.
  - Agent cancel workflow: `wf_agent_deployed_ms7o2yqb_cancel`.
  - Agent cancel run: `42952c1e-f6e2-4d0d-9d9b-1f77d0535f10`.
  - Agent cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Foreach concurrency definition-bound hardening slice record:

- `builtin.foreach.concurrency` is now bounded to the current M7 sequential
  runtime cap at the workflow DSL schema boundary. Definitions can omit
  `concurrency` or set `1`; values above `1` are rejected before persistence or
  run creation.
- The `/workflows` card editor applies the same cap when editing foreach
  concurrency. Oversized values are not written into canonical `Nodes JSON`;
  the editor follows the existing invalid numeric-field behavior and removes
  the optional `concurrency` field.
- This aligns the API/UI definition boundary with the existing runner contract:
  M7 supports observable sequential iteration only, and future parallel
  scheduling must be introduced by an explicit later slice.
- This slice intentionally does not change foreach runtime execution,
  per-item attempt numbering, item variable resolution, Python subprocess
  behavior, cancellation semantics, or deployed Python smoke workflow shape.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The focused workflow schema test was added first and failed because
  `WorkflowNodeSchema` accepted `builtin.foreach.concurrency: 2`.
- The focused workflow UI test was tightened before implementation and failed
  because entering `2` in the foreach concurrency field wrote that value into
  `Nodes JSON`.
- After adding `max(1)` to the schema and applying the same upper bound in the
  UI editor, both focused tests passed.

Focused validation:

- `pnpm exec prettier --write packages/workflows/src/schemas.ts packages/workflows/test/schemas.test.ts apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts -t "bounds foreach concurrency"`
  - failed before implementation because `concurrency: 2` was accepted.
  - passed after implementation, 1 Vitest test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because `2` was written into `Nodes JSON`.
  - passed after implementation and rebuilt web output, 1 Chromium test.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types` - passed.
- `pnpm --filter web check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/workflows build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `pnpm --filter web build` - passed; produced
  `workflow-runs-Xb0XyLRg.js` and `workflows-r1DfUDiI.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code 0 against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7o9nmg`.
  - Run: `ac2dc308-3b14-4ff7-9885-9b74e6ec66e8`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7o9nmg_cancel`.
  - Python cancel run: `b6c2ee8e-2963-4860-9a24-cd234795851c`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Python timeout UI definition-bound hardening slice record:

- `builtin.python.timeoutMs` was already bounded at `300000` milliseconds in
  the workflow schema. The `/workflows` card editor now applies the same upper
  bound while editing Python cards.
- Oversized Python timeout values are not written into canonical `Nodes JSON`;
  the editor follows the existing invalid-timeout behavior and removes the
  optional `timeoutMs` field.
- This keeps Python timeout authoring aligned with the MCP and agent timeout
  editor guards and prevents UI-authored drafts from carrying values the
  schema rejects.
- This slice intentionally does not change Python runtime defaults,
  subprocess lifecycle, cancellation, or persisted run trace semantics.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after a valid
  `python_10 python timeout` write, it fills `600000` and expects canonical
  `Nodes JSON` to remove `timeoutMs`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because entering `600000` wrote that
    oversized value into `Nodes JSON`.
- After reusing `parseOptionalTimeoutMs(value, 100, 300_000)` in the Python
  card updater and rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-uNq7cmsv.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7oig10`.
  - Run: `f8a39967-cb9c-46b8-be73-a9ea2a59c681`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7oig10_cancel`.
  - Python cancel run: `c8e2d89b-e6a1-48ff-8b88-117591bf9acb`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Assignment target UI schema-bound hardening slice record:

- Workflow assignment paths are schema-bound dotted context paths, such as
  `customer` or `customer.id`. The `/workflows` structured assignment target
  editor now applies the same path rule before mutating canonical `Nodes JSON`.
- Invalid structured assignment target edits, such as `normalized customer`,
  are ignored instead of producing a draft that the workflow schema rejects.
- This keeps the card editor aligned with `WorkflowAssignmentPathSchema` while
  preserving raw JSON editing as the explicit escape hatch for direct schema
  validation feedback.
- This slice intentionally does not change assignment source expressions,
  assignment modes, multi-assignment editing, runtime assignment behavior, or
  persisted context diff semantics.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after renaming the
  transform card assignment target to valid `normalizedCustomer`, it tries
  invalid `normalized customer` and expects canonical `Nodes JSON` to keep the
  valid target.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the invalid target was written into
    `Nodes JSON`.
- After adding the assignment target pattern guard to the structured editor and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-C54gR1qW.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7opksq`.
  - Run: `f57756f4-6bdc-411b-bfc7-c7e828dbc920`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7opksq_cancel`.
  - Python cancel run: `ab30d9cf-3516-487e-a931-a7e462902418`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Assignment source UI schema-bound hardening slice record:

- Workflow assignment values require a non-empty source expression. The
  `/workflows` structured assignment source editor now preserves the previous
  source when an operator clears the field instead of mutating canonical
  `Nodes JSON` to an empty string.
- This keeps structured assignment editing aligned with
  `WorkflowAssignmentValueSchema` while preserving raw JSON editing as the
  explicit path for direct schema validation feedback.
- This slice intentionally does not change assignment target validation,
  assignment mode semantics, expression resolution, runtime assignment
  behavior, or persisted context diff semantics.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `normalize assignment source` to valid `$.steps.normalize.output.value`, it
  clears the source field and expects canonical `Nodes JSON` to keep the valid
  source.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty source was written into
    `Nodes JSON`.
- After adding the empty-source guard to the structured editor and rebuilding
  the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-SbmtvamL.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7ovt6e`.
  - Run: `03cad880-6eee-43a4-9c20-e1e5e7b9ec84`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7ovt6e_cancel`.
  - Python cancel run: `7e1b25b4-2473-4666-8560-48aa5d68b3ef`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Branch condition UI schema-bound hardening slice record:

- `builtin.if.condition` and `builtin.if_else.condition` are schema-bound
  non-empty strings. The `/workflows` structured branch condition editor now
  preserves the previous condition when an operator clears the field instead of
  mutating canonical `Nodes JSON` to an empty string.
- This keeps branch card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change branch expression parsing, branch
  target reference validation, skipped-step semantics, runtime branch
  selection, or persisted branch metadata.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `if_else_07 branch condition` to valid `$.input.customer.riskScore >= 70`,
  it clears the condition field and expects canonical `Nodes JSON` to keep the
  valid condition.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty condition was written into
    `Nodes JSON`.
- After adding the empty-condition guard to the structured editor and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-CylWjWdd.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7p2iz7`.
  - Run: `a50fdead-bf43-4123-8d8d-781e4aa372d9`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7p2iz7_cancel`.
  - Python cancel run: `cae5c12b-b60e-41e5-b9d8-ea4e631b6588`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Log message UI schema-bound hardening slice record:

- `builtin.log.info`, `builtin.log.debug`, and `builtin.log.error` require a
  non-empty `message` in the workflow node schema. The `/workflows` structured
  log message editor now preserves the previous message when an operator clears
  the field instead of mutating canonical `Nodes JSON` to an empty string.
- This keeps log card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change log level selection, log payload
  editing, runtime log event persistence, assignment behavior, or run-console
  log rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `log_07 log message` to valid `Manual review failed`, it clears the message
  field and expects canonical `Nodes JSON` to keep the valid message.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty message was written into
    `Nodes JSON`.
- After adding the empty-message guard to the structured editor and rebuilding
  the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-Dj-vxTV3.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7p8ksv`.
  - Run: `f5a63306-1d2d-49e8-a05f-f92016dfcd8b`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7p8ksv_cancel`.
  - Python cancel run: `96c83e94-911d-4e9a-8e11-fb0022fa6ee8`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Python code UI schema-bound hardening slice record:

- `builtin.python.code` requires a non-empty string in the workflow node schema.
  The `/workflows` structured Python code editor now preserves the previous code
  when an operator clears the field instead of mutating canonical `Nodes JSON`
  to an empty string.
- This keeps Python card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change Python runtime execution,
  subprocess isolation, timeout/cancel behavior, reset semantics, stdout/stderr
  capture, or persisted Python step output.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `python_10 python code` to valid `output = {'name': input.get('name')}`, it
  clears the code field and expects canonical `Nodes JSON` to keep the valid
  code.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty code was written into
    `Nodes JSON`.
- After adding the empty-code guard to the structured editor and rebuilding the
  web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-C2kF8euP.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7peg2e`.
  - Run: `fa6bd76a-4f0d-4643-a626-92ceceda1d6e`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7peg2e_cancel`.
  - Python cancel run: `a8892ea2-f42d-4f1c-a38b-784cc6afa415`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Agent prompt UI schema-bound hardening slice record:

- `agent.call.prompt` requires a non-empty string in the workflow node schema.
  The `/workflows` structured agent prompt editor now preserves the previous
  prompt when an operator clears the field instead of mutating canonical
  `Nodes JSON` to an empty string.
- This keeps agent card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change agent selection, timeout semantics,
  context path handling, runtime agent dispatch, persisted step output, or
  run-console rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `agent_review agent prompt` to valid `Review normalized customer`, it clears
  the prompt field and expects canonical `Nodes JSON` to keep the valid prompt.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty prompt was written into
    `Nodes JSON`.
- After adding the empty-prompt guard to the structured editor and rebuilding
  the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-D-Y8xCx6.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7pl0q5`.
  - Run: `1fe31ed6-6c87-4e65-a2e3-cd93d8609ece`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7pl0q5_cancel`.
  - Python cancel run: `8370384b-c77c-4632-9a6d-c54d17a2d909`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

MCP server/tool UI schema-bound hardening slice record:

- `mcp.tool.server` and `mcp.tool.tool` require non-empty strings in the
  workflow node schema. The `/workflows` structured MCP tool editor now
  preserves the previous server/tool value when an operator clears either field
  instead of mutating canonical `Nodes JSON` to an empty string.
- This keeps MCP card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change MCP tool discovery, picker
  selection, schema-derived input editing, timeout semantics, runtime MCP
  dispatch, persisted step output, or run-console rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `mcp_echo MCP server` to valid `qa` and `mcp_echo MCP tool` to valid
  `lookup`, it clears each field and expects canonical `Nodes JSON` to keep the
  last valid value.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty server was written into
    `Nodes JSON`.
- After adding the empty server/tool guard to the structured editor and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-DsAI6BRi.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7prob2`.
  - Run: `8d77d929-8c48-4637-b10a-bcd8bbba4886`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7prob2_cancel`.
  - Python cancel run: `c1814cab-5929-460d-8daa-60355db8b78d`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Agent id UI schema-bound hardening slice record:

- `agent.call.agentId` requires a non-empty string in the workflow node schema.
  The `/workflows` structured agent editor now preserves the previous agent id
  when an operator clears the field instead of mutating canonical `Nodes JSON`
  to an empty string.
- This keeps agent card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change agent inventory discovery, picker
  selection behavior, prompt editing, timeout semantics, runtime agent dispatch,
  persisted step output, or run-console rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `agent_review agent id` to valid `agent_qa`, it clears the field and expects
  canonical `Nodes JSON` to keep the valid agent id.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty agent id was written into
    `Nodes JSON`.
- After adding the empty-agent-id guard to the structured editor and rebuilding
  the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-RcfsHWxK.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7pxm6j`.
  - Run: `86e11823-def7-473d-8357-80a79141b43e`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7pxm6j_cancel`.
  - Python cancel run: `83c55177-41a0-483b-b0fb-a9b968928de2`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Foreach items/item variable UI schema-bound hardening slice record:

- `builtin.foreach.items` and `builtin.foreach.itemVar` require non-empty
  strings in the workflow node schema. The `/workflows` structured foreach
  editor now preserves the previous items expression or item variable when an
  operator clears either field instead of mutating canonical `Nodes JSON` to an
  empty string.
- This keeps foreach card authoring aligned with the workflow node schema while
  preserving raw JSON editing as the explicit path for direct schema validation
  feedback.
- This slice intentionally does not change foreach body reference editing,
  concurrency bounds, runtime foreach execution, item trace persistence,
  assignment behavior, or run-console rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `foreach_09 foreach items` to valid `$.input.customers` and
  `foreach_09 foreach item variable` to valid `customer`, it clears each field
  and expects canonical `Nodes JSON` to keep the last valid value.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty items expression was written
    into `Nodes JSON`.
- After adding the empty items/item-variable guard to the structured editor and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-DRkHPpZ0.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7q3wj6`.
  - Run: `9af9f3e7-cc39-4988-bdaa-c723c8ca6e89`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7q3wj6_cancel`.
  - Python cancel run: `563298e6-5c9c-43e4-8726-f1adfd5f4faa`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Scheduled cron UI schema-bound hardening slice record:

- Scheduled workflow triggers require `schedule.expr` to be a non-empty string
  in the workflow trigger schema. The `/workflows` structured scheduled trigger
  editor now preserves the previous cron expression when an operator clears the
  cron field instead of mutating canonical `Triggers JSON` to an empty string.
- This keeps scheduled trigger card authoring aligned with the workflow trigger
  schema while preserving raw `Triggers JSON` editing as the explicit path for
  direct schema validation feedback.
- This slice intentionally does not change scheduled timezone editing, scheduled
  input editing, enabled-state behavior, dispatcher due-scan semantics,
  duplicate scheduled-run protection, or run-console rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `nightly scheduled cron` to valid `30 6 * * 1`, it clears the field and
  expects canonical `Triggers JSON` to keep the valid cron expression.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the empty cron expression was written
    into `Triggers JSON`.
- After adding the empty scheduled-cron guard to the structured editor and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-DRpg61HK.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7qa0bx`.
  - Run: `5f933664-add3-46c0-a6fb-ffedabd2b787`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7qa0bx_cancel`.
  - Python cancel run: `4ebf5079-bbd9-467d-925c-4045a89bc4c2`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Webhook secret SHA UI schema-bound hardening slice record:

- Webhook trigger `secretSha256` values must be 64-character SHA-256 hex
  digests when present in the workflow trigger schema. The `/workflows`
  structured webhook secret editor now writes only valid SHA-256 hex digests to
  canonical `Triggers JSON`; invalid non-empty values preserve the previous
  trigger definition, and empty values still remove the optional field.
- This keeps webhook secret authoring aligned with the workflow trigger schema
  while preserving raw `Triggers JSON` editing as the explicit path for direct
  schema validation feedback.
- This slice intentionally does not change public webhook authentication,
  path-based webhook routing, sanitized trigger metadata responses, export/import
  shape, or run-console rendering.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after setting
  `incoming webhook secret sha-256` to a valid digest, it fills `not-a-sha` and
  expects canonical `Triggers JSON` to keep the valid digest.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because `not-a-sha` was written into
    `Triggers JSON`.
- After adding the SHA-256 hex guard to the structured editor and rebuilding the
  web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-BcF8JQ4K.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7qgfcv`.
  - Run: `a9ae0d74-c217-45b1-8350-92c87c4c1cea`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7qgfcv_cancel`.
  - Python cancel run: `5442e095-daef-4c7f-9c43-ccf85354c23a`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow export description schema-bound hardening slice record:

- `WorkflowDefinitionSchema.description` is an optional string, while the
  draft-save API still accepts `description: null` as the explicit clear
  semantic. The `/workflows` export path now keeps those boundaries separate:
  an empty description is omitted from the exported definition JSON, and a
  non-empty description is exported as a string.
- This keeps `openacme.workflow.definition.v1` snapshots aligned with the
  workflow definition schema without changing draft save/clear behavior,
  import-as-new-draft behavior, run history, artifact export scope, or runtime
  execution.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: the existing
  explanation-free workflow export now asserts that the downloaded workflow
  object does not contain a `description` property.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because the downloaded JSON contained
    `description: null`.
- After omitting empty descriptions from the export payload and rebuilding the
  web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-CdC7WjwG.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7qosfr`.
  - Run: `9d9de116-a83b-4538-97c1-b03e2f829c73`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7qosfr_cancel`.
  - Python cancel run: `b8c4ede3-a234-438f-a643-a8643fdd4b52`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow import description schema-bound hardening slice record:

- `openacme.workflow.definition.v1` imports now treat `workflow.description` as
  the same optional string shape used by `WorkflowDefinitionSchema` and the
  export payload. A missing description is accepted as absent; a string
  description is preserved; any other JSON value is rejected before a new draft
  workflow is created.
- This keeps malformed workflow definition snapshots from being silently
  normalized into a clear operation while preserving the draft-save API's
  separate `description: null` clear semantic.
- This slice intentionally does not change export shape, import ids,
  import-as-new-draft behavior, run history, artifact import/export scope, or
  server-side workflow create/update request schemas.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it imports a workflow
  definition with `description: { text: "not a string" }`, expects
  `Imported workflow description must be a string`, and verifies the selected
  workflow id remains unchanged.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because no import-description error was shown.
- After adding the optional-string guard to `parseWorkflowImport` and rebuilding
  the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-y6bA70PJ.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7qv8da`.
  - Run: `971305e9-b928-4082-81cd-d052d132379a`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7qv8da_cancel`.
  - Python cancel run: `94f561b0-1fe3-4a8b-aff2-97acdfaa4b2f`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow import node shape schema-bound hardening slice record:

- `openacme.workflow.definition.v1` imports now validate imported node shape
  before creating a new draft workflow. The importer checks required node
  fields for the current workflow node types, including assignment maps,
  transform payloads, branch node arrays, foreach items/body/concurrency,
  log messages, exit status, Python code/reset/timeout, MCP server/tool/timeout,
  and agent id/prompt/timeout.
- This keeps malformed definition snapshots from falling through to the
  server-side create route as generic schema failures while preserving raw
  `Nodes JSON` editing, draft-save API validation, runtime execution, export
  shape, and import-as-new-draft behavior.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it imports a workflow
  definition containing `{ id: "log_import_invalid", type: "builtin.log.info" }`,
  expects `Imported workflow node log_import_invalid needs a message`, and
  verifies the selected workflow id remains unchanged.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because no import-node-shape error was shown.
- After adding `validateImportedNodeShape` to the importer and rebuilding the web
  bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types`
  - first failed on `timeoutMs` type narrowing, then passed after adding an
    explicit numeric guard.
- `pnpm --filter web build`
  - passed; produced `workflows-wAJ1xXaR.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7r3f2c`.
  - Run: `62788274-c853-4c3e-a0c8-ca2c040e14ca`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7r3f2c_cancel`.
  - Python cancel run: `1ab904ca-a54a-4848-a66f-a504edfa480d`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow export node shape schema-bound hardening slice record:

- `/workflows` export now validates `Nodes JSON` against the same node-shape
  guard used by definition import before producing an
  `openacme.workflow.definition.v1` download. Schema-invalid node snapshots are
  rejected in the UI and no export file is created.
- The export path reports operator-facing `Workflow node ...` messages while the
  import path keeps its `Imported workflow node ...` messages. Raw `Nodes JSON`
  editing, draft-save API validation, runtime execution, import-as-new-draft
  behavior, and server-side create/update schemas are unchanged.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it temporarily replaces
  `Nodes JSON` with `{ id: "log_export_invalid", type: "builtin.log.info" }`,
  clicks Export, expects `Workflow node log_export_invalid needs a message`, and
  verifies that no download is created before restoring the valid nodes draft.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because no export-node-shape error was shown.
- During implementation validation, the first focused rerun still failed because
  the guard had been inserted into draft Save instead of Export; after moving it
  to `exportWorkflowDefinition`, the focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-DLh2B5bX.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7rerr4`.
  - Run: `d62a4a03-4687-4896-8760-228c987d0a18`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7rerr4_cancel`.
  - Python cancel run: `d681b200-aa14-40ff-915c-3f33d35af48a`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow node id UI safe-pattern hardening slice record:

- The core workflow validation seam rejects node ids outside
  `[A-Za-z0-9][A-Za-z0-9_.-]*`, but the `/workflows` local node validation only
  checked duplicates and missing branch/foreach references. The UI now applies
  the same safe-id pattern before export/import/run/save paths that call local
  node reference validation.
- This prevents runtime-invalid ids such as `bad/node` from being exported as
  `openacme.workflow.definition.v1` snapshots and gives operators the same
  `Invalid workflow node id: ...` message used by the core validation seam.
- This slice intentionally does not change node id generation, branch reference
  semantics, raw `Nodes JSON` editing, workflow schema types, server-side
  create/update validation, or runtime execution.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it temporarily replaces
  `Nodes JSON` with a valid log node whose id is `bad/node`, clicks Export,
  expects `Invalid workflow node id: bad/node`, and verifies that no download is
  created before restoring the valid nodes draft.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because no invalid-node-id error was shown.
- After adding the safe-id check to local node reference validation and
  rebuilding the web bundle, the same focused smoke passed. One focused rerun
  caught a test locator ambiguity because the same error appears both inline and
  as a toast; the assertion was narrowed to the main page content.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-CALsoFTm.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7rlfb2`.
  - Run: `ff8ba37f-2d80-4140-8194-2cd6ff4af803`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7rlfb2_cancel`.
  - Python cancel run: `00ddcaf4-1002-441b-af96-8f985e0eae9b`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Workflow trigger id UI safe-pattern hardening slice record:

- The core workflow validation seam rejects trigger ids outside
  `[A-Za-z0-9][A-Za-z0-9_.-]*`, but the `/workflows` local trigger identity
  validation only checked duplicate trigger ids and duplicate webhook paths. The
  UI now applies the same safe-id pattern before export/import paths that call
  local trigger identity validation.
- This prevents runtime-invalid trigger ids such as `bad/trigger` from being
  exported as `openacme.workflow.definition.v1` snapshots and gives operators
  the same `Invalid workflow trigger id: ...` message used by the core
  validation seam.
- This slice intentionally does not change trigger id generation, trigger kind
  semantics, webhook path normalization, task trigger disabled semantics,
  scheduled trigger cron validation, workflow schema types, server-side
  create/update validation, or runtime execution.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it temporarily replaces
  `Triggers JSON` with a manual trigger and a webhook trigger whose id is
  `bad/trigger`, clicks Export, expects
  `Invalid workflow trigger id: bad/trigger`, and verifies that no download is
  created before restoring the valid triggers draft.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because no invalid-trigger-id error was shown.
- After adding the safe-id check to local trigger identity validation and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-Cuzd5rJn.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7rso4f`.
  - Run: `af7c755c-60de-4b19-8c8c-f7dc2c94bb75`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7rso4f_cancel`.
  - Python cancel run: `c2054673-e380-4eea-90f9-6cee8eb255d8`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Save draft trigger prevalidation slice record:

- The `/workflows` export/import paths already prevalidate trigger shape and
  identity before producing or accepting workflow definition snapshots, but Save
  Draft previously sent invalid trigger drafts to the server first. Save Draft
  now applies the same local `validateTriggerShape` and
  `validateTriggerIdentity` checks before PATCHing the workflow draft.
- This keeps operator feedback consistent across Save, export, and import for
  invalid trigger ids, duplicate trigger ids, duplicate webhook paths, disabled
  task-trigger constraints, scheduled cron shape, webhook path shape, and
  webhook secret digest shape.
- This slice intentionally does not change server-side validation, trigger
  schemas, trigger card editing semantics, publish/run validation, webhook
  routing, scheduled dispatch, or runtime execution. The server remains the
  authoritative validation owner; the UI Save path now avoids avoidable invalid
  PATCH requests for the same local trigger constraints.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; the pre-existing CLI serve listener remained untouched.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it installs a route
  observer for the current workflow PATCH endpoint, replaces `Triggers JSON`
  with a manual trigger and a webhook trigger whose id is `bad/save`, clicks
  Save, expects `Invalid workflow trigger id: bad/save`, and asserts that no
  invalid-trigger PATCH was sent.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because Save sent one invalid-trigger PATCH
    before showing the server validation error.
- After adding the trigger shape and identity checks to Save Draft and
  rebuilding the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-BI8IBlAu.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7rznd8`.
  - Run: `2570ca25-d9fa-47e6-bba9-c02d6d07e8ba`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7rznd8_cancel`.
  - Python cancel run: `df08c287-4830-4c3b-9ecc-5ff2b9fe8ffe`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and remained occupied by the pre-existing
    CLI serve process, not by this workflow test run.

Publish trigger prevalidation slice record:

- The `/workflows` Save/export/import paths now prevalidate trigger shape and
  identity locally, but Publish previously only checked local node references
  before POSTing the publish request. Publish now applies the same local
  `validateTriggerShape` and `validateTriggerIdentity` checks before calling the
  publish API.
- This prevents operators from publishing while the current trigger draft in the
  editor is visibly invalid, matching the existing Publish behavior for invalid
  local node references.
- This slice intentionally does not change server-side publish validation,
  draft-save behavior, workflow versioning, trigger schemas, trigger card
  editing semantics, run execution, webhook routing, or scheduled dispatch. The
  server remains the authoritative validation owner; the UI Publish path now
  avoids avoidable publish POSTs when the visible trigger draft is invalid.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it installs a route
  observer for the current workflow publish endpoint, replaces `Triggers JSON`
  with a manual trigger and a webhook trigger whose id is `bad/publish`, clicks
  Publish, expects `Invalid workflow trigger id: bad/publish`, and asserts that
  no publish POST was sent.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because Publish sent the POST and no local
    invalid-trigger-id error was shown.
- After adding the trigger shape and identity checks to Publish and rebuilding
  the web bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-CZvf2kFo.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7s61l7`.
  - Run: `60de8fb4-e9ed-4d16-907c-670f41afaebb`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7s61l7_cancel`.
  - Python cancel run: `cec68874-d674-4ed3-9692-8d4b49be177a`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, `61087`, or
    `3456`.

Test/Live run trigger prevalidation slice record:

- The `/workflows` Test and Live buttons already prevalidated the visible node
  draft for missing references before creating a run, but they did not
  prevalidate the visible trigger draft. Test/Live run actions now call a shared
  local trigger-draft guard before POSTing a run request.
- This keeps operator feedback consistent across Save, Publish, export, import,
  Test, and Live for invalid trigger ids, duplicate trigger ids, duplicate
  webhook paths, disabled task-trigger constraints, scheduled cron shape,
  webhook path shape, and webhook secret digest shape.
- This slice intentionally does not change persisted draft definitions,
  server-side run validation, trigger-card execution, rerun behavior, run input
  validation, workflow runtime execution, webhook routing, or scheduled
  dispatch. The server remains the authoritative validation owner; the UI
  Test/Live paths now avoid avoidable run POSTs when the visible trigger draft
  is invalid.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice.

TDD note:

- The `/workflows` Playwright smoke was tightened first: it installs a route
  observer for the current workflow test-run endpoint, replaces `Triggers JSON`
  with a manual trigger and a webhook trigger whose id is `bad/test-run`, clicks
  Test, expects `Invalid workflow trigger id: bad/test-run`, and asserts that no
  test-run POST was sent while that invalid draft was visible.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because Test did not show the local
    invalid-trigger-id error.
- After adding the trigger-draft guard to `runWorkflow` and rebuilding the web
  bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-BNBm-BKU.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7sc99j`.
  - Run: `3e643722-0398-409b-81d4-cc5cc55b21b2`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7sc99j_cancel`.
  - Python cancel run: `db979a34-48fe-445f-b9ea-b98fd32c0157`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, `61087`, or
    `3456`.

Trigger-card run prevalidation slice record:

- The `/workflows` Test and Live buttons now prevalidate the visible trigger
  draft before creating runs, but individual trigger-card Run buttons previously
  skipped that local guard. Trigger-card Run now uses the same
  `validateCurrentTriggerDraft` guard before POSTing to a trigger-run endpoint.
- This keeps operator feedback consistent across Save, Publish, export, import,
  Test, Live, and trigger-card Run for invalid trigger ids, duplicate trigger
  ids, duplicate webhook paths, disabled task-trigger constraints, scheduled
  cron shape, webhook path shape, and webhook secret digest shape.
- This slice intentionally does not change persisted draft definitions,
  server-side trigger-run validation, trigger-card enabled/runnable semantics,
  rerun behavior, run input validation, workflow runtime execution, webhook
  routing, or scheduled dispatch. The server remains the authoritative
  validation owner; the UI trigger-card Run path now avoids avoidable trigger-run
  POSTs when the visible trigger draft is invalid.
- Test ports: Playwright used the built server/web harness on `3998`, and the
  deployed foreach/Python smoke used `OPENACME_PORT=3458`. Port `3456` was not
  used for this slice; a pre-existing listener was observed separately after the
  smoke.

TDD note:

- The `/workflows` Playwright smoke was tightened first: after publishing the
  workflow, it installs a route observer for the manual trigger-run endpoint,
  replaces `Triggers JSON` with a valid manual trigger and a webhook trigger
  whose id is `bad/trigger-card-run`, clicks the manual trigger-card Run button,
  expects `Invalid workflow trigger id: bad/trigger-card-run`, and asserts that
  no trigger-run POST was sent while that invalid draft was visible.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation because trigger-card Run did not show the local
    invalid-trigger-id error.
- After adding the trigger-draft guard to `runTrigger` and rebuilding the web
  bundle, the same focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-A0TNXCBa.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - passed after implementation, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7sj374`.
  - Run: `6c65f66a-385a-4ca1-a4ff-a99a982b2bb9`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7sj374_cancel`.
  - Python cancel run: `f8ad9f63-4309-4516-aea6-87c69b9b273f`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and was occupied by a pre-existing
    listener, not by this workflow test run.

Workflow authoring agent skill slice record:

- Added a repo-local skill at
  `.claude/skills/openacme-workflow-author/SKILL.md`, discoverable through the
  existing `.agents/skills -> ../.claude/skills` symlink for agents working in
  this repository.
- The skill teaches other agents how to create, edit, save, test, publish,
  import, export, and validate OpenAcme workflows. It points agents to the
  canonical workflow docs, schemas, validation seams, server routes, and web UI
  route before authoring.
- The detailed reference at
  `.claude/skills/openacme-workflow-author/references/workflow-authoring.md`
  documents definition shape, trigger types, built-in nodes, MCP tool nodes,
  agent-call nodes, Python execution, flow control, variables and assignments,
  log/error nodes, UI/API save-test-publish-run flows, Run Console inspection,
  deployed smoke practice, and example definitions.
- The skill explicitly teaches the branch's deployment boundary: use
  `/Users/alenbohcelyan/.openacme-the-workflow` and non-`3456` test ports such
  as `3458` for deployed workflow validation.
- This slice intentionally does not change workflow runtime behavior, UI
  behavior, server APIs, schemas, migrations, test harnesses, or skill registry
  code. It adds an agent-facing authoring guide only.

Validation:

- `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/openacme-workflow-author`
  - passed with `Skill is valid!`.

Save/publish/test node-shape prevalidation slice record:

- `/workflows` now prevalidates exported node shape before saving a draft.
  Invalid node drafts stop locally with the same user-facing validation message
  used by export/import and do not send the workflow PATCH request.
- `validateCurrentNodeReferences()` now also validates exported node shape.
  Existing callers therefore get the same node-shape guard before Publish,
  Test Run, and Live Run.
- The slice intentionally does not change server validation, export/import
  semantics, runtime execution, trigger-card Run behavior, schema contracts, or
  migrations.
- TDD started in `apps/web/e2e/workflows.spec.ts` by inserting a
  `builtin.log.info` node with id `log_save_invalid` and no `message`.
  - The first focused run exposed a selector issue because the broad `Save`
    locator also matched node action buttons containing the word `save`; the
    test was corrected to target the exact top-level Save button.
  - The corrected focused run then failed as intended because the local
    `Workflow node log_save_invalid needs a message` error was absent before
    implementation.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 12 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-ClO9fZ7U.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - sandboxed run failed to bind `127.0.0.1:3998` with `EPERM`.
  - approved non-`3456` rerun passed, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7sx9ss`.
  - Run: `00ed017e-9002-4c11-8d2c-2a409e51ff4c`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7sx9ss_cancel`.
  - Python cancel run: `354b2cb7-0276-4234-8a84-70c76aeaedd8`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and was occupied by a pre-existing
    listener, not by this workflow test run.

Deferred `agent.task` first-release guard slice record:

- First-release decision: long-running durable `agent.task` creation,
  wait/resume, and task terminal-status wakeup are follow-up work, not part of
  the first workflow release.
- `WorkflowNodeSchema` already accepts `agent.call` only. This slice adds an
  explicit regression test proving `agent.task` node definitions are rejected.
- `/workflows` import/export node-shape validation now gives a specific
  deferred-contract message for `agent.task` instead of a generic unsupported
  node message. Export stops locally without creating a download; import keeps
  the current workflow selected and does not create a new draft.
- The repo-local `openacme-workflow-author` skill now teaches other agents not
  to author `agent.task` nodes for this release.
- This slice intentionally does not add task creation, task event
  subscriptions, waiting runs, resume dispatch, task-trigger execution, runtime
  agent task ports, server route changes, or schema support for `agent.task`.

TDD note:

- The `/workflows` Playwright smoke was tightened first with an `agent.task`
  node in `Nodes JSON`, then expected the exact deferred first-release message
  and no export download.
- The same smoke also imports a definition containing `agent.task` and expects
  the imported deferred message while preserving the currently selected
  workflow.
- The focused smoke failed before implementation because the built web bundle
  still showed the generic unsupported-node path. After adding the explicit
  `agent.task` branch and rebuilding the web bundle, the focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts packages/workflows/test/schemas.test.ts`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 13 Vitest tests.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-BwVue_XR.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before rebuilding the web bundle because Playwright serves built
    output and the old `workflows-ClO9fZ7U.js` chunk did not include the new
    deferred message.
  - passed after rebuild, 1 Chromium test.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7t6rt7`.
  - Run: `3aed3cc3-c457-47d7-b0d4-47f4f4eacd24`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7t6rt7_cancel`.
  - Python cancel run: `2c8c4a7f-c8cb-4fe7-b204-8ce320da4443`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and was occupied by a pre-existing
    listener, not by this workflow test run.

Import-as-new-draft conflict policy slice record:

- First-release decision: workflow definition import is non-destructive only.
  It always creates a new `wf_import_...` draft and never overwrites or merges
  into the currently selected workflow, even when the imported file carries the
  same `workflow.id` as an existing workflow.
- `/workflows` now reports successful imports as
  `Workflow imported as new draft`, making the policy operator-visible instead
  of relying on implementation detail.
- The Playwright workflow smoke now observes the import request while importing
  an export whose workflow id matches the current workflow. It asserts that no
  PATCH is sent to the current workflow, the create request uses a
  `wf_import_...` id, and the selected workflow changes to that new draft.
- The repo-local `openacme-workflow-author` skill now teaches authoring agents
  to create workflow definitions through the API or import/export JSON path.
  Playwright is reserved for product UI regression and deployed validation, not
  agent-driven workflow creation.
- This slice intentionally does not add overwrite, merge, conflict-resolution
  prompts, server-side import endpoints, destructive import modes, or workflow
  id preservation during import.

TDD note:

- The `/workflows` Playwright smoke was tightened first to expect
  `Workflow imported as new draft`, no PATCH to the current workflow during
  import, and a POST body id matching `wf_import_...`.
- The focused smoke failed before implementation because the UI still reported
  the older generic `Workflow imported` success message.
- After updating the success message, skill guidance, and rebuilt web bundle,
  the focused smoke passed.

Focused validation:

- `pnpm exec prettier --write apps/web/app/routes/workflows.tsx apps/web/e2e/workflows.spec.ts .claude/skills/openacme-workflow-author/SKILL.md .claude/skills/openacme-workflow-author/references/workflow-authoring.md`
  - passed.
- `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/openacme-workflow-author`
  - passed with `Skill is valid!`.
- `pnpm --filter web build`
  - passed; produced `workflows-4o2JIb5t.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts -g "runs configured manual workflow triggers from the console"`
  - failed before implementation on missing
    `Workflow imported as new draft`.
  - passed after implementation, 1 Chromium test.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 13 Vitest tests.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7thl6e`.
  - Run: `8b8b4cdf-c534-4ad1-bbe9-2cd0fdf0ef34`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7thl6e_cancel`.
  - Python cancel run: `477f6e24-fdc5-49ce-9274-5bd2a8c776db`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and was occupied by a pre-existing
    listener, not by this workflow test run.

First-release global workflow scope slice record:

- First-release decision: workflow definitions and workflow run history are
  global. Workflows are not team-scoped or agent-owned in the first release.
- The workflow definition and version tables intentionally have no `team_id`,
  `agent_id`, or `owner_id` columns. Ownership/scoping migrations are follow-up
  work and must be introduced explicitly when the authorization model exists.
- `GET /api/workflows` and global `GET /api/workflow-runs` now reject
  `teamId`, `agentId`, and `ownerId` query parameters with
  `400 workflow_scope_unsupported` instead of silently ignoring them. This
  prevents callers from thinking a global list was scoped.
- Workflow-scoped run history remains scoped by path or explicit
  `workflowId`, not by team or agent ownership.
- The `openacme-workflow-author` skill now teaches agents that every
  human-visible lifecycle action must have an API/import-export equivalent.
  It also documents API-first run inspection: list recent/failed runs, fetch
  run detail, inspect `steps[].input`, `steps[].output`, `steps[].error`,
  `logsSummary`, `contextDiff`, and fetch artifacts by id.
- This slice intentionally does not add team ownership, agent ownership,
  authorization filtering, owner migrations, owner-aware UI, or scoped
  workflow creation.

TDD note:

- `packages/server/test/workflow-routes.test.ts` was tightened first to expect
  `400 workflow_scope_unsupported` for `teamId` and `agentId` on
  `GET /api/workflows` and global `GET /api/workflow-runs`.
- The focused route suite failed before implementation because those query
  params were ignored and returned `200`.
- After adding the explicit route guard, the focused route suite passed.

Focused validation:

- `pnpm exec prettier --write packages/server/src/routes/workflows.ts packages/server/test/workflow-routes.test.ts .claude/skills/openacme-workflow-author/SKILL.md .claude/skills/openacme-workflow-author/references/workflow-authoring.md`
  - passed.
- `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/openacme-workflow-author`
  - passed with `Skill is valid!`.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
  - failed before implementation on ignored `teamId` query filters.
  - passed after implementation, 31 Vitest tests.
- `pnpm --filter @openacme/server check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 13 Vitest tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 35 Vitest tests across workflow routes, runtime, and Python
    runtime.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-4o2JIb5t.js`.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - passed with exit code `0` against the isolated workflow data dir.
  - Workflow: `wf_python_deployed_ms7trnhy`.
  - Run: `50796fc9-10b2-4514-92f9-edf96befbee5`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7trnhy_cancel`.
  - Python cancel run: `5902338d-a776-4149-b151-5b4102ed4cd2`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458`, `3998`, or `61087`.
  - Port `3456` was checked separately and was occupied by a pre-existing
    listener, not by this workflow test run.

Agent API lifecycle parity coverage slice record:

- The route-level lifecycle regression now proves that the API path covers the
  human workflow lifecycle the `openacme-workflow-author` skill teaches:
  draft creation, draft test, publish, direct live run, trigger-card live run,
  run detail inspection, recent run listing, failed run listing, and failed
  step error inspection.
- `GET /api/workflow-runs/:runId` is now explicitly asserted to expose
  run-level input, per-step resolved input, per-step output, context diff,
  ordered events, artifacts, and failed-step errors. This is the debugging
  contract agents rely on instead of using Playwright to inspect the UI.
- The trigger-card parity path is proven through
  `POST /api/workflows/:workflowId/triggers/:triggerId/runs`, including the
  persisted trigger snapshot with `kind`, `triggerId`, `requestedBy`, and
  trigger input.
- Failed-run investigation is proven through both global and workflow-scoped
  failed run list APIs plus run detail inspection for the failed step's
  structured `{ name, message }` error.
- This slice intentionally does not add new route behavior, server-side import
  endpoints, overwrite/merge import semantics, agent-owned workflows,
  team-scoped workflow lists, or Playwright-based workflow authoring for
  agents.
- The skill now explicitly requires agents to discover MCP inventory with
  `GET /api/workflows/mcp/tools` before authoring `mcp.tool` nodes. Agents must
  use the returned `server`, `tool`, `description`, and `inputSchema` to choose
  capabilities and construct node input; they must report missing inventory
  instead of inventing tool ids or parameters.
- The same discovery rule documents `GET /api/workflows/agents` for
  `agent.call` ids.

TDD note:

- `packages/server/test/workflow-routes.test.ts` was tightened first to assert
  agent-visible lifecycle parity through the existing API routes.
- The focused route suite initially failed on two over-specific expectations:
  `normalize` step input is the resolved workflow context after `builtin.set`
  and therefore excludes the unassigned `secret`, while failed step errors are
  persisted as structured `{ name, message }` objects.
- After correcting those assertions to the real runtime contract, the focused
  route suite passed without product-code changes.

Focused validation:

- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
  - failed before assertion correction on the expected normalize step input and
    failed step error shape.
  - passed after correction, 31 Vitest tests.
- `pnpm exec prettier --write .claude/skills/openacme-workflow-author/SKILL.md .claude/skills/openacme-workflow-author/references/workflow-authoring.md docs/workflow-engine-plan.md`
  - passed.
- `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/openacme-workflow-author`
  - passed with `Skill is valid!`.

Wide validation:

- `pnpm --filter @openacme/server check-types`
  - passed.
- `pnpm --filter @openacme/workflows check-types`
  - passed.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts`
  - passed, 13 Vitest tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts`
  - passed, 35 Vitest tests across workflow routes, runtime, and Python
    runtime.
- `pnpm --filter web check-types`
  - passed.
- `pnpm --filter web build`
  - passed; produced `workflows-4o2JIb5t.js` and the existing large chunk
    warnings only.
- `pnpm --dir apps/web exec playwright test workflows.spec.ts`
  - sandbox run failed because the web server could not bind
    `127.0.0.1:3998` (`EPERM`).
  - rerun outside the sandbox passed, 13 Chromium tests.

Deployed foreach/Python validation:

- `env OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
  - sandbox run failed because SQLite could not open
    `/Users/alenbohcelyan/.openacme-the-workflow/state.db` from the restricted
    filesystem.
  - rerun outside the sandbox passed with exit code `0` against the isolated
    workflow data dir.
  - Workflow: `wf_python_deployed_ms7u3p7v`.
  - Run: `4ee84a2b-3adb-426b-bb28-0f91dd43f8c6`.
  - Run status: `succeeded`.
  - Final context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2` with two succeeded item traces.
  - Python cancel workflow: `wf_python_deployed_ms7u3p7v_cancel`.
  - Python cancel run: `93b47106-be9c-43b8-afdf-f861738b79a2`.
  - Python cancel status: `canceled`.
  - `~/.openacme` was not used.
  - Post-smoke port checks showed no listener on `3458` or `3998`.
  - Port `3456` was checked separately and was occupied by a pre-existing
    listener, not by this workflow test run.

First workflow release audit record - 2026-07-30:

- Scope: revalidated the first workflow release across M0-M8 after closing the
  trigger, Python/foreach, agent-call, MCP discovery/execution, run-console,
  persistence, artifact, cancellation, and authoring-skill slices.
- Skill/API authoring contract:
  - `.claude/skills/openacme-workflow-author/SKILL.md` now treats
    `GET /api/workflows/mcp/tools` and `GET /api/workflows/agents` as the
    runtime source of truth for external-call node authoring.
  - The workflow-authoring reference explicitly says an authoring agent does
    not need prior MCP tool knowledge; it must read `server`, `tool`,
    `description`, and `inputSchema` from the MCP inventory response and map
    workflow values into the selected tool's JSON input.
  - `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/openacme-workflow-author`
    passed with `Skill is valid!`.
- Package and route validation:
  - `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
    passed, 17 Vitest tests.
  - `pnpm --filter @openacme/db check-types` passed.
  - `pnpm --filter @openacme/workflows test` passed, 37 Vitest tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts runtime.test.ts workflow-python-runtime.test.ts`
    passed, 36 Vitest tests. This includes MCP inventory metadata without
    builtin tool exposure, run detail inspection, artifact read/prune, cancel,
    agent.call, foreach/Python, manual/scheduled/webhook/public webhook
    triggers, rerun, and `builtin.exit` semantics.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/mcp-client check-types` passed.
  - `pnpm --filter @openacme/mcp-client build` passed.
- Web validation:
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed and produced
    `workflow-runs-DbE44UYl.js` and `workflows-4o2JIb5t.js`; the build emitted
    only the existing large asset/chunk listing and no fatal errors.
  - `pnpm --dir apps/web exec playwright test workflow-runs.spec.ts workflows.spec.ts`
    passed outside the sandbox on the non-3456 Playwright port, 23 Chromium
    tests. The suite covers global and workflow-scoped run history, filters,
    pagination, auto-refresh, selected step preservation, cancel/rerun,
    artifact errors, disabled external actions when no inventory is available,
    and configured manual trigger runs from the console.
- MCP e2e validation:
  - `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/workflows-mcp.e2e.ts`
    first failed inside the sandbox with `listen EPERM` while binding
    `127.0.0.1`.
  - The same command passed outside the sandbox, 1 Vitest e2e test,
    proving workflow MCP discovery and execution against the SDK-backed fake
    streamable HTTP MCP server.
- Deployed validation:
  - All deployed smokes used
    `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow` and
    `OPENACME_PORT=3458`; `~/.openacme` was not used.
  - `node packages/server/test/e2e/support/workflow-agent-deployed-smoke.mjs`
    passed. Workflow `wf_agent_deployed_ms7uwmox`; run
    `5b6841bd-bf82-4450-8e30-e172fb5dabf6`; status `succeeded`; cancel
    workflow `wf_agent_deployed_ms7uwmox_cancel`; cancel run
    `566fd1f2-5e4e-4b37-9a66-f7ba3bb1378f`; cancel status `canceled`.
  - `node packages/server/test/e2e/support/workflow-python-deployed-smoke.mjs`
    passed. Workflow `wf_python_deployed_ms7ux7r5`; run
    `8d513d2a-4e10-45e5-bf93-15867f811668`; status `succeeded`; final
    context included `tripled: 12`, `shifted: [11, 12]`, and
    `foreachSummary.count: 2`; cancel workflow
    `wf_python_deployed_ms7ux7r5_cancel`; cancel run
    `3bf5852a-bf79-40aa-abb6-01fcf9b4b32b`; cancel status `canceled`.
  - `node packages/server/test/e2e/support/workflow-trigger-deployed-smoke.mjs`
    passed. Workflow `wf_trigger_deployed_ms7uxmu0`; manual run
    `4fa27c31-cbea-4369-8ace-03e111be507c`; run-input spill run
    `0ce0a7c2-309a-45f6-9bff-dc8f6c3cc74d`; authenticated webhook run
    `fa6ec2fa-b872-4128-8548-3a951cbbcdc2`; public webhook run
    `b7d9d95a-d867-484c-816e-ead93b3c2b3e`; public webhook path run
    `ce26ccf9-1347-4be7-956a-c9c62c426716`; scheduled run
    `d185293b-f7e6-4bfa-976d-f07175384280`; accepted run count `5`;
    artifact prune result deleted 1 file with 0 unsafe paths skipped.
  - Post-smoke port checks showed no listener on `3458` or `3998`.
    Port `3456` remained occupied by pre-existing PID `92084`; this release
    audit did not use it.

## Open Questions

- None for the first workflow release architecture captured in this plan.
