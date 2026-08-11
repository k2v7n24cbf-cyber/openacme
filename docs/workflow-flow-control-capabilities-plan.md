# Workflow Flow-Control Capabilities Plan

Status: complete and validated for M11
Owner surface: workflow engine, workflow API, workflow designer, run console,
workflow authoring skill
Test environment: `/Users/alenbohcelyan/.openacme-the-workflow` on a non-3456
port, normally `3458`

## Goal

Make OpenAcme workflows expressive enough for real operational automation while
keeping authoring understandable from the canvas and preserving API parity for
agents.

This plan covers the next workflow runtime capability expansion:

- `foreach` over list items with per-item body execution and aggregate output.
- `parallel` for independent branches such as N assets, N vulnerabilities, or N
  tool calls.
- Backend `exit` behavior that produces terminal status/output without forcing
  an exit card onto the canvas.
- `throw_error` for controlled failures.
- `sleep` / `delay` for short waits, rate limits, and eventual consistency.
- `set_variable` / `assign` for writing outputs into workflow context.
- `transform` operations for replace, regex, CSV parse/create, JSON parse/stringify,
  IP/subnet helpers, and URI parsing.
- `append` for list aggregation.
- `merge` for controlled object accumulation.
- `log.debug`, `log.info`, `log.warn`, and `log.error` as structured run
  timeline events.
- IP address helpers: netmask calculations, in-subnet checks, IPv4 validation,
  IPv6 validation, CIDR parsing, network/broadcast where applicable.
- URI parsing helpers.

The result should let a human or an agent build workflows such as:

- Fetch 5 Qualys assets, run agent prioritization for each asset in parallel,
  aggregate the selected vulnerabilities, and log a concise summary.
- Normalize mixed CSV/JSON/tool output into stable context variables.
- Validate IP addresses and route assets based on subnet membership.
- Parse URIs from tool output and extract host/path/query fields for later MCP
  calls.
- Continue to inspect every run, step input, step output, logs, errors, and
  final context after the run completes.

## Current Baseline

Current runtime already has several pieces that this plan should preserve and
extend instead of replacing:

- Workflow definitions are canonical JSON with `triggers`, `nodes`, optional
  `ui`, and immutable published versions.
- The canvas is a projection over canonical workflow JSON. It must not become
  the source of truth.
- `builtin.set` writes context variables through the `assign` map.
- Executable nodes can assign outputs to context through `assign`.
- Assignment modes already exist: `replace`, `merge`, and `append`.
- `builtin.transform` currently supports string references, literal JSON, and
  `object_pick`.
- `builtin.foreach` executes sequentially with `concurrency` bounded to `1`.
- `builtin.log.info`, `builtin.log.debug`, and `builtin.log.error` produce run
  timeline log events.
- `builtin.exit` is valid runtime JSON but should stay hidden from the normal
  canvas.
- `builtin.if` and `builtin.if_else` currently exist, but product direction is
  to keep one visible `if` node with true/false flow.
- The run console persists and displays run status, step attempts, input,
  output, error, logs, context diff, events, and duration.

## Non-Goals

- Do not introduce a new free-form graph execution engine. Sequential order,
  branch references, foreach body references, and parallel branch references
  remain explicit in canonical JSON.
- Do not require agents to use Playwright to create workflows. Agents use API
  and import/export JSON paths.
- Do not touch production `~/.openacme` for validation.
- Do not use port `3456` for workflow test environments.
- Do not make `agent.task` durable wait/resume part of this capability slice.
- Do not add arbitrary JavaScript transforms. Deterministic transform helpers
  are safer, easier to validate, and easier to expose in the UI.
- Do not expose backend `exit` as a normal first-class canvas card unless a
  later operator need proves it belongs in the UI.

## Design Principles

1. Runtime first, UI second.
   Schema and runner behavior must be precise before the canvas exposes a node.

2. Backward compatible schemas.
   Existing workflow definitions and published versions must keep parsing and
   executing.

3. Deterministic by default.
   Flow-control and transform nodes should be replayable and observable. Python
   stays available for advanced cases, but common data shaping should not force
   code execution.

4. Explainable run history.
   Every control decision should produce inspectable events. Branch choice,
   foreach item summaries, parallel branch summaries, sleep timing, thrown
   errors, transform output, and log payloads must be visible in run detail.

5. Canvas simplicity.
   Humans should see clean cards and clear true/false/foreach/parallel routes.
   Low-level engine artifacts such as implicit exit should stay hidden.

6. Agent parity.
   Anything a human can configure in the designer must be representable through
   workflow JSON and documented in `openacme-workflow-author`.

7. TDD per slice.
   Each slice starts with schema/runner/helper tests, then server API tests when
   persistence or run detail changes, then Playwright only when UI changes.

8. Deployed test-env gate.
   Milestone 2+ runtime/UI capability work must be proven once against the
   isolated test data dir and a non-3456 port before closing the slice.

## Capability Contracts

### Assignment Contract

Keep the current `assign` model as the standard context write mechanism.

Current shape:

```json
{
  "assign": {
    "normalized.asset": "$.steps.normalize.output",
    "results": { "from": "$.steps.score.output", "mode": "append" },
    "summary": { "from": "$.steps.merge_summary.output", "mode": "merge" }
  }
}
```

Rules:

- Assignment targets are dotted context paths.
- `replace` overwrites the target.
- `append` creates a one-item array when the target does not exist, then appends
  to existing arrays.
- `merge` requires object target and object value.
- Assignments run only after the step succeeds.
- Failed steps do not mutate context unless an explicit future recovery feature
  says otherwise.
- Same-variable transform is allowed: read `$.context.foo`, transform it, assign
  back to `foo`.

Planned hardening:

- Preserve existing semantics.
- Add tests for append/merge inside foreach and parallel branches.
- Make UI copy say "Set variable", "Append to list", and "Merge object" while
  saving the same canonical `assign` JSON.

### Foreach Contract

Existing `builtin.foreach` should become the durable list-iteration primitive.

Target shape:

```json
{
  "id": "each_asset",
  "type": "builtin.foreach",
  "items": "$.context.assets",
  "itemVar": "asset",
  "body": ["score_asset", "choose_vuln"],
  "concurrency": 1,
  "assign": {
    "assetResults": {
      "from": "$.steps.each_asset.output.items",
      "mode": "replace"
    }
  }
}
```

Output shape:

```json
{
  "count": 5,
  "succeeded": 5,
  "failed": 0,
  "items": [
    {
      "index": 0,
      "item": {},
      "status": "succeeded",
      "steps": {
        "score_asset": {},
        "choose_vuln": {}
      }
    }
  ]
}
```

Rules:

- `items` must resolve to an array.
- `itemVar` is available only inside the foreach body.
- Body nodes execute in listed order for each item.
- Each item gets inspectable events: started, completed, failed.
- Aggregate output is written to `$.steps.<foreachId>.output`.
- `assign` can write the aggregate output into context.
- `concurrency: 1` remains the safe first contract until parallel isolation is
  implemented.

Future extension after parallel branch isolation:

- Allow `concurrency > 1` only when item context isolation is implemented.
- Add optional `continueOnError` if operators need partial-success loops. First
  release should fail fast to avoid silent partial automation.

### Parallel Contract

Add `builtin.parallel` for independent branches.

Candidate shape:

```json
{
  "id": "parallel_enrichment",
  "type": "builtin.parallel",
  "branches": [
    { "id": "qualys", "label": "Qualys", "nodes": ["get_qualys_asset"] },
    { "id": "cmdb", "label": "CMDB", "nodes": ["get_cmdb_record"] },
    { "id": "dns", "label": "DNS", "nodes": ["parse_uri", "resolve_owner"] }
  ],
  "concurrency": 3,
  "failFast": true,
  "assign": {
    "enrichment": "$.steps.parallel_enrichment.output.branches"
  }
}
```

Output shape:

```json
{
  "count": 3,
  "succeeded": 3,
  "failed": 0,
  "branches": {
    "qualys": {
      "status": "succeeded",
      "steps": {}
    }
  }
}
```

Rules:

- Branch node ids must exist.
- Branches must not share mutable step ids at the same attempt scope.
- Branches run with isolated step-output snapshots and merge only their final
  outputs through the parallel aggregate.
- Context mutation inside branches must be isolated until branch completion.
- `failFast: true` cancels sibling branches when any branch fails.
- `failFast: false` waits for all branches, records failures, and then marks the
  parallel step failed unless a later explicit partial-success policy is added.
- Parallel output must include per-branch status, timings, errors, and step
  outputs.

First implementation recommendation:

- Start with branch isolation and `concurrency` bounded to a small value.
- Do not make arbitrary linear canvas edges imply parallel execution. The
  operator adds a `Parallel` card and configures branches explicitly.

### Exit Contract

Keep `builtin.exit` as backend terminal behavior.

Rules:

- The runner can synthesize success at the end of a normal run without requiring
  an explicit exit node.
- Existing persisted `builtin.exit` nodes remain valid.
- The canvas hides exit nodes from ordinary authoring.
- Run detail still shows terminal status and final output.
- If a workflow includes an explicit exit node, it should stop further
  execution and emit the correct terminal event.

### Throw Error Contract

Add `builtin.throw_error`.

Candidate shape:

```json
{
  "id": "fail_missing_owner",
  "type": "builtin.throw_error",
  "message": "Asset owner is missing",
  "code": "asset_owner_missing",
  "details": {
    "assetId": "$.context.asset.id"
  }
}
```

Rules:

- `message` is required.
- `code` is optional but should be a safe machine-readable string.
- `details` is optional JSON with expression resolution.
- The step fails with a controlled error payload.
- The run fails unless this later sits inside an explicit recovery construct.
- Run events include `step_failed` and `run_failed`.

### Sleep / Delay Contract

Add `builtin.sleep`.

Candidate shape:

```json
{
  "id": "wait_for_index",
  "type": "builtin.sleep",
  "delayMs": 2500,
  "reason": "Wait for external index consistency"
}
```

Rules:

- `delayMs` is bounded by schema. Proposed initial max: 300000 ms.
- Sleep respects cancellation.
- Sleep records started/completed events and duration.
- Short waits only. Durable waits belong to future scheduled/wait semantics.
- UI should label this `Delay` and discourage long sleeps.

### Transform Contract

Keep `builtin.transform` as the deterministic data-shaping node. Preserve
existing string/literal/object-pick behavior, then add explicit operation
objects.

General shape:

```json
{
  "id": "normalize",
  "type": "builtin.transform",
  "input": {
    "value": "$.context.raw"
  },
  "transform": {
    "kind": "string.replace",
    "source": "$.workflowTrigger.input.value",
    "search": "prod-",
    "replace": ""
  },
  "assign": {
    "raw": "$.steps.normalize.output"
  }
}
```

Initial transform operations:

- `string.replace`
  - `source`, `search`, `replace`, optional `all`.
- `string.regex_replace`
  - `source`, `pattern`, `replace`, optional `flags`.
- `string.regex_match`
  - `source`, `pattern`, optional `flags`; output includes `matched`,
    `groups`, and `namedGroups` when available.
- `csv.parse`
  - `source`, optional `delimiter`, `headers`, `trim`.
- `csv.stringify`
  - `source`, optional `delimiter`, `headers`.
- `json.parse`
  - `source`; output is parsed JSON.
- `json.stringify`
  - `source`, optional `pretty`.
- `json.pick`
  - formal successor to current `object_pick`, with backwards compatibility.
- `ip.parse`
  - `source`; output includes normalized address, family, and validity.
- `ip.is_ipv4`
  - `source`; output boolean.
- `ip.is_ipv6`
  - `source`; output boolean.
- `ip.in_subnet`
  - `address`, `cidr`; output boolean.
- `ip.netmask`
  - `cidr` or `prefixLength`; output netmask fields where applicable.
- `ip.network`
  - `cidr`; output network address, prefix, first/last usable where applicable.
- `uri.parse`
  - `source`; output scheme, username, password redacted flag, host, port, path,
    query, queryParams, fragment.

Security and correctness:

- Regex must have bounded input and safe flags.
- CSV parse/stringify must bound rows and output size.
- URI parse must not preserve credentials in clear text.
- IP helpers should use a proven library or a small well-tested internal module,
  not ad hoc string splitting.
- Transform output should be artifact-pruned if too large, following existing
  run artifact rules.

### Log Contract

Extend logs to include `warn`.

Current:

- `builtin.log.info`
- `builtin.log.debug`
- `builtin.log.error`

Add:

- `builtin.log.warn`

Rules:

- Log nodes produce structured run timeline `log` events.
- Message is required.
- Payload is optional and expression-resolved.
- Log step output includes `{ message, payload? }`.
- Log nodes can also assign their output if needed, but normal usage is
  observability rather than data movement.

## Milestone Plan

### M11.0 - Planning And Contract Baseline

Goal: capture the accepted capability set and make the next implementation
slices testable before changing runtime behavior.

Scope:

- Add this plan.
- Keep `openacme-platform` routing to `openacme-workflow-author`.
- Confirm repo-local and packaged builtin workflow author skill copies are in
  sync.

TDD / validation:

- Documentation-only slice.
- Validate the workflow authoring skill format.
- Compare `.claude/skills/openacme-workflow-author` and
  `packages/skills/builtin/openacme-workflow-author`.

Acceptance:

- Agents reading `openacme-platform` know to route workflow work to
  `openacme-workflow-author`.
- The development roadmap stays in `docs/`; workflow skills remain focused on
  supported authoring behavior.

### M11.1 - Schema Contract For New Nodes And Log Warn

Goal: introduce typed schemas for `builtin.parallel`, `builtin.throw_error`,
`builtin.sleep`, and `builtin.log.warn` without changing UI behavior yet.

Scope:

- Extend workflow schemas.
- Extend validation for node references:
  - parallel branch references
  - no duplicate branch ids
  - no missing branch node ids
  - no self-referential branch cycles that validation can detect cheaply
- Preserve old definitions.
- Add migration-free compatibility tests.

TDD:

- Failing schema tests:
  - accepts valid `builtin.throw_error`
  - rejects missing throw message
  - accepts valid `builtin.sleep`
  - rejects delay below/above bounds
  - accepts `builtin.log.warn`
  - accepts valid `builtin.parallel`
  - rejects duplicate parallel branch ids
  - rejects missing parallel branch node refs
  - old definitions still parse
- Failing validation tests for branch/body/parallel references.

Validation:

- `pnpm --filter @openacme/workflows test -- schemas.test.ts validation.test.ts`
- `pnpm --filter @openacme/workflows check-types`

Acceptance:

- Runtime can still parse old and new definitions.
- New node shapes are not exposed in the canvas until runner tests exist.

Validation record - 2026-08-01:

- Added schema coverage for:
  - `builtin.throw_error`
  - `builtin.sleep`
  - `builtin.log.warn`
  - `builtin.parallel`
  - invalid throw/sleep/parallel shapes
  - missing parallel branch node references
  - duplicate parallel branch ids
  - self-referential parallel branch references
- Added workflow schema support for the new M11.1 node contracts without
  implementing runtime execution for them yet.
- Extended workflow run event levels with `warn` and bound the workflow event
  port level type to `WorkflowRunEventLevel` to avoid future schema/type drift.
- Extended cross-node validation so `builtin.parallel.branches[].nodes`
  participates in missing-reference checks.
- Runtime execution remains intentionally unchanged for this slice; the new
  nodes are schema/API contracts only until M11.2 and M11.9.
- Focused validation:
  - `pnpm --filter @openacme/workflows test -- schemas.test.ts` failed first
    for the expected missing node schemas.
  - `pnpm --filter @openacme/workflows test -- schemas.test.ts` passed after
    implementation, 19 tests.
  - `pnpm --filter @openacme/workflows test -- schemas.test.ts runner.test.ts`
    passed, 2 files / 42 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed,
    33 tests.
- Test-environment live validation:
  - Restarted the test server only with
    `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow` and
    `OPENACME_PORT=3458`.
  - `curl -sS http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - `POST /api/workflows` accepted
    `wf_m11_schema_contract_live_20260801_0346` with `builtin.log.warn`,
    `builtin.sleep`, `builtin.throw_error`, and `builtin.parallel` nodes.
  - `POST /api/workflows` rejected
    `wf_m11_schema_contract_invalid_20260801_0346` with
    `Node parallel_bad branches references missing node does_not_exist`.
  - Production `~/.openacme` and port `3456` were not used.

Status: complete for M11.1 schema and validation contract.

### M11.2 - Throw Error, Sleep, And Warn Runtime

Goal: implement small, deterministic runtime nodes first.

Scope:

- Implement `builtin.throw_error`.
- Implement `builtin.sleep`.
- Implement `builtin.log.warn`.
- Ensure cancellation is respected during sleep.
- Persist step duration for sleep and controlled failures.
- Add run events and selected-step evidence.

TDD:

- Runner test: `throw_error` creates failed step with controlled payload.
- Runner test: `throw_error` stops downstream nodes.
- Runner test: `sleep` waits through injected fake timer/clock abstraction or a
  very short deterministic delay.
- Runner test: sleep cancellation marks run canceled or failed according to the
  existing cancellation contract.
- Runner test: `log.warn` emits level `warn` and persisted step output.
- Server route test: run detail returns warn log and throw error evidence.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
- Deployed API smoke on `3458` creates a draft workflow:
  - log.warn
  - sleep 10ms
  - throw_error
  - verifies failed run detail has warning log, sleep duration, and error.

Acceptance:

- Operators can intentionally fail a workflow with explainable evidence.
- Delay behavior is bounded and inspectable.

Validation record - 2026-08-01:

- Added runner coverage for:
  - `builtin.log.warn` producing a warn-level `log` event, step output, event
    port emission, and `logsSummary`.
  - `builtin.throw_error` failing the run, stopping downstream steps, resolving
    JSON details, and persisting controlled error metadata.
  - `builtin.sleep` producing bounded output/duration and respecting an already
    aborted `AbortSignal` with canceled run/step status.
- Implemented runtime behavior for:
  - `builtin.log.warn` through the existing structured log path.
  - `builtin.throw_error` via controlled `WorkflowNodeExecutionError`.
  - `builtin.sleep` with timer cleanup and abort handling.
- Extended durable workflow event typing in `@openacme/db` so persisted run
  events accept `warn` as a first-class event level.
- Added server route coverage proving persisted run detail exposes warn logs,
  sleep output/duration, and controlled throw error evidence.
- Focused validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts` failed first
    for the expected missing runtime behavior.
  - `pnpm --filter @openacme/workflows test -- runner.test.ts` passed after
    implementation, 26 tests.
  - `pnpm --filter @openacme/workflows test -- schemas.test.ts runner.test.ts`
    passed, 2 files / 45 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter @openacme/db check-types` passed.
  - `pnpm --filter @openacme/db build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed,
    34 tests.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
- Test-environment live validation:
  - Restarted the test server only with
    `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow` and
    `OPENACME_PORT=3458`.
  - `curl -sS http://127.0.0.1:3458/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created `wf_m11_runtime_live_20260801_0355` through `POST /api/workflows`.
  - Ran `POST /api/workflows/wf_m11_runtime_live_20260801_0355/runs/test`
    with input `{ "asset": { "id": "asset_live_1" } }`.
  - Live run `e774648d-30b1-4072-9395-377f26e92910` finished `failed` as
    intended.
  - Run detail proved:
    - `warn_operator` succeeded with warn log summary.
    - `wait_for_index` succeeded with `{ "delayMs": 1, "reason": "Wait for external index consistency" }`
      and non-null `durationMs`.
    - `fail_missing_owner` failed with
      `WorkflowNodeExecutionError`, code `asset_owner_missing`, and resolved
      detail `{ "assetId": "asset_live_1" }`.
    - Events included warn-level `log`, `step_failed`, and `run_failed`.
  - Production `~/.openacme` and port `3456` were not used.

Status: complete for M11.2 throw error, sleep, and warn runtime.

### M11.3 - Assignment Hardening In Loops And Branches

Goal: make `replace`, `append`, and `merge` trustworthy under foreach and
branch execution.

Scope:

- Keep assignment schema unchanged unless tests reveal ambiguity.
- Add dedicated tests for append/merge in:
  - linear execution
  - true/false branch body
  - foreach item body
- Improve error messages for invalid merge/append targets.
- Ensure failed nodes do not partially mutate context.
- Ensure context diff is clear for append and merge writes.

TDD:

- Runner test: append creates array when target missing.
- Runner test: append adds one output per foreach item.
- Runner test: merge combines object output into an existing object.
- Runner test: merge rejects non-object target/value with node-specific error.
- Runner test: failed assignment rolls back the step context mutation.
- Run-console unit/UI helper test if context diff rendering needs a tweak.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`

Acceptance:

- `append` is safe as the main foreach aggregation mechanism.
- `merge` is safe as the main enrichment accumulation mechanism.

Validation record - 2026-08-01:

- Added runner coverage for assignment hardening:
  - append creates an array when the target is missing.
  - append and merge work in selected true and false branch bodies.
  - append continues to aggregate one output per foreach item.
  - merge works inside foreach item body steps.
  - merge and append reject invalid targets with node-specific details:
    `assignmentPath`, `assignmentMode`, `targetType`, and `valueType`.
  - failed multi-assignment steps roll back the whole step context mutation and
    do not emit a `contextDiff` for the failed step.
- Added server route coverage:
  - `wf_m11_assignment_evidence` persists assignment rollback and structured
    assignment error details through run creation and run detail retrieval.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 52 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 35 tests.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created workflow `wf_m11_assignment_live_20260801_0401`.
  - Test run `536d8e66-7876-4db1-975e-ae38bd4cadfe` failed intentionally on
    invalid merge.
  - Run context persisted as
    `{"asset":{"id":"asset_live_assign_1"},"notes":["original"]}`, proving the
    failed step rolled back the attempted append.
  - Failed step `partial_failure` persisted
    `WorkflowNodeExecutionError` with message
    `merge assignment for asset requires an object target and object value`
    and details
    `{"assignmentPath":"asset","assignmentMode":"merge","targetType":"object","valueType":"string"}`.
  - Fetching `/api/workflow-runs/536d8e66-7876-4db1-975e-ae38bd4cadfe`
    returned the same persisted context, steps, and error details.

Status: complete for M11.3 assignment hardening.

### M11.4 - Transform Operation Framework

Goal: evolve `builtin.transform` from generic JSON/object-pick into a typed
operation framework while preserving existing behavior.

Scope:

- Add a transform operation dispatcher inside `packages/workflows`.
- Keep existing `object_pick` behavior.
- Add schema refinement or runtime validation for known transform operations.
- Add common result envelope conventions:
  - raw primitive for simple transforms where obvious
  - structured object for parse/match helpers
  - errors include operation kind and invalid field name
- Add output-size guardrails.

TDD:

- Runner tests for backwards compatibility:
  - string reference transform
  - literal transform
  - existing `object_pick`
- Runner tests for invalid operation shape.
- Runner tests for transform assignment back to the same variable.
- Schema tests only if operation-specific schemas are represented at schema
  layer rather than runtime validation.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`

Acceptance:

- New transform operations can be added in small slices without changing the
  node type each time.
- Existing workflows keep running.

Validation record - 2026-08-01:

- Added a transform operation dispatcher in `packages/workflows`:
  - known `object_pick` transform dispatches through the operation path.
  - future namespaced operation kinds such as `string.*`, `json.*`, and
    `csv.*` can be added behind the same `builtin.transform` node type.
  - dotted but unsupported operation-style kinds fail with
    `WorkflowNodeExecutionError` and `operationKind` details.
  - literal object transforms with non-operation `kind` values remain backward
    compatible and are still resolved as literal JSON.
- Preserved existing behavior:
  - string reference transform still resolves to the referenced value.
  - primitive/literal transform still returns the literal value.
  - existing `object_pick` behavior still produces the selected fields.
  - transform assignment can overwrite the same context variable.
- Added runtime validation and guardrails:
  - invalid `object_pick.fields` and `object_pick.source` fail with structured
    details: `operationKind`, `field`, `expected`, and `actualType`.
  - transform outputs larger than `1_048_576` bytes fail before being written
    to step output or context.
- Added server route coverage:
  - `wf_m11_transform_evidence` persists structured transform operation error
    details through run creation and run detail retrieval.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 57 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 36 tests.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created workflow `wf_m11_transform_live_20260801_0406`.
  - Test run `e029ed03-2798-4b70-b71c-5007dc77928e` succeeded and showed
    self-assignment normalization of `customer` plus backward-compatible
    literal transform output for `kind:"identity"`.
  - Created workflow `wf_m11_transform_invalid_live_20260801_0407`.
  - Test run `4cba38ec-75e4-4ec9-b9a6-0107ab09b4fb` failed intentionally
    with `WorkflowNodeExecutionError`:
    `Transform operation object_pick has invalid field fields: expected string[]`.
  - Fetching `/api/workflow-runs/4cba38ec-75e4-4ec9-b9a6-0107ab09b4fb`
    returned the same persisted operation details.

Status: complete for M11.4 transform operation framework.

### M11.5 - String, Regex, JSON, And CSV Transforms

Goal: add the common data-shaping helpers needed before network/domain helpers.

Scope:

- Implement `string.replace`.
- Implement `string.regex_replace`.
- Implement `string.regex_match`.
- Implement `json.parse`.
- Implement `json.stringify`.
- Implement `csv.parse`.
- Implement `csv.stringify`.
- Add UI presets in the transform inspector for these operations.
- Keep raw JSON editor fallback for advanced transform payloads.

TDD:

- Runner test: replace one occurrence.
- Runner test: replace all occurrences.
- Runner test: regex replace with capture groups.
- Runner test: regex match returns matched/groups/named groups.
- Runner test: invalid regex fails with controlled error.
- Runner test: JSON parse/stringify round trip.
- Runner test: CSV parse with headers.
- Runner test: CSV stringify with stable header order.
- Runner test: CSV size/row guard.
- Web helper tests for inspector operation default payloads.
- Playwright edits a transform card using a preset, saves, test-runs, and
  verifies output.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- `pnpm --filter web test -- workflow-authoring.test.ts`
- `pnpm --filter web check-types`
- `pnpm --filter web build`
- Deployed UI/API smoke on `3458`:
  - input text plus CSV
  - transform parse/replace/stringify
  - log result
  - verify run output/log.

Acceptance:

- Operators can normalize common string/CSV/JSON output without Python.
- The right inspector stays clean through presets/collapsed sections.

Validation record - 2026-08-01:

- Added `builtin.transform` operations in `packages/workflows`:
  - `string.replace` with first-match default and `all: true` support.
  - `string.regex_replace` with capture-group replacement.
  - `string.regex_match` returning `matched`, `match`, `index`, `groups`, and
    `namedGroups`.
  - `json.parse`.
  - `json.stringify` with `pretty: true`.
  - `csv.parse` with headers, quote-aware fields, input byte guard, and row
    guard.
  - `csv.stringify` with stable explicit headers, quote escaping, and row
    guard.
- Added controlled failure behavior:
  - invalid regex returns `WorkflowNodeExecutionError` with
    `operationKind`, `field`, `pattern`, and `flags`.
  - CSV row guard returns `WorkflowNodeExecutionError` with `maxRows` and
    `actualRows`.
  - invalid operation field types use the structured transform field error
    details introduced in M11.4.
- Added UI preset support:
  - `WORKFLOW_TRANSFORM_PRESETS` and `workflowTransformPresetById` live in
    `apps/web/app/workflows/authoring.ts`.
  - The transform inspector shows a compact preset select that fills the
    Transform JSON while preserving the raw JSON editor fallback.
  - Presets cover `string.replace`, `string.regex_replace`,
    `string.regex_match`, `json.parse`, `json.stringify`, `csv.parse`, and
    `csv.stringify`.
- Added server route coverage:
  - `wf_m11_transform_operations_evidence` persists string, JSON, CSV parse,
    and CSV stringify outputs through run creation and run detail retrieval.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 63 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter web test -- workflow-authoring.test.ts` passed: 1 file,
    10 tests.
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed with the existing Vite chunk-size warning.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 37 tests.
  - Focused Playwright e2e passed:
    `pnpm --dir apps/web exec playwright test e2e/workflows.spec.ts -g "edits a transform card with a preset"`
    passed: 1 test.
  - An earlier incorrectly filtered command
    `pnpm --filter web test:e2e -- workflows.spec.ts -g "edits a transform card with a preset"`
    ran the broader workflows spec because the script forwarded `--`
    differently; the new M11.5 test passed there too, while unrelated
    existing run-console tests failed on strict locator assumptions.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created workflow `wf_m11_transform_ops_live_20260801_0418`.
  - Test run `48a4a090-7010-4e87-8310-2c081bcc0fbe` succeeded.
  - Input text `risk accepted, risk tracked` became
    `issue accepted, issue tracked`.
  - Input CSV `id,name,note` parsed to two row objects, was stringified back
    with stable headers, and the pretty JSON summary was written to context.
  - `log_result` persisted an info log with the full transform context.
  - Fetching `/api/workflow-runs/48a4a090-7010-4e87-8310-2c081bcc0fbe`
    returned the same persisted context, step outputs, and logs summary.

Status: complete for M11.5 string, regex, JSON, and CSV transforms.

### M11.6 - IP Address And Subnet Transforms

Goal: support common security workflow routing and enrichment decisions without
custom code.

Scope:

- Select implementation library or internal module.
- Implement:
  - `ip.parse`
  - `ip.is_ipv4`
  - `ip.is_ipv6`
  - `ip.in_subnet`
  - `ip.netmask`
  - `ip.network`
- Define IPv4/IPv6 output shape.
- Define invalid input behavior:
  - boolean helpers return `false`
  - parse/network helpers fail with controlled transform error unless
    `allowInvalid` is explicitly added in a later slice.
- Add UI presets.

TDD:

- IPv4 valid/invalid tests.
- IPv6 valid/invalid tests.
- CIDR membership true/false tests.
- Netmask tests for common prefix lengths.
- IPv6 subnet tests.
- Invalid CIDR controlled failure test.
- Workflow branch test uses `ip.in_subnet` output in `if`.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
- Deployed API smoke on `3458`:
  - input list of IPs
  - foreach transforms each IP
  - branch logs internal/external
  - verify aggregate output.

Acceptance:

- Workflows can route assets by IP/subnet without Python.

Validation record - 2026-08-01:

- Added `builtin.transform` operations in `packages/workflows`:
  - `ip.parse` returns stable IPv4/IPv6 metadata with normalized address,
    stringified integer value, and octets/hextets.
  - `ip.is_ipv4` and `ip.is_ipv6` return booleans and return `false` for
    invalid inputs.
  - `ip.in_subnet` supports IPv4 and IPv6 CIDR membership checks.
  - `ip.netmask` returns IPv4 dotted masks and expanded IPv6 masks.
  - `ip.network` returns `{ version, address, prefix, cidr }` for IPv4 and
    IPv6 networks.
- Added controlled failure behavior:
  - invalid `ip.parse` input fails with a structured transform error.
  - invalid CIDR input fails with `operationKind`, `field`, and `cidr`
    details.
  - boolean IP version checks keep invalid input non-throwing.
- Added UI preset support:
  - `WORKFLOW_TRANSFORM_PRESETS` now includes `ip.parse`, `ip.is_ipv4`,
    `ip.is_ipv6`, `ip.in_subnet`, `ip.netmask`, and `ip.network`.
  - The raw Transform JSON editor remains available for advanced payloads.
- Added server route coverage:
  - `wf_m11_ip_transform_evidence` persists IP parse, subnet check, network
    output, branch selection/skips, and run detail retrieval evidence.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 69 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter web test -- workflow-authoring.test.ts` passed: 1 file,
    10 tests.
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed with the existing Vite chunk-size warning.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 38 tests.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created workflow `wf_m11_ip_routing_live_20260801012831`.
  - Test run `11857fb7-8022-42d2-a712-c7f4deaaaa0e` succeeded.
  - Foreach processed three IPs:
    - `10.1.2.3` routed `internal`.
    - `8.8.8.8` routed `external`.
    - `10.44.5.6` routed `internal`.
  - Context aggregation persisted:
    - `routeChecks` with true/false subnet decisions.
    - `routed` with internal/external route labels.
    - `foreachSummary.count` equal to `3`.
  - Run timeline persisted structured debug/info/warn logs for each item.

Status: complete for M11.6 IP address and subnet transforms.

### M11.7 - URI Parse Transform

Goal: let workflows extract stable fields from URLs/URIs returned by tools.

Scope:

- Implement `uri.parse`.
- Use WHATWG URL where valid for absolute URLs.
- Decide behavior for relative paths:
  - either reject by default
  - or support `base` field
- Redact credentials.
- Parse query into both raw query string and object/list representation.
- Add UI preset.

TDD:

- Parse HTTPS URL with host/path/query/fragment.
- Parse URL with port.
- Redact username/password.
- Query params with repeated keys.
- Invalid URL controlled failure.
- Optional base URL behavior if included.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- Deployed API smoke on `3458` parses URI input and logs host/path.

Acceptance:

- URI extraction can feed MCP input mappings and branch conditions.

Validation record - 2026-08-01:

- Added `builtin.transform` operation `uri.parse` in `packages/workflows`.
- Locked relative URI behavior:
  - absolute URI values parse directly through WHATWG `URL`.
  - relative URI values require a valid `base` field.
  - invalid value/base inputs fail with `WorkflowNodeExecutionError` and
    structured `operationKind`, `field`, `value`, and optional `base` details.
- Output shape:
  - redacted `href` and `origin`.
  - `protocol`, `scheme`, `host`, `hostname`, `port`, `pathname`, `path`,
    `search`, `hash`, and `fragment`.
  - `query` object where repeated keys become arrays.
  - ordered `queryList` entries for consumers that need stable key order.
  - `username: null`, `password: null`, and `hasCredentials`.
  - API run-detail responses may still apply the platform response redactor to
    key names such as `password`.
- Added UI preset support:
  - `WORKFLOW_TRANSFORM_PRESETS` now includes `uri.parse`.
  - The preset fills `{ kind: "uri.parse", value: "$.workflowTrigger.input.url" }` and keeps
    the raw Transform JSON editor available.
- Added server route coverage:
  - `wf_m11_uri_transform_evidence` persists URI parse output, redacted
    credential output, structured log payload, and run detail retrieval
    evidence.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts` passed:
    1 file, 54 tests.
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 73 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter web test -- workflow-authoring.test.ts` passed: 1 file,
    10 tests.
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed with the existing Vite chunk-size warning.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 39 tests.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created workflow `wf_m11_uri_parse_live_20260801013514`.
  - Test run `4aaf8d79-d4b7-4edd-af7f-c472878a933c` succeeded.
  - Input
    `https://user:secret@api.example.com:8443/v1/assets?id=123&tag=cloud&tag=prod#section`
    produced redacted href
    `https://api.example.com:8443/v1/assets?id=123&tag=cloud&tag=prod#section`.
  - Parsed context included host `api.example.com:8443`, hostname
    `api.example.com`, pathname `/v1/assets`, repeated query key
    `tag: ["cloud", "prod"]`, fragment `section`, and
    `hasCredentials: true`.
  - Branch `route_host` selected `log_api` and skipped `log_other`.
  - Run timeline persisted an info log `api uri parsed` with host, path, and
    query payload.

Status: complete for M11.7 URI parse transform.

### M11.8 - Foreach Aggregate Hardening

Goal: make foreach reliable enough for real asset/vulnerability workflows.

Scope:

- Preserve `concurrency: 1`.
- Ensure per-item output includes item index, original item, status, body step
  outputs, and timing.
- Add explicit aggregate counts.
- Make foreach item events easy to inspect in run console.
- Add UI inspector copy for aggregate assignment:
  - "Save all item results to variable"
  - "Append each item result to variable" only if the runtime supports that
    exact semantic.

TDD:

- Runner test: foreach output includes counts.
- Runner test: item body step outputs are isolated per item.
- Runner test: item variable path resolution works for nested fields.
- Runner test: failing body fails the foreach and includes item index/error.
- Server route test: run detail exposes foreach item logs and output.
- Playwright: run history selected step shows foreach item outputs clearly.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
- `pnpm --filter web check-types`
- `pnpm --filter web build`
- Deployed UI smoke on `3458`:
  - workflow loops over 3 items
  - logs each item
  - verifies aggregate in run detail.

Acceptance:

- A 5-asset Qualys prioritization workflow can use foreach and produce a clear
  result list.

Validation record - 2026-08-01:

- Hardened `builtin.foreach` runtime output:
  - Preserved `concurrency: 1`.
  - Preserved existing `count` and `items` shape.
  - Added explicit `succeededCount` and `failedCount`.
  - Added per-item `startedAt`, `endedAt`, and `durationMs`.
  - Preserved each item `index`, original `item`, `status`, and body step
    `steps` output map.
  - Failed foreach items now include structured item details and latest child
    step error in the parent foreach step error.
- Kept foreach item events easy to inspect:
  - Each item emits `Foreach item N started`.
  - Each successful item emits `Foreach item N completed` with the full item
    aggregate payload.
- Added UI inspector copy:
  - "Save all item results to variable"
  - explicit aggregate assignment example for `$.steps.<foreach>.output`.
  - per-item append copy is shown as unavailable while runtime semantics are
    aggregate-only assignment.
- Added server route coverage:
  - existing `wf_foreach_python_http` route evidence now verifies aggregate
    counts, per-item timing, body step outputs, and foreach item timeline logs.
- Added Playwright coverage:
  - mocked run detail verifies the run console selected foreach step shows
    `count`, `succeededCount`, `failedCount`, per-item `durationMs`, original
    item ids, and body step outputs in `Step output JSON`.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts` passed:
    1 file, 54 tests.
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 73 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter web test -- workflow-authoring.test.ts` passed: 1 file,
    10 tests.
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed with the existing Vite chunk-size warning.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 39 tests.
  - Focused Playwright e2e passed:
    `pnpm --dir apps/web exec playwright test e2e/workflows.spec.ts -g "shows foreach aggregate output"`
    passed: 1 test.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Created workflow `wf_m11_foreach_aggregate_live_20260801014309`.
  - Test run `fdbb696b-ecfe-4a9e-9d8e-9b142256aa94` succeeded.
  - Foreach processed three assets.
  - Aggregate output persisted:
    - `count: 3`
    - `succeededCount: 3`
    - `failedCount: 0`
    - item durations `[209, 237, 275]`
    - body step output ids `asset_1`, `asset_2`, `asset_3`
  - Context assignment persisted `foreachSummary` and appended
    `processedAssets`.
  - Run timeline persisted six foreach item start/completion events and three
    per-item `asset processed` logs.

Status: complete for M11.8 foreach aggregate hardening.

### M11.9 - Parallel Runtime

Goal: add explicit parallel branches with safe context isolation.

Scope:

- Implement branch execution scheduler.
- Add context/step-output isolation per branch.
- Add cancellation handling.
- Add fail-fast behavior.
- Add aggregate output.
- Add event timeline:
  - parallel started
  - branch started
  - branch completed
  - branch failed
  - parallel completed/failed
- Add duration accounting for branches and parent parallel step.

TDD:

- Runner test: independent branches execute and aggregate outputs.
- Runner test: branch context mutations do not leak before aggregate merge.
- Runner test: failFast true cancels siblings.
- Runner test: failFast false waits for all and reports failures.
- Runner test: cancellation propagates to branch MCP/agent/Python ports.
- Runner test: duration is persisted for branch steps and parallel parent.
- Server route test: run detail shows branch outputs/errors/events.

Validation:

- `pnpm --filter @openacme/workflows test -- runner.test.ts`
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts`
- Deployed API smoke on `3458`:
  - three branches sleep/log different payloads
  - verify aggregate and durations.

Acceptance:

- Parallel can safely support independent tool/agent branches without corrupting
  workflow context.

Validation record - 2026-08-01:

- Implemented `builtin.parallel` runtime execution:
  - Each branch starts from a cloned parent context and cloned parent step
    output snapshot.
  - Branch-local `assign` mutations stay inside that branch.
  - Parent context changes only through the parallel node `assign` against the
    aggregate output.
  - Branch child step attempts are persisted with their own input, output,
    error, duration, and events.
  - Aggregate output includes `count`, `succeededCount`, `failedCount`,
    `canceledCount`, `failFast`, `branchOrder`, and per-branch `status`,
    `startedAt`, `endedAt`, `durationMs`, `steps`, `context`, and `error`.
  - `failFast: true` fails the parent parallel step and aborts sibling branch
    controllers after the first branch failure.
  - `failFast: false` waits for all branches and reports branch failures in the
    aggregate while allowing the parent workflow to continue.
- Added run timeline event kinds:
  - `parallel_started`
  - `parallel_branch_started`
  - `parallel_branch_completed`
  - `parallel_branch_failed`
  - `parallel_completed`
  - `parallel_failed`
- Added authoring helper support:
  - `createWorkflowNodeTemplate("parallel")` creates a two-branch default.
  - Removing a node prunes references from `parallel.branches[].nodes`.
- Added server route coverage:
  - `wf_m11_parallel_runtime_evidence` creates one successful asset branch,
    one successful URI branch, and one controlled failed policy branch.
  - The route test verifies parent run success for `failFast: false`, persisted
    branch outputs/errors/events, branch-local context isolation, parent
    aggregate assignment, and summary log payload.
- Automated validation:
  - `pnpm --filter @openacme/workflows test -- runner.test.ts` passed:
    1 file, 58 tests.
  - `pnpm --filter @openacme/workflows test -- runner.test.ts schemas.test.ts`
    passed: 2 files, 77 tests.
  - `pnpm --filter @openacme/workflows check-types` passed.
  - `pnpm --filter @openacme/workflows build` passed.
  - `pnpm --filter web test -- workflow-authoring.test.ts` passed: 1 file,
    10 tests.
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed with the existing Vite chunk-size warning.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server build` passed.
  - `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed:
    1 file, 40 tests.
- Live test environment validation on `OPENACME_PORT=3458` with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`:
  - Health check returned
    `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
  - Rebuilt server dist was restarted on
    `http://127.0.0.1:3458`.
  - Created workflow `wf_m11_parallel_live_20260801015925`.
  - Test run `76e04ebd-9f15-439c-9e40-c2d49ddcc27e` succeeded.
  - Parallel aggregate output persisted:
    - `count: 3`
    - `succeededCount: 3`
    - `failedCount: 0`
    - `branchOrder: ["asset", "uri", "ip"]`
  - Branch-local context stayed isolated from parent context:
    - URI branch stored `branchValue: "api.example.com"`.
    - IP branch stored `branchValue: true`.
    - Parent context did not contain top-level `branchValue`.
  - Run timeline persisted `parallel_completed`.
  - Summary log payload persisted
    `{ "succeeded": 3, "failed": 0, "host": "api.example.com", "internal": true }`.

Status: complete for M11.9 parallel runtime.

### M11.10 - Parallel UI

Goal: make parallel branches authorable from the clean canvas.

Scope:

- Add `Parallel` to Add Step modal.
- Canvas card shows branch count and status summary.
- Card exposes branch output handles or branch rows.
- Right inspector manages:
  - branch ids/labels
  - branch node membership
  - concurrency
  - failFast
  - aggregate assignment
- Run overlay maps branch/step statuses back to the card.

TDD:

- Web helper tests for graph projection of parallel branch references.
- Web helper tests for parallel edge mutation.
- Playwright:
  - add parallel card
  - add two branch steps
  - save
  - test-run
  - verify branch outputs in run detail.

Validation:

- `pnpm --filter web test -- workflow-graph.test.ts workflow-edges.test.ts workflow-authoring.test.ts workflow-run-overlay.test.ts`
- `pnpm --filter web check-types`
- `pnpm --filter web build`
- Deployed UI smoke on `3458`.

Acceptance:

- A human can configure parallel without raw JSON.
- Agents can still author the same workflow via API without `ui` metadata.

Validation record - 2026-08-01:

- Implemented dynamic `branch:<id>` graph handles and branch reference edges
  for `builtin.parallel`.
- Added branch count badges and branch route `+` buttons on the canvas.
- Added edge mutation support for `branches[].nodes`, including connect,
  reconnect, and remove behavior.
- Added right-inspector controls for concurrency, fail fast, branch id/label,
  branch node membership, add/remove branch, and aggregate assignment guidance.
- `pnpm --filter web test -- workflow-graph.test.ts workflow-edges.test.ts workflow-authoring.test.ts workflow-run-overlay.test.ts`
  passed: 4 test files, 29 tests.
- `pnpm --filter web check-types` passed.
- `pnpm --filter web build` passed with the existing Vite chunk-size warning.
- Live UI smoke on `http://127.0.0.1:3458/workflows?id=wf_m11_parallel_live_20260801015925&run=76e04ebd-9f15-439c-9e40-c2d49ddcc27e`
  showed `parallel_enrichment` with `succeeded`, `builtin.parallel`,
  `3 branches`, and `parallel` badges; branch routes for `Asset`, `URI`, and
  `IP`; branch-specific add-step buttons; and the parallel run aggregate
  output.
- Edit-mode inspector smoke showed the `Parallel` section with `Concurrency`,
  `Fail fast`, `Branch ID`, `Label`, branch node membership, `Add Branch`, and
  `assign.parallelSummary = $.steps.parallel_enrichment.output` guidance.
- Foreach canvas UX clarification - 2026-08-01:
  - `builtin.foreach` now draws one body entry edge from the foreach card to
    the first visible body node instead of drawing a body edge to every body
    node.
  - Body-internal node ordering is shown by normal sequence edges, for example
    `normalize_asset -> log_asset`.
  - Foreach cards now show a readable summary such as
    `For each $.workflowTrigger.input.assets as asset` instead of repeating only the node id.
  - `pnpm --filter web test -- workflow-graph.test.ts workflow-edges.test.ts workflow-authoring.test.ts workflow-run-overlay.test.ts`
    passed: 4 test files, 29 tests.
  - `pnpm --filter web check-types` passed.
  - `pnpm --filter web build` passed with the existing Vite chunk-size warning.
  - Live UI smoke on `3458` created workflow
    `wf_foreach_canvas_smoke_20260801101854` and run
    `ed30a91c-a1c6-4509-899f-b3b1a9c11769`; the snapshot showed
    `Edge from each_asset to normalize_asset`,
    `Edge from normalize_asset to log_asset`, no `each_asset -> log_asset`
    body edge, and card summary `For each $.workflowTrigger.input.assets as asset`.

Status: complete for M11.10 parallel UI.

### M11.11 - Skill, API, And Runbook Update

Goal: keep agent-facing workflow authoring complete after the capability
expansion. This is a development-plan milestone, not a place to store the plan
inside a skill file. The skill update is a required release artifact because
agents must learn the newly supported runtime/API/UI behavior before the
milestone closes.

Scope:

- Update `.claude/skills/openacme-workflow-author`.
- Update `packages/skills/builtin/openacme-workflow-author`.
- Keep the two directories in sync.
- Document all new node types, transform operations, API examples, and run
  inspection patterns.
- Document how agents discover MCP tool descriptions and parameter structures
  from the workflow API endpoint family before authoring MCP-backed nodes.
- Document the manual-trigger-first creation flow, branch routing semantics,
  run history inspection, step input/output/log/error lookup, and test/save
  practices.
- Add example workflows:
  - foreach aggregate
  - parallel enrichment
  - CSV parse/string replace/log
  - IP subnet branch
  - URI parse into MCP input
- Update `openacme-platform` only if routing language changes.

TDD / validation:

- Skill validator for both workflow skill copies where applicable.
- `diff -qr .claude/skills/openacme-workflow-author packages/skills/builtin/openacme-workflow-author`
- API smoke creates one workflow from the documented JSON example.

Acceptance:

- The milestone is not considered complete until the workflow-authoring skill
  documents every new M11 flow-control capability that is actually supported by
  runtime/API/UI.
- Acme/platform-admin agents can discover and explain all new workflow
  capabilities.
- Workflow-authoring agents can create, run, inspect, and debug workflows using
  only API/import-export paths.

Validation record - 2026-08-01:

- Updated `.claude/skills/openacme-workflow-author` and
  `packages/skills/builtin/openacme-workflow-author` with the M11
  flow-control/API/run-inspection contract.
- Skill now documents manual-trigger-first creation, `builtin.if` true/false
  routing, foreach aggregation, parallel branch routing and aggregate output,
  throw error, sleep, log warn, assignment `replace`/`append`/`merge`, transform
  operations, MCP/agent inventory discovery, API-first save/test/publish/run
  paths, failed-run listing, and step input/output/log/error lookup.
- `diff -qr .claude/skills/openacme-workflow-author packages/skills/builtin/openacme-workflow-author`
  passed with no output.
- `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/openacme-workflow-author`
  passed.
- `python3.11 /Users/alenbohcelyan/.codex/skills/.system/skill-creator/scripts/quick_validate.py packages/skills/builtin/openacme-workflow-author`
  passed.
- During the API smoke, run-level `durationMs` was found missing from the
  persisted public run contract. Fixed this by adding
  `workflow_runs.duration_ms`, wiring it through workflow run schema, store
  create/update/list/get, cancel/finalize route paths, and adding migration
  `packages/db/drizzle/0020_majestic_sally_floyd.sql`.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts workflow-store.test.ts`
  passed: 2 test files, 19 tests.
- `pnpm --filter @openacme/server test -- workflow-routes.test.ts` passed: 40
  tests.
- `pnpm --filter @openacme/workflows test -- schemas.test.ts runner.test.ts`
  passed: 77 tests.
- `pnpm --filter @openacme/workflows check-types`,
  `pnpm --filter @openacme/db check-types`, and
  `pnpm --filter @openacme/server check-types` passed.
- `pnpm --filter @openacme/workflows build`,
  `pnpm --filter @openacme/db exec tsc --build --force`, and
  `pnpm --filter @openacme/server build` passed.
- Restarted the isolated test server with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow` and
  `OPENACME_PORT=3458`; health returned
  `{"status":"ok","version":"0.14.0","agents":10,"skills":3}`.
- Live API smoke on `3458` created workflow
  `wf_skill_m11_author_20260801022148`, read 103 MCP tools and 10 agents from
  inventory endpoints, ran test run
  `b6a90422-a9fe-476d-87fd-165df2159aff`, verified status `succeeded`,
  persisted `durationMs: 526`, transform overwrite output `Ada Lovelace`,
  true route log step `succeeded`, and false route log step `skipped`.

Status: complete for M11.11 skill, API, and runbook update.

## Test Strategy

### Unit And Package Tests

Primary commands:

```bash
pnpm --filter @openacme/workflows test -- schemas.test.ts validation.test.ts runner.test.ts
pnpm --filter @openacme/workflows check-types
```

Add tests before implementation for every schema/runtime behavior. Prefer small
fixtures and explicit expected output over snapshot-heavy tests.

### Server API Tests

Primary command:

```bash
pnpm --filter @openacme/server test -- workflow-routes.test.ts
```

Use server tests when:

- Run detail shape changes.
- Events/logs/errors change.
- API validation changes.
- Persisted definitions or published versions change.
- Duration/status/cancel behavior changes.

### Web Tests

Primary commands:

```bash
pnpm --filter web test -- workflow-authoring.test.ts workflow-graph.test.ts workflow-edges.test.ts workflow-run-overlay.test.ts
pnpm --filter web check-types
pnpm --filter web build
```

Use Playwright only for user-visible behavior:

```bash
OPENACME_E2E_PORT=3458 OPENACME_E2E_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow pnpm --dir apps/web exec playwright test workflows.spec.ts -g "<focused test>"
```

Do not use port `3456`. Do not use production `~/.openacme`.

### Deployed Test-Environment Smoke

Each runtime/UI slice after schema-only work needs one deployed-style smoke
against the isolated workflow data dir:

```bash
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow OPENACME_PORT=3458 node packages/server/dist/index.js
```

Then verify with API or Playwright:

```bash
curl -sS http://127.0.0.1:3458/api/health
curl -sS http://127.0.0.1:3458/api/skills
```

Acceptance evidence should record:

- Exact command.
- Port.
- Data dir.
- Workflow id.
- Run id.
- Final run status.
- Step ids inspected.
- Output/log/error facts that prove the slice.

## UI/UX Requirements

- Add-step modal should list new nodes without long descriptions in the center
  list.
- Hovering or selecting a tool/node updates the detail panel.
- Right inspector uses collapsed sections with icon-only expand/collapse
  controls.
- Transform inspector should offer presets for common operations instead of
  forcing raw JSON first.
- Advanced JSON remains available for agents/operators who need exact payloads.
- If node has true/false or branch outputs, the canvas must label routes at the
  handles/connection points.
- Ordinary sequential connector lines should not show noisy labels.
- Backend exit remains hidden from ordinary canvas authoring.
- Parallel card should show branch labels and per-branch status after a run.
- Foreach card should show item count and aggregate status after a run.

## Data Model And Compatibility

- Existing definitions without new nodes keep parsing.
- Existing `builtin.if_else` remains valid for historical workflows, but the UI
  should create only `builtin.if`.
- Existing `object_pick` transforms keep working.
- Existing `concurrency: 1` foreach workflows keep working.
- New node schemas require published version snapshots to preserve exact
  definition JSON.
- Run history for old workflows remains inspectable.

## Risks

- Parallel context isolation is the highest-risk runtime change. It should not
  share mutable `state.context` across branches.
- Regex and CSV transforms can create large outputs. Add size guardrails early.
- IP/URI helpers can be deceptively tricky. Use proven parsing behavior and
  exhaustive tests.
- UI can become complex again if every transform operation exposes raw fields at
  once. Use presets and progressive disclosure.
- Hidden backend exit must not make run termination confusing. Run detail needs
  clear terminal status/output.

## Completion Definition

This capability expansion is complete when:

- All accepted node/transform capabilities are documented in the workflow
  authoring skill.
- Human UI and agent API authoring have parity.
- Runtime tests cover success, failure, cancellation where relevant, and run
  evidence shape.
- Server route tests prove persisted run detail exposes input/output/log/error
  evidence.
- UI tests prove the canvas/inspector can author and inspect the new behavior.
- At least one deployed-style smoke on the isolated test data dir proves each
  runtime family:
  - foreach aggregate
  - parallel aggregate
  - throw/sleep/log.warn
  - string/regex/CSV/JSON transform
  - IP/subnet transform
  - URI parse transform
- No validation uses production `~/.openacme` or port `3456`.
