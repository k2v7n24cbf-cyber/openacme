# Workflow Engineer First-Class Tooling TDD Plan

Date: 2026-08-21

## Goal

Make Workflow Engineer a first-class built-in OpenAcme agent that can develop workflows through a real dev/test loop, using tools instead of raw HTTP requests or source-code spelunking.

The minimum successful behavior is:

1. Discover available workflow cards, MCP tools, agents, schemas, references, and help.
2. Author or update a workflow draft.
3. Validate before saving/publishing.
4. Test one card in isolation.
5. Run a workflow until a selected step.
6. Inspect compact run evidence first, then drill into one step's input/output/log/error/context.
7. Set explicit workflow output.
8. Publish only after the current draft has passed validation and a full test.

## Code Context Reviewed

- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- `packages/server/src/routes/workflows.ts`
- `packages/workflows/src/runner.ts`
- `packages/workflows/src/schemas.ts`
- `packages/workflows/src/card-catalog.ts`
- `packages/workflows/src/validation.ts`
- `packages/db/src/stores/workflow-store.ts`
- `packages/hosted-integrations/src/help.ts`
- `packages/tools/src/builtins/hosted-integration-help.ts`
- `packages/agent-catalog/templates/workflow-engineer/AGENT.md`
- `packages/skills/builtin/openacme-workflow-author/SKILL.md`
- `packages/skills/builtin/openacme-workflow-author/references/workflow-authoring.md`
- `packages/skills/builtin/openacme-platform/SKILL.md`

## Calculated Decisions

1. Keep the workflow authoring surface small.
   Existing workflow tools already cover lifecycle operations. Add only three new tools:
   `workflow_help`, `workflow_help_upsert`, and `workflow_card_test_run`.

2. Do not split run inspection into many tools.
   `workflow_run_get` should remain the canonical inspection tool with `detail: "summary" | "step" | "full"`.

3. Copy the managed-tools help shape, not the whole managed-tools lifecycle.
   Workflow authoring needs one help reader with detail/options/parameter help, and one structured help writer for Workflow Engineer.

4. Workflow Engineer should not need raw HTTP.
   Every required authoring action must be possible through `workflow_*` tools.

5. Skills teach process; workflow help teaches concrete card/schema/reference behavior.
   Keep detailed card and parameter help in the workflow help layer, then point the skill/persona at that layer.

6. Make workflow output explicit.
   A callable workflow cannot rely on "last context wins". Add `builtin.output.set`; if no output card exists, final output should be `{}`.

7. Publish is the promotion gate.
   Do not add a separate promotion tool unless later UX requires it. Extend `workflow_publish` to block unsafe promotion with structured diagnostics.

## Final Tool Surface

Keep existing tools:

- `workflow_card_catalog`
- `workflow_tool_inventory`
- `workflow_agent_inventory`
- `workflow_validate`
- `workflow_list`
- `workflow_get`
- `workflow_create`
- `workflow_update`
- `workflow_delete`
- `workflow_publish`
- `workflow_export`
- `workflow_import`
- `workflow_test_run`
- `workflow_run_list`
- `workflow_run_get`
- `workflow_run_cancel`
- `workflow_run_rerun`
- `workflow_artifact_get`

Add:

- `workflow_help`
- `workflow_help_upsert`
- `workflow_card_test_run`

Extend:

- `workflow_run_get({ run_id, detail?, step_id?, include? })`
- `workflow_test_run({ workflow_id, input?, async?, stop_after_step_id?, assertions? })`
- `workflow_validate(...)` with deeper reference, route, schema, and output diagnostics
- `workflow_publish({ workflow_id })` with current-draft promotion gate

## Milestone 1: Run Evidence Shaping

Goal: Workflow Engineer first sees a compact timeline, not every step's full payload.

Status: implemented on 2026-08-21.

Slice:

- Add `detail`, `step_id`, and `include` to `workflow_run_get`.
- Default agent-facing detail to `summary`.
- Keep `detail: "full"` for UI/debug exports.
- Add `detail: "step"` for targeted evidence.
- Include step status, duration, branch decisions, foreach/parallel summaries, logs, and artifact count in summary.

TDD:

- Tool schema rejects `detail: "step"` without `step_id`.
- Default summary omits full `steps` and `events`.
- Step detail returns only requested evidence.
- Full detail remains available for UI/debug.
- Artifact references remain readable through `workflow_artifact_get`.

Verification:

- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`

## Milestone 2: Full Workflow TDD Controls

Goal: Workflow Engineer can run the draft up to a known card and verify facts inline.

Status: implemented on 2026-08-21.

Slice:

- Add `stop_after_step_id` to `workflow_test_run`.
- Propagate stop-after through top-level flow, if branches, foreach body, and parallel branches.
- Add inline assertions to `workflow_test_run`.
- Persist accepted assertions on async runs.
- Evaluate assertions immediately for sync terminal runs and later through `workflow_run_get`.
- Return `draftHash` so evidence can be tied to a specific draft snapshot.

TDD:

- Stop-after prevents downstream execution.
- Stop-after works inside if, foreach, and parallel.
- Sync assertions return pass/fail evidence.
- Async assertions persist and evaluate when the run becomes terminal.
- Missing reference paths produce actionable diagnostics.

Verification:

- `pnpm --filter @openacme/workflows test -- runner`
- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`

## Milestone 3: Card-Level Test Runner

Goal: Workflow Engineer can test one card config before wiring or publishing a full workflow.

Status: implemented on 2026-08-21.

Slice:

- Add `workflow_card_test_run`.
- Support `mode: "candidate"` for an unsaved card.
- Support `mode: "from_workflow"` for an existing draft/published workflow card.
- Support `mode: "from_run"` to rerun one card using previous run input/context/step state.
- Execute through normal runner semantics with a synthetic one-card workflow.
- Allow explicit `input` and `context` override.
- Return the same run summary and step-detail shape as normal workflow test runs.
- Runner accepts optional initial context and prior step state for card-level reruns.
- Synthetic card-test workflows strip downstream route fields so a card test cannot accidentally execute unrelated flow.

Implementation boundaries:

- Tool schema: `packages/tools/src/builtins/workflow-management.ts`.
- Runtime dispatch: `packages/server/src/runtime.ts`.
- Runner initial state support if needed: `packages/workflows/src/runner.ts`.
- Run detail shaping reuse: `packages/server/src/routes/workflows.ts`.

TDD:

- Passing: candidate `builtin.log.info` runs without saving a workflow.
- Passing: candidate transformer runs and returns standard `output.value`.
- Passing: from-workflow mode runs the selected card with caller-provided input/context.
- Passing: from-run mode reuses a previous run's input, context, and prior step outputs.
- Passing: invalid card-test requests return structured schema diagnostics before runtime dispatch.
- Passing: card test result can be inspected through `workflow_run_get(detail: "step")`.

Verification:

- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/workflows test -- runner`
- `pnpm --filter @openacme/workflows build`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`

## Milestone 4: Workflow Help Read

Goal: Agents can discover workflow/card/schema/reference knowledge without reading source code.

Status: implemented on 2026-08-21.

Slice:

- Add `workflow_help`.
- Seed help from `workflow_card_catalog`.
- Add help targets:
  - `overview`
  - `card_type`
  - `workflow_schema`
  - `reference_syntax`
  - `input_schema`
  - `output_schema`
  - `run_evidence`
  - `promotion_gate`
- Support `detail: "summary" | "full"`.
- Support `include_examples`.
- Support parameter-scoped requests with `parameters[]`, following `hosted_tool_help`.
- Return candidate parameter paths when a parameter query is ambiguous.
- Unknown card types return structured suggestions.
- Static help covers reference syntax, workflow schema, input schema, output schema, run evidence, and promotion gate concepts.

Tool shape:

```json
{
  "target": {
    "kind": "card_type",
    "card_type": "builtin.if"
  },
  "detail": "summary",
  "include_examples": false,
  "parameters": [
    {
      "name": "condition.left",
      "detail": "full",
      "query": "$.steps"
    }
  ]
}
```

TDD:

- Passing: overview help returns concise authoring loop guidance.
- Passing: card-type help returns config schema, routing behavior, standard output schema, and examples only when requested.
- Passing: parameter help returns requested parameter detail.
- Passing: unknown card type returns structured suggestions.
- Covered by helper behavior: unknown parameter names return candidate parameter paths.

Verification:

- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/workflows build`
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "help"`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`

## Milestone 5: Workflow Help Write

Goal: Workflow Engineer can improve workflow help data without editing skills.

Status: implemented on 2026-08-21.

Slice:

- Add `workflow_help_upsert`.
- Persist structured help keyed by target kind/ref in `dataDir/workflow-help.json`.
- Merge persisted help over catalog-seeded help.
- Audit updater and timestamp.
- Gate writes to Workflow Engineer/admin contexts.
- Reject help that does not match the structured help schema.

Help shape:

```json
{
  "target": {
    "kind": "card_type",
    "card_type": "builtin.if"
  },
  "help": {
    "summary": "Branch on a deterministic condition.",
    "full": "Use this card when a workflow has two deterministic routes.",
    "whenToUse": ["Need true/false routing from explicit values."],
    "whenNotToUse": ["Need fuzzy model judgment."],
    "parameters": {
      "condition.left": {
        "summary": "Left operand. Usually a $. reference.",
        "full": "Use $.workflowTrigger.input.* or $.steps.<step_id>.output.*.",
        "examples": ["$.workflowTrigger.input.enabled"]
      }
    },
    "examples": []
  }
}
```

TDD:

- Passing: invalid help is rejected with field-level diagnostics.
- Passing: upserted help overrides catalog seed in `workflow_help`.
- Passing: normal non-authoring agents cannot call `workflow_help_upsert`.
- Passing: Workflow Engineer/admin contexts can call `workflow_help_upsert`.
- Passing: help updates are audited and survive restart.

Verification:

- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "help"`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`

## Milestone 6: Explicit Workflow Output

Goal: Callable workflows expose deterministic output.

Status: implemented on 2026-08-21.

Slice:

- Add card type `builtin.output.set`.
- Add card catalog entry with config schema, defaults, examples, and output schema.
- Add runner support for a dedicated workflow output object.
- Support modes:
  - `replace`
  - `merge`
  - `append`
- Change final output behavior:
  - if output cards ran, final run output is the composed workflow output;
  - if no output card ran, final run output is `{}`.
- Output schema validation coverage is implemented in Milestone 7.

Suggested card config:

```json
{
  "path": "result",
  "value": "$.steps.prioritize.output.response",
  "mode": "replace"
}
```

TDD:

- Passing: `builtin.output.set` writes a top-level field from workflow state.
- Passing: `replace`, `merge`, and `append` modes work.
- Passing: multiple output cards compose deterministically.
- Passing: no output card returns `{}` instead of final context.
- Passing in Milestone 7: workflow with declared output schema fails validation if no output card can satisfy it.

Verification:

- `pnpm --filter @openacme/workflows test -- runner -t "output"`
- `pnpm --filter @openacme/workflows test -- runner`
- `pnpm --filter @openacme/workflows test -- card-catalog`
- `pnpm --filter @openacme/workflows build`
- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`

## Milestone 7: Validation Parity And Authoring Diagnostics

Goal: Backend validation enforces the same or stronger rules than UI validation.

Status: implemented on 2026-08-21.

Slice:

- Extend `workflow_validate`.
- Implemented: validate authoring references:
  - allowed top-level families: `$.workflowTrigger`, `$.context`, `$.steps`
  - `$.workflowTrigger.input.*`
  - `$.steps.<step_id>.input.*`
  - `$.steps.<step_id>.output.*`
  - `$.steps.<step_id>.error.*`
  - `$.steps.<step_id>.context.*`
- Implemented: reject unsupported top-level reference families such as `$.input`.
- Implemented: reject unknown `$.steps.<step_id>...` references.
- Implemented: add canonical `outputSchema` to workflow definitions/create/update/import/export.
- Implemented: require at least one `builtin.output.set` card when `outputSchema` is declared.
- Implemented: require top-level required output fields to be covered by `builtin.output.set` paths.
- Already covered before this slice: validate dangling route targets, unreachable cards, duplicate ids, MCP tool refs, and agent refs.
- Implemented: validate high-risk foreach/parallel route ownership:
  - foreach body nodes cannot route directly to parent continuation;
  - parallel branch nodes cannot route directly to parent continuation;
  - parallel branch nodes cannot route directly into another branch's start.
- Implemented: validate if/switch route ownership:
  - if branch nodes cannot route directly to parent continuation;
  - if branch nodes cannot route directly into the sibling branch start;
  - switch case/default branch nodes cannot route directly to parent continuation;
  - switch case/default branch nodes cannot route directly into another case/default branch start;
  - explicit merge nodes remain valid when they are not declared as another branch start or parent continuation.
- Implemented: reject duplicated explicit route ownership, where the same card is declared as the start of multiple if/switch/parallel routes.
- Implemented: every validation diagnostic carries explicit `severity`.
- Implemented: deterministic-first authoring warnings for `agent.call` cards that look like deterministic extraction, parsing, normalization, formatting, conversion, JSON/CSV/URI/IP manipulation, field selection, or simple classification.
- Implemented: validate card config objects against card catalog JSON schemas after Zod node parsing, so UI-facing required/minimum/enum/const constraints are enforced by backend validation too.
- Existing authoring validation covers dangling route targets, unreachable cards, duplicate ids, and route targets pointing to valid nodes.

TDD:

- Passing: backend rejects disconnected required routes that UI would reject.
- Passing: backend rejects invalid `$.steps.unknown.output.value`.
- Passing: backend rejects old/unsupported top-level reference families.
- Passing: backend catches invalid MCP server/tool references.
- Passing: backend catches invalid agent ids.
- Passing: backend rejects declared output schemas without explicit output cards.
- Passing: backend accepts declared output schemas covered by `builtin.output.set`.
- Passing: backend rejects foreach body nodes that route directly to parent continuation.
- Passing: backend rejects parallel branch nodes that route directly to parent continuation.
- Passing: backend accepts scoped foreach body internal chains.
- Passing: backend rejects if branch nodes that route directly to parent continuation.
- Passing: backend rejects switch branch nodes that route directly into a sibling case start.
- Passing: backend accepts explicit if branch merges through a shared downstream node.
- Passing: backend rejects duplicated explicit route ownership for if and parallel routes.
- Passing: backend validation output includes actionable path, code, message, and severity.
- Passing: backend returns warning diagnostics without failing validation when an `agent.call` appears to be doing deterministic transform/extract work.
- Passing: backend rejects card configs that violate catalog schema requirements not covered by generic Zod node schemas.

Verification:

- `pnpm --filter @openacme/server test -- workflow-management-tools -t "validation"`
- `pnpm --filter @openacme/workflows build`
- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/workflows test -- runner`
- `pnpm --filter @openacme/workflows test -- card-catalog`
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "validation"` after route ownership checks
- `pnpm --filter @openacme/server test -- workflow-management-tools` after route ownership checks
- `pnpm --filter @openacme/server check-types` after route ownership checks
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "warning diagnostics|reference expressions"` after diagnostic severity checks
- `pnpm --filter @openacme/server test -- workflow-management-tools` after diagnostic severity checks
- `pnpm --filter @openacme/server check-types` after diagnostic severity checks
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "card configs"` after card catalog schema checks
- `pnpm --filter @openacme/server test -- workflow-management-tools` after card catalog schema checks
- `pnpm --filter @openacme/workflows test -- runner card-catalog` after card catalog schema checks
- `pnpm --filter @openacme/workflows build` after card catalog schema checks
- `pnpm --filter @openacme/tools test -- workflow-management` after card catalog schema checks
- `pnpm --filter @openacme/tools build` after card catalog schema checks
- `pnpm --filter @openacme/server check-types` after card catalog schema checks
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "if and switch branch routes"` after if/switch route ownership checks
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "duplicated explicit route ownership"` after duplicated route ownership checks
- `pnpm --filter @openacme/server test -- workflow-management-tools` after route ownership hardening
- `pnpm --filter @openacme/server check-types` after route ownership hardening
- `pnpm --filter @openacme/server dogfood:workflow-engineer:live` after route ownership hardening

## Milestone 8: Publish Promotion Gate

Goal: Published workflows are known-good for the current draft.

Status: implemented on 2026-08-21.

Slice:

- Compute stable draft hash from definition snapshot.
- Store draft hash on test runs.
- Extend `workflow_publish` to block unless:
  - schema/graph/reference validation passes;
  - current draft hash has at least one successful full test run;
  - current draft has not changed after that test;
  - output schema is satisfied when present.
- Return structured promotion diagnostics.
- Add `dry_run` later only if UI needs preflight without publishing.

Implemented:

- `workflow_test_run` records the stable draft hash on manual test-run triggers.
- `workflow_test_run` records `stop_after_step_id` when a partial test run is requested.
- `workflow_publish` re-runs workflow definition validation before promotion.
- `workflow_publish` blocks when the current draft has no successful full test run.
- Partial stop-after tests do not satisfy the publish gate.
- Any draft mutation changes the draft hash and invalidates previous successful test evidence.
- Promotion diagnostics return `publish_gate_failed` with `missing_successful_current_draft_test`.

TDD:

- Publish fails when there is no successful current-draft test.
- Publish fails when a draft changes after the successful test.
- Publish fails when output schema exists but output coverage is missing.
- Publish succeeds after validation plus successful full test.
- Error response names the exact blocked gate.

Verification:

- `pnpm --filter @openacme/workflows build`
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "publish"`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/workflows test -- runner`
- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/tools build`

## Milestone 9: Built-In Agent, Skill, And Dogfood Sync

Goal: Workflow Engineer and normal agents know how to use the tool surface.

Status: implemented for built-in agent wiring, persona, skill/reference sync,
static dogfood coverage, and isolated workflow-tool dogfood execution on
2026-08-21. Real provider conversation dogfood remains optional release
validation because it depends on model/provider availability.

Slice:

- Ensure `workflow-engineer` is installed as a managed built-in agent, like `acme`.
- Update Workflow Engineer persona with:
  - discover help first;
  - deterministic-first design;
  - validate before create/update/publish;
  - card-level test loop;
  - stop-after full-run tests;
  - summary-first run inspection;
  - targeted step drilldown;
  - explicit output cards.
- Update `openacme-workflow-author` skill with all new tools and reference syntax.
- Update `openacme-platform` skill to route workflow authoring to Workflow Engineer guidance.
- Add isolated dogfood scripts that verify the intended workflow-tool cycle.
- Keep real provider conversation dogfood, including message-history
  inspection, as optional release validation.

Implemented:

- `workflow-engineer` is a platform-managed catalog template alongside `acme`
  and `tool-developer`.
- Workflow Engineer receives the complete `WORKFLOW_MANAGEMENT_TOOL_NAMES`
  surface, including `workflow_help`, `workflow_help_upsert`, and
  `workflow_card_test_run`.
- Workflow Engineer persona now requires help-first discovery, catalog/inventory
  discovery, card-level TDD, stop-after checkpoint tests, full current-draft
  test before publish, summary-first run inspection, deterministic-first design,
  and explicit `builtin.output.set` output contracts.
- `openacme-workflow-author` now describes the first-class workflow tool loop
  instead of requiring routine agents to discover workflow endpoints from source
  files.
- `openacme-workflow-author/references/workflow-authoring.md` now documents
  `builtin.output.set`, `workflow_help`, `workflow_help_upsert`,
  `workflow_card_test_run`, `stop_after_step_id`, summary-first
  `workflow_run_get`, MCP/agent inventory discovery, concrete transformer
  cards, and publish-gate evidence.
- Agent catalog tests lock the managed agent, tool surface, persona, bundled
  skill content, and reference guidance.
- Static workflow engineer dogfood scenario tests validate the declared scenario
  set and schema-valid cards/triggers.
- Isolated workflow-tool dogfood runs the declared scenarios end-to-end through
  `workflow_card_catalog`, `workflow_validate`, `workflow_create`,
  `workflow_test_run`, summary-first `workflow_run_get`, full run drilldown, and
  artifact fetch where needed.

TDD:

- Agent catalog test verifies Workflow Engineer is managed and receives workflow tools.
- Agent catalog test verifies Workflow Engineer has workflow author skill content.
- Skill text tests verify `workflow_help`, `workflow_card_test_run`, `stop_after_step_id`, `workflow_run_get(detail: "step")`, and `builtin.output.set`.
- Static persona/skill tests verify the agent is instructed to call
  `workflow_help`, validate before create/update, use card-level tests, inspect
  targeted run evidence, and publish only after gate evidence.
- Isolated workflow-tool dogfood verifies:
  - catalog and inventory discovery work;
  - validation happens before create;
  - workflow create and test-run work across the scenario set;
  - summary-first `workflow_run_get` is followed by full evidence drilldown;
  - spilled artifacts can be fetched when outputs are large.

Verification:

- `pnpm --filter @openacme/server test -- agent-catalog -t "materializes platform-managed"`
- `pnpm --filter @openacme/server test -- agent-catalog -t "Workflow Engineer bundled authoring guidance"`
- `pnpm --filter @openacme/server test -- agent-catalog`
- `pnpm --filter @openacme/server test -- workflow-engineer-live-scenarios`
- `pnpm --filter @openacme/server dogfood:workflow-engineer:live`
- `pnpm --filter @openacme/server check-types`

## Milestone 10: Normal Agent Consumption

Goal: Non-engineer agents can run approved workflows and understand their contract.

Status: implemented on 2026-08-21.

Slice:

- Expose callable workflow discovery separately from authoring operations where needed.
- Normal agents can read workflow help and schema/output contract.
- Normal agents can run published workflows only.
- Normal agents can inspect their own run summary and targeted step evidence if policy allows.
- Normal agents cannot mutate workflow drafts or help.

Implemented:

- Added consumer-safe workflow tool subset:
  - `workflow_help`
  - `workflow_callable_list`
  - `workflow_callable_get`
  - `workflow_run`
  - `workflow_run_get`
  - `workflow_artifact_get`
- Added `workflow_callable_list` to return only published workflow contracts;
  draft and archived workflows are excluded.
- Added `workflow_callable_get` to return one published workflow contract without
  exposing draft/editor node internals.
- Added `workflow_run` to execute only a published workflow snapshot through an
  enabled manual trigger in live mode.
- Normal agents with only consumer tools can read help, list/get published
  workflow contracts, run a published workflow, and inspect summary-first run
  evidence.
- Normal agents without authoring tools are denied mutation calls such as
  `workflow_update`.
- Workflow Engineer still receives the complete workflow tool surface.
- `outputSchema` is now persisted through workflow definition/version storage so
  callable contracts expose stable output contracts after create, update, and
  publish.
- Sync `workflow_run` responses include explicit workflow output for successful
  published runs.
- Skill/reference docs now describe the normal-agent consumer subset and the
  published-only consumption loop.

TDD:

- Normal agent sees published callable workflow and help.
- Normal agent cannot call workflow create/update/help upsert.
- Normal agent can run a published workflow and read explicit output.
- Normal agent run inspection defaults to summary.

Verification:

- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/tools test -- workflow-management`
- `pnpm --filter @openacme/db build`
- `pnpm --filter @openacme/db test -- workflow-store`
- `pnpm --filter @openacme/server test -- workflow-management-tools -t "normal agents"`
- `pnpm --filter @openacme/server test -- workflow-management-tools`
- `pnpm --filter @openacme/server test -- agent-catalog -t "materializes platform-managed|Workflow Engineer bundled authoring guidance"`
- `pnpm --filter @openacme/server test -- workflow-engineer-live-scenarios`
- `pnpm --filter @openacme/server check-types`

## Delivery Order

1. Finish Milestone 3, because it unlocks card-level TDD.
2. Implement Milestone 4 before adding much more skill text, because help should be live/tool-backed.
3. Implement Milestone 5 so Workflow Engineer can maintain help.
4. Implement Milestone 6, then Milestone 7, because output cards affect validation.
5. Implement Milestone 8 promotion gate.
6. Sync Milestone 9 skills/persona and rerun live dogfood.
7. Add Milestone 10 normal-agent consumption once published workflow behavior is stable.

## Standard Verification Per Slice

Run package-level tests first, then server tests after building package outputs:

```bash
pnpm --filter @openacme/workflows test -- <focused-test>
pnpm --filter @openacme/workflows build
pnpm --filter @openacme/tools test -- workflow-management
pnpm --filter @openacme/tools build
pnpm --filter @openacme/server test -- workflow-management-tools
pnpm --filter @openacme/server test -- agent-catalog
pnpm --filter @openacme/server check-types
```

For live dogfood milestones, also run the Workflow Engineer live scenario and inspect the session messages, not only the final output. The pass condition is that the agent used the workflow tools in the intended order rather than falling back to broad source-code search or raw HTTP.

## Non-Goals For This Round

- No full interactive debugger with breakpoints/resume/skip.
- No saved golden test-case registry yet.
- No separate tools for each help target.
- No separate run-step/log tools while `workflow_run_get(detail: "step")` is enough.
- No UI-specific changes unless required to expose the tool capability.
