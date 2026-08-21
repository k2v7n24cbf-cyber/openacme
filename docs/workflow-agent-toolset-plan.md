# First-Class Workflow Agent Tool-Set Plan

## Summary

Amaç: Ajanların workflow yaratırken repo taramadan, raw HTTP yazmadan ve
node/tool/agent isimlerini tahmin etmeden tüm workflow lifecycle'ını
yönetebilmesi.

Bu yüzden üç ayrı discovery yüzeyi olacak:

- `workflow_card_catalog`: Built-in, flow-control, transformer, log, MCP
  wrapper ve agent-call card/node tiplerini keşfetmek için.
- `workflow_tool_inventory`: Workflow içinde çağrılabilir MCP tool'ları
  keşfetmek için.
- `workflow_agent_inventory`: Workflow içinde çağrılabilir agent'ları
  keşfetmek için.

Workflow authoring tool family, mevcut workflow store/runner/validation
sözleşmelerini kullanacak; HTTP API kalacak ama ajanlar için primary yol bu
tool-set olacak.

Ek olarak `workflow-engineer`, `acme` ve `tool-developer` gibi
platform-managed built-in agent olacak. Bu agent yeni workflow tool-set'i ve
workflow authoring skill'i üzerinden workflow geliştirme, validasyon, test run,
run history inceleme ve publish/export lifecycle'ını sahiplenecek.

## Milestones / Slices / Goals

### Milestone 1: Workflow Card Catalog

Goal: Ajan hangi workflow cardlarını kullanabileceğini ve her cardın nasıl
konfigüre edileceğini discover edebilsin.

Slices:

1. `workflow_card_catalog`
   - Tüm workflow node/card tiplerini döner:
     - `builtin.set`
     - concrete transformer cards
     - `builtin.if`
     - `builtin.switch`
     - `builtin.foreach`
     - `builtin.parallel`
     - `builtin.exit`
     - `builtin.throw_error`
     - `builtin.sleep`
     - `builtin.log.*`
     - `builtin.python`
     - `mcp.tool`
     - `agent.call`
   - Her card için:
     - `type`
     - `family`
     - `label`
     - `description`
     - `configSchema`
     - `defaultConfig`
     - `routePorts`
     - `outputSchema`
     - `examples`

2. Catalog source of truth
   - Catalog UI'dan kopyalanmayacak.
   - Workflow schema + küçük metadata registry'den üretilecek.
   - Add-card modal ileride aynı catalog'u kullanabilecek, ama ilk hedef agent
     tooling.

3. Route semantics
   - Flow cards route portlarını açıkça tarif eder:
     - `if`: `then`, `else`
     - `switch`: `cases`, `default`
     - `foreach`: `body`, `next`
     - `parallel`: `branches`, `next`
     - normal cards: `next`

TDD:

- Unit: `WorkflowNodeSchema` içinde olan her node type catalog'da var.
- Unit: catalog'da olup schema'da olmayan node type yok.
- Unit: every catalog item has `configSchema`, `outputSchema`, and
  `routePorts`.
- Unit: `builtin.if_else` yeni authoring catalog'da görünmez.
- Unit: concrete transformer types ayrı card olarak görünür; generic transform
  görünmez.

### Milestone 2: Runtime Inventory And Validation

Goal: Ajan external call node'larını runtime truth ile doğru yazabilsin.

Slices:

1. `workflow_tool_inventory`
   - MCP tools için döner:
     - `server`
     - `tool`
     - `name`
     - `description`
     - `inputSchema`
   - Source: `WorkflowExecutionPorts.mcp.listTools()`.

2. `workflow_agent_inventory`
   - Callable agents için döner:
     - `id`
     - `name`
     - `role/description`
     - relevant capability metadata
   - Source: `WorkflowExecutionPorts.agent.listAgents()`.

3. `workflow_validate`
   - Input exactly one of:
     - `workflow_id`
     - full `definition`
     - draft `candidate`
   - Kontroller:
     - schema validity
     - graph/reference validity
     - trigger validity
     - card type catalog validity
     - MCP server/tool exists
     - agent id exists
     - route completeness

TDD:

- Server: invalid MCP server/tool `unknown_mcp_tool`.
- Server: invalid agent id `unknown_agent`.
- Server: unsupported node type `unsupported_card_type`.
- Server: detached/invalid graph save öncesi fail eder.
- Server: valid workflow passes validate.

### Milestone 3: Workflow Lifecycle Tools

Goal: Ajan workflow definition lifecycle'ını raw HTTP olmadan yönetebilsin.

Slices:

1. Definition tools
   - `workflow_list`
   - `workflow_get`
   - `workflow_create`
   - `workflow_update`
   - `workflow_delete`
   - `workflow_publish`

2. Import/export tools
   - `workflow_export`
   - `workflow_import`
   - Format: existing `openacme.workflow.definition.v1`.

3. Response standard
   - Success:
     ```json
     { "ok": true }
     ```
   - Failure:
     ```json
     { "ok": false, "error": { "code": "...", "message": "..." }, "issues": [] }
     ```

TDD:

- Unit: all tools registered.
- Unit: no active agent context -> `policy_denied`.
- Unit: unbound runtime -> `platform_unavailable`.
- Server smoke: create/get/update/export/import/publish path works.
- Regression: HTTP routes still work.

### Milestone 4: Test Run And Run Inspection Tools

Goal: Ajan workflow'u test edip insanın Run History'de gördüğü kanıtları
okuyabilsin.

Slices:

1. Run tools
   - `workflow_test_run`
   - `workflow_run_list`
   - `workflow_run_get`
   - `workflow_run_cancel`
   - `workflow_run_rerun`
   - `workflow_artifact_get`

2. Run detail
   - `workflow_run_get` döner:
     - run metadata
     - definition snapshot
     - step attempts
     - step input/output/error/log summary
     - timeline events
     - artifacts

3. Shared execution semantics
   - HTTP run path ve tool run path aynı execution helper'larını kullanmalı.
   - Cancel için aynı abort-controller lifecycle kullanılmalı.

TDD:

- Server smoke: create -> test_run -> run_get.
- Step input/output/log/error evidence görünür.
- Async run inspect edilebilir.
- Cancel running workflow terminal `canceled` yapar.
- Artifact get spilled output'u okur.

### Milestone 5: Skill And Agent Guidance

Goal: Ajanlar bu tool-set'i doğal olarak kullansın.

Slices:

1. `openacme-workflow-author` update
   - Authoring loop:
     - `workflow_card_catalog`
     - `workflow_tool_inventory`
     - `workflow_agent_inventory`
     - draft definition
     - `workflow_validate`
     - `workflow_create/update`
     - `workflow_test_run`
     - `workflow_run_get`
     - publish/export

2. Reference docs
   - Card catalog fields açıklanacak.
   - Flow route semantics açıklanacak.
   - Raw HTTP sadece fallback/debug olarak kalacak.

3. Platform skill alignment
   - `openacme-platform` workflow işi varsa workflow author skill'e
     yönlendirmeye devam edecek.
   - Platform skill, first-class workflow tools'un varlığını bilecek.

TDD:

- Skill text includes `workflow_card_catalog`.
- Skill text includes inventory/validate/test/run inspection tools.
- Skill text does not teach raw HTTP as primary workflow authoring path.

### Milestone 6: Built-In Workflow Engineer Agent

Goal: `workflow-engineer`, `acme` ve `tool-developer` gibi platform-managed
built-in agent olarak kurulmalı ve workflow authoring lifecycle'ını sahiplenmeli.

Slices:

1. Built-in agent template
   - Yeni template: `packages/agent-catalog/templates/workflow-engineer/AGENT.md`.
   - Managed metadata:
     - `template_id: workflow-engineer`
     - `template_name: Workflow Engineer`
     - `managed: true`
     - bundled skill: `openacme-workflow-author`
   - Tool set:
     - `workflow_card_catalog`
     - `workflow_tool_inventory`
     - `workflow_agent_inventory`
     - `workflow_validate`
     - workflow definition lifecycle tools
     - workflow run lifecycle tools
   - Generic filesystem mutation tools default olarak verilmemeli; workflow
     authoring birincil olarak workflow tools üzerinden yapılmalı.

2. Managed-agent materialization
   - `ensureManagedAgents()` empty workforce'te `acme`, `tool-developer` ve
     `workflow-engineer` yaratmalı.
   - İdempotent olmalı.
   - Existing unmanaged agents varsa managed agent eksikleri yine kurulmalı.
   - Managed mutation guard `workflow-engineer` için de geçerli olmalı.

3. Agent responsibility boundary
   - `workflow-engineer` workflow definition, validation, test run, run history
     ve publish/export lifecycle'ını sahiplenir.
   - Hosted integration source/draft/promotion işleri `tool-developer`'da
     kalır.
   - Workforce/admin setup işleri `acme`'de kalır.
   - Workflow içinde kullanılacak MCP tool veya agent bilgisi için tahmin
     yapmaz; discovery tool'larını kullanır.

4. Skill alignment
   - `openacme-platform` skill, workflow authoring isteği geldiğinde
     `workflow-engineer` agent'a delegasyonu önermeli.
   - `openacme-workflow-author` skill, `workflow-engineer` tarafından
     kullanılacak birincil lifecycle skill olarak kalmalı.

TDD:

- `agent-catalog.test.ts`: empty workforce `["acme", "tool-developer",
  "workflow-engineer"]` üretir.
- `agent-catalog.test.ts`: `workflow-engineer.managed === true`.
- `agent-catalog.test.ts`: `workflow-engineer.skills` içinde
  `openacme-workflow-author` var.
- `agent-catalog.test.ts`: `workflow-engineer.tools` workflow management tool
  family'yi içerir.
- `agent-catalog.test.ts`: managed mutation/delete guard `workflow-engineer`
  için çalışır.
- Skill text test: `openacme-platform` workflow authoring işlerini
  `workflow-engineer` boundary'sine yönlendirir.

### Milestone 7: Live Workflow Engineer Dogfood Test Kit

Goal: Tool-set implementasyonu sonrası `workflow-engineer` agent'ın gerçekten
bu tool'ları ve skill'i kullanarak workflow geliştirebildiğini 15 use-case ile
live ortamda doğrulayan, fakat normal pushlarda otomatik koşmayan bir test kit
olmalı. Bu kit mevcut test altyapısından kopuk olmayacak ve kolay bulunacak.

Slices:

1. Test kit location and command
   - Location: `packages/server/scripts/workflow-engineer-live-dogfood.ts`.
   - Package script:
     - `dogfood:workflow-engineer:live`
   - Push/PR default testlerinden bağımsız kalacak.
   - Existing dogfood pattern'leriyle aynı yerde listelenecek:
     - `dogfood:hosted-tools:live`
     - `dogfood:hosted-tools:live:unguided-management`
   - Varsayılan data dir:
     - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow`
   - Varsayılan port 3456 olmayacak; önerilen `3458`.

2. Test kit mechanics
   - Server'ı live/deployed benzeri şekilde boot eder.
   - `workflow-engineer` managed agent'ın materialize olduğunu doğrular.
   - Agent'a 15 ayrı workflow authoring görevi verir.
   - Agent'ın workflow tools'u kullanıp kullanmadığını session/tool-call
     evidence üzerinden doğrular.
   - Her case için:
     - workflow created/updated
     - `workflow_validate` success
     - `workflow_test_run` success veya beklenen controlled failure
     - `workflow_run_get` ile step evidence inspection
     - gerektiğinde `workflow_artifact_get`
     - final artifact/report record

3. 15 use-case inventory
   - Simple cases:
     1. Manual trigger -> `builtin.log.info` -> `builtin.exit`.
     2. Manual input -> `builtin.set` -> log context variable.
     3. `builtin.transform.uri_parse` -> object field log.
     4. `builtin.transform.json_parse` -> `object_pick`.
     5. `builtin.sleep` short wait -> log duration evidence.
     6. `agent.call` mock/stub agent response -> log `output.response`.
     7. `mcp.tool` mock inventory tool -> transform returned field.
     8. `builtin.throw_error` controlled failure -> run inspection validates
        error.
     9. `workflow_artifact_get` path for large output/spilled artifact.
     10. Publish/export/import roundtrip.
   - Complex flow cases:
     11. `builtin.if` true/false branches join into final log.
     12. `builtin.switch` cases/default with independent branch outputs.
     13. `builtin.foreach` over complex array, aggregate item outputs.
     14. `builtin.parallel` with 3 branches and post-parallel continuation.
     15. Combined workflow: manual input -> MCP mock -> foreach -> if ->
         agent.call -> transform -> final log/export.

4. Evidence/reporting
   - Test kit writes a JSON report under a predictable test artifact path, for
     example:
     - `packages/server/test-artifacts/workflow-engineer-live-dogfood/<timestamp>.json`
   - Report includes:
     - case id/name
     - prompt/task sent to `workflow-engineer`
     - session id
     - workflow id
     - run id
     - tool calls observed
     - validation result
     - run status
     - failure reason if any
   - Report must prove the agent used the workflow tool-set, not raw HTTP as the
     primary path.

5. Friction checks
   - Kit fails if agent:
     - guesses unavailable MCP `server/tool`
     - reads repo schema files instead of using `workflow_card_catalog`
     - uses raw HTTP while workflow tools are available
     - creates unsupported card/node types
     - saves without `workflow_validate`
     - cannot inspect run output/error/logs

TDD:

- Unit: scenario manifest contains exactly 15 cases.
- Unit: at least 5 cases are marked `complex: true`.
- Unit: every case declares required cards/tools and expected evidence.
- Integration harness: can run one deterministic stub case quickly.
- Dogfood live script: full 15-case suite only runs by explicit command.
- Report audit: script fails if any case lacks workflow id, run id,
  validation evidence, run inspection evidence, or workflow tool-call evidence.

## Public Interfaces

New agent-facing tool family: `workflow-management`.

Discovery:

- `workflow_card_catalog`
- `workflow_tool_inventory`
- `workflow_agent_inventory`

Validation:

- `workflow_validate`

Definition lifecycle:

- `workflow_list`
- `workflow_get`
- `workflow_create`
- `workflow_update`
- `workflow_delete`
- `workflow_publish`
- `workflow_export`
- `workflow_import`

Run lifecycle:

- `workflow_test_run`
- `workflow_run_list`
- `workflow_run_get`
- `workflow_run_cancel`
- `workflow_run_rerun`
- `workflow_artifact_get`

Built-in managed agent:

- `workflow-engineer`

Dogfood command:

- `pnpm --filter @openacme/server dogfood:workflow-engineer:live`

## Assumptions / Defaults

- Built-in/flow/transformer cards must be discoverable; agent should not read
  repo schema files to learn them.
- `workflow_card_catalog` is the source of truth for agent authoring card
  capabilities.
- MCP tools and callable agents remain separate runtime inventories.
- No backward compatibility aliases for wrong node/tool names.
- No UI work required in this milestone, except optional future reuse of
  catalog by add-card modal.
- Workflow orchestration remains sibling to `AgentManager`; this should not be
  hidden inside `AgentManager`.
- `workflow-engineer` is managed and non-editable by normal agent update/delete
  paths, same as `acme` and `tool-developer`.
- The 15-case live dogfood kit is explicit opt-in and must not run on ordinary
  push/PR checks.

## Implementation Notes

### Slice 1: Card Catalog And Tool Binding

Status: implemented locally.

Code:

- `packages/workflows/src/card-catalog.ts` exposes the authoring catalog.
- `packages/workflows/src/schemas.ts` exports workflow node type value lists.
- `packages/tools/src/builtins/workflow-management.ts` registers the
  `workflow-management` tool family.
- `packages/server/src/runtime.ts` binds workflow management tools to the
  existing workflow store, runner, inventory ports, validation, and shared
  cancel abort-controller map.
- `packages/server/src/routes/workflows.ts` exports shared workflow execution
  helpers used by both HTTP routes and workflow tools.

Validation:

- `pnpm --filter @openacme/workflows exec vitest run test/card-catalog.test.ts`
- `pnpm --filter @openacme/workflows check-types`
- `pnpm --filter @openacme/tools exec vitest run test/workflow-management.test.ts`
- `pnpm --filter @openacme/tools check-types`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/server exec vitest run test/workflow-management-tools.test.ts`
- `pnpm --filter @openacme/server check-types`

Additional validation behavior:

- `workflow_validate` reports unknown authoring card types as
  `unsupported_card_type`.
- `workflow_validate` rejects detached workflow graphs before save/create.
- Server integration tests cover definition lifecycle tools:
  `workflow_create`, `workflow_get`, `workflow_update`, `workflow_publish`,
  `workflow_export`, `workflow_import`, `workflow_list`, and
  `workflow_delete`.
- Server integration tests cover run lifecycle tools: `workflow_test_run`,
  `workflow_run_list`, `workflow_run_get`, `workflow_run_rerun`,
  `workflow_run_cancel`, and `workflow_artifact_get`.

### Slice 2: Managed Workflow Engineer Agent

Status: implemented locally.

Code:

- `packages/agent-catalog/templates/workflow-engineer/AGENT.md` defines the
  managed Workflow Engineer Agent with `openacme-workflow-author` and the full
  `workflow-management` tool family.
- `packages/server/test/agent-catalog.test.ts` verifies materialization,
  idempotency, managed mutation guards, bundled skill installation, and tool
  membership.
- `packages/skills/builtin/openacme-platform/SKILL.md` now routes routine
  workflow definition work to Workflow Engineer Agent and the workflow authoring
  skill boundary.

Validation:

- `pnpm --filter @openacme/server exec vitest run test/agent-catalog.test.ts`
- `pnpm --filter @openacme/server check-types`

### Slice 3: Workflow Engineer Dogfood Kit

Status: implemented locally and passing with deterministic live tool execution.

Code:

- `packages/server/test/e2e/support/workflow-engineer-live-scenarios.ts`
  defines exactly 15 workflow authoring scenarios, including 5 complex cases.
- `packages/server/scripts/workflow-engineer-live-dogfood.ts` runs the suite
  under `workflow-engineer` tool context and records workflow id, run id,
  task prompt, session id, validation, test run, run inspection, tool-call, and
  artifact evidence.
- `packages/server/package.json` exposes
  `pnpm --filter @openacme/server dogfood:workflow-engineer:live`.
- `.gitignore` excludes generated `packages/server/test-artifacts/` reports.

Validation:

- `pnpm --filter @openacme/server exec vitest run test/workflow-engineer-live-scenarios.test.ts`
- `pnpm --filter @openacme/server check-types`
- `OPENACME_DATA_DIR="$(mktemp -d /tmp/openacme-workflow-dogfood-XXXXXX)" pnpm --filter @openacme/server dogfood:workflow-engineer:live`

Latest passing report:

- `packages/server/test-artifacts/workflow-engineer-live-dogfood/mt174sgu.json`

Final validation on 2026-08-20:

- Workflow card catalog unit tests passed.
- Workflow management tool unit tests passed.
- Workflow management server integration tests passed.
- Workflow Engineer Agent catalog/materialization tests passed.
- Workflow Engineer live scenario manifest tests passed.
- Workflows, tools, and server typechecks passed.
- Workflow Engineer live dogfood passed against an isolated
  `OPENACME_DATA_DIR`.
- Dogfood report completeness now fails a scenario if task prompt, session id,
  workflow id, run id, `workflow_card_catalog`, `workflow_validate`,
  `workflow_test_run`, or `workflow_run_get` evidence is missing.
