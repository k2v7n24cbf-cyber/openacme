# Workflow Engineer Development Loop Notes

Date: 2026-08-21

These notes capture the next workflow-authoring gaps to address before exposing workflows broadly to normal agents. The theme is moving Workflow Engineer from "writes workflow definitions" to "develops workflows with a real dev/test loop".

## 0. Code-Review Based Decisions

Reviewed code:

- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- `packages/server/src/routes/workflows.ts`
- `packages/db/src/stores/workflow-store.ts`
- `packages/workflows/src/schemas.ts`
- `packages/workflows/src/runner.ts`
- `packages/workflows/src/card-catalog.ts`
- `packages/workflows/src/validation.ts`
- `packages/hosted-integrations/src/help.ts`
- `packages/hosted-integrations/src/schemas.ts`
- `packages/server/src/routes/hosted-integrations.ts`

Current facts:

- Workflow lifecycle tools already exist for catalog, MCP inventory, agent inventory, validate, CRUD, publish, import/export, test run, run list/get/cancel/rerun, and artifact read.
- Runner state already exposes the right top-level reference families: `$.workflowTrigger`, `$.context`, and `$.steps`.
- Run persistence already records definition snapshots, step attempts, events, input, context, duration, and large-value artifacts.
- `workflow_run_get` currently returns full details by default, which is too large for agent development loops.
- `workflow_validate` already validates schema, graph completeness, route target references, triggers, MCP tools, and agent refs through runtime validation, but does not yet deeply validate expression references or output-card coverage.
- Card catalog already has card type metadata, config schema, route ports, examples, and output schema. It is the correct seed for card help.
- Managed integrations use one read help tool (`hosted_tool_help`) with detail/options plus structured help in the tool contract. Workflow should copy that shape, not the whole hosted integration lifecycle.
- Workflow run output currently falls back to final context when no explicit exit/output is set. That works technically but is not a clear contract for callable workflows.

Calculated decisions:

| Area | Decision | Reason |
| --- | --- | --- |
| Tool count | Add only `workflow_help`, `workflow_help_upsert`, and `workflow_card_test_run`; extend existing tools for the rest. | Existing workflow tool surface is already broad. More tools would duplicate lifecycle concepts and make agents hunt for the right tool. |
| Run inspection | Make `workflow_run_get` default to summary and add targeted `detail: "step"` / `detail: "full"` modes. | Store already has steps/events/artifacts, so this is a response-shaping change, not a new persistence model. |
| Step/log inspection | Do not add `workflow_run_step_get` or `workflow_run_logs` in the minimum scope. | `workflow_run_get({ detail: "step", step_id, include })` covers the same need with one canonical inspection tool. |
| Card TDD | Add `workflow_card_test_run`; do not add card-test get/rerun yet. | Single-card execution is a distinct dev action. History can still be inspected through normal run tools if persisted. Get/rerun can wait until there is a clear saved card-test object. |
| Run-until | Extend `workflow_test_run` with `stop_after_step_id`. | Runner execution path is recursive and can stop after a card with a small state flag. Full debugger semantics are unnecessary now. |
| Assertions | Add inline assertions to `workflow_test_run`, sync-first. | Assertions make TDD practical without adding a saved test registry. Async assertion persistence can come later. |
| Help | Add `workflow_help` and `workflow_help_upsert` with managed-tools-like structure. | Skills teach process; help teaches concrete cards/schema/refs. Workflow Engineer must be able to improve help data. |
| Help storage | Use a dedicated persisted workflow help store keyed by target kind/ref, seeded from card catalog. | Workflow cards live in code, workflows live in DB, and agent-authored help needs audit/history. Overloading skill text or workflow description is the wrong persistence boundary. |
| Publish readiness | Extend `workflow_publish` with promotion gate; optionally add `dry_run` later. | Publish is the transition that needs enforcement. A separate promote tool is unnecessary now. |
| Workflow output | Add an explicit `builtin.output.set` card and output-schema validation. | Callable workflows need a declared output contract; final context fallback is too implicit. |

## 1. Card-Level TDD Loop

Workflow Engineer should be able to run one card at a time and inspect the result before running the full workflow.

Needed capabilities:

- `workflow_card_test_run`

Test modes:

- `candidate`: run an unsaved card config.
- `from_workflow`: run a card from a draft or published workflow.
- `from_run`: rerun a card using input/context from a previous workflow run.

Goal: enable card config -> card test -> inspect output/log/error -> adjust -> full workflow test.

Minimal full-run debug extension:

- `workflow_test_run` should support `stop_after_step_id`.

This is not a full step debugger. It only lets Workflow Engineer run a workflow up to a known card and inspect the intermediate state. That keeps complexity low while supporting the most common "does the flow work up to here?" development loop.

## 2. Strong Workflow Help Layer

Workflow definition metadata is too thin if it is only title and description. Workflow authoring needs a first-class help layer similar to managed tools.

Do not create a large family of separate help tools. Managed integrations use one canonical consumer-facing help tool, `hosted_tool_help`, with parameters such as `tool_detail`, `include_examples`, and `parameters[]` for field-level detail or vocabulary lookup. Workflow help should follow that shape.

Recommended read capability:

- `workflow_help`

Suggested request shape:

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

Target kinds should cover:

- `overview`
- `card_type`
- `workflow_schema`
- `reference_syntax`
- `output_schema`
- `run_evidence`

The same tool should return tool/card-level help plus requested parameter-level help. If parameter help is ambiguous, it should return candidate parameter paths and ask the agent to retry with one precise path.

Help should explain:

- when to use the card;
- when not to use the card;
- field-level input guidance;
- standard output schema;
- routing behavior;
- deterministic alternatives;
- common mistakes;
- minimal working examples.

Recommended write capability:

- `workflow_help_upsert`

Workflow Engineer must be able to set and improve help data. Help authoring should be structured, validated, and persisted, not hidden in free-form skill text.

Suggested write shape:

```json
{
  "target": {
    "kind": "card_type",
    "card_type": "builtin.if"
  },
  "help": {
    "summary": "Branch on a deterministic condition.",
    "full": "Use this card when a workflow has exactly two deterministic routes...",
    "whenToUse": ["Need true/false routing from explicit values."],
    "whenNotToUse": ["Need model judgment or fuzzy classification."],
    "parameters": {
      "condition.left": {
        "summary": "Left operand. Usually a $. reference.",
        "full": "Use $.workflowTrigger.input.* or $.steps.<step_id>.output.*.",
        "examples": ["$.workflowTrigger.input.enabled"]
      }
    },
    "examples": [
      {
        "condition": {
          "left": "$.workflowTrigger.input.enabled",
          "operator": "is_true"
        }
      }
    ]
  }
}
```

This mirrors hosted integration help concepts: `summary`, `full`, `whenToUse`, `whenNotToUse`, `parameterHelp`, examples, and validation.

## 3. Input Schema Guidance

JSON Schema can remain the canonical contract, but agents should not need to reason through raw complex schemas as their primary authoring interface.

Needed improvements:

- field-level help;
- generated valid sample input;
- validation errors with exact path and plain-language explanation;
- named components for complex objects;
- simple-first schema design;
- avoid forcing complex object construction unless necessary.

Example direction: represent `assets` as `Asset[]`, then document `Asset` fields and provide a minimum valid sample.

The help layer should make complex schemas progressive:

- summary-level help returns only required fields and common examples;
- full parameter help explains nested objects and arrays;
- generated sample input uses the workflow input schema when present;
- complex object help should be named and reusable, e.g. `Asset`, `Vulnerability`, `RouteBranch`;
- agents should request parameter-specific help instead of reading the whole schema dump.

## 4. Deterministic-First Workflow Design

Workflow Engineer should prefer deterministic workflow logic before AI calls.

Policy:

- Use built-in deterministic cards first: set, transform, if, switch, foreach, parallel, log, output, and tool calls.
- Use AI agent calls only for judgment, prioritization, interpretation, narrative synthesis, or when the user explicitly asks for AI reasoning.
- Prefer explicit references and structured outputs over natural-language handoff between steps.

Future validation can warn when an AI card appears replaceable by deterministic transform/control-flow cards.

## 5. Lazy Run Evidence Inspection

Workflow test/run output is too large if every card input/output is returned by default. The first response should be a timeline summary, with details fetched on demand.

Default run summary should include:

- trigger started;
- each executed step status;
- branch decisions;
- foreach iteration count;
- parallel branch status;
- final workflow output status;
- errors, if any.

Needed capabilities:

- `workflow_run_get(detail: "summary")`
- `workflow_run_get(detail: "step", step_id, include: ["input", "output", "logs", "error", "context"])`
- `workflow_run_get(detail: "full")` for UI/debug export only

Goal: Workflow Engineer first sees "what happened", then drills into only the step evidence it needs.

## 6. Explicit Workflow Output

Workflow output must be explicit. It should not be inferred from the last card or from arbitrary step output.

Needed card:

- `builtin.output.set`

Suggested config:

```json
{
  "path": "result",
  "value": "$.steps.prioritize.output.response",
  "mode": "replace"
}
```

Supported modes:

- `replace`
- `merge`
- `append`

Rules:

- Final run output is composed only from output cards.
- If no output card exists, final output is `{}`.
- If the workflow declares an output schema, validation should require matching output cards or fail.
- Callable/published workflows should have clear output schema and explicit output cards.

## Milestone Shape

Recommended order:

1. Run evidence shaping: `workflow_run_get` summary/default plus targeted step detail.
2. Full-run TDD controls: `workflow_test_run.stop_after_step_id`, inline assertions, and draft identity.
3. Card-level TDD: `workflow_card_test_run`.
4. Explicit workflow output: `builtin.output.set` and output-schema validation.
5. Workflow help storage/schema plus `workflow_help`.
6. `workflow_help_upsert` so Workflow Engineer can improve persisted help.
7. Publish promotion gate.
8. Skill/persona update: deterministic-first plus TDD authoring loop.

## Implementation Slices And TDD

### Slice 1: Run Evidence Shaping

Goal: make run inspection useful for agents without dumping every input/output/log by default.

Code areas:

- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- `packages/server/src/routes/workflows.ts`
- `packages/db/src/stores/workflow-store.ts`

Changes:

- Extend `workflow_run_get` params with `detail`, `step_id`, and `include`.
- Default `detail` to `summary`.
- Keep `detail: "full"` available for UI/export/backward internal debugging.
- Return summary evidence: run status, duration, executed step ids/statuses, branch decisions, foreach/parallel summaries, errors, and artifact references.

TDD:

- Tool schema test rejects `detail: "step"` without `step_id`.
- Runtime tool test verifies default summary omits large step outputs.
- Runtime tool test verifies targeted step detail returns only requested fields.
- Artifact test verifies spilled output can still be fetched through `workflow_artifact_get`.

### Slice 2: Full-Run TDD Controls

Goal: let Workflow Engineer run a draft up to a selected card and verify expected facts inline.

Code areas:

- `packages/workflows/src/runner.ts`
- `packages/workflows/src/schemas.ts`
- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- `packages/server/src/routes/workflows.ts`

Changes:

- Add `stop_after_step_id` to `workflow_test_run`.
- Add inline assertions with simple operators: `exists`, `equals`, `not_equals`, `contains`, `not_contains`, `matches`, `greater_than`, `less_than`.
- Include `draft_hash` or equivalent definition identity in test-run responses.
- For async runs, return accepted assertion config but only evaluate assertions when the run is inspected after completion.

TDD:

- Runner test stops after the target step and does not execute downstream steps.
- Runner test works when the stopped step is inside if/switch/foreach/parallel.
- Tool test returns assertion pass/fail results for sync test runs.
- Tool test returns actionable assertion diagnostics for missing reference paths.

### Slice 3: Card-Level Test Run

Goal: allow a card config -> execute -> inspect -> adjust loop without building the whole workflow first.

Code areas:

- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- `packages/workflows/src/runner.ts`
- `packages/workflows/src/schemas.ts`

Changes:

- Add `workflow_card_test_run`.
- Support `candidate`, `from_workflow`, and `from_run`.
- Use the normal runner execution semantics through a one-node synthetic workflow where possible.
- Return the same summary/step detail shape as normal test runs.

TDD:

- Candidate card test runs a log/transform card without saving a workflow.
- From-workflow card test runs an existing card with explicit input/context.
- From-run card test reuses previous run state and can test a downstream card.
- Invalid card config returns schema diagnostics, not a raw exception.

### Slice 4: Explicit Workflow Output

Goal: make callable workflow output deterministic and inspectable.

Code areas:

- `packages/workflows/src/schemas.ts`
- `packages/workflows/src/card-catalog.ts`
- `packages/workflows/src/runner.ts`
- `packages/workflows/src/validation.ts`
- UI card editor after backend acceptance.

Changes:

- Add `builtin.output.set`.
- Add a dedicated output object in runner state.
- Run output becomes explicit output object; no output card means `{}` for new workflows.
- Add output-schema coverage checks to validation.

TDD:

- Runner test writes `output.result` from a step reference.
- Merge and append output modes behave like context assignment modes.
- Validation fails when output schema exists but no output card can satisfy it.
- Skill/help docs explain `$.steps.<id>.output` to `builtin.output.set`.

### Slice 5: Workflow Help Read

Goal: give agents concrete, queryable knowledge about cards, reference syntax, schemas, and run evidence.

Code areas:

- New workflow help schema/module, likely under `packages/workflows/src`.
- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- DB migration/store for persisted help overrides.

Changes:

- Add `workflow_help`.
- Seed card help from `workflow_card_catalog`.
- Support target kinds: `overview`, `card_type`, `workflow_schema`, `reference_syntax`, `output_schema`, `run_evidence`.
- Support `detail`, `include_examples`, and parameter-scoped help requests.

TDD:

- Help tool returns summary card help without examples by default.
- Full card help includes examples and parameter help when requested.
- Parameter query returns only matching parameter guidance.
- Unknown target returns structured candidate suggestions.

### Slice 6: Workflow Help Write

Goal: let Workflow Engineer improve persisted workflow/card help without editing skills.

Code areas:

- Workflow help store/migration.
- `packages/tools/src/builtins/workflow-management.ts`
- `packages/server/src/runtime.ts`
- Workflow Engineer agent tool allowlist.

Changes:

- Add `workflow_help_upsert`.
- Validate help with a structured schema equivalent to managed integration help: summary, full, whenToUse, whenNotToUse, parameters, examples, noExampleJustification.
- Audit author/updater and target.
- Gate write access to Workflow Engineer/admin contexts.

TDD:

- Upsert rejects empty/invalid help.
- Upserted help overrides catalog seed in `workflow_help`.
- Normal non-authoring agent cannot call `workflow_help_upsert`.
- Workflow Engineer can call `workflow_help_upsert`.

### Slice 7: Promotion Gate

Goal: prevent publishing workflows that have not been validated and successfully tested as the current draft.

Code areas:

- `packages/server/src/runtime.ts`
- `packages/db/src/stores/workflow-store.ts`
- `packages/workflows/src/validation.ts`

Changes:

- Compute stable draft hash from the definition snapshot.
- Store or derive draft hash for test runs.
- Extend `workflow_publish` to block unless validation passes and at least one full successful test run exists for the current draft hash.
- Add `dry_run` only if preflight UX needs it.

TDD:

- Publish fails when no successful current-draft test exists.
- Publish fails when draft changed after the successful test.
- Publish succeeds after validation plus successful test.
- Diagnostics name the missing gate explicitly.

### Slice 8: Skill And Agent Persona Sync

Goal: make Workflow Engineer and normal agents use the new tool surface without reading source code.

Code areas:

- `packages/skills/builtin/openacme-platform/SKILL.md`
- `packages/skills/builtin/openacme-workflow-author/SKILL.md`
- `packages/agent-catalog/templates/workflow-engineer/AGENT.md`

Changes:

- Document deterministic-first workflow design.
- Document TDD loop: help -> validate -> card/full test -> inspect summary -> drill step -> update -> retest -> publish.
- Document `workflow_help` as the first stop for concrete syntax/card/schema details.
- Document explicit workflow output card as the callable output contract.

TDD:

- Agent catalog test verifies Workflow Engineer has workflow tools and workflow author skill.
- Skill tests verify key tool names and reference syntax are present.
- Live dogfood test verifies Workflow Engineer can discover help, create a workflow, run up to a step, inspect a step, and publish only after a passing full test.

## Final Tool Plan Aligned With Managed Tools

Managed tools has many lifecycle tools because hosted integration development has many lifecycle objects: families, drafts, locks, generations, environments, examples, debug runs, artifacts, and failure buckets. Workflow authoring does not need to copy that entire surface. It should copy the shape:

- separate lifecycle tools where the underlying object/action is genuinely different;
- one canonical help tool with `detail` and `parameters[]`;
- one canonical run inspection tool with `detail`, `step_id`, and `include`;
- readiness/promotion checks exposed as diagnostics, not hidden booleans;
- persisted structured help that Workflow Engineer can update.

### Keep Existing Lifecycle Tools

Keep the current workflow lifecycle tools:

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

These map cleanly to managed tools lifecycle concepts: catalog/source discovery, validate, draft mutate, promote/publish, run, inspect, artifact read.

### Add Only Three New Tools

Add:

- `workflow_help`
- `workflow_help_upsert`
- `workflow_card_test_run`

Do not add separate `workflow_card_help`, `workflow_schema_help`, `workflow_reference_help`, `workflow_example_get`, or `workflow_run_step_get` tools in the minimum scope.

### Extend Existing Tools Instead Of Adding More

Extend `workflow_test_run`:

```json
{
  "workflow_id": "wf_example",
  "input": {},
  "async": false,
  "stop_after_step_id": "normalize_asset",
  "assertions": [
    {
      "path": "$.steps.normalize_asset.status",
      "operator": "equals",
      "value": "succeeded"
    }
  ]
}
```

Rules:

- `stop_after_step_id` is enough for the minimum "run until here" debug loop.
- Do not implement resume/skip/breakpoints yet.
- Assertions are optional and inline; no saved/golden test registry yet.
- Response includes `run_id`, `draft_hash` or `definition_snapshot_id`, `status`, assertion results, and summary evidence.

Extend `workflow_run_get`:

```json
{
  "run_id": "run_123",
  "detail": "summary"
}
```

```json
{
  "run_id": "run_123",
  "detail": "step",
  "step_id": "normalize_asset",
  "include": ["input", "output", "logs", "error", "context"]
}
```

Rules:

- Default detail should be `summary`.
- `detail: "full"` can exist for UI/debug exports, but agents should not use it by default.
- Step evidence is fetched by `workflow_run_get`, not a new step-specific tool.

Extend `workflow_validate`:

- Include reference diagnostics for `$.workflowTrigger.input.*` and `$.steps.<step_id>.input/output/error/context`.
- Include route diagnostics: unreachable nodes, disconnected non-trigger nodes, invalid branch targets.
- Include output diagnostics: missing explicit output card when output schema exists.
- Include deterministic-first lint warnings where practical.

Extend `workflow_publish`:

- Run the promotion gate before publishing.
- Block publish with structured diagnostics when required conditions fail.
- Required minimum gate:
  - schema/graph validation passes;
  - no unresolved references;
  - current draft hash has at least one successful full test run;
  - output schema is satisfied by explicit output cards when an output schema exists.

No separate `workflow_promote` or `workflow_publish_gate` tool is needed in the minimum scope. If preflight visibility is needed, add `dry_run: true` to `workflow_publish` later before creating a new readiness tool.

### Help Tool Shape

`workflow_help` mirrors `hosted_tool_help`:

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

`workflow_help_upsert` mirrors hosted integration help write semantics:

```json
{
  "target": {
    "kind": "card_type",
    "card_type": "builtin.if"
  },
  "help": {
    "summary": "Branch on a deterministic condition.",
    "full": "Use this card when a workflow has exactly two deterministic routes.",
    "whenToUse": ["Need true/false routing from explicit values."],
    "whenNotToUse": ["Need model judgment or fuzzy classification."],
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

Access policy:

- Normal agents can call `workflow_help` for callable workflows/cards they are allowed to use.
- Workflow Engineer can call `workflow_help` and `workflow_help_upsert`.
- Help writes must be audited and schema-validated.

### Final Minimum Delta

Implementation delta from today's workflow tool set:

1. Add `workflow_help`.
2. Add `workflow_help_upsert`.
3. Add `workflow_card_test_run`.
4. Extend `workflow_test_run` with `stop_after_step_id`, assertions, and draft identity.
5. Extend `workflow_run_get` with summary/default and targeted step detail modes.
6. Extend `workflow_validate` with reference/route/output diagnostics.
7. Extend `workflow_publish` with the promotion gate.
8. Add `builtin.output.set` card.

This is the closest workflow equivalent to managed tools without importing unnecessary lifecycle complexity.

## Minimal Additions Outside The Initial List

Keep this list small. These are the only extras that currently look worth adding to the minimum "workflow develops, not just writes" scope:

1. Reference diagnostics inside `workflow_validate`.
   - Report unknown step ids, unsupported top-level reference families, invalid reference syntax, and references broken by step-id rename.
   - Do not add a separate reference-preview tool in the minimum scope.

2. Lightweight assertions on `workflow_test_run`.
   - Optional assertions such as path exists, path equals, step status equals, log contains, branch chosen.
   - No saved/golden test-case registry in the minimum scope.

3. Definition identity in run responses.
   - Every test/run response should include `definition_snapshot_id` or `draft_hash`.
   - This lets Workflow Engineer know exactly which workflow definition produced the observed evidence.

4. Stop-after-step support.
   - Add `stop_after_step_id` to `workflow_test_run`.
   - Avoid full breakpoint/resume/skip mechanics for now.

5. Promotion gate.
   - Publishing should require validation clean enough for the selected strictness.
   - Require at least one successful full test for the current draft hash/version.
   - Require explicit output-card coverage when an output schema exists.
   - Surface blocking failures as actionable diagnostics, not a generic publish failure.

## Managed Tools Design Notes

Observed pattern from hosted integrations:

- Consumer help is one canonical tool: `hosted_tool_help`.
- Detail is controlled by request parameters, not by many tool names.
- Field-level help is requested through a `parameters[]` array.
- Help access is policy-gated: the agent must be allowed to use both the target tool and the help tool.
- Help data lives with the managed tool contract and is validated as structured data.
- Full help can be referenced by file path to avoid dumping large content by default.
- Examples are opt-in.
- Vocabulary/query help is parameter-scoped.
- Write/update help exists in the authoring surface and updates the draft contract.

Workflow should copy the pattern, adapted to workflow concepts:

- Normal agents get a narrow `workflow_help` only for callable workflows/cards they can use.
- Workflow Engineer gets `workflow_help` plus `workflow_help_upsert`.
- Help writes should validate structured fields and preserve history/audit.
- The help layer should stay separate from skills: skills teach the authoring process; help teaches the concrete workflow/card/schema surface.
