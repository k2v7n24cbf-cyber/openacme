# Hosted Integrations Implementation Plan

Last revised: 2026-08-15.

## Goal

Deliver hosted integrations as a loosely coupled, tightly integrated OpenAcme
layer:

- loosely coupled: hosted integration source, storage, gateway, and runtime live
  behind `@openacme/hosted-integrations` ports instead of being embedded in
  agent-core, server routes, or `packages/tools`
- tightly integrated: hosted integration tools appear in the existing
  `ToolRegistry`, Agent Settings tool picker, Tool Developer Agent workflow, and
  OpenAcme API surface

This plan implements the architecture in
`docs/hosted-integrations-architecture.md`.

## Current Canonical Contract

The current implementation contract is Milestone 18 and later, especially
Milestones 20, 21, and 22. Earlier milestones remain historical evidence only
where they use superseded terms such as migration fixtures, config scopes, or
view-level cutover.

- Hosted integration product lifecycle states are source, draft, validation,
  example, generation, environment config, binding, invocation, debug run,
  failure bucket, and artifact.
- Legacy `integration-hub` definitions, tools, and configs may be used only as
  offline operator/test parity inputs. They are not hosted integration runtime
  code, not a product API state, not a management-tool target, not a readiness
  target, and not an authorization alias.
- Runtime package source under `packages/hosted-integrations/src` must not
  contain generated legacy integration-hub source, replacement inventories, or
  parity fixture catalogs.
- Active registry names use `hosted_<family>__<tool>` for hosted integrations
  and `mcp_<server>__<tool>` for remote MCP. These surfaces are independent.
- Active configuration uses `prod` and `test_debug` environment configs plus
  separate per-agent hosted-tool bindings. Historical config-scope references
  do not define new work.
- Tool Developer is the hosted integration maintainer persona. References to a
  generic engineering maintainer persona must not be introduced into hosted
  integration lifecycle guidance.

## Delivery Rules

- Build one milestone slice at a time.
- Each slice starts with a failing test or route-level contract test.
- Keep hosted integrations logic in `packages/hosted-integrations`.
- Keep `packages/tools` adapters thin.
- Keep server routes thin.
- Preserve the product principle: agent-first, but human-native. Every hosted
  integration lifecycle capability that agents use should also have an
  authorized human UI/API path.
- Do not introduce an external MCP server path for hosted integrations.
- Use Python for hosted integration family runtime in the MVP.
- Use file-backed persistence through package-level store ports only for the
  MVP/dev-test adapter. Production hosted integrations should use a DB-backed
  store for source, drafts, generations, locks, examples, environment config
  metadata, execution logs, failure buckets, approvals, jobs, idempotency, and
  retention metadata. Large run artifacts may remain in object/file storage
  with DB metadata and refs.
- Do not implement hosted integration discovery as continuous filesystem
  scanning. File-backed stores may persist source/generation artifacts, but the
  runtime registry must use explicit indexes, active-generation pointers,
  source revision records, and promotion/rollback refresh events.
- Do not implement canary promotion in the MVP.
- Do not let agents read or write secret values.

## MVP Outcome

The MVP is complete when:

1. A hosted integration family can be represented in source.
2. The Tool Developer Agent can inspect it through management tools.
3. The Tool Developer Agent can initialize a proposed family or acquire an
   existing family lock, patch a draft, run
   examples, validate, and promote a non-destructive generation.
4. Promoted hosted integration tools appear through the existing `/api/tools`
   and Agent Settings path.
5. A selected agent can invoke a promoted hosted integration tool through the
   Hosted Integration Gateway.
6. Large responses are returned as run artifacts.
7. Code-level failures create deduplicated failure buckets.
8. Fixed failures can be captured as regression examples.
9. At least one safe hosted integration family is promoted and invoked in the
   local test environment through the real hosted integration API/tool path,
   not only through unit tests.

## Dogfood Acceptance

Status: done.

Evidence:

- Added `packages/server/test/e2e/hosted-integrations-dogfood.e2e.ts`.
- Proves Tool Developer is materialized as a platform-managed agent and can
  load `$hosted-integrations-development` through a real `/api/chat` turn.
- Proves Tool Developer can create a new hosted integration family, patch
  source, register safe examples, validate, run an example, promote, and release
  the lock through `hosted_tool_*` management tools reached from chat.
- Proves Tool Developer can inspect lifecycle state through management tools:
  source files, draft metadata, registered examples, environment config
  metadata, execution logs, artifacts, generations, and generation rollback.
- Proves lock renewal and draft file deletion are covered through the same
  chat-driven lifecycle path before repair promotion.
- Proves promoted hosted integration tools surface through `/api/tools` and can
  be invoked by a separate consumer agent through Agent Settings
  `hostedIntegrationBindings`.
- Proves Agent Settings access policy blocks a second agent that has the hosted
  tool name but no hosted integration binding.
- Proves a code-level consumer failure creates a failure bucket and an open
  repair task assigned to Tool Developer; Tool Developer can inspect/assign the
  bucket, create a repair draft, add a regression example, promote the fix, run
  a debug invocation against the repaired generation, and close the bucket
  through chat-driven management tool calls.
- The dogfood uses the real Hono server, `/api/chat`, agent context, tool
  registry, hosted integration gateway, execution logs, artifacts, and
  file-backed test environment. It uses the deterministic e2e stub model rather
  than an external LLM so the acceptance is repeatable and offline.
- Added `packages/server/scripts/hosted-integrations-real-llm-dogfood.ts` for
  live model acceptance against the same local test environment. The runner uses
  the real configured OpenAI model path, starts the real Hono server on
  `127.0.0.1:3466`, and drives the same Tool Developer / consumer / denied-agent
  lifecycle through `/api/chat`.
- Real LLM dogfood exposed that OpenAI strict tool schemas may require optional
  management-tool fields to be present. Hosted integration management schemas now
  accept `null` for optional fields that LLMs must include in strict mode, while
  the runtime still treats `null` as absent.
- Green validation:
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_E2E_PORT=3466 pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-dogfood.e2e.ts`
- Green real LLM validation:
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_E2E_PORT=3466 pnpm --filter @openacme/server dogfood:hosted-integrations:real-llm`

## Non-Goals For MVP

- TypeScript hosted integration family runtime
- external MCP server compatibility adapter
- mandatory canary promotion
- merge workflows for simultaneous edits
- automatic secret rotation
- automatic secret rollback
- resumable progress event streams
- broad UI redesign
- live Qualys/Splunk validation in CI

## TDD Strategy

Use three layers of tests:

```text
packages/hosted-integrations
  Unit tests for stores, manifests, locks, examples, generations, gateway,
  policies, artifacts, and failure buckets.

packages/server
  Route tests proving the API delegates to hosted-integrations ports and
  enforces auth/shape/path constraints.

packages/tools
  Tool wrapper tests proving management tools call the hosted integrations
  control plane and do not duplicate lifecycle logic.
```

Use mocked Python family runtimes for CI. Live target-system examples are
allowed as manual validation, not as required CI proof.

Do not stop at unit tests for the full platform milestone. After runtime,
promotion, registry surfacing, and Agent Settings bindings exist, run a local
safe-tool smoke against the isolated test environment:

```text
OPENACME_DATA_DIR=~/.openamce-hosted-integrations-test-env
server.port: 3466
```

The smoke family must be safe by construction: no external credential, no
destructive operation, no arbitrary filesystem write outside the hosted
integration run directory/family home, and no network dependency. Examples:
`safe_echo`, `safe_sum`, or `safe_large_result`.

## Gap Audit

This plan must keep the API control plane explicit. A hosted integrations store
or package method is not complete until the corresponding API route and, where
needed, management tool wrapper are covered in a later slice.

Known implementation surfaces that need explicit slices:

- lock, draft, file, example, validation, and promotion routes
- proposed family creation from a minimal template
- family-level environment configs constrained to `prod` and `test_debug`
- environment config and human-only secret routes
- agent-specific hosted-tool binding overrides stored separately from
  environment configs, including default environment and optional generation pin
- Agent Settings as the primary user-facing policy and binding surface for
  hosted integration invocation access
- generation listing, diff, and rollback routes
- invocation, run detail, artifact, and debug-run routes
- async job routes
- invocation idempotency and duplicate-submit protection
- deprecation, hiding, disabling, and removal policy
- operational disable/quarantine at family, tool, generation, and environment
  config
- DB-backed hosted integration persistence and migration away from file-backed
  production storage
- response-size governance and inline/artifact spillover policy levels
- family-level runtime settings for timeouts, inline result spillover threshold,
  concurrency, and sandbox policy
- Python dependency declaration, validation, and generation pinning
- operator/test parity flows that can read legacy `integration-hub` inputs
  without turning them into product runtime code, management-tool targets, or
  authorization aliases
- UI visibility for family locks and active generations
- UI draft code editing through the same lock/draft/validation/promotion APIs
- deterministic tool handler naming, standard family hooks, and focused source
  views for tool-level investigation
- human-native rich family editor with tool mapping navigation, handler
  highlighting, focused code view, and generation diff UI
- local safe hosted-tool smoke validation in the isolated test environment
- optional OpenTelemetry wiring after execution logs exist
- hosted-tool-only help surface with summary/full tool help,
  summary/full parameter help, and examples for all active hosted tools

## Milestone 0: Planning Baseline

### Slice 0.1: Architecture Note

Status: done.

Artifact:

```text
docs/hosted-integrations-architecture.md
```

### Slice 0.2: Implementation Plan

Status: done.

Artifact:

```text
docs/hosted-integrations-implementation-plan.md
```

## Milestone 1: Package Skeleton And Read-Only Catalog

Goal: create the package boundary and prove OpenAcme can read hosted
integration family metadata without runtime execution.

### Slice 1.1: Package Scaffold And Domain Types

Status: done.

Evidence:

- Red test first: `pnpm --filter @openacme/hosted-integrations test` failed
  before implementation because `../src/index.js` did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Add `packages/hosted-integrations`.
- Wire it into the monorepo using the existing package conventions:
  package metadata, `exports`, `tsconfig.json`, `vitest.config.ts`, build,
  check-types, and test scripts.
- Include package README/LICENSE/files metadata consistent with existing
  `@openacme/*` packages.
- Export stable domain types for families, tools, drafts, generations, config
  scopes, examples, runs, jobs, policies, source revisions, runtime settings,
  idempotency records, and failure buckets.

Non-goals:

- No server routes.
- No Python execution.
- No registry integration.

TDD:

- package builds and checks types through the normal workspace scripts
- Add type/schema tests for a minimal valid family manifest.
- Add rejection tests for invalid family ids, invalid tool names, and missing
  tool classification.
- Add type/schema tests for family-level runtime settings.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test
pnpm --filter @openacme/hosted-integrations check-types
```

### Slice 1.2: File-Backed Source Catalog

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- catalog` failed before
  implementation because `createFileHostedIntegrationCatalog` was not exported.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- catalog`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Load hosted integration family manifests from
  `<dataDir>/hosted-integrations/source/families`.
- Provide a read-only `HostedIntegrationCatalog` port.

Non-goals:

- No draft writes.
- No promotion.

TDD:

- Given a temp data dir with two family fixtures, `listFamilies()` returns
  stable sorted summaries.
- `getFamily("qualys")` returns sanitized manifest metadata.
- malformed manifests are reported as catalog diagnostics without crashing the
  whole catalog.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- catalog
```

### Slice 1.3: Read-Only Hosted Integrations API

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/server test -- hosted-integrations-routes` failed
  before implementation because the requests fell through to the web fallback.
- Green validation:
  `pnpm --filter @openacme/server test -- hosted-integrations-routes`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Add server routes:

```http
GET /api/hosted-integrations/families
GET /api/hosted-integrations/families/:familyId
GET /api/hosted-integrations/families/:familyId/tools
```

Non-goals:

- No UI.
- No management tools.

TDD:

- Route tests prove family listing works from a temp data dir.
- Unknown family returns 404.
- Route output does not include secret values or source file contents.

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/server check-types
```

### Slice 1.4: Server Binding And Lifecycle Skeleton

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/server test -- runtime` failed before implementation
  because `ServerRuntime` did not expose `hostedIntegrationService` and
  `createApp` ignored the injected hosted integrations service.
- Green validation:
  `pnpm --filter @openacme/server test -- runtime`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Instantiate hosted integrations through a server-owned manager/service using
  `dataDir`.
- Keep server routes dependent on the manager/service port, not direct file
  access.
- Add close/startup hooks as no-op-safe lifecycle points for later workers,
  sweeps, and caches.

Non-goals:

- No Python workers.
- No background sweeps yet.

TDD:

- AgentManager/server construction creates a hosted integrations service
  against the configured data dir
- route handlers can be tested with a fake hosted integrations service
- server close calls the hosted integrations service close hook
- missing hosted integrations data dir does not break server startup

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/server check-types
```

## Milestone 2: Locks, Drafts, And Examples

Goal: let the Tool Developer Agent safely edit hosted integration source without
merge workflows.

### Slice 2.1: Family Edit Locks With TTL

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- locks` failed before
  implementation because `createFileHostedIntegrationLockStore` was not
  exported.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- locks`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Add a file-backed lock store.
- Support acquire, renew, release, and expired-lock takeover.

Non-goals:

- No drafts yet.
- No UI lock display yet.

TDD:

- acquiring an unlocked family succeeds
- acquiring an already locked family fails with lock owner and expiry
- renewing with the wrong lock id fails
- expired lock can be taken over

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- locks
```

### Slice 2.2: Draft Workspace

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- drafts` failed before
  implementation because `createFileHostedIntegrationDraftStore` was not
  exported.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- drafts`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Create drafts from family source while holding the family lock.
- Read and patch files inside a draft.
- Delete files inside a draft.
- Enforce path safety.

Non-goals:

- No source commit back.
- No promotion.

TDD:

- draft creation copies source into `<dataDir>/hosted-integrations/drafts`.
- draft file reads are limited to the draft root.
- path traversal is rejected.
- patching requires the active lock id.
- deleting requires the active lock id and is path-safe.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- drafts
```

### Slice 2.3: Examples Registry

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- examples` failed before
  implementation because `createFileHostedIntegrationExampleRegistry` was not
  exported.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- examples`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Define `examples.yaml` format.
- Read, add, and update examples in a draft.
- Classify examples as `smoke`, `live_safe`, `regression`, `mock_only`, or
  `destructive_requires_human`.

Non-goals:

- No live execution.
- No promotion gate yet.

TDD:

- valid examples parse into stable objects
- destructive examples require explicit classification
- invalid example args fail schema validation against the draft manifest

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- examples
```

### Slice 2.4: Draft Validation Contract

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- validation` failed
  before implementation because `createFileHostedIntegrationDraftValidator` was
  not exported.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- validation`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Add `validateDraft(draftId)`.
- Validate manifest shape, tool names, classification, examples, and required
  files.
- Validate family-level runtime settings such as default timeout, inline result
  spillover threshold, concurrency, and sandbox policy.
- Return structured diagnostics.

Non-goals:

- No Python import execution yet.

TDD:

- valid draft passes
- missing classification fails
- duplicate tool names fail
- breaking removal without deprecation fails
- invalid runtime settings fail with structured diagnostics

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- validation
```

### Slice 2.5: Draft Control Plane Routes

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/server test -- hosted-integrations` failed before
  implementation because the new draft control-plane routes returned 404.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`

Goal:

- Add lock, draft, file, example, and validation API routes:

```http
POST   /api/hosted-integrations/families/:familyId/lock
POST   /api/hosted-integrations/locks/:lockId/renew
DELETE /api/hosted-integrations/locks/:lockId
GET    /api/hosted-integrations/families/:familyId/source/files
GET    /api/hosted-integrations/families/:familyId/source/files/*path
POST   /api/hosted-integrations/families/:familyId/drafts
GET    /api/hosted-integrations/drafts/:draftId
GET    /api/hosted-integrations/drafts/:draftId/files
GET    /api/hosted-integrations/drafts/:draftId/files/*path
PUT    /api/hosted-integrations/drafts/:draftId/files/*path
DELETE /api/hosted-integrations/drafts/:draftId/files/*path
GET    /api/hosted-integrations/drafts/:draftId/examples
POST   /api/hosted-integrations/drafts/:draftId/examples
POST   /api/hosted-integrations/drafts/:draftId/validate
```

Non-goals:

- Route handlers stay thin.
- No model-facing management tools yet.
- No example execution or promotion routes yet; those require runtime and
  generation support.

TDD:

- route calls delegate to hosted-integrations ports
- canonical source file route is read-only and path-safe
- draft file route rejects path traversal
- draft delete route requires the active lock id
- route output never includes secret values

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
```

### Slice 2.6: Proposed Family Initialization

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- proposed-family`
  failed before implementation because
  `createFileHostedIntegrationProposedFamilyManager` did not exist.
- Red route test:
  `pnpm --filter @openacme/server test -- hosted-integrations` failed before
  implementation because `POST /api/hosted-integrations/families` returned
  404 and active family summaries did not include a management status.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`

Goal:

- Add `POST /api/hosted-integrations/families`.
- Create a proposed family from a minimal template under an edit lock.
- Return the new family id, lock id, draft id, and source revision placeholder.
- Keep proposed families hidden from runtime tool registry surfaces until first
  successful promotion.

Non-goals:

- No direct canonical source writes outside promotion.
- No runtime tool exposure before first generation.

TDD:

- creating a proposed family creates a lock and draft atomically
- duplicate family id is rejected
- proposed family appears in management family list with `status: proposed`
- proposed family tools do not appear in `/api/tools`
- first promotion turns the proposed family into an active family source and
  generation in the promotion slice, not in this non-promotion slice

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- proposed-family
pnpm --filter @openacme/server test -- hosted-integrations
```

## Milestone 3: Config Scopes, Secrets, And Access Policy

Status: historical / superseded for config-scope behavior.

This milestone records early implementation history only. Do not implement new
config-scope stores, routes, policy bindings, or default-scope resolution from
this section. Active config behavior is environment configs (`prod` and
`test_debug`) plus per-agent hosted-tool bindings, as formalized in Milestones
18 and 22.

Goal: establish the minimum security/config foundation before real invocation.

### Slice 3.1: Config Scope Store

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- config-scopes` failed
  before implementation because
  `createFileHostedIntegrationConfigScopeStore` did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- config-scopes`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

Goal:

- Add sanitized config scope files under
  `<dataDir>/hosted-integrations/config-scopes`.
- Track `id`, `family`, `revision`, `environment`, non-secret config, and
  configured/missing secret metadata.

Non-goals:

- No secret values in read APIs.
- No runtime injection.

TDD:

- reading a config scope returns no secret values
- updating non-secret config increments revision
- config scope must match a known family

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- config-scopes
```

### Slice 3.2: Human-Owned Secret Store

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- secrets` failed before
  implementation because `createFileHostedIntegrationSecretStore` did not
  exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- secrets`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

Goal:

- Store secret values under `<dataDir>/hosted-integrations/secrets`.
- Use atomic writes with `0600` semantics.
- Expose write/update only through human-authorized API paths.

Non-goals:

- No agent management tool can read or write secret values.
- No secret rollback automation.

TDD:

- secret write creates a file with restrictive permissions on POSIX
- secret read for API metadata returns configured/missing only
- raw secret read is available only to the runtime resolver port

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- secrets
```

### Slice 3.3: Access Policy MVP

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- policy` failed before
  implementation because `evaluateHostedIntegrationPolicy` and
  `createAgentSettingsHostedIntegrationBinding` did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- policy`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

Goal:

- Add a deny-by-default policy evaluator.
- Support actor, family, tool, operation class, config scope, environment, and
  debug/run mode.
- Add an agent/tool binding contract for allowed config scopes and default
  config scope resolution.
- Treat Agent Settings as the primary user-facing authoring surface for
  per-agent hosted integration invocation policy/bindings.

Non-goals:

- No complex policy language.
- No separate org-wide policy UI in the MVP.

TDD:

- unknown actor is denied
- Tool Developer Agent can edit drafts but cannot read secrets
- normal agent can invoke an allowed hosted integration tool
- normal agent cannot call hosted integration management tools
- normal agent invocation resolves the default config scope from its tool
  binding
- multiple allowed config scopes without a default fail with `config_missing`
  before runtime dispatch
- Agent Settings-authored bindings cannot grant management-tool access to
  normal agents
- Agent Settings-authored bindings cannot bypass destructive approval policy

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- policy
```

### Slice 3.4: Config Scope And Secret Routes

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/server test -- hosted-integrations` failed before
  implementation because config-scope routes returned 404.
- Green validation:
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server build`

Goal:

- Add config-scope and human-only secret API routes:

```http
GET /api/hosted-integrations/config-scopes
GET /api/hosted-integrations/config-scopes/:scopeId
PUT /api/hosted-integrations/config-scopes/:scopeId
PUT /api/hosted-integrations/config-scopes/:scopeId/secrets
```

Non-goals:

- No agent-facing secret write tool.
- No secret value read endpoint.

TDD:

- config-scope GET routes return sanitized metadata only
- config-scope PUT increments revision
- secrets PUT requires human/admin authorization
- secrets PUT updates configured/missing metadata without echoing values

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
```

### Slice 3.5: Human Approval Gate MVP

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- approvals` failed
  before implementation because the approval store, evaluator, and provenance
  builder did not exist.
  `pnpm --filter @openacme/server test -- hosted-integrations` then failed
  before the approval route existed.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- approvals`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`

Goal:

- Represent human approval as a human-authenticated UI/API action.
- Record `approved_by`, `approved_at`, operation type, and target draft/tool
  metadata on destructive operations.

Non-goals:

- No separate approval workflow engine.
- No agent self-approval.

TDD:

- Tool Developer Agent cannot promote destructive changes without human approval
- human-authenticated destructive promotion records approval metadata
- approval metadata is included in generation provenance
- stale approval cannot be reused for a different draft revision

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- approvals
pnpm --filter @openacme/server test -- hosted-integrations
```

## Milestone 4: Generations, Gateway, And Python Runtime

Goal: promote validated hosted integration code into immutable generations and
invoke it through the gateway.

### Slice 4.1: Generation Artifact Store

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- generations` failed
  before implementation because the generation store/export did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- generations`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

Goal:

- Package a validated draft into an immutable generation.
- Track active generation per family.
- Support rollback to a prior generation.

Non-goals:

- No request draining yet.
- No runtime invocation yet.

TDD:

- promoting creates an immutable generation directory
- generation metadata records source draft, source revision, actor, validation
  result, and time
- active generation changes atomically
- rollback points active generation to an existing generation

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- generations
```

### Slice 4.2: Request Draining

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- draining` failed
  before implementation because invocation leases and registry-refresh events
  did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- draining`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

Goal:

- Add generation references and inflight counts.
- New calls use the new active generation.
- Existing calls complete on their starting generation.
- Retire old generations after inflight count reaches zero.

Non-goals:

- No canary.
- No retry orchestration.

TDD:

- call started before promotion uses old generation
- call started after promotion uses new generation
- old generation retires only after inflight reaches zero
- generation change emits a registry-refresh event for affected family tools

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- draining
```

### Slice 4.3: Run Directories And Response Artifacts

Goal:

- Create per-call run directories under family workspaces.
- Write sanitized input, output, error, and diagnostics artifacts.
- Spill large responses to `result_ref`.

Non-goals:

- No UI artifact browser.

TDD:

- every invocation gets a unique run directory
- small response returns inline
- large response returns `result_ref`
- caller-visible artifact is sanitized before write

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- artifacts
```

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- artifacts` failed before implementation because the artifact store/export did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- artifacts`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

### Slice 4.4: Python Dependency Policy V0

Goal:

- Let families declare Python dependencies.
- Resolve and validate dependencies during generation build.
- Pin the resolved dependency set in generation metadata.

Non-goals:

- No package installation during normal invocation.
- No broad dependency marketplace or UI.

TDD:

- family with no dependencies validates
- family with allowed dependencies records pinned metadata in the generation
- dependency change is visible in promotion provenance
- runtime invocation cannot trigger dependency installation

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- dependencies
```

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- dependencies` failed because `runtime.dependencies` was not a manifest contract and promoted generations had no `dependencyResolution`.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- dependencies`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

### Slice 4.5: Python Family Runtime V0

Goal:

- Execute a promoted Python family generation in an isolated worker process.
- Pass `ToolContext` with family home, run dir, config, and secrets.
- Return a structured result or structured error to the gateway.
- Apply the resolved runtime policy for filesystem access, process environment,
  subprocess use, network egress declaration, timeout, and concurrency.

Non-goals:

- No TypeScript family runtime.
- No live target systems.
- No perfect sandboxing claim beyond the explicit MVP policy contract.

TDD:

- fixture Python family lists tools
- fixture Python family receives config through context
- fixture Python family writes only inside run dir/family home
- fixture Python family does not receive undeclared raw process environment
- raised Python exception becomes `tool_bug`

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- python-runtime
```

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- python-runtime` failed because `HostedIntegrationPythonRuntime` did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- python-runtime`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

### Slice 4.6: Hosted Integration Gateway MVP

Historical note after Milestones 18 and 22: the invocation path no longer uses
config scope as an active product concept. New gateway work must resolve
environment config and hosted-tool binding state instead.

Goal:

- Implement invocation path:

```text
actor -> policy -> config scope -> generation -> Python runtime -> artifacts
```

- Enforce family/tool timeout and inline result spillover settings.
- Enforce invocation idempotency for write/destructive operations and transport
  retries.

Non-goals:

- No failure bucket automation yet.
- No async jobs yet.

TDD:

- denied invocation never reaches runtime
- allowed invocation reaches selected generation
- config revision is recorded on execution log
- runtime error is normalized
- timeout produces a normalized `timeout` error
- repeated idempotency key with the same fingerprint returns the original final
  envelope metadata
- repeated idempotency key with a different fingerprint is rejected before
  runtime dispatch

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- gateway
```

Status: done.

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- gateway` failed because `createFileHostedIntegrationGateway` did not exist.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- gateway`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

### Slice 4.7: Invocation, Run, Artifact, And Debug Routes

Status: done.

Historical note after Milestone 24: this milestone originally kept a temporary
`legacy_call_tool` compatibility path for early replacement fixtures. That path
is superseded. The active runtime/schema contract is fieldless derived-only:
manifests do not declare dispatch mode, and product runtime never dispatches
`call_tool(name, args, context)`.

Goal:

- Add runtime API routes:

```http
POST /api/hosted-integrations/invoke
POST /api/hosted-integrations/debug-runs
GET  /api/hosted-integrations/runs/:runId
GET  /api/hosted-integrations/runs/:runId/artifacts/:name
```

Non-goals:

- No async jobs in this slice.
- No artifact browser UI.

TDD:

- invoke route enforces access policy before runtime dispatch
- run detail route returns sanitized execution metadata
- artifact route enforces caller authorization
- artifact route allows the assigned Tool Developer Agent to read sanitized
  failure-bucket evidence artifacts
- ordinary management tools cannot read raw artifacts
- debug-run route can target a draft or promoted generation when policy allows
- debug-run route denies replay of write/destructive tools unless policy allows

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
```

Evidence:

- Focused validation initially failed until promotion test helpers used the
  source family code under test instead of fixed debug code.
- Green validation:
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/hosted-integrations test`

### Slice 4.8: Generation Routes

Status: done.

Goal:

- Add generation listing, detail, and rollback routes:

```http
GET  /api/hosted-integrations/generations
GET  /api/hosted-integrations/generations/:generationId
POST /api/hosted-integrations/generations/:generationId/rollback
```

Non-goals:

- No canary.

TDD:

- listing returns active and retired generation summaries
- detail returns promotion provenance and validation summary
- rollback route enforces policy
- rollback does not roll back secret values
- rollback changes only the active generation pointer and does not rewrite
  canonical family source

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
```

Evidence:

- Focused validation initially failed until `HostedIntegrationGenerationStore`
  exposed `listGenerations` through the built package and rollback returned the
  refreshed active status.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- generations`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

### Slice 4.9: Deprecation And Removal Policy

Status: done.

Goal:

- Implement tool lifecycle states:

```text
active -> deprecated -> hidden -> disabled -> removed
```

- Enforce breaking-change policy during validation and promotion.

Non-goals:

- No automatic migration assistant.

TDD:

- direct removal of an active tool fails validation
- deprecated tool still appears for existing allowed agents
- hidden tool is omitted from new prompt/tool picker surfaces
- disabled tool returns a policy/disabled error before runtime dispatch
- removed tool cannot be selected by new agents

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- deprecation
pnpm --filter @openacme/server test -- hosted-integrations
```

Evidence:

- Red test first:
  `pnpm --filter @openacme/hosted-integrations test -- deprecation` failed
  while tightening the hidden/deprecated selection fixture.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- deprecation`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`
- Checked planned tools-package command:
  `pnpm --filter @openacme/tools test -- hosted-integrations` currently has no
  matching test files, so the picker/tool-surface assertion lives in the server
  route suite for this slice.

### Slice 4.10: Operational Disable

Status: done.

Goal:

- Add immediate disable controls at family, tool, generation, and config-scope
  levels.
- Ensure disabled tools fail before runtime dispatch.

Non-goals:

- Disable is not deprecation.
- Disable is not automatic rollback.

TDD:

- disabled family blocks all new family invocations
- disabled tool blocks only that tool
- disabled config scope blocks invocations using that scope
- disabled generation is not selected for new calls
- disabled result is normalized and does not create duplicate repair buckets by
  itself

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- disable
pnpm --filter @openacme/server test -- hosted-integrations
```

Evidence:

- Focused validation initially exposed stale package `dist` when server tests
  were run before the hosted-integrations build completed; rerunning after the
  build passed.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- disable`
  `pnpm --filter @openacme/hosted-integrations test`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

### Slice 4.11: Example Execution And Promotion Routes

Status: done.

Goal:

- Add the runtime-dependent draft routes:

```http
POST /api/hosted-integrations/drafts/:draftId/run-example
POST /api/hosted-integrations/drafts/:draftId/promote
```

- Ensure promotion runs the required validation and example gates before
  creating an immutable generation.
- Atomically update canonical family source from the accepted draft under the
  family lock and record the resulting source revision on the generation.

Non-goals:

- No model-facing management tools yet.

TDD:

- run-example route executes through the draft runtime context
- run-example route writes a debug run directory and sanitized artifacts
- promote route refuses invalid drafts
- promote route refuses missing required examples
- promote route requires the current draft lock
- promote route creates a generation and updates active generation atomically
- promote route updates canonical source from the accepted draft
- next draft starts from the promoted source revision
- destructive promotion requires human approval

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/hosted-integrations test -- promotion
```

Evidence:

- Red tests first:
  `pnpm --filter @openacme/hosted-integrations test -- promotion` failed on a
  missing source revision metadata type guard.
  `pnpm --filter @openacme/server test -- hosted-integrations` exposed that
  draft example runs wrote artifacts without execution logs, so artifact routes
  could not authorize the debug run.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- promotion`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

## Milestone 5: ToolRegistry Surfacing And Management Tools

Goal: integrate hosted integrations into the existing OpenAcme tool surfaces
without inventing a second tool selection system.

### Slice 5.1: Runtime Tool Registry Adapter

Status: done.

Goal:

- Register promoted hosted integration tools as `ToolEntry` adapters.
- Show them in `/api/tools`.
- Group them as Hosted Integrations by family.
- Refresh registrations when a hosted integration generation changes.
- Evict cached Agent instances whose prompts may contain stale hosted
  integration schemas.
- Include hosted integration generation ids in the tool schema snapshot used to
  create per-turn callable adapters.

Non-goals:

- No Agent Settings UI redesign.

TDD:

- promoted `qualys_count_assets` appears in `toolRegistry.getInfo()`
- toolset/group metadata distinguishes hosted integrations from MCP tools
- collision with existing built-in tool is rejected
- generation promotion refreshes hosted integration registry entries
- affected agents are evicted so new turns see refreshed schemas
- in-flight calls keep using their starting generation
- generated tool adapters carry the captured generation id into gateway calls

Validation:

```text
pnpm --filter @openacme/tools test -- hosted-integrations
pnpm --filter @openacme/server test -- tools
```

Evidence:

- Red tests first:
  `pnpm --filter @openacme/server test -- hosted-integrations` failed because
  promoted hosted integration tools were not synced into `/api/tools`.
  `pnpm --filter @openacme/server test -- tools` initially had no matching
  server test file, so this slice added a startup-sync `/api/tools` coverage
  file.
- Green validation:
  `pnpm --filter @openacme/tools test -- hosted-integrations`
  `pnpm --filter @openacme/server test -- tools`
  `pnpm --filter @openacme/hosted-integrations test -- generations`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/tools check-types`
  `pnpm --filter @openacme/tools build`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

### Slice 5.2: Invocation Through Existing Agent Tool Path

Status: done.

Evidence:

- Focused validation first failed while wiring this slice:
  `pnpm --filter @openacme/agent-core test -- agent-preflight` exposed an
  incomplete test registry stub for `get()`;
  `pnpm --filter @openacme/server test -- tools-hosted-integrations` exposed
  the missing persisted agent binding in the invocation path before rebuilt
  config declarations reached server tests.
- Green validation:
  `pnpm --filter @openacme/config test -- agent-store`
  `pnpm --filter @openacme/config check-types`
  `pnpm --filter @openacme/config build`
  `pnpm --filter @openacme/agent-core test -- agent-preflight`
  `pnpm --filter @openacme/agent-core check-types`
  `pnpm --filter @openacme/agent-core build`
  `pnpm --filter @openacme/tools test -- hosted-integrations`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

Goal:

- A selected hosted integration tool reaches the Hosted Integration Gateway
  through `registry.getVercelTools()`.
- The gateway receives actor and selected tool context sufficient to resolve
  the agent/tool config-scope binding.

Non-goals:

- No full UI e2e yet.

TDD:

- agent with hosted integration tool in `agent.tools` receives the tool schema
- calling the tool routes to the gateway adapter
- agent without the tool in `agent.tools` does not receive it
- selected tool invocation uses the configured default config scope without
  exposing config-scope choice as a model argument
- a call from an older in-flight turn dispatches to the generation captured
  when that turn's tool schemas were built

Validation:

```text
pnpm --filter @openacme/agent-core test -- agent-preflight
pnpm --filter @openacme/tools test -- hosted-integrations
```

### Slice 5.3: Management Tool Wrappers

Status: done.

Goal:

- Add `hosted_tool_*` management tools in `packages/tools`.
- Each wrapper delegates to the Hosted Integrations API/control-plane port.
- Add a bindable hosted integrations control-plane interface following the
  existing tools package binding style, so tool handlers do not perform raw HTTP
  calls or import server route code.
- Cover the Tool Developer Agent lifecycle surface: family create/inspect,
  source inspect, lock/draft edit/delete, example list/upsert/run, validation,
  promotion, generation inspect/rollback, config-scope metadata inspect, debug
  run, and run/artifact inspect.
- Register failure bucket management tool names against the same bindable port,
  but keep their store/route behavior in Milestone 6.3 where failure buckets are
  introduced.

Non-goals:

- No duplicate lifecycle logic in tool handlers.
- No agent-facing secret write or secret value read tools.

TDD:

- management tool invokes the correct control-plane method
- unbound management tool returns a clear platform-unavailable error
- Tool Developer Agent policy can call management tools
- normal agent policy cannot call management tools
- management tools never return secret values
- management tools cannot self-approve destructive changes
- management tools cover every Tool Developer Agent lifecycle route without
  requiring filesystem access
- config-scope management tools return sanitized metadata only
- run/artifact management tools enforce caller authorization and sanitization

Validation:

```text
pnpm --filter @openacme/tools test -- hosted-integration-management
```

Evidence:

- Red/green validation:
  `pnpm --filter @openacme/server test -- tools-hosted-integrations` first
  exposed that `hosted_tool_promote` did not refresh the registry through
  the management path and that the test was reading registry info incorrectly.
- Green validation:
  `pnpm --filter @openacme/tools test -- hosted-integration-management`
  `pnpm --filter @openacme/tools check-types`
  `pnpm --filter @openacme/tools build`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`
- Isolated live smoke used
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env` on
  `127.0.0.1:3466` to promote and invoke a non-destructive Python
  `live_safe_echo` hosted integration without touching local prod.

### Slice 5.4: Tool Developer Agent Template

Status: done.

Goal:

- Add `packages/agent-catalog/templates/tool-developer/AGENT.md`.
- Mark it `managed: true`.
- Bundle the `hosted-integrations-development` skill. This slice adds the
  minimal builtin skill package so managed materialization never points at a
  missing dependency; Slice 5.5 expands the playbook content.

Non-goals:

- No custom agent materialization path.

TDD:

- `ensureManagedAgents()` materializes `tool-developer`
- managed-agent mutation protection applies
- Tool Developer Agent has hosted integration management tools

Validation:

```text
pnpm --filter @openacme/server test -- agent-catalog
```

Evidence:

- Red validation:
  `pnpm --filter @openacme/server test -- agent-catalog` first failed because
  only `acme` was materialized and `tool-developer` did not exist.
- Green validation:
  `pnpm --filter @openacme/server test -- agent-catalog`
  `pnpm --filter @openacme/agent-catalog check-types`
  `pnpm --filter @openacme/agent-catalog build`
  `pnpm --filter @openacme/skills check-types`
  `pnpm --filter @openacme/skills build`
  `pnpm --filter @openacme/server check-types`

### Slice 5.5: Hosted Integrations Development Skill

Status: done.

Goal:

- Expand the bundled `hosted-integrations-development` skill.
- Teach the practical lifecycle from request to promotion and failure repair.

Non-goals:

- Do not duplicate the architecture document.
- Do not expose secrets guidance that encourages reading secret files.

TDD:

- bundled skill installs through the existing template dependency path
- skill index includes the expected name and description

Validation:

```text
pnpm --filter @openacme/server test -- agent-catalog
```

Evidence:

- Red validation:
  `pnpm --filter @openacme/server test -- agent-catalog` first failed because
  the bundled skill still used the placeholder "Lifecycle guide" description
  and did not include the lifecycle guardrails asserted by the managed-agent
  install path.
- Green validation:
  `pnpm --filter @openacme/server test -- agent-catalog`
  `pnpm --filter @openacme/skills check-types`
  `pnpm --filter @openacme/skills build`
  `pnpm --filter @openacme/server check-types`

Implementation note:

- Slice commits are made locally after focused validation. Pushes are reserved
  for milestone or batch boundaries, risky transitions, long pauses/context
  compaction, or explicit user request, because the pre-push hook runs the
  expensive full build/e2e gate.

### Slice 5.6: Local Safe Hosted Tool Smoke

Status: done.

Goal:

- In the isolated local test environment, create or load a safe hosted
  integration family.
- Promote it through the real Hosted Integrations API lifecycle.
- Surface its tools through `/api/tools`.
- Bind one safe invocation tool to a test agent through Agent Settings data.
- Invoke the tool through the real agent/tool path.

Required safe tools:

```text
safe_echo
safe_sum
safe_large_result
```

Non-goals:

- No external credentials.
- No destructive operations.
- No production data dir.
- No production daemon.

TDD / Live Validation:

- `safe_echo` returns caller-provided text through the gateway envelope
- `safe_sum` validates numeric args and returns a deterministic result
- `safe_large_result` spills to `result_ref` instead of inline content
- `/api/tools` shows the promoted safe tools as Hosted Integrations
- a test agent selected for `safe_sum` can invoke it through
  `registry.getVercelTools()`
- validation evidence records the exact test data dir and port

Validation:

```text
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_E2E_PORT=3466 pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts
```

Evidence:

- Red validation:
  targeted e2e first failed because the test helper functions were scoped
  outside the e2e client/server variables, then failed again because
  `family_create` already returns the initial lock and draft while the test
  incorrectly tried to acquire a second lock.
- Green validation:
  `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts`
  `pnpm --filter @openacme/server check-types`
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_E2E_PORT=3466 pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts`
- Isolated live smoke used
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env` and
  `127.0.0.1:3466`. `lsof -nP -iTCP:3466 -sTCP:LISTEN` returned no listener
  after shutdown.
- The safe promoted tools were `safe_echo`, `safe_sum`, and
  `safe_large_result`; invocation went through Agent Settings data and
  `registry.getVercelTools()`. `safe_large_result` returned a `result_ref`
  artifact instead of inline payload.

## Milestone 6: Failure Buckets And Regression Loop

Goal: make promoted hosted integrations resilient by turning code-level failures
into repair work for the Tool Developer Agent.

### Slice 6.1: Execution Log Store

Status: done.

Goal:

- Record invocation start/finish with sanitized args, config revision,
  generation id, result metadata, duration, and normalized error.

Non-goals:

- No full observability dashboard.
- No OTEL blocker.

TDD:

- successful invocation writes one completed execution record
- failed invocation writes one failed execution record
- secret values are absent from execution logs

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- execution-log
```

Evidence:

- Red validation:
  `pnpm --filter @openacme/hosted-integrations test -- execution-log` first
  failed because execution logs did not include sanitized args, duration, or
  result metadata, and failed logs persisted raw normalized error details.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- execution-log`
  `pnpm --filter @openacme/hosted-integrations test -- gateway`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

### Slice 6.2: Failure Bucket Dedupe

Status: done.

Goal:

- Create or update failure buckets for owner-actionable failures.
- Fingerprint by family, tool, generation, standard error category, normalized
  stack/vendor code hash, and sanitized argument shape/hash when useful.

Non-goals:

- No complex bucket lifecycle.

TDD:

- same failure increments the same bucket
- different generation creates a distinct bucket
- policy_denied does not create a repair bucket
- target timeout can be classified as non-owner-actionable when policy says so

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- failure-buckets
```

Evidence:

- Red validation:
  `pnpm --filter @openacme/hosted-integrations test -- failure-buckets` first
  failed because no failure bucket store/export existed.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- failure-buckets`
  `pnpm --filter @openacme/hosted-integrations test -- execution-log`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

### Slice 6.3: Failure Bucket Routes And Tools

Status: done.

Goal:

- Expose list/get/assign/close routes.
- Expose list/get management tools.

Non-goals:

- No advanced workflow state machine.

TDD:

- Tool Developer Agent can list and inspect buckets
- normal agents cannot inspect buckets
- Tool Developer Agent can assign and close buckets when policy allows
- closing a bucket requires the related regression example to exist when a fix
  is linked

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management
```

Evidence:

- Red validation:
  `pnpm --filter @openacme/server test -- tools-hosted-integrations` first
  failed because `HostedIntegrationService.failureBuckets` was not wired.
  `pnpm --filter @openacme/server test -- hosted-integrations-routes` then
  caught one 6.1 schema drift in the draft-example route log path
  (`sanitizedArgs` missing).
- Green validation:
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server test -- hosted-integrations-routes`
  `pnpm --filter @openacme/tools test -- hosted-integration-management`
  `pnpm --filter @openacme/hosted-integrations test -- failure-buckets`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/tools check-types`
  `pnpm --filter @openacme/tools build`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

### Slice 6.4: Repair Task Creation

Status: done.

Goal:

- Assign new owner-actionable buckets to the Tool Developer Agent.
- Create a task with a sanitized repro package reference.
- Keep caller-facing tool result simple: `tool failed`.

Non-goals:

- No caller involvement in repair routing.

TDD:

- first bucket occurrence creates one Tool Developer Agent task
- repeated same bucket does not create duplicate tasks
- Tool Developer Agent test/debug failures write logs but do not create buckets
  or repair tasks
- task body includes bucket id, latest run ref, family, tool, generation, and
  sanitized error category
- caller result does not include task id or internal routing detail

Validation:

```text
pnpm --filter @openacme/server test -- tasks
pnpm --filter @openacme/hosted-integrations test -- failure-buckets
```

Implementation notes:

- `@openacme/hosted-integrations` emits a failure-bucket-recorded callback
  after the gateway writes the sanitized failed execution log and records the
  bucket. The package still does not depend on task-store/server internals.
- `ServerRuntime` adapts that callback into a Tool Developer Agent repair task,
  assigns the bucket to `tool-developer`, and uses a stable task-body marker to
  avoid duplicate open tasks for repeated occurrences of the same bucket.
- Normal agent-facing hosted tool failures are normalized to
  `{ code: "tool_failed", message: "tool failed" }`; run, bucket, and task
  routing details remain platform/developer surfaces.
- Tool Developer Agent test/example/debug invocations still write sanitized
  execution logs and artifacts, but management/debug surfaces mark them with
  explicit tool-maintenance invocation purpose. The gateway uses that purpose,
  not the `tool_developer` role alone, to suppress failure-bucket callbacks so
  the validation loop does not create repair-task churn.
- Current route authorization may temporarily key maintenance/debug authority
  off the canonical Tool Developer agent id. Track this as design debt:
  replace it with a centralized authority resolver based on managed-agent
  template metadata and future family maintainer/lock/bucket assignment state.

Evidence:

- Red validation:
  `pnpm --filter @openacme/server test -- hosted-integrations-routes` first
  failed because no Tool Developer Agent repair task was created for the new
  bucket.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- failure-buckets`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations-routes`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`
  `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/tasks.e2e.ts`
- Validation note:
  `pnpm --filter @openacme/server test -- tasks` has no matching unit test file
  in this repo; the task lifecycle coverage lives in `test/e2e/tasks.e2e.ts`
  and was run with the e2e Vitest config.

### Slice 6.5: Regression Example On Fix

Status: done.

Goal:

- Require fixed buckets to add or link a regression example before close.
- Validate that the regression example passes on the promoted fix generation.

Non-goals:

- No AI-generated test synthesis requirement.

TDD:

- bucket close with linked fix and no regression example fails
- bucket close succeeds after regression example passes
- regression example is retained in family source after promotion

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management
```

Implementation notes:

- Failure-bucket close now requires `draft_id` / `draftId`,
  `generation_id` / `generationId`, and `regression_example_id` /
  `regressionExampleId` evidence. The generation must belong to the bucket
  family and must have been promoted from the linked draft.
- The regression example must exist on the linked draft and in the promoted
  generation's copied `examples.yaml`, which verifies the regression was
  retained in source/generation artifacts after promotion.
- The close path executes the regression example against promoted generation
  files before closing. Failed regression execution leaves the bucket open and
  returns a sanitized regression run id to the Tool Developer Agent.

Evidence:

- Green validation:
  `pnpm --filter @openacme/server test -- hosted-integrations-routes`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`
  `pnpm --filter @openacme/tools test -- hosted-integration-management`
  `pnpm --filter @openacme/tools check-types`
  `pnpm --filter @openacme/tools build`

### Slice 6.6: Run Artifact Retention

Status: done.

Goal:

- Add retention policy for run directories, artifacts, execution logs, and
  failure-bucket evidence.
- Successful runs may expire by age.
- Failed runs tied to open buckets are retained until the bucket closes, then
  follow retention.

Non-goals:

- No user-facing retention UI yet.
- No archival export.

TDD:

- successful old run artifacts are swept
- failed run artifacts tied to open buckets are retained
- failed run artifacts tied to closed buckets follow retention policy
- sweep never deletes active job/run directories
- sweep logs counts and bytes without exposing artifact content

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- retention
```

Implementation notes:

- Added a hosted-integrations retention sweeper that deletes expired run
  directories, execution logs, and closed failure-bucket evidence while
  retaining failed run/log evidence tied to open bucket fingerprints.
- Running run directories/logs are never deleted, even when old.
- Sweep logging is count/byte-only and intentionally excludes artifact content.
- `HostedIntegrationService` exposes the retention sweeper as a hosted
  integrations package port, keeping the policy implementation outside server
  routes.

Evidence:

- Red validation:
  `pnpm --filter @openacme/hosted-integrations test -- retention` first failed
  because `createFileHostedIntegrationRetentionSweeper` was not implemented.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- retention`
  `pnpm --filter @openacme/hosted-integrations test -- artifacts failure-buckets execution-log`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

## Milestone 7: Async Jobs And Explicit Cache Tools

Goal: support longer-running hosted integration work without making the MVP
gateway or examples complex.

### Slice 7.1: Async Job Contract

Status: done.

Goal:

- Add opt-in async execution for tools classified as `execution: async`.
- Support start, status, cancel, and result.

Non-goals:

- No resumable progress event stream.

TDD:

- sync-only tool rejects async start
- async tool returns job id
- status returns latest progress snapshot
- cancel applies only to running async jobs
- result returns `result_ref`

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- jobs
```

Implementation notes:

- Added the file-backed hosted integration job store and expanded
  `HostedIntegrationJob` with generation, actor, progress, result ref,
  cancellation, and error fields.
- Async start is contract-level and opt-in: tools with `execution: sync` are
  rejected by the store. Route/worker binding remains in Slice 7.2+.
- Job status exposes the latest progress snapshot. `cancel` only applies while
  the job is running. `result` returns a `result_ref` only after success.
- `HostedIntegrationService` exposes the job store as the package-level port.

Evidence:

- Red validation:
  `pnpm --filter @openacme/hosted-integrations test -- jobs` first failed
  because `createFileHostedIntegrationJobStore` was not implemented.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- jobs`
  `pnpm --filter @openacme/hosted-integrations test -- jobs retention gateway validation`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

### Slice 7.2: Async Job Routes

Status: done.

Goal:

- Add async job API routes:

```http
POST /api/hosted-integrations/jobs
GET  /api/hosted-integrations/jobs/:jobId
POST /api/hosted-integrations/jobs/:jobId/cancel
GET  /api/hosted-integrations/jobs/:jobId/result
```

Non-goals:

- No resumable progress event stream.

TDD:

- job start enforces tool classification and access policy
- job start enforces idempotency for duplicate async-start requests
- status returns latest progress snapshot
- cancel is allowed only for cancellable async jobs
- result returns `result_ref` and never raw secret-bearing output

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
```

Implementation notes:

- Added HTTP job routes for async hosted tools:
  `POST /api/hosted-integrations/jobs`,
  `GET /api/hosted-integrations/jobs/:jobId`,
  `POST /api/hosted-integrations/jobs/:jobId/cancel`, and
  `GET /api/hosted-integrations/jobs/:jobId/result`.
- Job start reuses hosted integration policy evaluation, config-scope
  resolution, active generation resolution, and tool classification checks.
  `execution: sync` tools return `sync_only` instead of enqueueing.
- Async-start idempotency is persisted on the job record by
  `idempotencyKey + requestFingerprint`: identical retries return the same job
  as replayed, while mismatched retries return `idempotency_conflict`.
- Public job responses hide idempotency key/fingerprint internals and result
  reads return only `result_ref`.
- This slice still does not run the background async worker; route tests drive
  status/result transitions through the job-store port.

Evidence:

- Red validation:
  `pnpm --filter @openacme/server test -- hosted-integrations-routes` first
  failed because the job routes returned 404.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- jobs gateway`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server test -- hosted-integrations-routes`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server check-types`
  `pnpm --filter @openacme/server build`

### Slice 7.3: Explicit Cache Contract

Status: done.

Goal:

- Support tools classified as `freshness: cached` or `freshness: sync`.
- Store family-owned cache metadata under family home.

Non-goals:

- No implicit response cache.

TDD:

- live tool cannot read previous response as cache
- cached tool must declare cache metadata
- cached tool cache path is under family home
- caller agent does not gain write access to family home

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- cache-contract
```

Implementation notes:

- Added explicit `tool.cache` metadata for tools classified with
  `freshness: cached` or `freshness: sync`.
- `freshness: live` tools cannot declare cache metadata, which keeps the
  platform from becoming an implicit response cache.
- Cache paths resolve only under the family-owned `family_home` scope. Path
  traversal or absolute escape attempts are rejected by validation.
- The cache resolver uses family home directly and does not derive cache access
  from the caller agent workspace.

Evidence:

- Red validation:
  `pnpm --filter @openacme/hosted-integrations test -- cache-contract` first
  failed because cache metadata was not part of the manifest schema,
  freshness/cache validation did not exist, and the cache path resolver was not
  exported.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- cache-contract`
  `pnpm --filter @openacme/hosted-integrations test -- cache-contract validation schemas gateway`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/server check-types`

## Milestone 8: UI Integration

Status note: early Agent Settings/Admin config-scope UI requirements in this
milestone are historical/superseded. New UI work must expose only `prod` and
`test_debug` environment configs plus agent hosted-tool bindings.

Goal: expose hosted integrations through both Agent Settings and human-native
family management/editor surfaces.

### Slice 8.1: Agent Settings Tool Grouping

Goal:

- Show hosted integration tools under Hosted Tools groups.
- Preserve existing built-in and MCP groups.
- Let authorized users select the default config scope for each hosted
  integration family/tool binding when more than one scope is available.
- Let authorized users configure per-agent hosted integration invocation access
  directly in Agent Settings.

Non-goals:

- No hosted integration editor UI yet.

TDD:

- UI grouping helper distinguishes built-in, MCP, and hosted integration tools
- hosted integration tools can be toggled like other non-system tools
- toggling a hosted integration tool creates or updates the agent/tool policy
  binding used by the gateway
- disabled hosted integration tools are shown as unavailable, not ordinary
  selectable tools
- policy-ineligible hosted integration tools are hidden or disabled when the
  agent context is available
- hosted integration binding with multiple config scopes requires a default
  before save
- config-scope labels render sanitized metadata only

Validation:

```text
pnpm --filter web check-types
pnpm --filter web test -- agents
```

Status: done.

Implemented:

- Added a web helper for Agent Settings tool grouping that preserves built-in
  and MCP toolsets while grouping hosted integration tools under
  `Hosted Tools / <family>`.
- Mirrored hosted integration tool source metadata in the web `ToolInfo` type.
- Loaded sanitized hosted integration config scopes into the Agents page.
- Wired hosted integration tool toggles to create/update/prune per-agent
  `hostedIntegrationBindings` alongside the existing `tools` allowlist.
- Added default config-scope selection for selected hosted integration tools;
  unavailable hosted tools remain visible but disabled until a family config
  scope exists.
- Moved hosted tool config-scope binding controls next to the Hosted Tools
  groups in Agent Settings, so access policy setup stays attached to the
  selected hosted tools instead of appearing after the full tool catalog.
- Agent Settings now renders selected tool groups before unselected catalog
  groups, keeping existing hosted tool access policy visible before unrelated
  available tools.
- Hosted tool names in Agent Settings wrap to two lines with full-name hover
  detail, so selected hosted tools can be distinguished by operation instead of
  being clipped at the shared `hosted_<family>__...` prefix.
- Hosted tool access binding rows follow the same readable-name rule and label
  the `Config scope` selector explicitly, so access policy rows remain
  understandable on mobile.
- Added a server route regression test proving `/api/agents/:id` persists
  hosted integration access bindings from Agent Settings payloads.

Green validation:

```text
pnpm --filter web test -- hosted-integration-agent-settings
pnpm --filter web check-types
pnpm --filter @openacme/server test -- app-routes
pnpm --filter web test
pnpm --filter @openacme/server check-types
```

Note: `pnpm --filter web test -- agents` currently has no matching test file in
the repo and exits with `No test files found`; the new helper test plus full web
test run cover this slice.

### Slice 8.2: Minimal Hosted Integrations Admin View

Goal:

- Add a read-only view for families, tools, active generations, config scopes,
  and failure buckets.

Non-goals:

- No browser code editor in this slice.

TDD:

- view loads family list from `/api/hosted-integrations/families`
- view does not render secret values
- failure bucket list links to bucket detail
- family detail shows active generation and edit lock owner/expiry when locked

Validation:

```text
pnpm --filter web check-types
```

Status: done.

Implemented:

- Added a read-only Settings tab for hosted integration families.
- Added a view-model helper that aggregates families with tools, active
  generation, sanitized config-scope summaries, active lock, and open failure
  bucket counts.
- Added `GET /api/hosted-integrations/families/:familyId/lock` so the UI can show
  lock owner/expiry without acquiring a lock.
- Linked each family row to the existing failure-bucket API filtered by family.
- Kept secret values out of the admin model and UI while exposing config-scope
  key metadata: non-secret config key names, secret key names, and
  configured/missing secret status are visible without raw secret values.

Green validation:

```text
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings
pnpm --filter web check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes
pnpm --filter web test
pnpm --filter @openacme/server check-types
```

### Slice 8.3: Browser Draft Code Editor

Goal:

- Let authorized humans and the Tool Developer Agent workflow inspect canonical
  source, acquire/renew/release family locks, create drafts, edit draft files,
  update examples, validate, run examples, and submit promotion.
- Show lock owner/expiry, draft revision, validation diagnostics, example
  results, and promotion eligibility in the editor surface.
- Route every action through the Hosted Integrations API; the UI must not write
  directly to repo or data-dir paths.

Non-goals:

- No multi-user merge editor.
- No secret value editor inside the code editor.
- No destructive promotion self-approval by agents.

TDD:

- opening a family source file uses the read-only source API
- editing requires an active lock owned by the actor
- stale or expired lock prevents draft patch
- stale or expired lock prevents draft delete
- validation diagnostics render without exposing secret values
- destructive promotion path shows human approval required instead of invoking
  agent self-approval

Validation:

```text
pnpm --filter web check-types
pnpm --filter web test -- hosted-integrations
```

Status: done.

Implemented:

- Added a browser draft editor inside the hosted integrations Settings tab.
- The editor reads canonical source through
  `/api/hosted-integrations/families/:familyId/source/files/*`.
- The editor can acquire/release family locks, create drafts, read draft files,
  patch/delete draft files, upsert examples, run examples, validate drafts, and
  submit promotion through the hosted integrations API.
- Added optional backend lock-owner enforcement for draft file patch/delete and
  example upsert. Existing management tools remain compatible because the
  owner check only runs when `lockedBy` is supplied.
- The editor sends `lockedBy: web-settings`; edits are disabled unless the
  active lock is owned by that actor.
- Destructive promotion displays the human-approval requirement and does not
  create agent self-approval.

Green validation:

```text
pnpm --filter web check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes
pnpm --filter web test -- hosted-integrations
pnpm --filter @openacme/server check-types
pnpm --filter web test
```

## Milestone 9: Observability Wiring

Goal: connect hosted integrations execution records to existing OpenTelemetry
without making observability a blocker for the core lifecycle.

### Slice 9.1: OpenTelemetry Span And Metrics Bridge

Goal:

- Emit spans, metrics, and events through the existing OpenTelemetry channel
  from gateway execution lifecycle events.

Non-goals:

- No new exporter stack.
- No raw args or secret values in spans.

TDD:

- invocation emits a span with family, tool, generation, actor type, and status
- denied calls emit a policy-denied event without runtime dispatch
- large responses increment large-response metric
- no raw secret/config values are emitted as attributes

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- telemetry
```

Status: done.

Implemented:

- Added a hosted integration telemetry bridge with a default
  `@opentelemetry/api` tracer/meter implementation and injectable test sink.
- Gateway invocations now emit `hosted_integration.invoke` spans with family,
  tool, environment, actor kind, generation, run id, replay status, and final
  status attributes.
- Policy/config denial outcomes add a policy-denied span event without runtime
  dispatch.
- Artifact/large responses add a span event and increment
  `openacme.hosted_integrations.large_responses`.
- Telemetry attributes intentionally exclude raw args, config values, and
  secret values.

Green validation:

```text
pnpm --filter @openacme/hosted-integrations test -- telemetry
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/hosted-integrations test -- telemetry gateway artifacts execution-log
pnpm --filter @openacme/hosted-integrations build
pnpm --filter @openacme/server check-types
```

## Milestone 10: Legacy Integration-Hub Migration

Status: historical / superseded.

This milestone records early implementation history only. Do not implement its
runtime conversion fixture, generated source fixture, config-scope model,
readiness target, or view-level cutover decisions. Active contract is Milestone
18 and later, with the offline parity/test-input boundary formalized in
Milestone 20, the artifact/terminology boundary formalized in Milestone 21, and
the config boundary audit formalized in Milestone 22.

Goal: move from the current external `integration-hub` stdio MCP setup to
hosted integrations without breaking existing Qualys, Splunk, Microsoft Graph,
MDE, and defender-alert workflows.

### Slice 10.1: Integration-Hub Compatibility Inventory

Status: done.

Evidence:

- The current worktree does not contain
  `workspace/src/integration_hub/integrations`; searched the platform
  workspace and sibling AIProjects directories before treating the legacy
  source as external/unavailable.
- Added an early reference inventory in package runtime source.
  Historical note after Milestones 20 and 21: legacy integration-hub replacement
  fixtures now live under
  `packages/hosted-integrations/test-support/integration-hub/`, not package
  runtime source.
- Seeded Qualys tool names from the installed `qualys-toolkit` reference and
  seeded Splunk, Microsoft Graph, MDE, and defender-alert placeholder tools
  from the hosted integrations architecture notes.
- Preserved legacy external MCP names as
  `mcp_integration-hub__<legacyToolName>`. This early migration inventory kept
  hosted registry names equal to legacy native tool names; Milestone 11
  supersedes that target with hosted tool canonical registry names.
- Captured family-level config keys and human-managed secret refs for the early
  config-scope model. Historical note after Milestone 18: active
  implementation uses `prod` and `test_debug` environment configs plus
  separate agent bindings, not arbitrary config scopes.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Inventory existing `integration-hub` families, tools, schemas, examples,
  result-file behavior, env requirements, and known incidents.
- Produce replacement metadata from old MCP tool names to hosted integration
  tool names.

Non-goals:

- No code migration yet.

TDD:

- inventory fixture captures every expected old tool name
- replacement metadata rejects missing or duplicate target tool names
- env/config requirements map to environment config metadata and secret refs

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
```

### Slice 10.2: Replace First Read-Only Family

Status: done.

Evidence:

- Added an early first replacement read-only family fixture for
  `splunk/splunk_search`.
- Preserved the legacy external MCP registry name
  `mcp_integration-hub__splunk_search` in the replacement fixture metadata.
- Proved the replacement source validates, registers examples, promotes to an
  active generation, and exposes the expected hosted tool name.
- Proved a registered example runs through the hosted integration gateway and
  real Python runtime with config metadata and human-owned secret metadata.
- Proved legacy `result_file` behavior maps to hosted run artifacts for large
  responses and does not expose the dummy secret value in the artifact.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/tools test -- hosted-integrations`

Goal:

- Build one hosted replacement for an existing read-only family, preferably
  `example` or the smallest real family.
- Validate source, examples, promotion, registry surfacing, and invocation.

Non-goals:

- No broad Qualys migration yet.

TDD:

- replacement family exposes the expected hosted tool names
- examples pass through hosted integration runtime
- old result-file expectations map to run artifacts

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/tools test -- hosted-integrations
```

### Slice 10.3: Replace Security Families

Status: done.

Evidence:

- Added generated replacement fixtures for Qualys, Microsoft Graph, MDE, and
  defender-alert, alongside the first Splunk replacement family.
- Each replacement family fixture is generated from the replacement inventory so
  hosted tool names, legacy MCP names, config keys, secret refs, freshness, and
  result behavior stay aligned.
- Proved every replacement security family validates, registers examples, and
  promotes to an active generation.
- Proved config and secret requirements are represented as hosted config-scope
  metadata and replacement Python fixtures do not read process env directly.
  Historical note after Milestone 18: active config work uses environment
  configs and separate hosted-tool bindings.
- Proved hosted cache declarations exist only for tools classified as
  `cached` or `sync`.
- `ops/incidents.jsonl` is not present in the current worktree; no synthetic
  regression examples were created.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement`
  `pnpm --filter @openacme/hosted-integrations check-types`
  `pnpm --filter @openacme/hosted-integrations build`

Goal:

- Build hosted replacements for Qualys, Splunk, Microsoft Graph, MDE, and
  defender-alert incrementally.
- Preserve read-only/write/destructive classifications.
- Preserve known regression cases from current `ops/incidents.jsonl`.

Non-goals:

- No new target-system capabilities during replacement unless needed to
  preserve existing behavior.

TDD:

- each replacement family validates with examples
- known incident reproductions become regression examples
- environment configs replace process-global env requirements
- no hosted replacement stores target-system response cache unless the tool is
  explicitly classified as cached/sync

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
```

### Slice 10.4: Cut Over Agent Tooling

Status: superseded by Milestone 11 naming-boundary hardening.

The evidence below records the earlier implementation state. It is no longer
the target naming contract. Do not reintroduce view-level hiding, cutover alias
behavior, or remote-MCP-to-hosted authorization redirects.

Evidence:

- Added a registry view option that hides legacy
  `mcp_integration-hub__<tool>` entries when an active hosted integration tool
  with the same native name is registered.
- Kept raw registry registration intact so legacy MCP discovery can still
  exist during parity verification.
- `/api/tools` now uses the cutover view, so Agent Settings sees hosted
  integration tools without duplicate legacy integration-hub MCP names.
- Agent model-facing tool emission uses the same cutover view, so hosted tool
  schemas are emitted and replaced legacy MCP names are suppressed.
- Proved legacy MCP-only tools are still visible when no hosted replacement
  exists.
- Green validation:
  `pnpm --filter @openacme/tools test -- hosted-integrations`
  `pnpm --filter @openacme/tools check-types`
  `pnpm --filter @openacme/tools build`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/agent-core check-types`
  `pnpm --filter @openacme/server check-types`

Goal:

- Stop exposing migrated hosted integration families through the external
  `integration-hub` MCP server path.
- Keep hosted integration tools visible through `/api/tools` and Agent Settings.

Non-goals:

- Do not remove the old integration-hub workspace until parity is verified.

TDD:

- migrated hosted integration tools appeared without `mcp_<server>__` names in
  the earlier native-name cutover view
- old MCP tool registrations can be disabled without removing hosted tools
- agents configured for hosted tools receive hosted schemas

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integrations
```

## Milestone 11: Hosted Tool Naming Boundary

Goal: make hosted integration tools and remote MCP tools independent at the
canonical tool-name boundary. Agent Settings, access policy, model-facing tool
schemas, run logs, and migration/cutover behavior must not rely on native
hosted tool names colliding with remote MCP names.

Architecture contract:

- family manifests keep family-native tool names, such as `splunk_search`
- registry-facing hosted tools use `hosted_<family>__<tool>`
- hosted canonical names must satisfy the model-provider tool/function name
  pattern and length cap; invalid pairs fail validation instead of being
  truncated, hashed, aliased, or rewritten
- remote MCP tools keep `mcp_<server>__<tool>`
- Agent Settings stores and enables canonical registry names
- registry `ToolInfo.source` for hosted integrations carries the native
  `source.toolName` as well as `familyId`, `familyName`, and `generationId`
- hosted integration bindings still store `familyId`, family-native `toolName`,
  config scopes, environment, and policy data
- the registry adapter maps canonical hosted names back to
  `familyId/toolName/generationId` before dispatch
- direct `/api/hosted-integrations/*` control-plane calls keep using
  family-native `toolName` inside their family context
- hosted integration management-tool parameters keep using family-native
  `tool_name`
- remote MCP entries must never enable hosted tools
- hosted tool entries must never enable remote MCP tools
- migration `replaces` metadata is operational metadata only, not an
  authorization alias

Non-goals:

- No live integration-hub sync/cutover in this milestone.
- No compatibility alias that accepts both old native hosted names and new
  hosted names in Agent Settings.
- No removal of remote MCP registrations.
- No Agent Settings redesign beyond presenting the corrected canonical names.

### Slice 11.1: Naming Contract And Registry Adapter

Status: done.

Evidence:

- Added provider-safe hosted tool naming helpers in
  `@openacme/hosted-integrations`.
- Registered hosted integration tools as `hosted_<family>__<tool>` while
  preserving native family tool names in source metadata and gateway dispatch.
- Extended hosted `ToolSource` metadata with native `source.toolName`.
- Routed hosted registry invocations with both `canonicalToolName` and native
  `toolName`.
- Removed default legacy integration-hub hiding from `/api/tools` and
  model-facing tool emission.
- Proved hosted tools and remote MCP tools coexist as independent
  registry surfaces.
- Proved stale native hosted tool names are removed during hosted-name refresh
  so cached agents are evicted across the rename transition.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- naming`
  `pnpm --filter @openacme/tools test -- hosted-integrations`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/agent-core check-types`

Goal:

- Add a single hosted integration canonical-name helper in
  `@openacme/hosted-integrations` or the thin tools adapter.
- Register hosted integration tools as `hosted_<family>__<tool>`.
- Reject provider-incompatible hosted canonical names during validation or
  registry sync; do not introduce generated aliases.
- Preserve family-native names in manifests, examples, generations, gateway
  calls, direct Hosted Integrations API calls, async jobs, disablements, run
  logs, artifacts, and failure buckets.
- Extend hosted `ToolSource` metadata with the family-native tool name so UI
  and runtime policy do not reverse-engineer it from the hosted canonical
  name.
- Carry both `canonicalToolName` and family-native `toolName` through the
  hosted registry adapter invocation request.
- Remove hardcoded legacy integration-hub hiding from default `/api/tools` and
  model-facing emission paths.

TDD:

- canonical helper builds and parses `hosted_<family>__<tool>`
- invalid family/tool segments are rejected
- provider-incompatible hosted canonical names, including over-length names,
  are rejected with actionable diagnostics
- canonical parser preserves family ids with hyphens and native tool names with
  underscores
- hosted registry adapter exposes hosted names but dispatches native
  `familyId/toolName`
- hosted registry adapter rejects canonical collisions without treating native
  name matches as cross-layer replacements
- `ToolInfo.source.toolName` is present for hosted tools returned by
  `/api/tools`
- raw remote MCP and hosted tools can coexist in `/api/tools`
- no view-level hiding occurs without an explicit future cutover option
- registry observation spans record the hosted canonical tool name while
  hosted execution logs record `familyId` plus native `toolName`
- registry refresh evicts cached agents for both removed native hosted names
  and newly registered hosted canonical names during the rename transition

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- naming
pnpm --filter @openacme/tools test -- hosted-integrations
pnpm --filter @openacme/server test -- tools-hosted-integrations
pnpm --filter @openacme/agent-core check-types
```

### Slice 11.2: Agent Settings And Policy Boundary

Status: done.

Evidence:

- Updated Agent Settings helpers to store hosted integration selections in
  `agent.tools` with hosted canonical names while preserving hosted bindings
  as family-native `familyId/toolName` records.
- Updated hosted registry/runtime policy tests so `hosted_*` hosted selections
  and `mcp_*` remote MCP selections do not satisfy each other.
- Added native-name diagnostics for hosted integration management tools and
  direct hosted control-plane calls where `tool_name` must stay family-native.
- Updated Tool Developer Agent skill coverage so developer-facing lifecycle
  guidance names the native-vs-hosted-registry boundary explicitly.
- Updated safe-tools and hosted-integrations dogfood fixtures so consumer
  agents call promoted hosted tools through hosted tool canonical registry names.
- Real LLM dogfood passed the skill, create/promote, consumer invocation,
  access-denial, and failure-bucket repair scenarios in the test data dir
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env`.
- Real LLM dogfood exits cleanly after emitting `{"status":"pass"}`; the
  harness closes app runtime first, then bounds HTTP server cleanup, and logs
  dogfood-only abort noise instead of crashing on provider/timeout aborts.
- Green validation:
  `pnpm --filter web test -- hosted-integration-agent-settings`
  `pnpm --filter @openacme/config test -- agent-store`
  `pnpm --filter @openacme/server test -- hosted-integrations`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server test -- agent-catalog`
  `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-dogfood.e2e.ts`
  `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts`
  `pnpm --filter @openacme/server check-types`

Goal:

- Store hosted tool selections in `agent.tools` using canonical
  `hosted_<family>__<tool>` names.
- Keep hosted integration bindings keyed by family-native
  `familyId/toolName`.
- Enforce that a selected remote MCP name cannot satisfy a hosted integration
  binding and that a selected hosted registry name cannot satisfy an MCP tool.
- Update API route tests and dogfood fixtures to use hosted canonical names
  for model-facing calls.
- Update the real LLM dogfood script so the developer-created native family
  tools are consumed through hosted tool canonical registry names.
- Update Agent Settings web helpers so binding creation, default-scope editing,
  and stale-binding pruning use `tool.source.toolName`, not the hosted
  canonical `tool.name`.
- Update config schema tests to preserve hosted bindings as family-native
  `familyId/toolName` records while `agent.tools` stores hosted canonical
  names.
- Update the Tool Developer Agent skill so it explicitly says management-tool
  `tool_name`, manifest names, examples, debug runs, and failure-bucket
  references are family-native names, while Agent Settings/model-facing tools
  use hosted canonical names.

TDD:

- consumer agent with `hosted_splunk__splunk_search` and a matching hosted
  binding can invoke the hosted tool
- consumer agent with only `mcp_integration-hub__splunk_search` cannot invoke
  the hosted tool
- consumer agent with only `hosted_splunk__splunk_search` cannot invoke the
  remote MCP tool
- denied hosted binding still returns normalized `policy_denied`
- `/api/tools` shows MCP and hosted tool entries as separate surfaces
- Agent Settings selecting `hosted_qualys__qualys_count_assets` stores
  `agent.tools=["hosted_qualys__qualys_count_assets"]` and a hosted binding
  with `toolName="qualys_count_assets"`
- direct `/api/hosted-integrations/invoke`, jobs, and debug runs continue to
  accept family-native `toolName`, not hosted canonical names
- `hosted_tool_*` management tools reject or clearly diagnose hosted
  canonical names where family-native `tool_name` is required
- Tool Developer Agent skill tests cover the native-vs-hosted-registry naming guidance

Validation:

```text
pnpm --filter web test -- hosted-integration-agent-settings
pnpm --filter @openacme/config test -- agent-store
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/server test -- tools-hosted-integrations
pnpm --filter @openacme/server test -- agent-catalog
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-dogfood.e2e.ts
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts
pnpm --filter @openacme/server check-types
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_E2E_PORT=3466 pnpm --filter @openacme/server dogfood:hosted-integrations:real-llm
```

### Slice 11.3: Migration Metadata Without Authorization Aliases

Status: done.

Evidence:

- Added hosted tool canonical replacement metadata to legacy
  integration-hub migration inventory entries.
- Added migrated-family metadata for `hostedToolNames` and explicit
  legacy-MCP-to-hosted replacement mappings.
- Kept generated family manifests, examples, runtime execution, cache metadata,
  and promoted generation tool names family-native.
- Validation now rejects malformed hosted tool names, malformed legacy MCP
  names, duplicate native hosted targets, and duplicate hosted registry targets.
- Server policy tests still prove replacement metadata is not an authorization
  alias: a remote MCP-only selection cannot invoke a hosted tool.
- Green validation:
  `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement`
  `pnpm --filter @openacme/hosted-integrations build`
  `pnpm --filter @openacme/tools check-types`
  `pnpm --filter @openacme/server test -- tools-hosted-integrations`
  `pnpm --filter @openacme/server check-types`

Goal:

- Add explicit migration metadata that can state
  `hosted_<family>__<tool>` replaces `mcp_<server>__<tool>`.
- Keep replacement metadata out of dispatch and access policy.
- Update integration-hub migration fixtures so hosted migrated tool names are
  hosted canonical names at registry/UI boundaries while source/runtime names
  stay native.
- Add parity tests that prove replacement metadata can be displayed or queried
  without hiding, enabling, or redirecting either tool.

TDD:

- migration inventory records both legacy MCP canonical name and hosted
  hosted canonical name
- replacement metadata rejects malformed MCP or hosted names
- migration fixtures promote native family tools and expose hosted registry
  names
- replacement metadata does not change agent allowlists or gateway policy

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/server test -- tools-hosted-integrations
pnpm --filter @openacme/tools check-types
pnpm --filter @openacme/server check-types
```

## Milestone 12: Convert Integration-Hub To Hosted Tools

Status note: this milestone remains valid only for source-backed hosted
replacement and parity goals. Any references below to config scopes or
config-scope bindings are historical/superseded by Milestones 18 and 22.

Goal: port the real legacy `integration-hub` tool implementations into hosted
tool families while keeping the existing remote MCP
`integration-hub` server available. This milestone is conversion and parity,
not deletion or forced cutover.

Architecture contract:

- Do not delete the legacy `integration-hub` source, MCP server registration,
  or remote MCP tool surface in this milestone.
- Hosted tools are added alongside remote MCP tools as independent
  registry entries using `hosted_<family>__<tool>`.
- Legacy remote MCP entries keep `mcp_integration-hub__<tool>`.
- Replacement metadata may say a hosted tool replaces a remote MCP
  tool, but this remains operational metadata and never becomes an
  authorization alias.
- Port real tool code family by family from the legacy integration-hub source
  into hosted integration family source. Generated migration fixtures are not
  enough for this milestone.
- Hosted family manifests, examples, debug runs, failure buckets, logs, and
  config-scope bindings keep family-native tool names.
- Agent Settings can enable hosted tool replacements explicitly, per agent,
  through the existing hosted tool policy path.
- The conversion must preserve existing env/config/secret behavior through
  hosted config scopes and human-owned secrets, not process-global env reads.
- Explicit cache behavior may be recreated only for tools whose legacy behavior
  was explicitly cache/sync oriented.
- Hosted source must not be embedded as static package code for real
  families. Agents manage source through the hosted integration source/draft
  store; promotion copies a validated snapshot into an immutable generation.
- Runtime and `/api/tools` registry refresh must be event/index driven. Startup
  may read the active generation index, but it must not recursively scan source
  trees or generation directories on every request or refresh.
- Live target-system validation is optional per family until credentials are
  configured; every family still needs mock/parity examples that exercise real
  hosted runtime code, not generated placeholders.

Non-goals:

- No deletion of `integration-hub`.
- No hidden rewrite from `mcp_integration-hub__*` to `hosted_*`.
- No compatibility alias that lets an MCP allowlist invoke hosted tools.
- No all-at-once cutover.
- No canary promotion redesign.
- No broad new integration capability beyond preserving the legacy tool
  behavior.

### Slice 12.0: Five Read-Only Hosted Sync Pilot

Status: done.

Evidence:

- Added a bounded Qualys pilot fixture for five read-only legacy
  `integration-hub` tools:
  `qualys_gav_asset_count`, `qualys_gav_asset_search`,
  `qualys_cloud_agent_hostasset_count`,
  `qualys_cloud_agent_hostasset_search`, and `qualys_vmdr_host_list`.
- The pilot exposes the hosted tool names `hosted_qualys__<tool>` while
  preserving the legacy remote MCP names `mcp_integration-hub__<tool>` as
  separate migration metadata.
- The pilot intentionally uses generated hosted source because Slice 12.1 has
  not yet frozen the authoritative legacy `integration-hub` source tree. This
  proves the hosted sync surface, not source-backed parity.
- `packages/hosted-integrations/test/integration-hub-replacement.test.ts` proves all five tools
  validate, register examples, promote, and invoke through the hosted gateway
  with an explicit Qualys config scope.
- `packages/server/test/tools-hosted-integrations.test.ts` proves `/api/tools`
  shows the five hosted tools without hiding same-target remote MCP
  tools, and proves a remote MCP-only agent cannot invoke the hosted names.

TDD:

- fixture metadata must preserve native tool order and expose one example per
  pilot tool
- hosted gateway invocation must require explicit config-scope policy binding
- hosted tool names and remote MCP names must coexist in `/api/tools`
- `mcp_integration-hub__*` selections must not authorize
  `hosted_qualys__*` invocation

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/hosted-integrations build
pnpm --filter @openacme/server test -- tools-hosted-integrations
```

### Slice 12.1: Locate And Freeze Legacy Integration-Hub Source

Status: done for the Qualys pilot; remaining families continue through their
own port slices.

Goal:

- Locate the authoritative legacy `integration-hub` source tree and record the
  exact source revision or external path used for conversion.
- Replace placeholder/source-unavailable assumptions in the migration inventory
  with source-backed metadata where source is available.
- Freeze the conversion contract for each family: legacy source files, tool
  schemas, env vars, secrets, result-file behavior, cache behavior, destructive
  classification, and known examples/incidents.

TDD:

- inventory validation fails when an expected legacy tool has no source-backed
  conversion record unless explicitly marked unavailable with a reason
- every source-backed tool maps exactly one
  `mcp_integration-hub__<tool>` name to one hosted tool canonical name
- env vars are classified as hosted config keys or human-owned secret refs
- destructive/write tools cannot be marked read-only during conversion

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/hosted-integrations check-types
```

Evidence:

- Frozen Qualys source path:
  `tmp/openacme-realdata-test-20260724-103001/agents/mcp-server-admin-and-developer/workspace/src/integration_hub/integrations/qualys`.
- Qualys inventory now records `QUALYS_VM_URL` and `QUALYS_GATEWAY_URL` as
  hosted config keys, and `QUALYS_USERNAME` and `QUALYS_PASSWORD` as
  human-owned secret refs.
- The source-backed Qualys hosted family reads credentials and endpoints only
  from ToolContext config/secrets. The ported Python source intentionally does
  not read process env directly.

### Slice 12.2: Port Splunk As The First Real Source-Backed Family

Status: done.

Goal:

- Replace the generated Splunk migration fixture with real hosted integration
  source ported from legacy `integration-hub`.
- Keep the remote MCP `mcp_integration-hub__splunk_search` visible and
  independent while exposing `hosted_splunk__splunk_search`.
- Preserve legacy request shape, config/secret mapping, result-file behavior,
  and sanitized error behavior.

TDD:

- real Splunk hosted source validates and promotes without generated placeholder
  code
- mock example exercises the real ported `splunk_search` implementation
- large Splunk results spill to hosted run artifacts
- caller-facing failures are sanitized and create hosted failure buckets
- remote MCP-only agent selection cannot invoke the hosted Splunk tool
- hosted Splunk agent selection cannot invoke the remote MCP tool

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/server test -- tools-hosted-integrations
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-dogfood.e2e.ts
```

### Slice 12.3: Port Qualys Read-Only Families In Batches

Status: done.

Goal:

- Port Qualys read-only/search/list/count/fetch tools from legacy
  `integration-hub` into the `qualys` hosted family in small batches.
- Preserve native tool names and hosted registry names:
  `qualys_*` inside family source and `hosted_qualys__qualys_*` at registry
  boundaries.
- Preserve result-file and explicit-cache behavior for the Qualys tools that
  used it.

TDD:

- each batch has source-backed examples for every ported tool
- manifest validation rejects missing examples for newly ported active tools
- bounded live-safe examples prove request path, query/body semantics, and
  result shaping against the real target API when credentials are configured
- unit tests may assert source/runtime contracts without standing up fake
  target APIs for Qualys live validation
- artifact-producing tools spill through hosted artifacts
- cache tools use family home explicitly and do not read or write the caller
  agent workspace
- access policy denies unbound agents for every hosted Qualys batch

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement qualys
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integrations
```

#### Slice 12.3.1: First Five Qualys Read-Only Source-Backed Batch

Status: done.

Goal:

- Replace the Slice 12.0 generated five-tool Qualys pilot with source-backed
  hosted family source ported from legacy `integration-hub`.
- Keep this batch read-only and bounded:
  `qualys_gav_asset_count`, `qualys_gav_asset_search`,
  `qualys_cloud_agent_hostasset_count`,
  `qualys_cloud_agent_hostasset_search`, and `qualys_vmdr_host_list`.
- Preserve the hosted/remote naming boundary:
  `hosted_qualys__<tool>` never aliases or enables
  `mcp_integration-hub__<tool>`.

TDD:

- generated placeholder source is not used for the source-backed fixture
- each of the five tools has a `live_safe` example with bounded pagination or
  count-only behavior
- Cloud Agent tools add the `asset.trackingMethod EQUALS QAGENT` GAV filter
  instead of sending `tracking_method` to VMDR Host List
- VMDR Host List rejects `tracking_method` input before credentials or network
  are touched
- live validation must hit real Qualys APIs; no localhost/mock Qualys server is
  acceptable for this batch

Validation:

```text
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/hosted-integrations test -- test/integration-hub-replacement.test.ts
OPENACME_LIVE_QUALYS=1 pnpm --filter @openacme/hosted-integrations test -- test/integration-hub-replacement.test.ts -t "live Qualys"
```

Evidence:

- The live run loaded the existing prod `integration-hub` Qualys env block from
  `/Users/alenbohcelyan/.openacme/mcp.json` into the test process with values
  suppressed from logs.
- `QUALYS_GATEWAY_URL` was not configured, so the hosted Qualys source derived
  the Gateway URL from `QUALYS_VM_URL`, matching the legacy client behavior.
- The latest live Qualys test passed in 23.09s and invoked all five tools through the
  hosted gateway against real Qualys APIs.

### Slice 12.4: Port Remaining Security Families

Status: done.

Goal:

- Port Microsoft Graph, Microsoft Defender for Endpoint, and Defender Alert
  legacy tools into hosted families using the same source-backed pattern.
- Preserve OAuth/client credential config mapping through hosted config scopes
  and human-owned secrets.
- Keep remote MCP tools visible until parity is accepted.

TDD:

- every family has real source-backed hosted implementation, not generated
  placeholder source
- mock examples cover success, provider error, auth/config missing, and large
  response paths where applicable
- hosted and remote MCP tool surfaces remain independent in `/api/tools`
- failure buckets are bucketized by unique hosted error type and route repair
  tasks to Tool Developer

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-dogfood.e2e.ts
```

### Slice 12.5: Parity Report And Agent Opt-In Migration

Status: done.

Goal:

- Add an operator-visible parity report that compares legacy remote MCP tools
  and hosted tool replacements without hiding either surface.
- Support explicit per-agent opt-in migration in Agent Settings from
  `mcp_integration-hub__<tool>` selections to the corresponding
  `hosted_<family>__<tool>` selections and hosted bindings.
- Keep migration reversible by leaving the legacy MCP selections and server
  registration intact until a later, separately approved decommission
  milestone.

TDD:

- parity report lists legacy MCP name, hosted registry name, family, native tool
  name, source-backed status, examples, validation status, and latest run
  health
- migration preview shows exact `agent.tools` and hosted binding changes before
  applying
- applying migration never grants a hosted tool without an explicit
  hosted binding and config scope
- rollback restores the previous agent tool selection without deleting hosted
  source or legacy MCP config

Validation:

```text
pnpm --filter web test -- hosted-integration-agent-settings
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/config test -- agent-store
```

### Slice 12.6: Optional Live Parity Validation

Status: done.

Goal:

- When target-system credentials are configured in the local test environment,
  run live safe parity checks against selected legacy remote MCP tools and
  hosted tools.
- Store live parity results as evidence without making CI depend on external
  target systems.

TDD:

- live parity runner skips with explicit diagnostics when credentials or remote
  MCP server config are absent
- when configured, runner invokes the legacy MCP tool and hosted tool
  with equivalent safe read-only inputs
- sanitized result comparison records match/mismatch, artifact references, run
  ids, and failure bucket ids
- live parity never writes target-system state unless the tool is explicitly
  classified as write/destructive and separately approved

Validation:

```text
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LEGACY_MCP_DATA_DIR=/Users/alenbohcelyan/.openacme pnpm --filter @openacme/server integration-hub:parity
pnpm --filter @openacme/server test -- hosted-integrations
```

Evidence:

- Added `pnpm --filter @openacme/server integration-hub:parity` as the
  operator live parity command.
- The runner skips with explicit diagnostics when the legacy remote MCP server
  config or Qualys credentials are absent.
- The configured run uses the local test data dir for hosted integration state
  and reads the legacy `integration-hub` MCP config from
  `/Users/alenbohcelyan/.openacme` without copying secrets into docs or logs.
- Legacy MCP `result_path` outputs are read and summarized without embedding
  raw target-system records in the parity artifact.
- Qualys Cloud Agent parity uses equivalent safe read-only intent with
  schema-specific args: legacy QPS `criteria`, hosted GAV/QAGENT
  filters.
- Live run `live_parity_0cf1c3cc-de2f-42d6-abcb-312b9a2c074d` passed against
  real Qualys APIs for all five selected read-only tools:
  `qualys_gav_asset_count`, `qualys_gav_asset_search`,
  `qualys_cloud_agent_hostasset_count`,
  `qualys_cloud_agent_hostasset_search`, and `qualys_vmdr_host_list`.
  Evidence artifact:
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env/hosted-integrations/live-parity/live_parity_0cf1c3cc-de2f-42d6-abcb-312b9a2c074d.json`.

## Milestone 13: Hosted Tool Help Surface

Status: done for the hosted-help MVP and the first five Qualys hosted tools.

Goal:

- Add a reserved built-in support tool named `hosted_tool_help` so normal
  agents can inspect how to call hosted integration tools without mixing with
  remote MCP or hosted invocation tool surfaces.
- Support every active hosted tool with:
  - tool short summary
  - tool full detail
  - parameter short summary
  - parameter full detail
  - examples at tool and parameter level
- Keep model-facing tool descriptions short enough for tool selection while
  moving detailed call guidance into help metadata.
- Make help content generation and validation part of the Tool Developer Agent
  lifecycle.

Non-goals:

- No remote MCP help surface.
- No help content for ordinary built-in OpenAcme tools such as file, shell, or
  memory.
- No automatic target-system cache or inferred domain catalog. Domain reference
  tools, such as Qualys quickref, must be explicit hosted tools or explicit
  family-local help references.
- No secret/config disclosure.

### Slice 13.1: Help Metadata Schema

Status: done.

Implementation notes:

- Added optional `help` metadata to hosted family tool manifests.
- Added `noExampleJustification` for tools that intentionally cannot provide a
  meaningful example.
- Draft validation checks family-local help file references for path traversal
  and missing files.

Goal:

- Extend hosted family manifests with optional structured help metadata.
- Support inline text and family-local file references for:
  - `help.summary`
  - `help.full`
  - `help.whenToUse`
  - `help.whenNotToUse`
  - `help.parameters.<path>.summary`
  - `help.parameters.<path>.full`
  - `help.parameters.<path>.shape`
  - `help.parameters.<path>.rules`
  - `help.parameters.<path>.examples`
- Preserve existing `description` and `inputSchema` semantics.
  `description` remains selection-oriented; help metadata teaches correct
  invocation.
- Validate help file references are path-safe and remain inside the promoted
  generation files root.

TDD:

- valid manifest with inline help parses
- valid manifest with `help/*.md` and `help/*.json` references parses
- path traversal in help references fails validation
- unknown parameter help paths warn or fail according to validation severity
- existing manifests without help remain loadable during the migration slice

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- schemas validation catalog
pnpm --filter @openacme/hosted-integrations check-types
```

### Slice 13.2: Help Resolver And Response Contract

Status: done.

Goal:

- Add a package-level help resolver that reads the active generation manifest
  and associated help files.
- Normalize help responses for all tools:

```json
{
  "tool_name": "hosted_<family>__<tool>",
  "family_id": "<family>",
  "family_tool_name": "<tool>",
  "generation_id": "gen_...",
  "tool_help": {
    "summary": "...",
    "full": "...",
    "when_to_use": [],
    "when_not_to_use": [],
    "no_example_justification": "..."
  },
  "parameters": {
    "<param>": {
      "summary": "...",
      "full": "...",
      "shape": {},
      "rules": [],
      "examples": []
    }
  },
  "examples": []
}
```

- Support request modes:
  - `tool_detail: "none" | "summary" | "full"`
  - `include_examples: boolean`
  - `parameters: [{ name, detail: "summary" | "full", include_examples }]`
- Provide fallback help from `description`, `inputSchema`, and registered
  examples when explicit help metadata is not present.
- Agent-facing `hosted_tool_help` responses flow through the existing
  `@openacme/tools` tool-result choke point, so oversized help spills through
  the same per-session tool-call spill path as other built-in tool results. The
  HTTP route remains a control-plane JSON endpoint.

TDD:

- summary request returns only summary-level tool help and requested parameter
  summaries
- full request expands full tool and parameter references
- omitted or `null` `parameters` returns documented parameters automatically;
  `tool_detail: "full"` expands them with full parameter details
- `include_examples: false` suppresses example payloads
- large full-help output spills through the common tool-call spill path when
  invoked as `hosted_tool_help`
- fallback help is deterministic when explicit metadata is absent

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- help artifacts
pnpm --filter @openacme/hosted-integrations check-types
```

### Slice 13.3: Hosted Help API And Built-In Tool

Status: done.

Implementation notes:

- Added `POST /api/hosted-integrations/help`.
- Added `hosted_tool_help` as a normal allowlisted built-in support tool in
  `@openacme/tools`.
- Both the HTTP route and ServerRuntime binding delegate to the package-level
  resolver.
- The route and binding require the caller agent to have `hosted_tool_help`
  and the target hosted tool enabled and bound.

Goal:

- Add a server API route backed by the help resolver:

```http
POST /api/hosted-integrations/help
```

- Add a normal agent-facing built-in tool:

```text
hosted_tool_help
```

- Keep `hosted_tool_help` out of `SYSTEM_TOOLS`; it must be allowlisted through
  Agent Settings like other user-configurable built-in tools.
- Treat `hosted_tool_help` as reserved support-tool naming. It is not a
  canonical hosted invocation tool because it does not match
  `hosted_<family>__<tool>`.
- Accept only provider-facing hosted tool names:

```text
hosted_<family>__<tool>
```

- Reject:
  - `mcp_<server>__<tool>`
  - built-in tool names
  - family-native tool names such as `qualys_gav_asset_count`
  - malformed hosted names
- Resolve hosted registry name to family/tool/generation through the same registry
  naming helper used for invocation.
- Assert hosted-tool classification uses parser/source metadata, never
  `name.startsWith("hosted_")`.
- Enforce Agent Settings policy: an agent may request help only for hosted
  hosted tools it can see or invoke in that environment/config-scope context.
- Follow the existing hosted integration management pattern: the built-in tool
  self-registers in `@openacme/tools`, ServerRuntime binds the in-process port,
  and both the route and binding call the package-level help resolver.

TDD:

- route returns help for an active hosted tool
- route rejects remote MCP, built-in, raw family-native, and malformed names
- route hides help for an unbound agent
- tool wrapper calls the bound server port and does not duplicate help logic
- normal agents can receive `hosted_tool_help`; they still cannot receive
  hosted integration management tools
- parser/grouping regression proves `hosted_tool_help` is not classified as a
  hosted invocation tool
- response never contains secret or config values

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integrations
pnpm --filter @openacme/config test -- agent-store
```

### Slice 13.4: Promotion Help Quality Gate

Status: done.

Implementation notes:

- Draft validation emits help-quality warnings by default for migration
  compatibility.
- `helpQualityMode: "error"` flips the same checks to blocking diagnostics.
- The gate checks active tools for `help.summary`, parameter summaries, complex
  parameter full help, target-specific examples or `noExampleJustification`,
  unknown parameter help roots, and destructive approval/risk wording.

Goal:

- Promote only active hosted tools with enough help for autonomous agent use.
- Require, for every active tool:
  - `description`
  - `help.summary`
  - short parameter help for every public `inputSchema.properties` key
  - at least one registered example, or a structured justification for no
    example
- Require full parameter help for complex parameters:
  - filter/query DSLs
  - request body pass-throughs
  - pagination/cursor controls
  - result artifact/file behavior
  - cache/local-sync semantics
  - enum-like or catalog-backed values
  - destructive or approval-sensitive parameters
- Keep the first migration non-blocking by allowing warnings for existing
  hosted tools, then flip to blocking validation after the initial Qualys batch
  is remediated.

TDD:

- validation warns for missing help while the migration flag is non-blocking
- validation fails for missing help when blocking mode is enabled
- complex parameter detection requires full detail
- examples attached only to unrelated tools do not satisfy the target tool
- destructive parameter help must mention approval/risk classification

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- validation examples
pnpm --filter @openacme/server test -- hosted-integrations
```

### Slice 13.5: Qualys Help Dogfood

Status: done for the first five source-backed Qualys read-only tools.

Goal:

- Add full help metadata for the first five Qualys hosted tools.
- Treat `filter_body` as the first high-value parameter dogfood case.
- Teach the agent that GAV filter fields are native Qualys GAV tokens, not
  response projection fields.
- Provide short and full help for:
  - `filter_body`
  - `filter_body.filters`
  - `filter_body.filters.field`
  - `filter_body.filters.operator`
  - `filter_body.filters.value`
  - `filter_body.operation`
  - pagination and cursor fields for search/list tools
  - `include_fields` and `exclude_fields`
  - `asset_last_updated`
- Include examples that prove:
  - valid impossible asset-name filter uses `asset.name`, not `assetName`
  - Cloud Agent tools automatically add `asset.trackingMethod EQUALS QAGENT`
  - Cloud Agent tools reject `operation: OR`
  - Cloud Agent tools reject non-QAGENT trackingMethod override
  - `qualys.agent.lastCheckedInDate` is the canonical Cloud Agent last check-in
    filter token
- If the Qualys GAV field catalog is too large for full inline help, store it
  as a family-local reference file and expose a separate explicit quickref tool
  in a later Qualys batch. `hosted_tool_help` should explain how to discover
  exact fields without embedding the whole catalog in every response.

TDD:

- `hosted_tool_help` summary for every first-batch Qualys tool is concise
- full help for `qualys_cloud_agent_hostasset_count` includes filter body
  rules, field-token warnings, Cloud Agent scope rules, and examples
- parameter summary for `filter_body.filters.field` mentions native GAV token
  and rejects response field confusion
- `include_examples: false` omits example payloads
- full help output remains below inline threshold, or spills to artifact when
  deliberately oversized
- live-safe Qualys probes confirm the examples are behaviorally correct against
  real Qualys APIs when credentials are configured

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- help migration
pnpm --filter @openacme/server test -- hosted-integrations tools-hosted-integrations
OPENACME_LIVE_QUALYS=1 pnpm --filter @openacme/hosted-integrations test -- test/integration-hub-replacement.test.ts -t "live Qualys"
```

### Slice 13.6: Agent Settings And Agent Dogfood

Status: done for Agent Settings grouping and focused real-LLM help dogfood.

Goal:

- Show `hosted_tool_help` in Agent Settings as a built-in support tool,
  separate from hosted invocation tools.
- Ensure an agent with hosted Qualys tools can call help before calling the
  target tool.
- Add dogfood scenarios where a consumer agent:
  - asks for summarized help for a hosted tool
  - asks for full help with examples
  - asks for short parameter help
  - asks for full parameter help
  - uses the help output to construct a valid Qualys count call
  - receives `bad_arguments` for invalid filter fields instead of a repair task

TDD:

- UI grouping keeps `hosted_tool_help` out of remote MCP and hosted family
  groups unless design explicitly places it in a support-tools group
- e2e dogfood proves the consumer agent calls help before the Qualys tool when
  filter syntax is required
- denied agent cannot get help for a hosted tool it cannot use
- invalid caller arguments do not create Tool Developer repair buckets
- Tool Developer test/debug failures keep execution evidence but do not create
  Tool Developer repair buckets

Validation:

```text
pnpm --filter web test -- hosted-integration-agent-settings
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-dogfood.e2e.ts
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_E2E_PORT=3466 pnpm --filter @openacme/server dogfood:hosted-integrations:real-llm
```

Latest validation evidence:

- `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement validation help schemas`
- `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations`
- `pnpm --filter @openacme/tools build`
- `pnpm --filter @openacme/tools test -- hosted-integration-help hosted-integration-management hosted-integrations`
- `pnpm --filter web test -- hosted-integration-agent-settings`
- `pnpm --filter @openacme/hosted-integrations check-types`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/tools check-types`
- `pnpm --filter web check-types`
- 3466 test env real Qualys read-only invoke:
  `qualys_cloud_agent_hostasset_count` with
  `filter_body.filters: [{ field, operator, value }]` returned
  `responseCode: SUCCESS`, `count: 0`.
- 3466 real LLM dogfood session `dogfood-help-1786644219676` called
  `hosted_tool_help`, avoided Qualys data tools, summarized the Qualys
  `filters` array contract, and placed `operation` inside `filter_body`.

## Milestone 14: Deterministic Tool Handler Format And Focused Source Views

Status: done.

Goal:

- Keep the family-level single-file Python development option, but make tool to
  handler mapping deterministic and inspectable.
- Require each family-native tool name to map to `def tool_<tool_name>(args,
context): ...`.
- Require standard family lifecycle hooks for generic cross-tool behavior:
  `authenticate`, `before_tool_call`, and `after_tool_call`, with explicit
  justification when a hook is not needed.
- Let Tool Developer and repair workflows request a focused source package for a
  single tool: manifest/schema/help/classification for that tool plus only the
  matching handler body by default.
- Collapse unrelated tool handlers in focused views so an investigating agent
  sees a clean package and can ask for full family source only when needed.
- Verify helper discovery deterministically so focused source packages can
  include the helper context needed for the selected tool without dumping the
  whole family by default.

Non-goals:

- No per-tool micro-file requirement.
- No ban on shared helpers in the same family file.
- No hidden mapping table that differs from tool names.
- No per-family invention of hook names or hook signatures.
- No LLM-inferred helper selection as the source of truth.

### Slice 14.1: Handler Naming Contract

Status: done.

Goal:

- Define and validate the deterministic Python handler naming rule:
  `tool_<family_native_tool_name>`.
- Deprecate arbitrary `call_tool(name, args, context)` routers for new families.

TDD:

- validation fails when a manifest tool lacks `def tool_<tool_name>(args, context)`
- validation fails when handler signature does not accept `args` and `context`
- validation rejects manifests or entrypoints that rely on legacy `call_tool`
- validation rejects manifest handler aliases that do not match the derived name

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- validation python-runtime
```

Implemented:

- Added deterministic Python entrypoint analysis to draft validation using
  Python AST.
- For every non-removed manifest tool, validation now requires a top-level
  derived handler named `tool_<tool_name>(args, context)`.
- Handler signature validation rejects missing handlers, async handlers,
  `*args`/`**kwargs` handlers, and handlers whose first two positional
  arguments are not exactly `args` and `context`.
- Entry points that expose only legacy `call_tool(name, args, context)` are
  rejected by the active Milestone 24 contract.
- Proposed family templates now start with the derived handler name rather than
  an arbitrary `invoke(...)` function.
- Custom manifest handler aliases remain rejected by the strict manifest schema.

Evidence:

```text
pnpm --filter @openacme/hosted-integrations test -- validation
pnpm --filter @openacme/hosted-integrations test -- validation python-runtime dependencies proposed-family migration
```

### Slice 14.2: Standard Family Lifecycle Hooks

Status: done.

Goal:

- Add standard structured hooks that every production family can use for
  cross-tool setup and cleanup:
  `authenticate(ctx)`,
  `before_tool_call(tool_name, args, ctx, auth)`, and
  `after_tool_call(tool_name, args, ctx, result, auth)`.
- Keep auth/config/client construction out of individual tool handlers when it
  applies family-wide.
- Make hook names and signatures deterministic so source views, validators, and
  repair agents can find them.

TDD:

- validation checks hook names and signatures for new-format families
- validation fails when a required hook is missing without an explicit
  justification
- `authenticate` receives `ToolContext` and may return JSON-serializable auth
  state or a platform-normalized error
- `before_tool_call` may return normalized args/context metadata used by the
  selected handler
- `after_tool_call` may normalize/mask/enrich the handler result before gateway
  response governance
- hook inclusion in focused source views is deferred to Slice 14.4, where the
  focused source API exists

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- validation python-runtime
```

Implemented:

- Added manifest-level `hookJustifications` for intentionally omitted standard
  hooks.
- New-format Python entrypoints now validate standard hook signatures:
  `authenticate(ctx)`,
  `before_tool_call(tool_name, args, ctx, auth)`, and
  `after_tool_call(tool_name, args, ctx, result, auth)`.
- Missing hooks fail validation unless the matching `hookJustifications` entry
  contains a non-empty reason.
- Historical implementation note: legacy `call_tool`-only migrated families
  were temporarily exempt from hook enforcement. Milestone 24 removed this
  runtime/schema compatibility path.
- Proposed family and dependency fixtures now satisfy the hook contract through
  explicit justifications where hooks are intentionally absent.

Evidence:

```text
pnpm --filter @openacme/hosted-integrations test -- validation
pnpm --filter @openacme/hosted-integrations test -- validation python-runtime dependencies proposed-family migration
```

### Slice 14.3: Runtime Dispatch By Derived Handler And Hooks

Status: done.

Goal:

- Update Python runtime dispatch to call `tool_<tool_name>(args, context)`
  directly.
- Execute standard lifecycle hooks in deterministic order:
  `authenticate -> before_tool_call -> tool_<tool_name> -> after_tool_call`.
- Remove the temporary compatibility path for generations that only implement
  `call_tool`; product runtime dispatch is derived-only.

TDD:

- runtime calls the derived handler for a new-format family
- runtime executes lifecycle hooks exactly once and in order
- auth/config errors raised by `authenticate` normalize before the tool handler
  runs
- `before_tool_call` can normalize args consumed by the handler
- `after_tool_call` can normalize the handler result before the gateway envelope
- runtime returns `tool_bug`/validation diagnostics when the derived handler is
  missing
- legacy generation compatibility metadata is rejected
- new promoted generation cannot rely only on arbitrary `call_tool`

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- python-runtime validation migration
pnpm --filter @openacme/server test -- hosted-integrations-routes
```

Implemented:

- Historical implementation note: this slice originally added
  `runtime.handlerDispatch` with default `derived`. Milestone 24 removed the
  field entirely because a single allowed value carried no product decision.
- Python runtime now dispatches derived families through
  `tool_<tool_name>(args, context)`.
- Runtime executes available standard hooks in order:
  `authenticate -> before_tool_call -> tool_<tool_name> -> after_tool_call`.
- `authenticate` return state is exposed to handlers through `context["auth"]`
  and passed to pre/post hooks.
- `before_tool_call` may return normalized args consumed by the derived handler.
- `after_tool_call` may return a normalized result before gateway envelope
  handling.
- Historical implementation note: legacy dispatch was once available via
  `handlerDispatch: legacy_call_tool`. Milestone 24 removed that option from
  schema, runtime, validator, and replacement fixtures.

Evidence:

```text
pnpm --filter @openacme/hosted-integrations test -- python-runtime validation
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement dependencies proposed-family schemas
pnpm --filter @openacme/hosted-integrations test -- validation python-runtime dependencies proposed-family migration schemas gateway
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
```

### Slice 14.4: Focused Tool Source View

Status: done.

Goal:

- Add a management/debug API and tool wrapper that returns source focused on one
  family-native tool.
- Include the tool's manifest excerpt, input schema, help summary/full refs,
  classification, examples refs, selected Python handler body, and optionally
  standard hooks/shared helper snippets.
- Build helper snippets from a deterministic family-local helper dependency
  graph with explicit depth and size limits.

TDD:

- focused view for `qualys_cloud_agent_hostasset_count` includes only
  `def tool_qualys_cloud_agent_hostasset_count(args, context)` by default
- unrelated handlers are replaced with collapsed stubs or placeholders; exact
  placeholder wording is implementation-defined
- `include_shared_helpers=true` includes referenced helper functions up to a
  deterministic depth/limit
- helper snippets are returned in stable source order with metadata describing
  why each helper was included
- helper graph traversal starts from the selected handler and included standard
  hooks, not from unrelated tool handlers
- unresolved helper references are returned as diagnostics instead of silently
  omitted
- dynamic helper patterns that cannot be resolved statically produce a bounded
  diagnostic and require full-family view for complete context
- helper extraction respects source-view size limits and reports truncation
  metadata deterministically
- `include_hooks=true` includes `authenticate`, `before_tool_call`, and
  `after_tool_call` snippets relevant to the selected tool
- `include_all_tools=true` returns full family source
- route/tool denies focused source reads to normal consumer agents

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- source-view
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management
```

Implemented:

- Added `buildHostedIntegrationFocusedSourceView` in
  `@openacme/hosted-integrations`.
- Added Python AST-backed top-level function/source analysis for focused source
  packages.
- Focused mode returns the selected deterministic handler, the selected tool's
  manifest excerpt, collapsed unrelated tool handler placeholders, optional
  standard hooks, optional deterministic helper snippets, diagnostics, and
  source-view limit metadata.
- Full-family mode is explicit via `includeAllTools`.
- Helper traversal starts from the selected handler and included standard hooks,
  sorts included helpers by source order, reports unresolved helper references,
  reports dynamic call patterns, and reports deterministic truncation when
  limits omit optional snippets.
- Added HTTP control-plane route
  `POST /api/hosted-integrations/source-view`.
- Added Tool Developer Agent management wrapper
  `hosted_tool_source_view`.
- Focused source access is denied to normal consumer agents unless they are
  authorized for the hosted integration management tool surface.

Evidence:

```text
pnpm --filter @openacme/hosted-integrations test -- source-view
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
```

### Slice 14.5: Qualys Family Format Migration

Status: done.

Goal:

- Convert the first five hosted Qualys read-only tools from custom
  `call_tool` dispatch to deterministic `tool_<tool_name>` handlers.
- Move common Qualys auth/client construction into `authenticate` and common
  request/response normalization into standard hooks where appropriate.
- Preserve shared Qualys client/helper code in the same file.

TDD:

- each migrated Qualys tool has a matching deterministic handler
- Qualys authentication/config validation is centralized in `authenticate`
- pre/post hooks run for every migrated Qualys tool
- focused source view returns the requested Qualys handler and schema cleanly
- live safe Qualys read-only calls still hit real Qualys APIs and preserve
  current behavior
- invalid Qualys filter fields still fail with `bad_arguments` before network

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement validation source-view
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
OPENACME_LIVE_QUALYS=1 pnpm --filter @openacme/hosted-integrations test -- test/integration-hub-replacement.test.ts -t "live Qualys"
```

Implemented:

- Removed `handlerDispatch: legacy_call_tool` from the source-backed five-tool
  Qualys pilot manifest so it uses the default deterministic derived dispatch.
- Replaced the custom Python `call_tool(name, args, context)` router with
  `tool_<tool_name>(args, context)` handlers for:
  `qualys_gav_asset_count`, `qualys_gav_asset_search`,
  `qualys_cloud_agent_hostasset_count`,
  `qualys_cloud_agent_hostasset_search`, and `qualys_vmdr_host_list`.
- Added standard `authenticate`, `before_tool_call`, and `after_tool_call`
  hooks to the generated Qualys family.
- Centralized Qualys auth state in `authenticate` while keeping the actual
  `QualysClient` construction lazy so request validation can reject bad
  arguments before credential/config access.
- Added source-view regression coverage proving the Cloud Agent count handler,
  schema excerpt, hooks, collapsed unrelated handlers, and helper inclusion are
  focused and deterministic.

Evidence:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
```

Live Qualys validation remains gated by `OPENACME_LIVE_QUALYS=1` and real
Qualys credentials.

## Milestone 15: Generation Diff And Review Surface

Status: done.

Goal:

- Add first-class diff surfaces between promoted hosted integration generations.
- Expose both an HTTP control-plane route and a Tool Developer management tool.
- Support full-file, path-filtered, manifest-only, summary, unified patch, and
  tool-focused diff modes.

### Slice 15.1: Generation Diff Routes And Tools

Status: done.

Goal:

- Compare two promoted generation snapshots without reading raw store internals.
- Reuse the deterministic handler and focused-source model from Milestone 14 for
  tool-focused diffs.

Non-goals:

- No automatic rollback or promotion from diff output.
- No secret/config value diffing.
- No broad code-review agent workflow in this slice.

API:

```http
GET /api/hosted-integrations/generations/:baseGenerationId/diff/:compareGenerationId
```

Management tool:

```text
hosted_tool_generation_diff
```

TDD:

- diff rejects generations from different families unless explicitly allowed by
  a future migration/rebase mode
- summary mode returns changed file paths, changed manifest tool names, and
  changed runtime/dependency metadata
- unified mode returns deterministic unified patches with stable file ordering
- manifest-only mode highlights schema/help/classification changes
- `toolName` focused mode returns only the selected tool's manifest excerpt and
  deterministic handler diff, with unrelated handlers omitted or collapsed
- diff output is sanitized and never includes secret values
- normal consumer agents cannot call generation diff management tools

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- generation-diff source-view
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
```

Implemented:

- Added `buildHostedIntegrationGenerationDiff` in
  `@openacme/hosted-integrations`.
- Added summary, unified, manifest-only, and tool-focused diff modes.
- Summary mode returns stable changed file paths, changed manifest tool names,
  changed tool fields, runtime metadata changes, and dependency policy changes.
- Unified mode returns deterministic per-file patches in stable path order.
- Manifest mode isolates tool contract changes such as schema/help/
  classification/runtime metadata changes.
- Tool-focused mode reuses the Milestone 14 focused source-view resolver for
  both generations and returns a deterministic selected-handler patch.
- Diff payloads redact secret-like values before returning file/handler patch
  text.
- Added HTTP route
  `GET /api/hosted-integrations/generations/:baseGenerationId/diff/:compareGenerationId`.
- Added Tool Developer Agent management wrapper
  `hosted_tool_generation_diff`.
- Normal consumer agents are denied generation diff access.

Evidence:

```text
pnpm --filter @openacme/hosted-integrations test -- generation-diff
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
```

## Milestone 16: Human-Native Integration Studio

Status: done.

Goal:

- Turn hosted integrations from an agent-only lifecycle into a human-native
  editing and operations surface.
- Build on Milestone 14 source contracts and Milestone 15 generation diff so the
  UI does not invent separate parsing or lifecycle rules.
- Make every Hosted Tools screen comply with the human-native UX principles
  and canonical UI language in
  `docs/hosted-integrations-architecture.md#human-native-hosted-tools-ux`.

Human-ready acceptance bar:

- every tab has one clear job and one obvious primary action
- the user-facing words for the same concept are identical across tabs
- `Edit`, `Save`, `Validate`, `Test`, `Publish`, `Rollback`, `Discard`,
  `Version`, `Tool`, `Hosted tool`, `Family`, `Config scope`,
  `Execution log`, and `Failure bucket` are used consistently
- internal terms such as `lock`, `draft`, `generation id`, and
  `source revision id` appear only as metadata or detail fields
- raw JSON/schema/source metadata is reachable, but not the default view when a
  structured human form can represent it
- diagnostics appear next to the code, help, schema, example, debug, or publish
  control they relate to
- tab switches preserve selected family/tool state and do not silently discard
  unsaved work
- UI actions call the same hosted integration API/control-plane contracts that
  agents use
- the same visible fact is not repeated in multiple places without a
  task-specific reason
- repeated small affordances use familiar icon buttons with tooltips instead of
  visible text labels where practical
- every section earns its space by adding new information, enabling the current
  task, or improving at-a-glance comprehension
- navigation/context lines own selected family/tool identity; right-side work
  panes do not start with another large family/tool restatement
- primary family/tool navigation resolves duplicate active/proposed summaries by
  family id to the active runtime family; proposed drafts appear only in explicit
  creation or review flows
- `GET /api/hosted-integrations/families` defaults to active runtime families;
  proposed draft summaries require an explicit `includeProposed=true` query
- Hosted Tools is reachable from both desktop and mobile primary navigation;
  mobile bottom navigation remains one row after the route is added, and command
  palette navigation includes the route
- right-side work panes start at the selected task, not with an intermediary
  registry/workbench/status band that repeats context without changing the next
  user decision
- named chrome such as `Registry`, `Workbench`, `Workspace`, or `Controls` is
  removed unless it owns a concrete task that cannot be named more directly
- section headers must justify their space by owning a decision, action, or
  faster comprehension path; backend-concept headings are not sufficient
- common editing folds backend draft creation behind `Edit`; `New draft` is not
  a default primary action
- explicit `New draft` appears only in advanced flows such as start-over,
  start-from-version, or recovery, not beside the ordinary edit control
- tabs, sections, and primary actions are state-aware; actions with no current
  target, such as publishing when no editable change set exists, are not shown
  as active workspaces
- lifecycle tabs and lanes follow the same target rule as buttons: they appear
  only after the selected state has entered that task, not as placeholders for
  commands the platform could perform later
- visible lifecycle actions are derived from concrete hosted integration state,
  not from static page chrome; if there is no active edit session, draft-backed
  change set, selected prior version, open failure bucket, or selected
  run/artifact, the related action is absent or represented as contextual
  guidance
- primary lifecycle controls are decided by the view model before render; they
  are not mounted as an always-present command inventory and disabled afterward
  unless the current human already owns the target and the missing prerequisite
  is local and immediately fixable
- visible lifecycle actions also require the current human's active owned
  target; a draft, generation, run, or bucket that exists elsewhere in backend
  state does not justify a primary action for the current workspace
- publish is validation-gated: before a valid change set exists the primary
  action is `Validate` or `Validate again`, not `Publish`
- publish is also target-gated: before the current human owns an editable
  change set, there is no publish workspace or primary publish action
- the Validate/Publish lane opens only after the current human owns an editable
  change set; its primary action moves from `Validate` to `Validate again` to
  `Publish` according to validation state for that same change set
- lifecycle actions are visible as actions only when their concrete target
  exists: publishable change set, selected rollback version, active edit
  session, held edit lock, open failure bucket, or selected run/artifact
- every primary lifecycle action answers "what exact object would this operate
  on right now?" before render; if the answer is absent, the UI shows guidance
  or omits the command instead of mounting a disabled inventory item
- one state transition has one user-facing control; backend primitives such as
  acquiring locks and creating drafts are folded behind `Edit` unless the user
  opens explicit diagnostic/details surfaces
- lifecycle controls transform in place where practical, for example `Edit`
  becoming `Unlock` after a lock is held, instead of showing parallel controls
  for the same transition lane
- advanced controls appear when the related task state exists, not as always-on
  chrome
- lifecycle actions require targets owned by the current human context:
  `Validate`/`Publish` requires the current human's editable draft, `Unlock`
  requires a held edit session, `Rollback` requires an explicitly selected prior
  version, and run/artifact actions require a selected run or artifact
- tabs and lanes are created by concrete state rather than static page chrome;
  when there is no editable change set, selected prior version, open failure
  bucket, selected run, or selected artifact, the related workspace is hidden or
  reduced to contextual guidance
- empty states explain the missing lifecycle object and route the user toward
  the next real task instead of rendering inert primary controls
- transient result panes such as debug/test output, version diff, rollback
  response, artifact preview, and expanded run details clear when their selected
  tool, scope, version, run, or artifact target changes
- human-native completeness means every detail remains reachable, not that raw
  ids, locks, draft metadata, diagnostics, and all lifecycle controls are
  visible at once

### Slice 16.1: Human-Native Rich Family Editor

Status: done.

Goal:

- Build a first-class hosted integration family page for authorized humans.
- Let the human select a family, inspect active generation/draft/lock state,
  see the tool list and deterministic tool-to-handler mapping, and edit source
  in a rich code editor.
- When the human clicks a tool name, navigate to and highlight the matching
  `tool_<tool_name>(args, context)` handler.
- Show that tool's manifest excerpt, input schema, help/classification, example
  refs, focused handler code, validation status, and recent failures alongside
  the editor.
- Collapse or visually de-emphasize unrelated tool handlers by default while
  allowing full-family source view for shared refactors.
- Let humans run the same lifecycle actions as Tool Developer through UI/API:
  acquire/renew/release lock, create/update draft, validate, run examples,
  debug read-safe calls, view generation diffs, promote, rollback, and close
  repair loops where policy allows.

Dependencies:

- Slice 14.1 handler naming contract.
- Slice 14.2 standard family lifecycle hooks.
- Slice 14.4 focused tool source view.
- Slice 15.1 generation diff routes for version comparison.

Non-goals:

- No direct filesystem writes from the browser.
- No secret value editor inside the code editor.
- No bypass of human approval policy.
- No multi-user merge editor in the first rich editor slice.

TDD:

- family list loads and selecting a family opens its family detail/editor page
- tool mapping panel lists family-native tool names and derived handler names
- clicking a tool scrolls/highlights the corresponding handler in the editor
- focused view includes the selected tool's schema/help/classification and
  handler code
- unrelated handlers are collapsed or visually de-emphasized by default
- full-family mode expands all handlers and shared helper code
- edit actions require an active lock owned by the human actor
- validation/debug/promotion buttons call hosted integration APIs and surface
  sanitized diagnostics only
- generation diff UI can compare active generation to another generation
- normal users without hosted integration management permission cannot edit or
  promote

Validation:

```text
pnpm --filter web test -- hosted-integrations-rich-editor
pnpm --filter web check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes
```

Implemented so far:

- Extended the hosted integrations Settings tab with a family editor model for
  deterministic tool-to-handler mappings.
- Deduplicated repeated family summaries by family id before rendering rows so
  stale duplicate catalog records do not produce duplicate React keys or
  repeated cards.
- Added focused source-view loading from the browser using the same
  `POST /api/hosted-integrations/source-view` API used by Tool Developer.
- Added selected-tool focused handler/source panel, schema/help/classification
  preview, collapsed handler metadata, full-family toggle, and generation diff
  controls.
- Added explicit read-safe debug controls that call
  `POST /api/hosted-integrations/debug-runs` only when the selected tool is
  classified as `read` and a config scope is selected.
- Added permission-aware editor model state so normal human users without
  hosted integration management permission cannot edit, debug, diff, or
  promote from the human-native surface.
- Added web view-model tests for handler mapping, selected focused handler,
  schema/help preview, collapsed handler list, human lock ownership,
  permission-denied edit state, read-safe debug state, and duplicate family
  row suppression.
- Updated server management actor checks so humans with `tool_developer` role
  can use management surfaces while humans without that role are denied.
- Validated the rendered Settings Hosted Integrations UI in a browser at
  `http://127.0.0.1:3466/settings?tab=hosted-integrations` using the test data
  dir `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env`.

Validation completed:

```text
pnpm --filter web test -- hosted-integrations-rich-editor hosted-integrations-admin
pnpm --filter web check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help
pnpm --filter @openacme/tools check-types
```

Browser validation note:

- The current test env Qualys active generation still carries an older source
  snapshot for some focused handlers, so the UI correctly surfaces
  `selected_handler_missing` diagnostics for those stale generation files.
  Newly promoted deterministic handler-format generations satisfy the focused
  source contract.

### Slice 16.2: Hosted Tools Human-Ready UX Pass

Status: done.

Goal:

- Redesign the active Hosted Tools route as a calm, human-native admin surface
  while preserving full lifecycle capability.
- Remove redundant registry/family/workbench chrome and replace technical
  primitives with canonical lifecycle language.
- Split or simplify tabs so Code, Help, Files, Test/Debug, and Publish/Version
  each have a clear purpose, stable selection, and one primary action.
- Keep advanced details, raw JSON, ids, lock/draft/generation metadata,
  diagnostics, execution logs, and artifacts reachable through explicit detail
  controls.

TDD:

- route-level render test proves the page has no `Registry` section, no
  `Workbench` label, and no standalone `Create draft` action
- route-level render test proves the right pane does not repeat a large
  selected-family hero when the left navigation already owns family/tool
  selection
- UI model test proves edit mode exposes one toggle action: `Edit` or `Unlock`
  depending on ownership/state
- UI model test proves draft creation is represented by the edit state and does
  not appear as a default `New draft` action
- tab tests prove each tab exposes its own primary action using canonical UI
  language
- tab tests prove lifecycle tabs are state-aware, including no visible
  `Publish` workspace before an editable change set exists
- state-derivation tests prove lifecycle actions are computed from concrete
  hosted integration objects rather than static page layout
- action-target tests prove every lifecycle action or lifecycle tab is backed by
  a view-model target descriptor with target kind, selected target identity,
  current-human ownership, and readiness; missing descriptors produce guidance
  or no action rather than a disabled command placeholder
- publish-state tests prove the primary action is `Validate` before validation,
  `Validate again` after failed validation, and `Publish` only after the latest
  validation for the current change set passed
- empty-state tests prove publish/version surfaces explain the missing
  change-set or selected-version target and point to the next real task instead
  of rendering inert `Publish`/`Rollback` controls
- action-state tests prove `Publish`, `Rollback`, `Discard`, `Unlock`, and
  failure repair actions appear only when their concrete target object exists
- edit-mode tests prove lock/draft primitives are represented by one
  user-facing state transition control instead of separate always-visible
  `Acquire lock`, `Release lock`, and `Create draft` controls
- toolbar tests prove controls transform in place for the same lifecycle lane
  instead of multiplying visible buttons for old and new states
- disclosure tests prove validation, publish, rollback, repair, and artifact
  controls appear after the related run/change/version/bucket exists rather
  than as idle chrome
- help editor tests prove structured fields are the default and raw JSON is
  behind an explicit detail/advanced control
- code tab tests prove selected tool mapping focuses the expected handler and
  unrelated handlers are not shown as primary content
- publish/version tests prove validation status, diff, publish, rollback, and
  internal ids are separated into human summary plus details
- failure recovery tests prove bucket count is not the only surface: bucket
  tool, status, hit count, assignment, version relation, and repair assignment
  action are reachable when buckets exist
- execution log tests prove recent sanitized runs are listed by family with
  status, duration, config scope, version relation, error code, and artifact
  loading available through row details rather than a raw default JSON dump
- config tab tests prove required runtime env keys are visible by config scope:
  non-secret config key names, secret key names, and configured/missing secret
  status are shown, while secret values remain write-only and absent from the
  DOM/view model
- secret update tests prove setting or rotating one secret merges with existing
  human-owned values instead of marking other configured secrets missing
- unsaved-change tests prove switching family/tool/tab does not silently discard
  draft edits
- Playwright validation captures desktop and mobile screenshots and checks for
  absent legacy/technical labels: `Registry`, `Workbench`, `Acquire lock`,
  `Create draft`, and duplicate family hero headings
- screenshot review includes a screen-economy audit for duplicated facts,
  repeated visible microcopy that should be icon+tooltip, and sections that do
  not add task value
- compact target-row review checks that config-scope selectors, operation
  badges, mode controls, and other values are labeled even when they share a
  dense row with the primary action
- editor accessibility review checks that line-number gutters and cursor chrome
  are decorative and do not dominate snapshots or assistive content
- scoped table review checks that column labels match the row's current primary
  label, and that completed historical rows do not display active-state labels
  such as `running` when only secondary metadata is missing
- screenshot and interaction review also checks that lifecycle verbs are true
  for the current selected state: no draft means no visible primary
  `Publish`, no selected previous version means no visible primary `Rollback`,
  no selected run/artifact means no visible inspect/load action, and no open
  actionable bucket means no visible repair action
- screenshot and interaction review checks disabled lifecycle controls with the
  same standard: disabled primary actions are allowed only when the current
  human already owns the concrete target and the remaining prerequisite is
  local and immediately fixable, such as invalid JSON in the same editor
- copy review proves default human UI uses human-facing lifecycle verbs such as
  `Publish`; internal verbs such as `promote` appear only in API, management
  tool, or diagnostic contexts
- every repeatable UX confusion found while reviewing or implementing this
  surface is added back to the canonical Human-Native Hosted Tools UX
  principles before the slice is considered complete
- Agent Settings catalog tests prove hosted integration management tools are
  not rendered as ordinary selectable tools for normal consumer agents; hosted
  invocation tools and `hosted_tool_help` remain visible

Acceptance:

- an authorized human can inspect and update source, help, files, examples,
  validation, debug runs, publish, rollback, execution logs, and failure buckets
  without using an agent
- the page uses one vocabulary for each lifecycle concept across all tabs
- internal platform mechanics are visible only where they help recovery,
  debugging, or audit
- navigation owns selection context, while work panes start directly with the
  selected task
- `Registry`, `Workbench`, `New draft`, and parallel lock/draft controls are
  absent from the default human workflow
- publish appears only after a draft/change set exists and the latest
  validation for that change set passed
- lifecycle actions and lifecycle tabs are rendered only from explicit target
  descriptors for the current human workspace, never from static command
  inventory
- no visible section, repeated label, or duplicated fact survives unless it has
  explicit task value
- compact target rows remain readable because every selector/status value has a
  clear label
- code editor line-number gutters do not pollute accessible/snapshot content
- table labels and status words do not contradict the current scope or row
  lifecycle state
- no lifecycle action appears as a primary workspace when the current state has
  no object for that action
- lifecycle verbs are treated as current-state promises rather than a static
  command inventory
- view-model state decides lifecycle action availability before render; disabled
  primary controls are reserved for owned targets with local, immediately fixable
  prerequisites
- the Validate/Publish lane exists only for the current human's editable change
  set and never as a static placeholder before editing starts
- disabled primary lifecycle actions are not used to advertise commands that
  have no current target
- default human-facing copy says `Publish` for the validated-draft transition;
  `promote` remains internal lifecycle terminology
- normal Agent Settings tool selection cannot accidentally grant hosted
  integration lifecycle management tools while configuring consumer invocation
  access
- empty states route the user toward the next valid lifecycle step instead of
  showing inert lifecycle controls
- the implementation remains backed by existing hosted integration API routes
  and does not add UI-only lifecycle bypasses

Implemented so far:

- Added a `Logs` tab backed by family-scoped execution log listing APIs. Recent
  sanitized runs show status, result mode, duration, config scope, current or
  previous version relation, and row-level details for arguments, errors, and
  artifacts.
- Logs now render raw argument/error payloads only for the selected run row, so
  the default log list stays a lightweight human summary instead of mounting
  every raw JSON detail at once.
- Added a `Version` tab that separates version history, comparison, and
  rollback from the Code and Publish workspaces. Compare results show a compact
  human summary before raw diff JSON; the tab no longer preselects a rollback
  target, and `Compare`/`Rollback` appear only after the user explicitly
  selects a previous version.
- Version target selection now has a single user-facing control: the version
  history list. The header lane shows a family-aware missing previous-version
  selection message or actions for the selected row; it does not duplicate
  selection with a second dropdown.
- Removed embedded generation diff controls from Code advanced schema details
  so Code remains focused on source/schema/diagnostics.
- Differentiated families with duplicate display names in the left rail by
  showing the family id only when the name is ambiguous.
- Tightened top-bar and left-rail action identity:
  - Hosted Tools header keeps the compact visible `Refresh` label while naming
    the operated surface as `Refresh hosted tools`
  - family selection rows keep visual name/status density while exposing a
    single synthesized action label such as `Select family Qualys, active`,
    avoiding merged names such as `QualysActive`
  - duplicate family names include the family id in the action label only when
    needed to disambiguate the target
  - tool selection rows keep the registry tool name visible while naming both
    the selected tool and family in the action label, so agent/browser-driven
    UI work does not rely on surrounding layout context
  - editor task buttons keep compact labels such as `Code` and `Help` while
    naming the selected tool target in their action labels
  - Files selector rows keep path and size visually stacked while exposing one
    synthesized action label, avoiding merged names such as
    `qualys.py34726 bytes`
  - Logs scope toggles and refresh keep compact visible labels while naming the
    concrete tool or family scope in their action labels
  - Failure repair actions keep the compact visible `Assign repair` label while
    naming the concrete tool/version failure bucket target in their action
    labels
  - Debug argument editors keep the compact visible `Arguments` header while
    naming the selected tool in the textarea action label
  - Test example payload editors keep compact visible headers while naming the
    selected example payload target in the textarea action label
  - Help form fields keep compact visible labels while naming the selected tool,
    parameter, or example target in the actual input action labels
  - Code source and schema editors keep compact visible headers while naming
    the selected handler or tool in the actual textarea labels
  - Files mode toggles and source editors keep compact visible labels while
    naming the selected family or file path in their action/input labels
  - Version diff and rollback result editors keep compact visible headers while
    naming the selected previous-version target in their textarea labels
  - Validate/Publish primary actions and raw result editors keep compact visible
    labels while naming the selected family pending-change target
  - Test/debug result editors and execution-log detail editors keep compact
    visible headers while naming the concrete example, tool/config-scope, run,
    and artifact targets in their input/action labels
  - Disclosure summaries such as Code schema diagnostics, Help advanced fields,
    Help examples, and Validate/Publish raw result keep compact visible labels
    while naming the selected tool or family pending-change target in their
    action labels
  - Test example and Debug config-scope selectors keep compact visible labels
    while exposing combobox names tied to the selected tool, so row selectors do
    not fall back to anonymous value-only controls
  - Files empty states now name the selected family and whether the missing
    state is current files, a locked Changes view, or an empty changed-file set
    instead of showing generic `No files found` / `No changed files yet` copy
  - Help empty states now name the selected tool and, for parameter rows, the
    selected parameter, instead of generic `No summary documented`,
    `No parameter help entries`, or `No help examples` copy
  - Test example empty states now name the selected tool and distinguish current
    published examples from saved draft examples
  - Debug unavailable guidance now names the selected tool/family and separates
    missing permission, non-read classification, and missing config-scope causes
  - Code focused-source empty states now name the selected handler and tool
    instead of showing generic missing-source copy
  - Version empty states now name the selected family and distinguish missing
    previous-version selection from a family with no published versions
- Refined the human-native UX contract from the active Hosted Tools examples:
  selection context belongs to navigation, named chrome must own a task, draft
  creation is folded behind edit, publish is validation-gated, and controls
  should transform in place for the same lifecycle lane.
- Extended the UX contract from the Validate/Publish regression: visible
  lifecycle actions must require the current human's owned target, not merely a
  backend object that exists somewhere in the family state.
- Extended the same contract from the targetless Promote/Publish example:
  lifecycle controls are rendered only when the current workspace has a
  selected, actionable target; otherwise the surface shows guidance or no lane,
  not an inert primary action.
- Added explicit lifecycle target descriptors to the Version, Validate/Publish,
  and Failure repair view-model helpers. These helpers now expose actions only
  when they can name the selected previous version, editable change set, or
  failure bucket target for the current human context; missing permission or
  missing target state produces guidance/status UI rather than disabled command
  inventory.
- Extended the same target-descriptor guardrail to execution-log refresh and
  run-artifact loading. Audit actions now require a selected family/tool log
  target or run artifact target plus management context before rendering as
  actions; otherwise log/artifact metadata remains visible without exposing a
  disabled command placeholder.
- Extended target descriptors to draft file save/delete and test example
  save/run actions. Changed-file actions now require an editable draft file
  target, while test actions distinguish the editable examples target used for
  saving from the selected saved example target used for running a test.
- Extended target descriptors to Code source editing, Help saving, Debug runs,
  and Version comparison readiness. Code and Help actions now require an
  editable draft-backed source/help target; Debug requires a read-safe tool plus
  selected config scope and only disables for local argument errors or busy
  state; Version comparison renders only when both a previous version and an
  active version exist to compare.
- Fixed a live screenshot copy issue in Failure rows by sharing the same
  singular/plural hit label between visible row text and synthesized accessible
  labels, so `1 hit` does not render as `1 hits`.
- Revalidated the mobile Hosted Tools surface at a 390px viewport after the
  target-descriptor and copy fixes. The primary bottom navigation remains one
  row, family/tool navigation remains bounded, the selected tool workspace is
  visible in the first viewport, edit mode transforms `Edit` into `Unlock`, and
  mobile Files edit mode keeps the file selector, path field, save/delete
  actions, and changed-source editor within the working viewport.
- Tightened Test/Debug/Validate/Publish state behavior in the Hosted Tools
  route:
  - read-only Test hides save/run-example actions until an editable draft and
    selected example exist
  - read-only Test still shows published examples for inspection; editing,
    saving, and running examples remain draft-scoped actions
  - Test example selection owns the selected example id; the payload editor uses
    payload labels instead of repeating the same id in both the selector and
    editor header
  - Test example selector is explicitly labeled, so snapshots and assistive
    review identify the target as `Examples` instead of an anonymous combobox
  - `Run test` is available only when the current human owns an editable draft
    and a saved example is selected
  - Test save/run actions now keep compact visible labels while naming the
    selected example target in their accessible labels, so example mutation and
    execution commands are not targetless
  - Test keeps `Save example` and `Run test` in the Examples target row when a
    draft exists, so example selection, save, and run are visible before the
    payload editor instead of falling below the first mobile viewport
  - Debug shows controls only for read tools with a config scope target
  - Debug target state keeps config scope selection and operation classification
    in one row, instead of separating a floating operation badge from the target
    selector
  - Debug validates argument JSON inline and disables `Run debug` while the
    argument payload is invalid, instead of surfacing parse failures as a
    generic page-level error
  - Debug keeps `Run debug` in the target row with config scope and operation,
    so the primary action is visible before the argument editor and does not
    fall below the first mobile viewport
  - Debug target rows label `Config scope` and `Operation` explicitly, so dense
    controls do not leave values floating beside `Run debug`
  - Debug run actions now keep the compact visible label while naming the
    selected tool and config scope in the accessible label, so read-safe debug
    commands are not targetless
  - Config now has its own task tab between Help and Files. Each config scope
    shows environment, revision, non-secret config env key names, secret env key
    names, and configured/missing status; secret values are edited only through
    blank password inputs and are never rendered back into the page.
  - Secret writes are merge-safe: a human can set or rotate one secret key from
    the tool page without dropping other existing configured secrets in the same
    config scope.
  - Hosted code editor line-number gutters were removed from the primary editor
    DOM, leaving line count and cursor position in the footer so editor
    snapshots focus on source/payload content
  - the edit lane shows `Validate` before validation, `Validate again` after a
    failed validation, and `Publish` only after the latest validation passes
  - the edit lane keeps visible lifecycle verbs compact while giving primary
    action buttons target-specific accessible names, so the `Validate` tab and
    `Validate pending changes` action are not ambiguous
  - Validate/Publish lane appears only for the current human's editable draft,
    not merely because some draft exists under another editor's lock
  - validation JSON is labeled `Validation result` until a publish result
    actually exists
  - Validate/Publish shows the human summary by default and keeps raw
    validation/publish JSON behind a `Raw result` disclosure
  - Hosted Tools mobile scroll content keeps bottom padding/scroll padding so
    fixed bottom navigation does not cover late-page controls such as raw
    result disclosures
- Tightened Help and Failures state behavior:
  - read-only Help hides add/remove example actions instead of showing disabled
    controls with no current edit target
  - Help edit keeps `Save help` attached to the Summary editing row instead of
    rendering a standalone toolbar band, so mobile users see the actual help
    content sooner and the primary action remains tied to its work target
  - Help save/add actions now keep compact visible labels while naming the
    selected tool target in their accessible labels, so help mutation commands
    are not targetless
  - Help summary and parameter summary fields use multiline controls, so
    domain guidance remains readable on mobile instead of being clipped inside
    single-line inputs
  - Help advanced fields and example payload editors render only after their
    disclosure is opened, keeping the default Help surface focused on summary
    and parameter help
  - Help parameter edit rows now give each compact name/summary control a
    row-specific accessible label, so table headers are not the only cue for
    assistive or keyboard-driven editing
  - Help parameter edit rows now also name the selected tool and parameter or
    row ordinal in name/summary/remove labels, so compact table controls do not
    fall back to generic `Parameter 1 name` or `Remove parameter` actions
  - Failures summary counts only open assigned buckets, so closed historical
    repair buckets do not appear as active assignments
  - Failures guidance now changes by state: open buckets show repair/close
    guidance, while closed-only history is labeled as audit history instead of
    an active repair task
  - Failure bucket rows keep the default view focused on tool, version, hit
    count, assignee, and status; fingerprint and first/latest seen metadata are
    available only after expanding the row for investigation
  - Failure bucket rows keep desktop audit columns, but mobile folds hit count,
    assignee, latest-seen time, and bucket state into a compact meta line while
    preserving visible repair assignment actions for actionable open buckets
  - Failure bucket row buttons now use a single synthesized accessible label,
    so desktop columns plus mobile meta do not duplicate the same state in
    assistive row names
- Tightened Code and Version wording:
  - Header edit/lock actions now keep compact visible labels while naming the
    selected family in their accessible labels, so entering or leaving edit
    mode is not targetless
  - Header mode text now uses canonical `Changes` for the editable working set
    instead of saying `changes pending` immediately after `Edit`, before any
    validation/publish state exists
  - Code advanced details are labeled `Schema and diagnostics`, keeping
    generation comparison in the Version surface
  - Code edit state now exposes a concrete `Edit source file` action that opens
    the draft source file in Files/Changes instead of leaving the user in a
    read-only handler view with no edit target
  - Code source scope now uses a two-state `Focused handler` / `Full family`
    control, instead of a single button whose label changes after click without
    showing the current mode
  - Code edit/source-mode actions now keep compact visible labels while naming
    the selected handler or tool in their accessible labels, so source editing
    and view-mode commands are not targetless
  - Code handler source now uses a viewport-bounded editor height and no longer
    sits inside a second framed container, so source inspection stays readable
    without turning the page into a nested, oversized editor shell
  - Version history and comparison targets use human-readable relation, actor,
    status, and published time in the default view instead of raw
    generation/source revision ids
  - Version row buttons now use a single synthesized accessible label, so
    desktop state/published columns plus mobile meta do not duplicate the same
    version metadata in assistive row names
  - Version Compare/Rollback actions now include the selected previous-version
    target in their accessible names, so short visible verbs remain clear
    without becoming targetless commands
  - Current version renders as a non-action information row; only previous
    versions render as selectable rows that can expose `Compare` and `Rollback`
  - Previous version rows derive their human state from the active-generation
    relation, so stale backend `active` status cannot render a previous version
    as active
  - Version rows keep desktop audit columns, but mobile folds state and
    published time into a compact meta line under relation/actor so long
    version history remains scannable
- Tightened Files edit intent:
  - read-only Files stays on `Current` source with no save/delete actions, and
    opens the family source file by default instead of metadata files
  - current and draft file selection prefer editable source files such as
    `*.py` over metadata files such as `examples.yaml` and `family.yaml`
  - starting an edit session switches Files to `Changes` so the active work pane
    immediately has editable source plus concrete `Save`/`Delete file` targets
  - reloading or reopening a family while the current human still owns an
    editable draft also keeps Files on `Changes`, so edit state does not fall
    back to read-only `Current` source
  - releasing the edit lock returns Files to `Current`
  - long source files use a viewport-bounded editor height in Files so mobile
    and desktop users scroll inside the editor instead of through one giant
    page-height textarea
  - Files/Changes path editing now binds the visible `Path` label to the input
    control, so dense edit rows remain usable through accessible form
    navigation as well as visual scanning
  - Files/Changes save and delete actions now keep compact visible labels while
    naming the current path target in their accessible labels, so file mutation
    commands are not targetless
- Removed the selected family id from the right work-pane header because family
  selection is already owned by the left navigation.
- Tightened unsaved edit navigation:
  - tab switches preserve in-progress local edits inside the active family
  - tab switches scroll the active work pane back to the selected task start, so
    short tabs such as Validate do not inherit blank offset from longer tabs
  - while a family edit session is active, navigation to another family is
    blocked until the current family is unlocked, avoiding silent loss of
    unsaved local editor state
- Tightened Logs scope behavior:
  - Logs defaults to the selected tool so the right work pane does not show a
    different tool's recent calls immediately under the selected tool header
  - Family-wide logs remain reachable through an explicit `Family` scope
    control, preserving audit capability without making the default view
    ambiguous
  - Selected-tool log rows no longer repeat the selected tool name on every
    row; they lead with version relation, while family-scoped logs keep the
    tool name as the row label
  - Selected-tool log table headers now say `Version` instead of `Tool`, matching
    the scoped row primary label
  - Completed log rows with missing duration metadata show `not recorded`
    instead of contradicting their succeeded/failed status with `running`
  - Log rows keep desktop table columns, but mobile folds status, result, and
    duration into a compact meta line under the selected tool/run context so
    repeated execution records stay scannable
  - Log row buttons now use a single synthesized accessible label, so hidden
    mobile/desktop duplicate metadata does not make run rows noisy in snapshots
    or assistive review
- Tuned the canonical Human-Native Hosted Tools UX principles after the active
  route review:
  - reduced duplicated principle wording into sharper rules for selection
    ownership, user-task naming, explicit edit mode, state-derived workspaces,
    owned action targets, and section space value
  - added the rule that navigation is bounded on constrained screens, so
    family/tool selection remains available without pushing the active tool
    workspace below the fold on mobile
  - tightened the mobile family/tool navigation cap after screenshot review, so
    the selected tool workspace starts earlier in the first viewport while the
    navigation list remains scrollable
  - moved the family/tool navigation rail to the two-column desktop layout at the
    `lg` breakpoint after screenshot review showed the `xl` breakpoint left
    normal desktop widths with a full-width top navigation band that pushed the
    workspace down
  - kept editor task tabs to a single scrollable row on constrained screens,
    preventing tab wrapping from consuming vertical work area before the active
    tab content
  - made selected editor task tabs scroll themselves into view on mobile, so the
    active task target is not hidden offscreen after switching to later tabs
  - tuned mobile editor task tab auto-scroll to use contained alignment and
    scroll padding, so selecting middle tabs keeps the active tab readable
    without exposing clipped fragments of neighboring labels as broken UI text
  - added mobile-only trailing scroll room to the editor task tab strip, so
    end-of-list tabs such as Version/Logs/Failures can align cleanly instead of
    leaving partial earlier-tab labels visible
  - moved Version compare raw JSON behind an explicit `Raw version diff`
    disclosure, so the default result starts with summary facts instead of a
    long audit payload
  - tightened mobile task-switch scroll alignment so switching from long
    navigation/list content into Logs/Failures lands the selected task directly
    under the page header, without clipped family/tool navigation fragments
    above it
  - constrained mobile task tab click handling to horizontal tab-strip movement;
    vertical alignment is owned by the editor workspace root, not each tab
  - moved Debug `Run debug` after the arguments editor and local JSON validation
    so execution follows the payload being reviewed instead of preceding it
  - moved parameter-level Help detail out of the generic Advanced disclosure:
    selecting a parameter now exposes its full detail, rules, shape override,
    and parameter examples directly in the parameter help workflow
  - split Help into compact `Tool details` and `Parameters` sub-tabs, so
    tool-level description/usage/examples and parameter-level documentation do
    not compete in one long mixed surface
  - tightened mobile Help parameter edit rows so the remove action stays beside
    the parameter identity and the longer summary keeps readable full-width
    editing space below it
  - changed the Files tab's mobile file picker into a compact horizontal
    selector, keeping source file access visible while moving the editor closer
    to the first viewport
  - kept the active file first in the Files tab selector, so horizontal mobile
    navigation never hides the file currently being edited behind offscreen
    scroll
  - tightened Files/code-editor width containment with `min-w-0` so compact
    horizontal selectors and long source editors cannot expand the mobile work
    pane off-screen
  - recorded that `Registry`, `Workbench`, always-visible `New draft`, parallel
    lock controls, and targetless `Publish` are examples of platform plumbing
    leaking into the human workflow
  - tightened the same example into a right-pane structure rule: after the left
    navigation owns `family > tool`, the work pane starts with the selected task
    rather than another large family title, registry summary, or workbench band
  - recorded that section headers must own a real decision/action/comprehension
    benefit; backend-concept headings that only occupy space are removed,
    collapsed, or folded into a small status/action row
  - clarified that human-native completeness means lifecycle details remain
    reachable through deliberate detail paths, not that every raw id, lock,
    draft, diagnostic, or lifecycle command is always visible
  - clarified that `New draft` is absent from the default edit path because edit
    mode creates or reuses the working set; explicit draft creation is reserved
    for advanced start-over, start-from-version, or recovery flows
  - recorded that page-level utility actions belong in the page header only
    when their scope is truly page-wide; otherwise actions stay beside their
    target task
  - sharpened the targetless Publish/Promote example into a lifecycle-verb
    rule: a visible action must be immediately meaningful for the selected
    state, not merely part of the platform's possible command set
  - tightened the same example into a disabled-control rule: disabled primary
    lifecycle buttons are acceptable only when the target exists and the missing
    prerequisite is local and immediately fixable, not when the command has no
    current object to operate on
  - recorded the public/internal verb boundary: the human UI publishes a
    validated change set, while `promote` remains API, management-tool, and
    diagnostic terminology
  - added the principle-maintenance rule that repeatable confusion found during
    implementation review must be folded back into the canonical UX principles
    and this implementation-plan acceptance record
  - filtered hosted integration management tools out of the normal Agent
    Settings tool catalog after browser review showed them listed next to
    consumer invocation tools; hosted invocation tools and `hosted_tool_help`
    remain available
  - made `Publish` depend on a current human-owned editable change set with a
    passed latest validation, rather than merely existing as static page chrome
  - tightened the same example into a render contract: lifecycle controls are
    derived from view-model state before mounting, not rendered first and disabled
    to advertise commands that lack a current target
  - recorded that Validate/Publish is a state lane, not a permanent tab: it opens
    only for the current human's editable change set and advances from
    `Validate`/`Validate again` to `Publish` as validation state changes
  - added the rule that primary actions should stay beside the field, list, or
    lifecycle state they affect, avoiding standalone control bands unless the
    action is genuinely page-level
  - added the rule that code, JSON, payload, and diff editors are
    viewport-bounded work surfaces with internal scrolling and no redundant
    outer decorative frame
  - added the rule that form control shape follows content shape, so long
    summaries and parameter explanations use readable multiline controls while
    single-line inputs stay reserved for short names, ids, paths, and scalars
  - added the rule that compact target rows must still label selectors,
    operation badges, and mode state before the associated action
  - added the rule that editor gutters and cursor chrome are decorative aids,
    not accessible primary content
  - added the rule that repeated records must stay scannable, with secondary
    metadata compacted on mobile or moved into details instead of making every
    row a tall block
  - added the rule that scoped table headings and status words must not
    contradict the row's actual primary label or completed lifecycle state
  - added the rule that transient result panes follow the selected target and
    clear when tool, log scope, version, run, or artifact context changes, rather
    than leaving stale output in the current workspace
  - tightened family navigation identity after the live test environment showed
    active and proposed summaries for the same dogfood family id; primary
    navigation now prefers the active runtime summary, leaving proposed drafts
    to explicit creation/review surfaces
  - moved the same runtime-first rule down to the API boundary:
    `GET /api/hosted-integrations/families` now serves active families by
    default and requires `includeProposed=true` for proposed draft review flows
  - added Hosted Tools to the mobile primary navigation and kept the bottom bar
    single-row after screenshot review showed Settings wrapping to a second row
    and no direct mobile route back to Hosted Tools
  - added Hosted Tools to command palette navigation, keeping keyboard route
    discovery aligned with desktop and mobile primary navigation

## Milestone 17: DB-Backed Hosted Integration Persistence

Status: done.

Goal:

- Move production hosted integration persistence from file-backed stores to a
  DB-backed store implementation while keeping the current file-backed stores
  as dev/test adapters.
- Keep runtime and server code behind store interfaces so persistence remains a
  port swap, not a lifecycle rewrite.
- Store source, drafts, immutable generation snapshots, locks, examples,
  config-scope metadata, execution logs, failure buckets, approvals, jobs,
  idempotency records, retention metadata, and promotion provenance in DB
  tables with explicit transactions.
- Keep large run artifacts and oversized tool responses outside hot relational
  rows when needed; DB stores artifact metadata, content hash, size, retention
  state, and object/file ref.

Non-goals:

- No change to agent-facing hosted tool names.
- No remote MCP path.
- No cache-by-default behavior.
- No requirement to migrate historical local dev/test file-backed data unless a
  separate import tool is requested.

### Slice 17.1: Persistence Contract Audit

Status: done.

Goal:

- Enumerate every current file-backed hosted integration store and define the
  DB persistence contract for each one.
- Mark which records require transactional writes with promotion/rollback and
  which records can be append-only/event style.

TDD:

- contract tests enumerate all file-backed persistence surfaces and mark
  DB-backed adapter coverage as required from Slice 17.3
- store interfaces cover source revisions, drafts, generations, active pointers,
  locks, examples, config scopes, secrets metadata, logs, artifacts, buckets,
  approvals, jobs, idempotency, and retention
- no server route imports a concrete file-backed store

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- store-contract
pnpm --filter @openacme/server test -- hosted-integrations-routes
```

Implemented:

- Added `packages/hosted-integrations/src/persistence-contract.ts` as the
  executable persistence audit for every current hosted integration
  file-backed surface.
- Exported `HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS` and
  `HOSTED_INTEGRATION_SERVICE_PERSISTENCE_KEYS` so DB schema and adapter slices
  consume the same contract.
- Classified each surface by record kinds, owning module, current file-backed
  factory, intended DB table families, transactional writes, append-only
  events, immutable records, and adapter coverage expectations.
- Added `packages/hosted-integrations/test/store-contract.test.ts` to prove
  required record kinds are covered, service-level persistence ports have a
  contract, DB adapter coverage is explicitly required from Slice 17.3, and
  server routes stay behind the hosted integration service port.
- Updated the architecture doc so DB-backed persistence is no longer an open
  product question; exact DDL and migrations are left to Slice 17.2.

Validation completed:

```text
pnpm --filter @openacme/hosted-integrations test -- store-contract
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes
```

### Slice 17.2: DB Schema And Migrations

Status: done.

Goal:

- Add hosted integration DB tables and migrations using the existing OpenAcme DB
  migration conventions.
- Represent source/generation files as path-addressed content rows with sha256,
  size, media type when useful, and revision/generation ownership.

TDD:

- migrations create all hosted integration tables from an empty DB
- unique constraints prevent duplicate active pointers, duplicate generation
  file paths, duplicate draft file paths, and duplicate idempotency keys
- generation file rows are immutable after promotion
- active generation pointer update is transactional with promotion state

Validation:

```text
pnpm --filter @openacme/db test -- hosted-integrations
pnpm --filter @openacme/hosted-integrations test -- db-schema
```

Implemented:

- Added hosted integration Drizzle schema definitions in
  `packages/db/src/schema.ts` for every table family named by the Slice 17.1
  persistence contract.
- Generated migration `packages/db/drizzle/0023_mixed_dreadnoughts.sql`.
- Added DB tables for families, source revisions/files, drafts/files, examples,
  proposed families, locks, config scopes, secret metadata, approvals,
  disablements, generations/files/active pointers/invocation leases, jobs/job
  events, runs/artifacts, execution logs, failure buckets/events, and
  idempotency records.
- Represented source, draft, and generation file content as path-addressed rows
  with sha256, size, optional media type, and revision/draft/generation
  ownership.
- Enforced duplicate active pointers, duplicate generation file paths,
  duplicate draft file paths, duplicate artifact names per run, duplicate job
  progress sequence numbers, and duplicate idempotency keys through primary keys
  or unique indexes.
- Added SQLite triggers to reject update/delete attempts on promoted generation
  file rows.
- Added `packages/db/test/hosted-integrations.test.ts` to prove empty-DB
  migration, required table creation, uniqueness constraints, generation file
  immutability, and transactional rollback for generation promotion state plus
  active pointer updates.
- Added `packages/hosted-integrations/test/db-schema.test.ts` to prove the
  Slice 17.1 persistence contract table families are represented in the DB
  schema.

Validation completed:

```text
pnpm --filter @openacme/db test -- hosted-integrations
pnpm --filter @openacme/db check-types
pnpm --filter @openacme/hosted-integrations test -- db-schema
pnpm --filter @openacme/hosted-integrations check-types
```

### Slice 17.3: DB Store Adapter

Status: done.

Goal:

- Implement DB-backed hosted integration store adapters behind the existing
  package-level ports.
- Preserve exact route/tool behavior while switching persistence backends in
  tests.

TDD:

- shared store contract suite passes for DB-backed stores
- promotion copies a validated draft into immutable generation rows and updates
  the active pointer in one transaction
- rollback updates only active pointer/provenance and never deletes generation
  rows
- lock TTL and renewal semantics match the file-backed adapter
- execution logs and failure buckets dedupe identically across adapters

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- db-store store-contract
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
```

Implemented so far:

- Added `packages/hosted-integrations/src/db-store.ts` with DB-backed adapters
  for the lifecycle ports used by management, invocation, async execution, and
  repair:
  `HostedIntegrationLockStore`, `HostedIntegrationSourceFileStore`,
  `HostedIntegrationDraftStore`, `HostedIntegrationGenerationStore`,
  `HostedIntegrationConfigScopeStore`, `HostedIntegrationSecretStore`,
  `HostedIntegrationApprovalStore`, `HostedIntegrationDisablementStore`,
  `HostedIntegrationJobStore`, `HostedIntegrationArtifactStore`,
  `HostedIntegrationExecutionLogStore`,
  `HostedIntegrationFailureBucketStore`, and
  `HostedIntegrationIdempotencyStore`.
- Kept the adapter boundary DB-driver-light by accepting a small
  SQLite-compatible `HostedIntegrationSqlDatabase` interface instead of making
  hosted-integrations depend on the DB package at runtime.
- Preserved existing runtime path behavior by materializing promoted generation
  files and run artifacts under the current workspace roots while storing
  canonical generation, run, artifact metadata, hash, size, and storage refs in
  DB.
- Kept raw runtime secret values out of hosted integration DB rows:
  `createDbHostedIntegrationSecretStore` persists secret metadata in DB and
  delegates human-owned secret values to the configured runtime secret store.
- Covered lock TTL/renew/release semantics, DB source replacement, draft
  mutation, transactional promotion, request draining status transitions,
  rollback without deleting generation materialization, config scope revision
  semantics, delegated runtime secret reads, human-only approvals, disablement
  lookup, async job lifecycle/idempotency behavior, artifact response spillover,
  execution log finish metadata, and failure bucket dedupe.
- Corrected the DB schema/migration to store lock `draft_id`/`renewed_at` and
  failure bucket `first_seen_at`/`assigned_to`, matching the existing store port
  schemas.
- Extended `packages/hosted-integrations/src/persistence-contract.ts` so every
  Slice 17.1 persistence surface declares either an exported DB factory or an
  explicit delegated storage decision. `store-contract` now verifies those
  factory exports and delegated decisions.
- Added `createDbHostedIntegrationService` so DB-backed stores can be composed
  behind the existing `HostedIntegrationService` port without changing server
  routes. Backend selection and production guardrails remain Slice 17.5.

Explicit delegated decisions:

- Keep catalog, examples, and proposed-family summaries as explicit
  delegated decisions until the service-level DB composition owns family
  snapshot refresh, DB example registry wiring, proposed-summary persistence,
  and related lifecycle refreshes.

Validation completed so far:

```text
pnpm --filter @openacme/hosted-integrations test -- db-store store-contract
pnpm --filter @openacme/hosted-integrations test
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/db test -- hosted-integrations clean-bootstrap
pnpm --filter @openacme/db check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
```

### Slice 17.4: Artifact Metadata Split

Status: done.

Goal:

- Keep DB as the canonical index for artifacts while allowing artifact bytes to
  live in object/file storage when large.
- Make response spillover, retention, and failure evidence use DB metadata
  instead of directory scanning.

TDD:

- oversized tool responses return artifact refs backed by DB metadata
- artifact reads enforce the same authorization checks through DB metadata
- retention sweeps by DB state and does not scan run directories
- failed run artifacts tied to open buckets remain retained

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- artifacts retention db-store
pnpm --filter @openacme/server test -- hosted-integrations-routes
```

Implemented:

- Added `createDbHostedIntegrationRetentionSweeper`, backed by
  `hosted_integration_runs`, `hosted_integration_artifacts`,
  `hosted_integration_execution_logs`, and
  `hosted_integration_failure_buckets`.
- DB retention uses run/artifact/log/bucket rows as the canonical sweep index
  and derives file deletion paths from DB metadata; it does not scan run
  directories to discover retention candidates.
- Successful and failed-closed runs are marked `retention_state = 'deleted'`
  with artifact metadata marked deleted, while the file/object bytes are
  removed from the workspace path.
- Failed runs tied to open owner-actionable failure buckets are retained until
  the bucket closes.
- `createDbHostedIntegrationService` now composes the DB retention sweeper
  instead of delegating retention to the file-backed sweeper.
- Added DB-backed route coverage proving artifact reads still enforce the
  execution-log authorization path when run logs and artifact metadata come
  from DB-backed stores.

Validation completed:

```text
pnpm --filter @openacme/hosted-integrations test -- retention db-store store-contract
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes
pnpm --filter @openacme/server check-types
```

### Slice 17.5: Backend Selection And Migration Guardrails

Status: done.

Goal:

- Add explicit backend selection for dev/test file-backed vs production DB-backed
  hosted integration persistence.
- Fail fast if production is configured with file-backed hosted integration
  persistence unless a local-only/dev override is set.

TDD:

- local test env can intentionally use file-backed adapter
- production mode refuses file-backed adapter
- DB-backed adapter is selected by default for production deployment mode
- diagnostics report active hosted integration persistence backend

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations-persistence
pnpm --filter @openacme/server check-types
```

Implemented:

- Added `hostedIntegrations.persistenceBackend` config with values
  `auto`, `file`, and `db`.
- `auto` selects file-backed hosted integration persistence for local trusted
  loopback deployments and DB-backed hosted integration persistence for
  authenticated deployments.
- Explicit `file` persistence now fails fast in authenticated deployments.
- `ServerRuntime` exposes the selected hosted integration persistence backend
  and `GET /api/hosted-integrations/persistence` reports it for diagnostics.
- Runtime-owned DB-backed hosted integration service creation owns the DB handle
  and closes it during app shutdown.

Validation completed:

```text
pnpm --filter @openacme/config build
pnpm --filter @openacme/hosted-integrations build
pnpm --filter @openacme/config check-types
pnpm --filter @openacme/server test -- runtime hosted-integrations-routes
pnpm --filter @openacme/server check-types
```

## Milestone 18: Rectification - Environment Config Boundary And Agent Overrides

Status: implementation validated in the isolated worktree.

Why this is rectification:

- The current config-scope model is too flexible for the intended product
  boundary. It lets operational purposes such as `demo` and `parity` appear as
  first-class family config sets next to real runtime environments.
- That creates human confusion in Hosted Tools and Agent Settings: a user sees
  multiple Qualys configs without knowing which one is the actual environment
  and which one is an agent/internal-runner override.
- The correct boundary is narrower: family-level environment configs are shared
  runtime state; agent-specific selection, defaults, purpose, and version pins
  are per-agent binding state.

Contract:

- Product-level hosted integration environments are exactly `prod` and
  `test_debug`.
- An environment config is identified by `(familyId, environment)` and persisted
  with a derived id `<familyId>-<environment>`. Humans and agents do not provide
  arbitrary environment config ids.
- Storage must enforce at most one environment config per `(familyId,
environment)`.
- Agent-specific choices live in hosted-tool bindings, not cloned family config:
  allowed environments, default environment, generation pin, binding kind,
  purpose, optional binding note, and audit metadata.
- Per-agent custom runtime config is explicitly unsupported. Agent hosted-tool
  bindings must not carry config values, secret references, endpoint overrides,
  tenant overrides, credential selectors, custom environment config ids, or
  environment config revision pins.
- Future tenant/profile-level config isolation is out of scope for Milestone 18
  and must be introduced later as a new first-class primitive, not as an agent
  binding extension.
- Hosted-tool binding identity is unique by `(agentId, familyId, toolName)`.
  Internal runners use their own stable agent ids.
- Hosted-tool bindings are stored on the existing `AgentDefinition` model. There
  is no second authoritative hosted-integration policy store.
- `allowedEnvironments` is a non-empty subset of `["prod", "test_debug"]`.
  `defaultEnvironment` must be one of `allowedEnvironments`.
- `generationPin` is exactly one of `{ type: "current" }` or
  `{ type: "generation", generationId }`.
- Normal model-facing hosted tool calls do not include environment or config
  selection arguments. The gateway resolves them from the invoking agent's
  hosted-tool binding.
- Tool surfacing honors the generation pin: the ToolRegistry exposes the schema
  for the active generation when pinned to `current`, or the pinned generation
  when pinned to a concrete generation id.
- Internal parity/debug/dogfood runners are represented as internal hosted-tool
  bindings against `test_debug`; they must not create human-facing config labels
  such as `parity`, `demo`, or `stage`.
- Internal runner actor ids are reserved as:
  `agent:hosted-integrations:debug`,
  `agent:hosted-integrations:live-parity`, and
  `agent:hosted-integrations:dogfood`.
- Debug runs default to `test_debug`. `prod` debug is allowed only through the
  hosted integration control plane for an authorized human or internal
  maintenance actor with explicit `allowProdEnvironment=true`.
- GA publish requires production runtime readiness. If a family declares required
  runtime config or secret keys, the canonical `prod` environment config must
  exist and all required keys must be configured before publish can create an
  agent-visible active generation.
- A family that requires no runtime config/secrets can publish without a `prod`
  environment config only when the manifest explicitly declares an empty runtime
  config contract. Missing or ambiguous runtime config contracts block GA publish.
- `test_debug` readiness is sufficient for validate, example run, debug, parity,
  and dogfood, but it is not sufficient for GA publish.
- Legacy `/config-scopes` routes are not compatibility aliases. Migration may
  read legacy persisted files/rows directly, but active APIs and management
  tools use `/environment-configs`.
- Existing execution logs may retain historical config identifiers for audit,
  but new logs should record the resolved environment config id and environment.
- Existing `config-scope` wording is legacy implementation language. New product,
  API, UI, and agent-facing tool wording uses `environment config` and
  `hosted-tool binding`.
- Hosted integration workflow state is managed through shared deterministic
  readiness resolvers. UI components, API routes, management tools, and gateway
  dispatch must not duplicate ad hoc gate logic.
- Resolver outputs are sanitized structured states: `status`, `code`, `target`,
  `blockers[]`, and optional `sanitizedDetails`. They never include secret
  values, raw credentials, provider tokens, or unmasked request/response
  payloads.
- The canonical state machines are environment config readiness, hosted-tool
  binding readiness, publish readiness, debug readiness, invocation readiness,
  and migration readiness.
- API, management-tool, and skill surfaces are part of the contract. A resolver,
  route, or lifecycle operation is not complete until the Hosted Integrations
  API exposes it where needed, the relevant `hosted_tool_*` management
  tool wraps that API without duplicating logic, and the
  `hosted-integrations-development` skill teaches the Tool Developer Agent how
  to use the surface.

TDD operating rule:

- Each Slice 18 implementation slice starts by adding or updating the smallest
  deterministic test, fixture check, or `rg` gate that proves the slice goal and
  fails against the current pre-slice implementation.
- Red tests must cover the slice's public contract first: schema/API/tool
  names, migration behavior, resolver codes, UI action visibility, or dogfood
  orchestration, depending on the slice.
- Implementation is not complete until the slice validation commands pass and
  the failed-before/passed-after evidence is recorded in the slice close-out
  notes or milestone evidence section.
- Live Qualys calls are dogfood evidence, not the first TDD gate. Unit,
  contract, route, and UI tests must remain deterministic and runnable without
  target-system credentials.

### Slice 18.0: Contract Freeze And Surface Alignment

Goal:

- Freeze Milestone 18's implementation contract before code changes start, so
  environment config, hosted-tool binding, readiness, management-tool, API,
  skill, and agent-template surfaces cannot drift during implementation.
- Convert the plan-quality findings into explicit implementation work instead
  of leaving them as chat-only review notes.
- Make the next implementation slice decision-complete: the implementer should
  not need to decide tool names, readiness tool shape, state transitions,
  validation commands, or migration-owned surfaces.
- Remove active references to the legacy config-scope model from all
  user-facing, agent-facing, API-facing, and runtime-facing surfaces, and make
  that absence an explicit acceptance requirement.
- Produce a legacy-reference inventory before editing, classify every reference
  as active-to-remove, offline-migration-only, DB storage-internal, historical
  completed-plan note, or legacy-negative test, and close the slice only when no
  active-to-remove references remain.

Slice-owned work area goals:

- Contract freeze: make Milestone 18's target model explicit enough that later
  slices do not invent API, schema, tool, or lifecycle behavior locally.
- Surface alignment: align management tools, API routes, Tool Developer
  template, bundled skills, Agent Settings, runtime dispatch, dogfood scripts,
  and active UI/test fixtures to the same environment config and hosted-tool
  binding vocabulary.
- Legacy reference inventory and cleanup proof: create the reference inventory
  as a first-class slice work product, remove every `active-to-remove`
  reference, record allowed leftovers with path/reason/owner, and use the final
  `rg` pass only as proof that the slice-owned cleanup goal is complete.

Contract:

- Active public management tools are
  `hosted_tool_environment_config_list`,
  `hosted_tool_environment_config_get`, and
  `hosted_tool_readiness_get`. Legacy
  `hosted_integration_config_scope_*` tools are removed from active tool
  registry, runtime dispatch, Tool Developer template, dogfood prompts, and
  active tests. They are not compatibility aliases.
- Active public/runtime references to `allowedConfigScopeIds`,
  `defaultConfigScopeId`, `config_scope_id`, `configScopeId`,
  `/api/hosted-integrations/config-scopes`, `config scope`, and `config-scope`
  are removed or migrated to environment config / hosted-tool binding language.
  The only allowed remaining references are in offline migration code paths,
  historical completed-milestone notes, DB storage internals that are not public
  API/schema/runtime contracts, or explicit legacy-negative tests that prove the
  old surface is rejected.
- Agent-facing skill references include all bundled OpenAcme skills that route
  or describe hosted integration work, including
  `hosted-integrations-development` and `openacme-platform`. They must not teach
  config-scope terminology for new hosted integration work.
- Allowed legacy references must be documented in the slice close-out inventory
  with path, reason, and owner. A broad `rg` match is not acceptable evidence by
  itself unless each remaining match is either removed or classified. Legacy
  agent definitions are rewritten to the new binding shape by a one-way
  migration; active schemas and runtime paths reject the legacy binding shape
  after migration.
- `hosted_tool_readiness_get` is a single strict discriminated tool:
  `target_type="environment_config"` requires `family_id` and `environment`;
  `target_type="binding"` requires `agent_id`, `family_id`, and `tool_name`;
  `target_type="publish"` requires `draft_id`;
  `target_type="debug"` requires `family_id` and `tool_name`, with optional
  `environment` defaulting to `test_debug` and prod requiring
  `allow_prod_environment=true`;
  `target_type="invocation"` requires `agent_id`, `family_id`, and `tool_name`,
  with optional `captured_generation_id`;
  `target_type="migration"` requires no target fields.
- Readiness tool responses are always `{ ok: true, readiness }`, where
  `readiness` has `kind`, `status`, `code`, `target`, `blockers[]`, and
  optional `sanitizedDetails`.
- Readiness APIs include environment config, binding, publish, debug,
  invocation, and migration reads. Readiness reads are advisory; mutation routes
  must rerun the matching resolver before state changes.
- Agent matrix uses
  `GET /api/hosted-integrations/families/:familyId/tools/:toolName/agent-bindings`
  as a read-only projection. Binding writes use the existing
  `PATCH /api/agents/:id` Agent Settings persistence path.
- Agent binding migration explicitly covers `packages/config` schema,
  persisted agent files, managed-agent template refresh, Agent Settings payload
  read/write, and server/tool invocation paths.
- Route placeholder names in docs and new code use `familyId`; wire behavior is
  unchanged.
- State machines have explicit transition ownership:
  environment config transitions are owned by environment config writes,
  runtime contract changes, and migration conflict resolution;
  hosted-tool binding transitions are owned by Agent Settings writes, policy
  evaluation, and generation pin resolution;
  publish transitions are owned by draft, lock, validation, runtime contract,
  and prod readiness changes;
  debug/invocation transitions are owned by policy, binding, environment
  readiness, operation class, and generation/draining state;
  migration transitions are owned by the migration planner and human conflict
  resolution.

Non-goals:

- No implementation of Milestone 18 behavior in this slice beyond plan/doc/skill
  contract alignment.
- No legacy route/tool aliases.
- No new policy language, tenant/profile config primitive, or environment label.

TDD:

- `rg` over active tool/runtime/template/skill/dogfood source proves no
  `hosted_integration_config_scope_*` active surface remains after the
  implementation slices.
- `rg` over active app/server/tool/config/agent-template/skill source proves no
  active `allowedConfigScopeIds`, `defaultConfigScopeId`, `config_scope_id`,
  `configScopeId`, `/api/hosted-integrations/config-scopes`, `config scope`, or
  `config-scope` references remain outside offline migration modules,
  historical docs, DB storage internals, and legacy-negative tests.
- the legacy-reference inventory is checked into the slice close-out notes or
  recorded in the milestone evidence section, and every remaining match has an
  allowed classification
- Tool wrapper tests prove `hosted_tool_readiness_get` validates the
  discriminated input contract and delegates to the control plane.
- Route tests prove readiness APIs expose all six readiness target kinds and
  mutation routes return resolver-coded blocked errors.
- Config/schema tests prove active agent definitions use hosted-tool binding
  fields and reject legacy `allowedConfigScopeIds/defaultConfigScopeId`;
  migration tests separately prove old agent definitions are rewritten before
  runtime use.
- Skill/template fixture checks prove Tool Developer receives the environment
  config and readiness tools and no longer teaches config-scope tools for new
  work.
- State resolver tests cover every listed state transition and verify no secret
  values appear in readiness results.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- readiness policy validation migration
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter @openacme/skills check-types
pnpm --filter @openacme/agent-catalog check-types
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings
pnpm --filter web check-types
rg -n "hosted_integration_config_scope_" packages/skills/builtin packages/agent-catalog/templates packages/tools/src packages/server/src packages/server/scripts apps/web/app apps/web/test
rg -n "allowedConfigScopeIds|defaultConfigScopeId|config_scope_id|configScopeId|/api/hosted-integrations/config-scopes|config scope|config-scope" packages/skills/builtin packages/agent-catalog/templates packages/tools/src packages/server/src packages/server/scripts apps/web/app apps/web/test packages/config/src packages/hosted-integrations/src
rg -n "allowedConfigScopeIds|defaultConfigScopeId|config_scope_id|configScopeId|/api/hosted-integrations/config-scopes|hosted_integration_config_scope_|config scope|config-scope" packages apps docs/hosted-integrations-architecture.md docs/hosted-integrations-implementation-plan.md
```

The first two `rg` commands are zero-match gates over active surfaces after the
implementation slices. The broad `rg` command is the input to the
legacy-reference inventory; every match must be removed or classified before the
slice closes.

### Slice 18.1: Two Environment Configs Only

Status: validated. The later storage rename slice removed the remaining
storage-internal `config-scopes` vocabulary, so environment config is now the
only active package, API, tool, UI, runtime, and DB concept.

Goal:

- Replace open-ended hosted integration environment/config-scope semantics with
  exactly two product-level family environments: `prod` and `test_debug`.
- Keep family-level config/secrets shared and human-owned, not agent-specific.
- Reject new environment config labels outside `prod` and `test_debug`.
- Add the canonical environment config id strategy:
  `<familyId>-<environment>`.
- Enforce uniqueness for `(familyId, environment)` in file-backed and DB-backed
  stores.
- Make `PUT /environment-configs/:familyId/:environment` idempotently create or
  update only the canonical environment config for that identity.
- Rename the active control-plane surface from config scopes to environment
  configs. Any remaining config-scope names are internal historical migration
  details, not user-facing product vocabulary.

Non-goals:

- No arbitrary environment list in the UI.
- No secret value readback.
- No runtime behavior change for existing agents before migration in Slice 18.2.
- No support for additional environment labels through hidden feature flags.

TDD:

- environment config validation accepts only `prod` and `test_debug`
- creating or updating an environment config with `dev`, `stage`, `demo`, or
  `parity` is rejected with a normalized validation error
- `PUT /environment-configs/:familyId/:environment` creates the canonical record
  when missing and updates that same canonical record when present
- attempts to create a second record for the same `familyId + environment`
  through any store/API path fail with a normalized validation/conflict error
- read APIs return sanitized environment config metadata and never return secret
  values
- API routes accept only `/environment-configs/:familyId/:environment` with
  `environment in {prod,test_debug}`
- `/config-scopes` routes are absent from the active route table and return the
  normal not-found response; they do not behave as aliases
- DB schema has a uniqueness guarantee for `(family_id, environment)`
- file-backed storage derives ids from family/environment and refuses custom ids
- Hosted Tools Config tab labels these records as environment configs, not
  agent-specific config clones
- management-tool schemas stop exposing `config_scope` names for new calls

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- environment-configs
pnpm --filter @openacme/hosted-integrations test -- db-store
pnpm --filter @openacme/db test -- hosted-integrations
pnpm --filter @openacme/server test -- hosted-integrations-routes
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter web test -- hosted-integrations-admin
pnpm --filter web check-types
```

Evidence so far:

- Red-first package tests added:
  `packages/hosted-integrations/test/environment-configs.test.ts`.
- Initial red run failed because
  `createFileHostedIntegrationEnvironmentConfigStore` did not exist.
- Added package-level environment config contract:
  `HostedIntegrationEnvironmentSchema`,
  `HostedIntegrationEnvironmentConfigSchema`,
  `HOSTED_INTEGRATION_ENVIRONMENTS`,
  canonical `hostedIntegrationEnvironmentConfigId`, and
  `createFileHostedIntegrationEnvironmentConfigStore`.
- Focused package validation is green:
  `pnpm --filter @openacme/hosted-integrations build` and
  `pnpm --filter @openacme/hosted-integrations test -- gateway policy execution-log telemetry deprecation disable db-store environment-configs hosted-tool-bindings migration validation source-view`.
- Added active API and management-tool environment config surfaces:
  `GET /api/hosted-integrations/environment-configs`,
  `GET /api/hosted-integrations/environment-configs/:familyId/:environment`,
  `PUT /api/hosted-integrations/environment-configs/:familyId/:environment`,
  `hosted_tool_environment_config_list`, and
  `hosted_tool_environment_config_get`.
- Added server route coverage proving canonical id creation, secret metadata
  sanitization, detail/list reads, and invalid environment rejection.
- Added active secret metadata route:
  `PUT /api/hosted-integrations/environment-configs/:familyId/:environment/secrets`.
  It requires a human session when auth is available, updates secret metadata,
  and never returns raw secret values.
- Old `/api/hosted-integrations/config-scopes` routes are absent from the
  active route table. Later storage cleanup removed the explicit tombstones, so
  old URLs now receive the platform default 404 and do not behave as aliases.
- Migrated debug-run parameters, live parity, safe E2E, dogfood E2E, Tool
  Developer template, bundled hosted-integrations skill, Agent Settings, and
  Hosted Tools admin copy to environment config terminology.

### Slice 18.2: Agent Binding Overrides And Migration

Status: validated. Later readiness, publish-gate, dogfood, and storage-rename
slices closed the remaining milestone work; the legacy binding fallback is not
part of the active runtime path.

Goal:

- Move caller-specific selection, defaults, parity/debug purpose, and version
  pinning into agent-specific hosted-tool bindings instead of creating extra
  config scopes such as `demo`, `parity`, or per-agent clones.
- Migrate existing `test`, `demo`, and `parity` scope usage to `test_debug`
  environment configs plus agent binding metadata.
- Rewrite existing agent definitions and hosted-runner bindings to the new
  hosted-tool binding shape before they can be used by active runtime paths.
- Extend the agent hosted-tool binding contract with:
  `allowedEnvironments`, `defaultEnvironment`, `generationPin`,
  `bindingKind`, optional `purpose`, optional `bindingNote`, `updatedAt`,
  and `updatedBy`.
- Make normal runtime invocation resolve environment config and generation from
  the invoking agent's binding. The model-facing hosted tool call does not
  carry environment or config identifiers.
- Convert live parity and debug/dogfood runners to internal bindings against
  `test_debug`.
- Make binding writes upsert exactly one binding per `(agentId, familyId,
toolName)`.
- Route binding writes through the existing Agent Settings/agent-definition
  persistence path. Hosted Integrations may expose a computed matrix read-model,
  but it does not own binding writes.

Non-goals:

- No org-wide complex policy language.
- No UI for arbitrary policy expressions.
- No automatic merge of conflicting secret/config material without an explicit
  migration decision.
- No per-agent config values, secret refs, tenant selectors, endpoint overrides,
  credential selectors, or config revision pins.
- No backward-compatible active runtime path for legacy binding fields.

Migration rules:

- Migration classifies legacy records from the persisted `environment` field
  first, not from the scope id.
- Legacy records with `environment === "prod"` map to `prod`.
- Legacy records with `environment` in `["test", "debug", "demo", "parity",
"dev", "stage", "local"]` map to `test_debug`.
- A legacy id containing `demo`, `parity`, `live`, or dogfood words becomes
  binding `purpose` metadata only after the environment mapping above has
  succeeded.
- A legacy record with `environment === "live"` maps to `test_debug` only when
  its id or metadata also marks it as demo/parity/dogfood. Otherwise migration
  emits a blocking conflict report because `live` is ambiguous.
- Any other legacy environment label emits a blocking conflict report.
- If multiple legacy scopes for one family map to the same canonical
  environment and their non-secret config plus secret key metadata are
  equivalent, migration merges them into the canonical environment config and
  rewrites agent/internal bindings.
- If multiple legacy scopes map to the same canonical environment but have
  conflicting non-secret config or secret key metadata, migration emits a
  blocking conflict report and does not delete source records. Secret values are
  not read or compared.
- Historical execution logs keep their original identifiers for audit; new
  invocation logs use canonical environment config ids.
- Records that migrate without conflicts are rewritten to the new environment
  config and hosted-tool binding shape. Conflicted records are quarantined and
  unavailable for new invocation until a human resolves the environment/config
  conflict. Active runtime paths do not preserve or accept legacy binding shape.

TDD:

- migrating existing `test`, `demo`, or `parity` scopes maps them to
  `test_debug` plus agent binding metadata
- ambiguous legacy `live` or unknown environment labels produce blocking
  migration conflict reports
- migrated internal parity/debug/dogfood bindings use the reserved internal actor
  ids
- conflicting duplicate legacy scopes produce a migration conflict report
  instead of silently picking a winner
- parity runner uses an internal agent binding against `test_debug` instead of
  creating a human-facing `*-parity` config scope
- normal agent invocation resolves environment config from the agent binding
  without exposing environment/config selection as a model argument
- agent binding can express `generationPin=current` or a concrete generation id
- `defaultEnvironment` outside `allowedEnvironments` is rejected
- public binding write APIs are upserts by `(agentId, familyId, toolName)` and
  replace the prior binding atomically
- Hosted Integrations matrix data is derived from AgentDefinition bindings and
  hosted tool catalog state; mutating a matrix row updates the same
  AgentDefinition binding that Agent Settings edits
- storage validation rejects persisted data that contains more than one active
  binding for the same `(agentId, familyId, toolName)`; runtime never sees two
  candidate bindings for one agent/tool
- ToolRegistry exposes the schema for the generation selected by the binding pin
- runtime/gateway rejects stale calls whose captured generation id does not match
  the binding pin resolution
- Agent Settings edits only the selected agent's binding; it does not create
  family-level config clones
- policy rejects a requested environment/config not allowed by the agent binding
- persisted bindings that contain config values, secret refs, endpoint overrides,
  tenant overrides, credential selectors, custom config ids, or config revision
  pins are rejected during schema validation/migration
- legacy per-agent/custom scopes that are not equivalent to the canonical
  environment config become migration conflicts, not agent binding overrides
- existing agents in the local test env migrate from `allowedConfigScopeIds` to
  the new binding shape
- active config schema rejects persisted agent definitions that still contain
  `allowedConfigScopeIds` or `defaultConfigScopeId` after migration
- debug/example runs from the Tool Developer Agent are marked
  `invocationPurpose=tool_maintenance` and do not create failure-bucket churn

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- policy environment-configs hosted-tool-bindings
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/server test -- hosted-integrations-routes
pnpm --filter @openacme/server test -- hosted-integration-live-parity
pnpm --filter @openacme/server test -- tools-hosted-integrations
pnpm --filter web test -- hosted-integration-agent-settings
pnpm --filter web check-types
```

Evidence so far:

- Red-first package tests added:
  `packages/hosted-integrations/test/hosted-tool-bindings.test.ts`.
- Initial red run failed because
  `HostedIntegrationHostedToolBindingSchema`,
  `createAgentSettingsHostedToolBinding`, and
  `resolveHostedIntegrationBindingEnvironment` did not exist, and policy still
  resolved only config-scope bindings.
- Added package-level hosted-tool binding contract with
  `allowedEnvironments`, `defaultEnvironment`, `generationPin`, `bindingKind`,
  optional purpose/note, and audit fields.
- Added policy resolution for `hostedToolBindings` that resolves canonical
  environment config ids from the invoking agent's binding without model-facing
  config arguments.
- Migrated `packages/config` `AgentHostedIntegrationBindingSchema` to the new
  hosted-tool binding shape and added a negative AgentStore test rejecting
  legacy `allowedConfigScopeIds/defaultConfigScopeId` bindings.
- Migrated Agent Settings helper payload construction and fetch path to
  environment configs, with web helper tests and `web check-types` green.
- Removed the active runtime fallback to legacy
  `allowedConfigScopeIds/defaultConfigScopeId` policy bindings. Normal gateway
  invocation now resolves from `hostedToolBindings` and returns canonical
  `resolvedEnvironment` / `resolvedEnvironmentConfigId`.
- Migrated server runtime dispatch, debug-run management parameters, live
  parity, migration fixtures, safe E2E, dogfood E2E, and app-route agent
  settings fixtures to hosted-tool binding shape.
- Added Tool Developer access to `hosted_tool_source_view` and updated
  the hosted-integrations development skill so repairs can inspect one selected
  tool handler plus hooks/helpers instead of raw source windows.
- Dogfood evidence is green:
  `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/hosted-integrations-safe-tools.e2e.ts test/e2e/hosted-integrations-dogfood.e2e.ts --reporter verbose`
  passed 8 tests. The covered flows include API lifecycle, `/api/tools`
  surfacing, real agent tool invocation, Tool Developer chat lifecycle, consumer
  access denial, failure bucket creation, focused source-view repair, regression
  example, debug run, close, and rollback.

Closed legacy-reference inventory:

- Final active-surface `rg` gate after the storage rename:
  `rg -n "hosted_integration_config_scope_|allowedConfigScopeIds|defaultConfigScopeId|config_scope_id|/api/hosted-integrations/config-scopes|config scope|config-scope|HostedIntegrationPolicyBinding|createAgentSettingsHostedIntegrationBinding|requestedConfigScopeId|resolvedConfigScopeId" packages/skills/builtin packages/agent-catalog/templates packages/tools/src packages/server/src packages/server/scripts apps/web/app apps/web/test packages/config/src packages/config/test packages/server/test/e2e packages/server/test/app-routes.test.ts packages/hosted-integrations/src packages/hosted-integrations/test/integration-hub-replacement.test.ts`
- Current active source/test/dist gate has no matches for the legacy
  config-scope and old hosted-tool binding field names. Legacy-negative tests
  keep the old property names constructed indirectly where needed, without
  exposing active API/tool/UI wording.
- `HostedIntegrationPolicyBindingSchema` has been removed from active source.

### Slice 18.3: Shared Workflow State Resolvers

Goal:

- Introduce a shared hosted integration readiness resolver layer that owns all
  lifecycle state decisions before UI, API, management tools, and gateway
  dispatch use them.
- Make readiness deterministic and explainable through normalized state/code
  pairs rather than scattered boolean checks.
- Use the resolver layer for environment config readiness, hosted-tool binding
  readiness, publish readiness, debug readiness, invocation readiness, and
  migration readiness.
- Ensure UI and management tools render resolver output, API routes enforce the
  same resolver output before mutations, and the gateway rechecks invocation
  readiness immediately before runtime dispatch.
- Add read-only readiness API endpoints for UI, automation, and Tool Developer
  Agent planning:
  `/readiness/environment-configs/:familyId/:environment`,
  `/readiness/bindings/:agentId/:familyId/:toolName`,
  `/readiness/drafts/:draftId/publish`, `/readiness/debug`, and
  `/readiness/migration`.
- Add or update the `hosted_tool_readiness_get` management tool so the
  Tool Developer Agent can inspect the same resolver state without direct store
  access.
- Update `hosted-integrations-development` skill wording so it uses
  `environment config`, `hosted-tool binding`, readiness codes, and the
  `hosted_tool_readiness_get` flow instead of legacy config-scope
  language.

Contract:

- Resolver functions:
  `resolveEnvironmentConfigReadiness(familyId, environment)`,
  `resolveAgentHostedToolBinding(agentId, familyId, toolName)`,
  `resolvePublishReadiness(draftId)`,
  `resolveDebugReadiness(actor, familyId, toolName, requestedEnvironment?)`,
  `resolveInvocationReadiness(actor, familyId, toolName, capturedGenerationId)`,
  and `resolveMigrationReadiness(source)`.
- Every resolver returns a sanitized result with `status`, `code`, `target`,
  `blockers[]`, and optional `sanitizedDetails`.
- Environment config readiness states:
  `missing`, `incomplete`, `ready`, `conflicted`, `quarantined`.
- Hosted-tool binding readiness states:
  `missing`, `invalid`, `ready`, `denied`, `stale_generation`.
- Publish readiness states:
  `draft_missing`, `lock_required`, `validation_required`,
  `validation_failed`, `runtime_config_contract_missing`,
  `production_config_missing`, `production_config_incomplete`, `ready`.
- Debug readiness states:
  `ready`, `actor_denied`, `approval_required`, `environment_missing`,
  `environment_incomplete`, `prod_environment_requires_explicit_allow`,
  `tool_not_debuggable`.
- Invocation readiness states:
  `ready`, `tool_not_enabled`, `binding_missing`, `binding_invalid`,
  `environment_missing`, `environment_incomplete`, `generation_stale`,
  `tool_disabled`, `approval_required`.
- Migration readiness states:
  `ready`, `conflict`, `quarantined`, `blocked`.
- Resolvers never read back or return secret values.
- UI action visibility/disabled states must be derived from resolver results.
  For example, `Publish` appears only when there is a publish candidate and is
  disabled with resolver blockers until `resolvePublishReadiness` is `ready`.
- API handlers must call the relevant resolver before state mutation and return
  the resolver's normalized code when blocked.
- Management tools must call API/control-plane operations and surface returned
  resolver codes instead of implementing their own readiness checks.
- Gateway invocation must call `resolveInvocationReadiness` after binding and
  generation capture and before Python runtime dispatch.
- Readiness reads are advisory snapshots. Mutation endpoints must still rerun
  the relevant resolver immediately before changing state.
- If OpenAcme exposes hosted integration lifecycle tools through an internal
  MCP-compatible transport later, that transport is only a wrapper over the same
  `hosted_tool_*` OpenAcme tool definitions and Hosted Integrations API.
  It must not behave like an external MCP server and must not share allowlist
  identity with remote MCP tools.

Non-goals:

- No new policy language.
- No new environment labels.
- No UI redesign in this slice beyond wiring existing controls to resolver
  output.
- No secret editor or secret value readback.
- No compatibility aliases for legacy config-scope routes.

TDD:

- environment config resolver returns `missing`, `incomplete`, `ready`,
  `conflicted`, and `quarantined` for deterministic fixtures
- binding resolver rejects missing bindings, invalid environment defaults,
  denied actors, and stale generation pins with normalized codes
- publish resolver distinguishes `validation_required`, `validation_failed`,
  `runtime_config_contract_missing`, `production_config_missing`,
  `production_config_incomplete`, and `ready`
- debug resolver defaults to `test_debug`, blocks prod debug without
  `allowProdEnvironment=true`, and returns actor/policy blockers without
  dispatching runtime code
- invocation resolver blocks hidden/disabled tools, missing bindings, incomplete
  environments, and stale captured generations before runtime dispatch
- migration resolver returns conflict/quarantine states without mutating source
  data until the migration step explicitly applies a resolved plan
- resolver payload snapshots prove no secret values, raw credentials, provider
  tokens, or unmasked payloads are returned
- API route tests prove blocked mutations return resolver codes rather than
  route-local error strings
- API route tests cover the readiness read endpoints and prove they return the
  same resolver result shape as blocked mutations
- `hosted_tool_readiness_get` wrapper tests prove the management tool
  delegates to the API/control-plane surface and does not reimplement readiness
  decisions
- gateway tests prove runtime dispatch is not called when invocation readiness
  is anything other than `ready`
- web tests prove Hosted Tools and Agent Settings render action disabled/hidden
  states from resolver codes instead of local heuristics
- skill tests or fixture checks prove `hosted-integrations-development` no
  longer teaches legacy config-scope tools for new work and includes the
  readiness inspection flow
- `rg` checks over active hosted integration UI/API/gateway code find no direct
  ad hoc checks for publish/debug/invocation readiness outside the resolver
  module and thin adapters

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- readiness policy validation migration
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter @openacme/skills check-types
pnpm --filter @openacme/agent-catalog check-types
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings
pnpm --filter web check-types
```

Evidence so far:

- Red-first package readiness coverage was expanded from a small smoke test to
  table-driven resolver coverage for every Slice 18.3 readiness state code:
  environment config `missing`, `incomplete`, `ready`, `conflicted`,
  `quarantined`; hosted-tool binding `missing`, `invalid`, `denied`,
  `ready`, `stale_generation`; publish `draft_missing`, `lock_required`,
  `validation_required`, `validation_failed`,
  `runtime_config_contract_missing`, `production_config_missing`,
  `production_config_incomplete`, `ready`; debug `ready`, `actor_denied`,
  `approval_required`, `environment_missing`, `environment_incomplete`,
  `prod_environment_requires_explicit_allow`, `tool_not_debuggable`;
  invocation `ready`, `tool_not_enabled`, `binding_missing`,
  `binding_invalid`, `environment_missing`, `environment_incomplete`,
  `generation_stale`, `tool_disabled`, `approval_required`; migration
  `ready`, `conflict`, `quarantined`, `blocked`.
- The expanded readiness test first failed because the resolver returned
  `ready` instead of `denied` for policy-denied bindings and `ready` instead
  of `approval_required` for approval-gated debug runs. The resolver now emits
  those normalized codes through the shared package layer.
- Gateway coverage now proves invocation dispatch consults readiness before
  Python runtime dispatch for missing environment configs: the red test first
  observed legacy `environment_config_not_found`, then passed with resolver
  code `environment_missing` and zero runtime calls.
- Gateway policy-denied invocation coverage now returns resolver taxonomy
  (`binding_missing`) before runtime dispatch instead of the generic
  `policy_denied` bucket.
- Promotion mutation route coverage now proves blocked publish mutations return
  a resolver snapshot: stale locks return publish readiness `lock_required` and
  invalid drafts return publish readiness `validation_failed`. The route also
  reruns publish readiness immediately before source replacement and generation
  promotion.
- Async job start and debug-run mutation-like routes now return resolver
  snapshots for invocation/debug blockers. Unauthorized async starts return
  invocation readiness `binding_missing`; non-canonical Tool Developer debug
  attempts return debug readiness `actor_denied`; write debug without explicit
  write allowance returns debug readiness `tool_not_debuggable`.
- Active route/gateway audit shows remaining policy/environment branches are
  thin adapters over `resolveInvocationReadiness`,
  `resolveDebugReadiness`, `resolvePublishReadiness`, or
  `resolveEnvironmentConfigReadiness`.
- Focused validation is green:
  `pnpm --filter @openacme/hosted-integrations build`;
  `pnpm --filter @openacme/hosted-integrations test -- readiness gateway policy validation migration`
  passed 62 tests with 1 skipped;
  `pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help`
  passed 15 tests;
  `pnpm --filter @openacme/tools build`;
  `pnpm --filter @openacme/server check-types`;
  `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations runtime`
  passed 57 tests;
  `pnpm --filter @openacme/skills check-types`;
  `pnpm --filter @openacme/agent-catalog check-types`;
  `pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings`
  passed 40 tests;
  `pnpm --filter web check-types`.
- Current acceptance boundary: the shared resolver package, read-only readiness
  route/tool surface, Tool Developer template wiring, UI/test compatibility,
  gateway environment/policy readiness blocking, and publish mutation/job/debug
  resolver-coded blockers are validated. Slice 18.3 is closed.

### Slice 18.4: Hosted Tools Agent Matrix

Goal:

- Add a Hosted Tools settings matrix for the selected family/tool showing each
  agent that can use it, the agent's default environment, whether it follows the
  active generation or is pinned to a generation/version, and any binding note.
- Add a read-only matrix API endpoint:
  `GET /api/hosted-integrations/families/:familyId/tools/:toolName/agent-bindings`.
- Show internal parity/debug runner bindings as internal bindings, not as
  normal human-facing environment configs.
- Update Agent Settings hosted tool rows to configure environment/generation
  binding state, not raw config-scope ids.
- Update debug/config/logs UI copy so humans see environment configs and binding
  purposes, not cloned scopes.
- Keep human-native editing complete: environment config keys, secret key status,
  agent binding rows, internal binding rows, generation pins, and binding notes
  are inspectable without exposing secret values.

Non-goals:

- No secret value editor in the agent matrix.
- No duplicate Agent Settings surface inside Hosted Tools; the matrix is
  read-only inspection for the selected hosted tool.
- No arbitrary environment creation from the UI.

TDD:

- Hosted Tools shows an agent matrix for a selected family/tool with agent,
  default environment, version/generation selection, and binding note state
- the agent matrix API returns a read-only projection derived from
  `AgentDefinition` bindings plus hosted tool catalog state
- internal bindings are visually separated from ordinary agent bindings
- matrix rows show sanitized binding details and no secret values
- binding writes remain owned by Agent Settings through `PATCH /api/agents/:id`;
  Hosted Tools does not create a second binding write path or store
- removed agents or disabled tools do not appear as active bindings
- Config tab shows exactly `prod` and `test_debug` rows for a family where those
  configs exist, with missing states for unset required env/secret keys
- Debug tab runs against `test_debug` by default and never lists `demo` or
  `parity` as environment choices
- `prod` debug is absent for normal users and appears only for authorized
  human/internal maintenance actors with explicit `allowProdEnvironment`
- execution log rows show the canonical environment/config target while
  preserving historical audit identifiers in detail view when present
- Agent Settings cannot accidentally allow every config that shares the same
  environment label
- Agent Settings and Hosted Tools matrix do not expose controls for per-agent
  config values, secret refs, endpoint overrides, tenant overrides, credential
  selectors, custom config ids, or config revision pins

Validation:

```text
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings
pnpm --filter web check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes
```

Evidence:

- `packages/server/src/routes/hosted-integrations.ts` exposes the read-only
  family/tool agent binding matrix and derives rows from `AgentDefinition`
  hosted integration bindings plus the hosted tool name boundary.
- `apps/web/app/routes/settings.tsx` shows a selected-tool `Agents` tab with
  ordinary agent bindings separated from internal bindings, generation state,
  default/allowed environment state, and binding notes.
- `apps/web/app/lib/hosted-integrations-admin.ts` groups/sanitizes the matrix
  rows for human inspection; no config values, endpoint values, or secret values
  are included.
- Validation run on 2026-08-14:
  `pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings`;
  `pnpm --filter web check-types`;
  `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations runtime`;
  `pnpm --filter @openacme/server check-types`;
  `pnpm --filter @openacme/hosted-integrations test -- readiness gateway hosted-tool-bindings help source-view validation environment-configs`;
  `pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help`.

### Slice 18.5: Publish Readiness Workflow Gates

Goal:

- Make publish behavior deterministic when environment configs are missing or
  incomplete.
- Split validation/debug readiness from GA publish readiness.
- Prevent a hosted integration from becoming agent-visible unless its production
  runtime config contract is satisfied, or unless the family explicitly declares
  that no runtime config/secrets are required.

Contract:

- Validation, example runs, debug runs, parity, and dogfood can run with
  `test_debug` only.
- GA publish checks the family manifest/source-derived runtime config contract.
- The manifest contract is declared as:
  `runtimeConfig.requiredConfigKeys: string[]` and
  `runtimeConfig.requiredSecretKeys: string[]`.
- If the contract has required config or secret keys, GA publish requires the
  canonical `prod` environment config to exist and report every required key as
  configured.
- If the contract is explicitly empty, GA publish does not require a `prod`
  environment config.
- If the contract is missing, invalid, or ambiguous, GA publish fails with
  `runtime_config_contract_missing`.
- If `prod` is missing, GA publish fails with `production_config_missing`.
- If `prod` exists but required keys are missing, GA publish fails with
  `production_config_incomplete` and returns sanitized missing key names only.
- Publish never creates or mutates environment configs or secret values.
- Non-GA/internal-only generations are not introduced in this slice. Any
  internal-only publishing mode requires a later explicit product contract.

Non-goals:

- No automatic creation of `prod` environment configs during publish.
- No secret value readback.
- No internal-only generation lifecycle.

TDD:

- draft validation can pass with only `test_debug` configured
- debug/example runs can run with only `test_debug` configured
- GA publish fails with `production_config_missing` when required runtime config
  exists but no `prod` environment config exists
- GA publish fails with `production_config_incomplete` when `prod` exists but a
  required config or secret key is missing
- GA publish fails with `runtime_config_contract_missing` when the family does
  not declare whether runtime config/secrets are required
- GA publish succeeds without any environment config only for a family that
  explicitly declares an empty runtime config contract
- publish failure responses include sanitized missing key names and never include
  secret values
- Hosted Tools Publish lane shows production readiness blockers before showing
  `Publish`

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- validation
pnpm --filter @openacme/server test -- hosted-integrations-routes
pnpm --filter web test -- hosted-integrations-admin
pnpm --filter web check-types
```

Evidence:

- `packages/hosted-integrations/src/schemas.ts` adds the explicit
  `runtimeConfig` manifest contract with required non-secret config keys and
  required secret keys.
- `packages/hosted-integrations/src/readiness.ts` resolves manifest contract
  state as `missing`, `empty`, or `requires`, and `resolvePublishReadiness`
  maps required prod config blockers to deterministic publish errors.
- `packages/server/src/routes/hosted-integrations.ts` uses the actual draft
  manifest contract plus canonical `prod` environment config readiness before
  promoting; publish never creates or mutates environment configs or secrets.
- `apps/web/app/routes/settings.tsx` reads publish readiness after validation
  and shows production blockers before offering `Publish`.
- Validation run on 2026-08-14:
  `pnpm --filter @openacme/hosted-integrations build`;
  `pnpm --filter @openacme/hosted-integrations test -- validation readiness`;
  `pnpm --filter @openacme/hosted-integrations check-types`;
  `pnpm --filter @openacme/server test -- hosted-integrations-routes`;
  `pnpm --filter @openacme/server check-types`;
  `pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings`;
  `pnpm --filter web check-types`.

### Slice 18.6: Legacy Surface Cleanup And Dogfood

Goal:

- Remove or quarantine all old user-facing `config scope` surfaces after the
  environment-config and binding migration is complete.
- Update hosted integration management tools and skill guidance so the Tool
  Developer Agent uses environment config and hosted-tool binding terminology.
- Run a focused dogfood pass on the migrated local test environment, including
  Qualys live read-only calls.

Non-goals:

- No broad non-Qualys parity expansion in this slice.
- No destructive Qualys operations.

TDD:

- `rg` checks over active source paths find no user-facing
  `hosted_integration_config_scope_*` management tool schemas
- `rg` checks prove the bundled `hosted-integrations-development` skill uses
  `environment config`, `hosted-tool binding`, and readiness terminology for new
  work instead of `config scope`
- `qualys-live-parity`, `qualys-live-demo`, and `environment: "test"` are not
  recreated by startup, live parity, debug, or Agent Settings flows
- a migrated normal agent can invoke one Qualys hosted read-only tool through
  its hosted-tool binding
- the Tool Developer Agent can run a debug call against `test_debug` without
  creating a maintenance failure bucket
- a live parity run uses an internal binding and does not add an extra
  environment config row

Validation:

```text
pnpm --filter @openacme/hosted-integrations test
pnpm --filter @openacme/server test -- hosted-integrations-routes hosted-integration-live-parity tools-hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings hosted-integrations-rich-editor
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server check-types
pnpm --filter web check-types
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LEGACY_MCP_DATA_DIR=/Users/alenbohcelyan/.openacme pnpm --filter @openacme/server integration-hub:parity
```

Evidence:

- Added `packages/server/test/hosted-integrations-legacy-surface.test.ts` to
  lock active tool, skill, Tool Developer Agent, live parity, and web admin
  surfaces against legacy `config scope` names.
- Updated web active surface terminology from `configScopes` to
  `environmentConfigs` while preserving the existing environment config API
  behavior.
- Renamed active execution-log and disablement runtime fields from
  `configScopeId`/`config_scope` to `environmentConfigId`/
  `environment_config`; historical config-scope store/table internals remain
  quarantined behind the environment config adapter.
- Added a Qualys `runtimeConfig` contract to the source-backed five-tool pilot:
  required non-secret config key `QUALYS_VM_URL`, required secret keys
  `QUALYS_USERNAME` and `QUALYS_PASSWORD`.
- Live parity now seeds only `qualys-test_debug` and calls hosted tools with
  an internal hosted-tool binding instead of creating `qualys-live-parity` or
  `qualys-live-demo` environment records.
- Cleaned the local test env active surface:
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env` now has one
  Qualys environment config (`qualys-test_debug`), a migrated
  `qualys-hosted-demo` agent binding shape, and no active
  `allowedConfigScopeIds/defaultConfigScopeId` agent definitions.
- Real Qualys live parity passed on 2026-08-14:
  `live_parity_c1ddc6da-68d5-4f0a-821f-e1d7d426fbc8`, artifact
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env/hosted-integrations/live-parity/live_parity_c1ddc6da-68d5-4f0a-821f-e1d7d426fbc8.json`.
- 3466 is running against the isolated test env with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env`
  and the worktree web dev path.
- Validation run on 2026-08-14:
  `pnpm --filter @openacme/hosted-integrations build`;
  `pnpm --filter @openacme/hosted-integrations test`;
  `pnpm --filter @openacme/server test -- hosted-integrations-routes hosted-integration-live-parity tools-hosted-integrations hosted-integrations-legacy-surface`;
  `pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help`;
  `pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings hosted-integrations-rich-editor`;
  `pnpm --filter @openacme/hosted-integrations check-types`;
  `pnpm --filter @openacme/server check-types`;
  `pnpm --filter web check-types`;
  active-surface `rg` for legacy config-scope names returned no matches.

### Slice 18.7: Storage-Internal Environment Config Rename

Goal:

- Remove the remaining storage-internal `config scope` vocabulary from active
  hosted integration source, tests, service contracts, and DB schema.
- Make environment config the only active package/runtime persistence concept:
  file path `environment-configs`, DB table
  `hosted_integration_environment_configs`, service key `environmentConfigs`,
  factory names, record kind `environment_config`, and secret metadata foreign
  key naming.
- Remove the explicit `/api/hosted-integrations/config-scopes` tombstone routes;
  old URLs receive the platform default 404 instead of being represented in the
  active route table.

Non-goals:

- No migration alias from old config-scope APIs, fields, files, or tables.
- No support for arbitrary environment labels.
- No change to the human/runtime secret ownership model.

TDD:

- `rg` over active package, server, config, db, tool, web, and test source finds
  no `ConfigScope`, `configScopes`, `config-scopes`, `config_scope`,
  `config scope`, `config-scope`, `allowedConfigScopeIds`,
  `defaultConfigScopeId`, `config_scope_id`, or `configScopeId` references
  except historical docs and explicit old-binding rejection fixtures.
- DB schema and DB tests use `hosted_integration_environment_configs` plus
  `environment_config_id`, not `hosted_integration_config_scopes` or
  `scope_id`.
- Service construction exposes only `environmentConfigs`; no
  `service.configScopes` contract remains.
- Secret metadata APIs use `environmentConfigId` naming while still returning no
  raw secret values.
- Legacy `/api/hosted-integrations/config-scopes` routes are not registered as
  explicit tombstones.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- environment-configs db-store store-contract secrets migration hosted-tool-bindings
pnpm --filter @openacme/hosted-integrations test
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/db test -- hosted-integrations
pnpm --filter @openacme/db check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations hosted-integrations-legacy-surface
pnpm --filter @openacme/server check-types
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings hosted-integrations-rich-editor
pnpm --filter web check-types
```

Evidence:

- Validation run on 2026-08-14:
  - `pnpm --filter @openacme/hosted-integrations test -- environment-configs db-store store-contract secrets migration hosted-tool-bindings`
    passed: 6 files, 45 passed, 1 skipped.
  - `pnpm --filter @openacme/hosted-integrations test` passed: 37 files,
    212 passed, 1 skipped.
  - `pnpm --filter @openacme/hosted-integrations build` passed after the
    deleted legacy `config-scopes` dist artifacts were removed.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - `pnpm --filter @openacme/db test -- hosted-integrations` passed: 1 file,
    4 passed.
  - `pnpm --filter @openacme/db check-types` passed.
  - `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations hosted-integrations-legacy-surface`
    passed: 3 files, 55 passed.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings hosted-integrations-rich-editor`
    passed: 3 files, 43 passed.
  - `pnpm --filter web check-types` passed.
- Legacy naming gate passed with no matches across active hosted integration,
  DB, server, config, tool, web source/tests, and
  `packages/hosted-integrations/dist` for:
  `ConfigScope`, `configScope`, `config_scope`, `config-scopes`,
  `config scope`, `scopeId`, `scope_id`,
  `hosted_integration_config_scopes`, `allowedConfigScopeIds`,
  `defaultConfigScopeId`, and `configScopeId`.
- Active source/test references to legacy live environment names were rechecked
  on 2026-08-14 after cleaning a stale web execution-log fixture:
  `qualys-live-parity` and `qualys-live-demo` remain only in negative
  assertions proving live parity no longer creates those configs. The focused
  web admin model validation
  `pnpm --filter web test -- hosted-integrations-admin` passed: 36 passed.
- 3466 restarted against
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env`.
  `/api/hosted-integrations/environment-configs` returned the active
  `qualys-test_debug` environment config with write-only secret metadata, and
  `/api/hosted-integrations/config-scopes` returned the platform default
  `404 Not Found`.

Milestone 18 close-out audit:

- The environment model is narrowed to exactly `prod` and `test_debug`.
- Environment config is the only active package/runtime persistence concept.
- Agent-specific hosted-tool binding state owns allowed/default environment,
  generation pin, binding kind, purpose, note, and audit metadata.
- Active APIs, management tools, Tool Developer guidance, web surfaces, DB
  schema, server runtime, and package contracts use environment config and
  hosted-tool binding terminology.
- Active source/test/dist legacy naming gate has no matches for config-scope
  storage/API/tool/binding identifiers.
- 3466 runs against the isolated hosted-integrations test environment, not the
  local production data dir.

## Milestone 19: Non-Qualys Production Parity Coverage

Status: implementation validated; live target coverage remains credential-gated
where noted below.

Goal:

- Expand production parity beyond the first five Qualys read-only tools without
  weakening the hosted/remote MCP naming boundary.
- Keep every new parity slice family-bounded, read-only, and deterministic
  first; live target-system calls remain optional operator evidence when
  credentials and legacy remote MCP connectivity are configured.
- Preserve the post-Milestone 18 model: parity/debug/dogfood uses internal
  hosted-tool bindings against `test_debug`, not extra environment configs.

### Slice 19.1: Splunk Live-Parity Plumbing

Goal:

- Make the live parity runner family-aware for the first non-Qualys family:
  `splunk/splunk_search`.
- Add Splunk parity case construction from the existing migrated Splunk fixture.
- Seed the hosted Splunk parity target through the same generic fixture
  promotion path as Qualys, writing only the canonical `splunk-test_debug`
  environment config.
- Resolve Splunk runtime config from legacy remote MCP env/config and explicit
  runner overrides using `SPLUNK_BASE_URL` and `SPLUNK_TOKEN`.
- Keep live Splunk parity optional: when the legacy MCP server, Splunk URL, or
  token is missing, the runner returns an explicit skipped result instead of
  failing CI.

Non-goals:

- No destructive Splunk operations.
- No broad Microsoft Graph, MDE, or defender-alert parity in this slice.
- No hidden fallback from hosted tool names to remote MCP names.
- No arbitrary environment config labels.

TDD:

- `defaultSplunkLiveParityCases()` returns the `splunk_search` hosted/legacy
  mapping from the migrated family fixture.
- live parity can run a Splunk case with fake hosted/legacy clients, compares
  result-count summaries, and writes sanitized evidence.
- missing `SPLUNK_BASE_URL` or `SPLUNK_TOKEN` causes a skipped result with
  explicit diagnostics.
- an expired JWT-form `SPLUNK_TOKEN` causes a skipped result before hosted or
  legacy target calls are made.
- seeding a Splunk hosted parity target creates only
  `splunk-test_debug`, stores `SPLUNK_BASE_URL` as non-secret config, stores
  only write-only `SPLUNK_TOKEN` metadata, and does not expose the raw token.
- the existing Qualys parity runner behavior and canonical
  `qualys-test_debug` seeding remain unchanged.
- 3466 remains running against the isolated hosted-integrations test
  environment after the slice.

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integration-live-parity
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/hosted-integrations check-types
curl -sS -m 5 http://127.0.0.1:3466/api/health
```

Evidence:

- Added family-aware live parity plumbing:
  `defaultSplunkLiveParityCases()`, generic hosted parity seeding, Splunk
  runtime config resolution, and `OPENACME_LIVE_PARITY_FAMILY=splunk` operator
  selection.
- The operator script now passes family-native shell env overrides into the
  existing runner `familyConfig`/`familySecrets` ports, so a refreshed
  `SPLUNK_TOKEN`, `SPLUNK_BASE_URL`, `MSGRAPH_*`, `MDE_*`, `DEFENDER_*`, or
  `QUALYS_*` value can override stale legacy MCP env without editing `mcp.json`.
- The Splunk migrated fixture now reads the declared runtime contract keys
  `SPLUNK_BASE_URL` and `SPLUNK_TOKEN` instead of lower-case fixture-only keys.
- Deterministic validation on 2026-08-14:
  - `pnpm --filter @openacme/server test -- hosted-integration-live-parity`
    passed: 1 file, 12 passed.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/hosted-integrations build` passed.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement` passed:
    16 passed, 1 skipped.
- Live Splunk parity was attempted with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env`,
  `OPENACME_LEGACY_MCP_DATA_DIR=/Users/alenbohcelyan/.openacme`, and
  `OPENACME_LIVE_PARITY_FAMILY=splunk`.
  The first live attempt proved the hosted Splunk call succeeded and
  seeded only `splunk-test_debug`; the legacy remote MCP call reached Splunk but
  returned `401 call not properly authenticated`. Artifact:
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env/hosted-integrations/live-parity/live_parity_c1b9cb4e-09d3-40f1-a4ee-5aa445cd54b4.json`.
  The artifact was checked for bearer/JWT-like token leakage and did not contain
  one.
- The configured legacy Splunk token was then inspected by expiry metadata only
  and found expired at `2026-08-14T14:57:55.000Z`. The runner now preflights
  JWT-form Splunk token expiry and returns an explicit skipped result before
  target calls:
  `OPENACME_LIVE_PARITY_FAMILY=splunk pnpm --filter @openacme/server integration-hub:parity`
  returned `status: "skipped"` with diagnostic
  `SPLUNK_TOKEN expired at 2026-08-14T14:57:55.000Z`.
- Splunk live parity was re-attempted on 2026-08-14 with
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env`,
  `OPENACME_LEGACY_MCP_DATA_DIR=/Users/alenbohcelyan/.openacme`, and
  `OPENACME_LIVE_PARITY_FAMILY=splunk`; both the isolated test env and
  `~/.openacme/mcp.json` still exposed a `SPLUNK_TOKEN` expiring at
  `2026-08-14T14:57:55.000Z`, so the command again returned `status:
"skipped"` with the same expiry diagnostic before calling hosted or legacy
  targets.
- Splunk skip diagnostics were tightened on 2026-08-14 so credential problems
  also report the non-secret config source. The focused validation
  `pnpm --filter @openacme/server test -- hosted-integration-live-parity` and
  `pnpm --filter @openacme/server check-types` passed. Deterministic coverage
  proves an explicit runner `SPLUNK_TOKEN`/`SPLUNK_BASE_URL` override replaces
  an expired legacy MCP env token before target calls. A live retry with
  `OPENACME_LEGACY_MCP_DATA_DIR=/Users/alenbohcelyan/.openacme` returned
  `status: "skipped"` with
  `SPLUNK_TOKEN expired at 2026-08-14T14:57:55.000Z (source: legacy MCP env)`,
  proving the runner is still seeing the expired legacy MCP env token and not a
  refreshed override.
- The same source-aware missing-credential diagnostics were generalized across
  the live parity runner on 2026-08-14 for Qualys, Microsoft Graph, MDE, and
  defender-alert, without exposing secret values. Focused validation
  `pnpm --filter @openacme/server test -- hosted-integration-live-parity` and
  `pnpm --filter @openacme/server check-types` passed. Operator retries for
  `OPENACME_LIVE_PARITY_FAMILY=mde` and
  `OPENACME_LIVE_PARITY_FAMILY=defender-alert` returned skipped results whose
  missing credential diagnostics explicitly say they checked legacy MCP env,
  runner config override, and runner secret override.
- 3466 health check passed after restart:
  `http://127.0.0.1:3466/api/health`. The isolated test env now contains the
  expected canonical environment configs `qualys-test_debug` and
  `splunk-test_debug`.

### Slice 19.2: Source-Backed Parity Eligibility Guardrail

Goal:

- Prevent operator live parity from implying that generated placeholder
  migrated families are production-parity ready.
- Make live parity family selection explicit: only source-backed parity
  families are selectable by the operator command.
- Return an explicit skipped result for unsupported families instead of
  throwing a generic script error or attempting fake hosted/legacy comparison.

Non-goals:

- No Microsoft Graph, MDE, or defender-alert source port in this slice.
- No target-system network calls for unsupported families.
- No deletion of generated migration fixtures; they remain useful for migration
  shape validation.

TDD:

- `defaultLiveParityCasesForFamily("qualys")` returns the Qualys cases.
- `defaultLiveParityCasesForFamily("splunk")` returns the Splunk cases.
- `defaultLiveParityCasesForFamily("msgraph" | "mde" | "defender-alert")`
  returns a source-backed eligibility diagnostic and no cases.
- `OPENACME_LIVE_PARITY_FAMILY=<unsupported>` prints a skipped live parity
  result and exits successfully, with no hosted or legacy calls.
- 3466 remains running against the isolated hosted-integrations test
  environment after the slice.

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integration-live-parity
pnpm --filter @openacme/server check-types
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=msgraph pnpm --filter @openacme/server integration-hub:parity
curl -sS -m 5 http://127.0.0.1:3466/api/health
```

Evidence:

- Added canonical live parity family selection through
  `defaultLiveParityCasesForFamily()`. Source-backed live parity is currently
  eligible only for `qualys` and `splunk`.
- Updated the operator parity script so unsupported families such as `msgraph`
  return a structured skipped result instead of throwing or attempting generated
  placeholder parity.
- Deterministic validation on 2026-08-14:
  - `pnpm --filter @openacme/server test -- hosted-integration-live-parity`
    passed: 1 file, 13 passed.
  - `pnpm --filter @openacme/server check-types` passed.
  - `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=msgraph pnpm --filter @openacme/server integration-hub:parity`
    returned `status: "skipped"` with diagnostic
    `live parity family 'msgraph' is not source-backed yet; supported families: qualys, splunk`.
  - `curl -sS -m 5 http://127.0.0.1:3466/api/health` passed.

### Slice 19.3: Microsoft Graph GET Source-Backed Port

Goal:

- Replace the generated placeholder `msgraph/msgraph_get` fixture with a
  source-backed hosted implementation ported from the legacy
  `integration_hub/integrations/msgraph` GET wrapper.
- Preserve the read-only boundary: this slice ports only `msgraph_get` and does
  not expose `run_hunting_query` or any generic POST path.
- Use hosted runtime config and secrets only:
  `MSGRAPH_TENANT_ID`, `MSGRAPH_CLIENT_ID`, optional
  `MSGRAPH_TIMEOUT_SECONDS`, optional `MSGRAPH_MAX_PAGES`, optional
  `MSGRAPH_API_VERSION`, and write-only `MSGRAPH_CLIENT_SECRET`.
- Reject absolute URLs outside `graph.microsoft.com` before token acquisition
  or target-system network calls.
- Make the live parity selector eligible for `msgraph` only after the
  source-backed fixture is in place; live runs still skip explicitly when
  credentials are absent.

Non-goals:

- No `msgraph_run_hunting_query` in this slice.
- No Microsoft Defender for Endpoint or defender-alert source port.
- No write or mutation Graph operations.
- No live Graph pass requirement when tenant credentials or permissions are not
  configured.

TDD:

- migrated security fixtures still list `msgraph`, but its source file is no
  longer the generated placeholder and contains a deterministic
  `tool_msgraph_get(args, context)` handler.
- the `msgraph_get` manifest input schema requires `path`, accepts optional
  `params` and `api_version`, and rejects additional properties.
- invoking `msgraph_get` with an absolute non-Graph URL fails with
  `bad_arguments` before auth/token or Graph network code.
- missing Microsoft Graph runtime config fails with a normalized missing-config
  error and does not read process env directly.
- `defaultLiveParityCasesForFamily("msgraph")` returns a source-backed
  `msgraph_get` parity case once the fixture is ported.
- `OPENACME_LIVE_PARITY_FAMILY=msgraph` returns skipped diagnostics when
  Microsoft Graph credentials are missing instead of attempting placeholder
  parity.
- 3466 remains running against the isolated hosted-integrations test
  environment after the slice.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server test -- hosted-integration-live-parity
pnpm --filter @openacme/server check-types
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=msgraph pnpm --filter @openacme/server integration-hub:parity
curl -sS -m 5 http://127.0.0.1:3466/api/health
```

Evidence:

- Replaced the generated Microsoft Graph placeholder fixture with
  `LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY`.
  The fixture exposes only `msgraph_get`, uses derived
  `tool_msgraph_get(args, context)` dispatch, declares runtime config
  `MSGRAPH_TENANT_ID` and `MSGRAPH_CLIENT_ID`, declares write-only
  `MSGRAPH_CLIENT_SECRET`, and keeps optional runtime tuning keys at family
  level: `MSGRAPH_TIMEOUT_SECONDS`, `MSGRAPH_MAX_PAGES`, and
  `MSGRAPH_API_VERSION`.
- The hosted Python implementation reads config/secrets only from runtime
  context, not process env, validates absolute URL hosts before token exchange,
  rejects non-`graph.microsoft.com` absolute URLs with `bad_arguments`, and
  ports the legacy GET pagination shape for collection responses.
- Updated live parity source-backed eligibility so `msgraph` is selectable with
  default `msgraph_get` service-root args. The default Graph parity path is `/`
  because the configured tenant credentials can fetch the Graph service root
  without directory read permissions; `/organization` and `/users` both reached
  Graph from hosted and legacy clients but returned Graph `403
Authorization_RequestDenied`.
- Deterministic validation on 2026-08-14:
  - `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement` passed:
    18 passed, 1 skipped.
  - `pnpm --filter @openacme/hosted-integrations build` passed.
  - `pnpm --filter @openacme/server test -- hosted-integration-live-parity`
    passed: 14 passed.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - `pnpm --filter @openacme/server check-types` passed.
- Live Microsoft Graph parity on 2026-08-14:
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=msgraph pnpm --filter @openacme/server integration-hub:parity`
  returned `status: "pass"` with one `match` case. Hosted and legacy summaries
  matched: `resultCount: 72`, `pagesFetched: 1`, `truncated: false`,
  `payloadKind: "object"`. Artifact:
  `/Users/alenbohcelyan/.openamce-hosted-integrations-test-env/hosted-integrations/live-parity/live_parity_9ff86d05-0f4f-438e-8399-0d4fa086b7de.json`.
  The artifact was checked for `Bearer`, `access_token`, `client_secret`, and
  `MSGRAPH_CLIENT_SECRET` markers; none were present.
- 3466 health check passed after validation:
  `http://127.0.0.1:3466/api/health`.

### Slice 19.4: MDE GET Source-Backed Port

Goal:

- Replace the generated placeholder `mde/mde_get` fixture with a
  source-backed hosted implementation ported from the legacy
  `integration_hub/integrations/mde` generic GET wrapper.
- Preserve the read-only boundary: this slice ports only `mde_get` and does
  not expose `mde_list_machines`, `mde_get_logon_users`, or any mutation path.
- Use hosted runtime config and secrets only:
  `MDE_TENANT_ID`, `MDE_CLIENT_ID`, optional `MDE_TIMEOUT_SECONDS`, optional
  `MDE_MAX_PAGES`, and write-only `MDE_CLIENT_SECRET`.
- Do not carry over the legacy `MSGRAPH_*` credential fallback. Hosted
  families must keep their runtime config contract explicit per family, so MDE
  live parity skips when `MDE_*` credentials are absent.
- Reject absolute URLs outside
  `https://api.securitycenter.microsoft.com/api` before token acquisition or
  target-system network calls.
- Make the live parity selector eligible for `mde` only after the source-backed
  fixture is in place; live runs still skip explicitly when MDE credentials are
  absent.

Non-goals:

- No `mde_list_machines` or `mde_get_logon_users` dedicated hosted tools in
  this slice.
- No defender-alert source port.
- No Graph credential fallback, Graph token reuse, or cross-family config
  aliasing.
- No write or mutation Defender for Endpoint operations.
- No live MDE pass requirement when tenant credentials or WindowsDefenderATP
  permissions are not configured.

TDD:

- migrated security fixtures still list `mde`, but its source file is no
  longer the generated placeholder and contains a deterministic
  `tool_mde_get(args, context)` handler.
- the `mde_get` manifest input schema requires `path`, accepts optional
  `params`, and rejects additional properties.
- invoking `mde_get` with an absolute non-MDE URL fails with `bad_arguments`
  before auth/token or MDE network code.
- missing MDE runtime config fails with a normalized missing-config error and
  does not read process env or `MSGRAPH_*` fallback keys.
- `defaultLiveParityCasesForFamily("mde")` returns a source-backed `mde_get`
  parity case once the fixture is ported.
- `OPENACME_LIVE_PARITY_FAMILY=mde` returns skipped diagnostics when MDE
  credentials are missing instead of attempting placeholder parity.
- 3466 remains running against the isolated hosted-integrations test
  environment after the slice.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server test -- hosted-integration-live-parity
pnpm --filter @openacme/server check-types
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=mde pnpm --filter @openacme/server integration-hub:parity
curl -sS -m 5 http://127.0.0.1:3466/api/health
```

Evidence:

- Replaced the generated MDE placeholder fixture with
  `LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY`. The fixture exposes only
  `mde_get`, uses derived `tool_mde_get(args, context)` dispatch, declares
  runtime config `MDE_TENANT_ID` and `MDE_CLIENT_ID`, declares write-only
  `MDE_CLIENT_SECRET`, and keeps optional runtime tuning keys at family level:
  `MDE_TIMEOUT_SECONDS` and `MDE_MAX_PAGES`.
- The hosted Python implementation reads config/secrets only from runtime
  context, does not contain `MSGRAPH_*` fallback keys, validates absolute URL
  prefixes before token exchange, rejects non-MDE absolute URLs with
  `bad_arguments`, and ports the legacy GET pagination shape for collection
  responses.
- Updated live parity source-backed eligibility so `mde` is selectable with
  default `mde_get` args `{ "path": "/machines", "params": { "$top": "1" } }`.
  The live runner intentionally requires `MDE_*` credentials and does not use
  Graph credentials as aliases.
- Deterministic validation on 2026-08-14:
  - `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement` passed:
    20 passed, 1 skipped.
  - `pnpm --filter @openacme/hosted-integrations build` passed.
  - `pnpm --filter @openacme/server test -- hosted-integration-live-parity`
    passed: 15 passed.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - `pnpm --filter @openacme/server check-types` passed.
- Live MDE parity on 2026-08-14:
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=mde pnpm --filter @openacme/server integration-hub:parity`
  returned `status: "skipped"` with diagnostics
  `MDE_TENANT_ID is not configured (checked legacy MCP env, runner config
override, runner secret override)`, `MDE_CLIENT_ID is not configured (checked
legacy MCP env, runner config override, runner secret override)`, and
  `MDE_CLIENT_SECRET is not configured (checked legacy MCP env, runner config
override, runner secret override)`. This is the expected operator result until
  MDE-specific credentials are configured.
- 3466 health check passed after validation:
  `http://127.0.0.1:3466/api/health`.

### Slice 19.5: Defender Alert GET Source-Backed Port

Goal:

- Correct the generated defender-alert migration target from the invented
  `defender_alert_search` placeholder to the legacy source-backed
  `defender_alert_get` tool.
- Port the legacy cross-API alert lookup as one deterministic hosted tool:
  `tool_defender_alert_get(args, context)`.
- Preserve the read-only orchestration boundary: fetch the Graph
  `/security/alerts_v2/{graph_alert_id}` payload, then best-effort fetch the
  matching MDE `/alerts/{graph_alert_id}` payload, returning both raw sides
  without merging, correlation logic, interpretation, or mutation.
- Use explicit defender-alert family runtime config and secrets only:
  `DEFENDER_TENANT_ID`, `DEFENDER_CLIENT_ID`, optional
  `DEFENDER_TIMEOUT_SECONDS`, and write-only `DEFENDER_CLIENT_SECRET`.
  The hosted family must not read `MSGRAPH_*` or `MDE_*` values as aliases.
- Make the MDE side non-fatal, matching legacy behavior: if Graph lookup
  succeeds but MDE lookup fails or does not find the alert, return the Graph
  result with a clear `mde_status`.
- Make the live parity selector eligible for `defender-alert` only after the
  source-backed fixture is in place; live runs still skip explicitly when
  defender-alert credentials are absent.

Non-goals:

- No `defender_alert_search` compatibility alias.
- No alert search/list tool in this slice.
- No use of existing `msgraph` or `mde` family environment configs or secrets.
- No write or mutation Graph/MDE operations.
- No live defender-alert pass requirement when credentials, alert IDs, or
  required permissions are not configured.

TDD:

- migrated security fixtures still list `defender-alert`, but its migrated tool
  name is `defender_alert_get`, not `defender_alert_search`.
- the defender-alert source file is no longer the generated placeholder and
  contains a deterministic `tool_defender_alert_get(args, context)` handler.
- the `defender_alert_get` manifest input schema requires `graph_alert_id` and
  rejects additional properties.
- missing `graph_alert_id` fails with `bad_arguments`.
- missing defender-alert runtime config fails with a normalized missing-config
  error and does not read process env, `MSGRAPH_*`, or `MDE_*` fallback keys.
- `defaultLiveParityCasesForFamily("defender-alert")` returns a source-backed
  `defender_alert_get` parity case once the fixture is ported.
- `OPENACME_LIVE_PARITY_FAMILY=defender-alert` returns skipped diagnostics when
  defender-alert credentials are missing instead of attempting placeholder
  parity.
- 3466 remains running against the isolated hosted-integrations test
  environment after the slice.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server test -- hosted-integration-live-parity
pnpm --filter @openacme/server check-types
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=defender-alert pnpm --filter @openacme/server integration-hub:parity
curl -sS -m 5 http://127.0.0.1:3466/api/health
```

Evidence:

- Corrected the active defender-alert migration contract from
  `defender_alert_search` to the source-backed legacy tool
  `defender_alert_get`. No compatibility alias was added.
- Replaced the generated defender-alert placeholder fixture with
  `LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY`. The fixture
  exposes only `defender_alert_get`, uses derived
  `tool_defender_alert_get(args, context)` dispatch, declares runtime config
  `DEFENDER_TENANT_ID` and `DEFENDER_CLIENT_ID`, declares write-only
  `DEFENDER_CLIENT_SECRET`, and keeps optional runtime tuning
  `DEFENDER_TIMEOUT_SECONDS` at family level.
- The hosted Python implementation reads config/secrets only from runtime
  context, does not contain `MSGRAPH_*` or `MDE_*` fallback keys, fetches Graph
  `/security/alerts_v2/{graph_alert_id}` as the required side, and fetches MDE
  `/alerts/{graph_alert_id}` as a best-effort side reported through
  `mde_status`.
- Deterministic validation on 2026-08-14:
  - `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement` passed:
    22 passed, 1 skipped.
  - `pnpm --filter @openacme/hosted-integrations build` passed.
  - `pnpm --filter @openacme/server test -- hosted-integration-live-parity`
    passed: 16 passed.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - `pnpm --filter @openacme/server check-types` passed.
- Live defender-alert parity on 2026-08-14:
  `OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env OPENACME_LIVE_PARITY_FAMILY=defender-alert pnpm --filter @openacme/server integration-hub:parity`
  returned `status: "skipped"` with diagnostics
  `DEFENDER_TENANT_ID is not configured (checked legacy MCP env, runner config
override, runner secret override)`, `DEFENDER_CLIENT_ID is not configured
(checked legacy MCP env, runner config override, runner secret override)`, and
  `DEFENDER_CLIENT_SECRET is not configured (checked legacy MCP env, runner
config override, runner secret override)`. This is the expected operator
  result until defender-alert-specific credentials and a real alert id are
  configured.
- 3466 health check passed after validation:
  `http://127.0.0.1:3466/api/health`.

### Milestone 19 Source-Backed Parity Audit

Evidence:

- Active source-backed live parity families are now `qualys`, `splunk`,
  `msgraph`, `mde`, and `defender-alert`.
- Non-Qualys generated placeholders were replaced with source-backed fixtures
  for `msgraph_get`, `mde_get`, and `defender_alert_get`. The only remaining
  `buildMigratedFamilyFixture("qualys", ...)` use in the migrated security
  family list is the broad Qualys migration shape fixture; the live-parity
  Qualys batch continues to use
  `LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY`.
- Active code/test references to the incorrect `defender_alert_search` target
  were removed. A repo scan on 2026-08-14 found only historical plan notes and
  one negative assertion proving the migrated defender-alert tool name is not
  `defender_alert_search`.
- Focused audit validation on 2026-08-14:
  - `pnpm --filter @openacme/hosted-integrations test -- naming migration`
    passed: 27 passed, 1 skipped.
  - `curl -sS -m 5 http://127.0.0.1:3466/api/health` passed.
- Broader focused validation on 2026-08-14:
  - `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement validation python-runtime readiness environment-configs hosted-tool-bindings help source-view generation-diff db-store store-contract naming`
    passed: 106 passed, 1 skipped.
  - `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations hosted-integration-live-parity hosted-integrations-legacy-surface runtime`
    passed: 80 passed.
  - `pnpm --filter web test -- hosted-integration-agent-settings hosted-integrations-admin hosted-integrations-rich-editor`
    passed: 43 passed.
  - `pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help`
    passed: 15 passed.
  - `pnpm --filter @openacme/hosted-integrations check-types`,
    `pnpm --filter @openacme/server check-types`,
    `pnpm --filter @openacme/tools check-types`, and
    `pnpm --filter web check-types` passed.
- 3466 runtime smoke on 2026-08-14:
  - Source-only active generations were seeded into the isolated test env for
    `mde` and `defender-alert` without writing runtime credentials, so their
    tool definitions are visible while invocation remains blocked until
    environment configs are provided.
  - `GET /api/hosted-integrations/families` returned active family ids including
    `defender-alert`, `mde`, `msgraph`, `qualys`, and `splunk`.
  - `GET /api/tools` returned 16 hosted tools and included
    `hosted_mde__mde_get`, `hosted_defender-alert__defender_alert_get`, and
    `hosted_msgraph__msgraph_get`; `hosted_tool_help` was also present.
  - `curl -sS -m 5 http://127.0.0.1:3466/api/health` returned
    `{"status":"ok","version":"0.14.0","agents":3,"skills":3}`.
- Live parity credential status after the source-backed ports:
  - `msgraph` passes against live Graph service-root parity.
  - `splunk` still skips because the configured JWT token is expired at
    `2026-08-14T14:57:55.000Z`; current diagnostics identify the source as
    legacy MCP env.
  - `mde` skips until `MDE_*` credentials are configured; diagnostics confirm
    legacy MCP env, runner config override, and runner secret override were
    checked.
  - `defender-alert` skips until `DEFENDER_*` credentials and a real alert id
    are configured; diagnostics confirm legacy MCP env, runner config override,
    and runner secret override were checked.

## Milestone 20: Rectification - Offline Parity/Test-Input Boundary

Status: validated.

Goal:

- Remove hosted integration legacy conversion/replacement behavior from product runtime,
  API, management-tool, and package root-export surfaces.
- Keep useful operator/test workflows that seed hosted replacement tools, read
  legacy integration-hub definitions/configs as test inputs, and run live
  parity, but place them outside the runtime control plane and make them write
  through normal source/generation store or API boundaries.
- Prevent future slices from treating integration-hub replacement as a built-in
  hosted integration lifecycle state.
- Preserve DB schema migrations as normal infrastructure work; this milestone
  concerns legacy integration-hub replacement/parity logic, not database DDL.

Contract:

- `@openacme/hosted-integrations` root exports must not export
  integration-hub inventories, generated replacement fixtures, or cutover helper
  APIs.
- Runtime package source must not contain generated legacy integration-hub tool
  source, replacement inventories, or live-parity fixture catalogs.
- Product readiness has five kinds only:
  `environment_config`, `binding`, `publish`, `debug`, and `invocation`.
- There is no `resolveMigrationReadiness`, no product readiness route for
  legacy integration-hub migration/import, and no
  `hosted_tool_readiness_get` target_type of legacy migration/import.
  Removed legacy URLs may have explicit 404 tombstones to avoid SPA fallback
  ambiguity; those tombstones must not return readiness payloads.
- Offline parity/replacement tooling may keep replacement metadata such as
  `hosted_<family>__<tool> replaces mcp_integration-hub__<tool>`, but that
  metadata is operational evidence only. It is not an authorization alias, not a
  readiness state, and not a product lifecycle operation.
- Test scripts and operator scripts may create sample hosted tools, read legacy
  integration-hub tool/config definitions, and execute live parity against real
  providers. They must be clearly outside runtime app modules and must not
  create a second lifecycle implementation.
- Management tools, API handlers, runtime dispatch, bundled skills, UI, and
  agent settings must describe parity/replacement work as offline/operator
  workflow when needed, not as a hosted tool lifecycle capability.

### Slice 20.1: Remove Product Migration Readiness Surface

Status: validated.

Goal:

- Delete the product-facing migration readiness resolver, HTTP route, runtime
  management-tool case, management-tool schema target, skill wording, and tests.
- Add negative coverage proving the old route/target is rejected instead of
  silently preserved as compatibility.

Non-goals:

- No relocation of integration-hub conversion fixtures in this slice.
- No live parity rewrite in this slice.
- No UI redesign.

TDD:

- Readiness resolver tests enumerate only the five product readiness kinds.
- Route tests prove `/api/hosted-integrations/readiness/migration` returns the
  platform's normal not-found response.
- Management-tool tests prove
  `hosted_tool_readiness_get({ target_type: "migration" })` is rejected
  before invoking the bound control-plane port.
- Runtime management-tool tests prove migration readiness cannot be requested
  through the server port.
- Skill/reference scans prove active Tool Developer guidance no longer teaches
  migration readiness.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- readiness
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/tools check-types
rg -n "readiness/migration|resolveMigrationReadiness|target_type.*migration|migration readiness" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin packages/hosted-integrations/test packages/server/test packages/tools/test
```

Evidence on 2026-08-15:

- Removed the product legacy conversion/replacement readiness kind and
  `resolveMigrationReadiness` from the hosted integration readiness resolver and
  package readiness exports.
- Removed the management-tool schema target for legacy migration/import
  readiness and updated `hosted_tool_readiness_get` wording to the five
  product readiness targets.
- Added direct management-tool argument parsing so invalid management tool
  params are rejected before the bound control-plane port is invoked, even when
  a test or local caller uses the raw handler rather than registry dispatch.
- Removed the server runtime readiness case for legacy migration/import and
  added an explicit 404 tombstone for the removed readiness URL to prevent SPA
  fallback from returning 200.
- Updated Tool Developer skill wording so it no longer teaches migration
  readiness as a platform capability.
- Focused validation passed:
  - `pnpm --filter @openacme/hosted-integrations test -- readiness`: 6 passed.
  - `pnpm --filter @openacme/tools test -- hosted-integration-management`: 11
    passed.
  - `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations`:
    52 passed.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/tools check-types` passed.
  - Active source/test scan returned no matches:
    `rg -n "readiness/migration|resolveMigrationReadiness|target_type.*migration|migration readiness" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin packages/hosted-integrations/test packages/server/test packages/tools/test`.

### Slice 20.2: Move Integration-Hub Conversion Fixtures Out Of Runtime

Status: validated.

Goal:

- Move legacy integration-hub inventories, replacement fixture builders, and
  generated source-backed fixture catalogs out of `packages/hosted-integrations/src`
  runtime package
  modules.
- Keep deterministic tests and operator scripts that create hosted replacement
  tools for dogfood/parity.
- Remove integration-hub replacement fixture exports from
  `@openacme/hosted-integrations`.

Implementation decisions:

- The replacement fixture home is
  `packages/hosted-integrations/test-support/integration-hub/`.
- Test-support modules are not package root exports and are not included in the
  runtime package `files`.
- Product runtime code must not import from test-support modules.
- Rename active test command/language from generic `migration` to
  `integration-hub-replacement` where practical.
- No backward-compatible aliases from old `migration.ts` exports.

Non-goals:

- No deletion of the legacy integration-hub source or remote MCP setup.
- No backward-compatible package export aliases for moved replacement helpers.
- No new product API route for cutover.

TDD:

- Package export tests prove no legacy integration-hub replacement symbol is
  exported from `@openacme/hosted-integrations`.
- Source scans prove runtime `packages/hosted-integrations/src` contains no
  integration-hub replacement inventories or generated legacy tool source.
- Replacement tests load fixtures from explicit test-support/operator modules,
  not package root exports.
- Live parity tests consume explicit operator/test-support fixture modules or
  active hosted generations, not app runtime exports.

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement naming
pnpm --filter @openacme/hosted-integrations check-types
rg -n "LEGACY_INTEGRATION_HUB|legacy-qualys-source|migration\\.js" packages/hosted-integrations/src packages/hosted-integrations/package.json
```

Evidence on 2026-08-15:

- Moved integration-hub replacement fixtures and source-backed Qualys fixture
  code from `packages/hosted-integrations/src` to
  `packages/hosted-integrations/test-support/integration-hub`.
- Removed legacy replacement fixture exports from
  `@openacme/hosted-integrations` package root.
- Renamed the active package conversion test file to
  `integration-hub-replacement.test.ts` and updated tests to import replacement
  fixtures from test-support directly.
- Focused validation passed:
  - `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement naming`:
    27 passed, 1 skipped.
  - `pnpm --filter @openacme/hosted-integrations check-types` passed.
  - Runtime source scan returned no matches:
    `rg -n "LEGACY_INTEGRATION_HUB|legacy-qualys-source|migration\\.js" packages/hosted-integrations/src packages/hosted-integrations/package.json`.

### Slice 20.3: Move Live Parity Out Of Server Runtime Source

Status: validated.

Goal:

- Move live parity runner code out of `packages/server/src`.
- Keep `packages/server/scripts/integration-hub-parity.ts` as the operator
  entrypoint.
- Make operator parity code depend on explicit operator/test-support imports,
  not runtime package exports.

Implementation decisions:

- The new operator runner home is
  `packages/server/test-support/integration-hub/`.
- `packages/server/scripts/integration-hub-parity.ts` imports from
  `../test-support/integration-hub/...`.
- Add `packages/server/tsconfig.operator.json` covering
  `scripts/**/*.ts`, `operator/**/*.ts`, and the hosted integration
  test-support fixture modules it imports.
- Add package script `check-types:operator`.
- Server runtime `src` must not import live parity or legacy conversion
  fixtures.

Non-goals:

- No automatic agent setting rewrite.
- No hidden remote MCP to hosted tool alias.
- No default cache behavior.

TDD:

- Server runtime scan proves `packages/server/src` has no
  `LEGACY_INTEGRATION_HUB`, `integration-hub-parity`, or
  `hosted-integration-live-parity` implementation imports.
- Script/test-support typecheck proves scripts/operator code remains typed after moving
  out of `src`.
- Live parity tests import the operator runner directly and still cover
  sanitized evidence, env override precedence, skipped credential diagnostics,
  and source-backed family selection.
- Negative tests prove no public API or management tool exposes operator
  parity/replacement execution.

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integration-live-parity hosted-integrations-legacy-surface
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/server check-types:operator
rg -n "LEGACY_INTEGRATION_HUB|integration-hub-parity|hosted-integration-live-parity" packages/server/src
```

Evidence on 2026-08-15:

- Moved the live parity runner from `packages/server/src` to
  `packages/server/test-support/integration-hub`.
- Updated `packages/server/scripts/integration-hub-parity.ts` and live parity
  tests to import the operator runner directly.
- Added `packages/server/tsconfig.operator.json` and
  `pnpm --filter @openacme/server check-types:operator` to typecheck
  scripts/test-support code outside runtime `src`.
- Focused validation passed:
  - `pnpm --filter @openacme/server test -- hosted-integration-live-parity hosted-integrations-legacy-surface`:
    21 passed.
  - `pnpm --filter @openacme/server check-types` passed.
  - `pnpm --filter @openacme/server check-types:operator` passed.
  - Server runtime source scan returned no matches:
    `rg -n "LEGACY_INTEGRATION_HUB|integration-hub-parity|hosted-integration-live-parity" packages/server/src`.

### Slice 20.4: Operator Parity And Live Parity Dogfood

Status: validated.

Goal:

- Prove operator parity/replacement still works against the isolated test
  environment after runtime cleanup.
- Seed the selected read-only tools through normal hosted integration
  service/API/store boundaries.
- Run live parity without product runtime conversion code.

Implementation decisions:

- Operator parity/replacement may use test-support fixtures and real provider
  credentials.
- It must write hosted integration source/generation records through the
  hosted integration service or API boundary.
- It must not create product routes, management tools, readiness states, or
  hidden MCP aliases.
- Evidence must remain sanitized: no bearer tokens, passwords, client secrets,
  raw credentials, or unmasked provider payloads.

TDD:

- Operator script test proves seeded tools appear as hosted generations and
  hosted registry tools.
- Live parity test proves runner can execute from seeded/active hosted
  generations.
- Sanitization test scans parity artifacts for known secret markers.
- Boundary scan proves no product route/tool/schema/skill advertises
  integration-hub replacement operations, migration readiness, or cutover.

Validation:

```text
OPENACME_DATA_DIR=/Users/alenbohcelyan/.openamce-hosted-integrations-test-env pnpm --filter @openacme/server integration-hub:parity
curl -sS -m 5 http://127.0.0.1:3466/api/health
rg -n "integration-hub replacement operation|migration readiness|readiness/migration|resolveMigrationReadiness|target_type.*migration" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin apps/web/app
```

Evidence on 2026-08-15:

- Live Qualys parity ran through the operator script against the isolated test
  environment and passed five read-only cases with
  `live_parity_dbda7b87-fa48-4198-b082-a45089e42ade`.
- 3466 health check returned
  `{"status":"ok","version":"0.14.0","agents":3,"skills":3}`.
- The new live parity artifact was scanned for `Bearer`, `access_token`,
  `client_secret`, `MSGRAPH_CLIENT_SECRET`, `QUALYS_PASSWORD`,
  `QUALYS_USERNAME`, `SPLUNK_TOKEN`, `raw-secret`, and `password`; no matches
  were found.
- Product surface scan returned no matches:
  `rg -n "integration-hub replacement operation|migration readiness|readiness/migration|resolveMigrationReadiness|target_type.*migration" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin apps/web/app`.

## Milestone 21: Historical Plan Hygiene And Artifact Boundary

Status: validated.

Goal:

- Make historical milestones clearly historical so future implementation does
  not resurrect superseded config-scope, migration-readiness, generated-source,
  or cutover-alias designs.
- Rename active integration-hub conversion test-support language from
  `migration/migrated` to `replacement/parity/reference` where it is not database DDL.
- Prove runtime build output cannot retain stale deleted files such as old
  package migration modules.
- Typecheck operator/test-support code explicitly while keeping it outside
  runtime package exports.
- Confirm hosted integration lifecycle guidance uses Tool Developer naming, not
  a generic engineering maintainer persona.

Contract:

- Historical plan sections may mention old decisions only as evidence and must
  state when the decision is superseded.
- Active test and operator names should say integration-hub replacement/parity,
  not migration/import lifecycle.
- `packages/hosted-integrations/dist` is disposable build output. A package
  build must remove stale files before emitting fresh runtime artifacts.
- `packages/hosted-integrations/test-support/**` may import package `src` for
  tests/operator workflows, but runtime `src` must not import test-support.
- `@openacme/hosted-integrations` root exports remain runtime/API contract
  only; no integration-hub replacement fixtures or generated legacy source
  exports.

### Slice 21.1: Historical Vs Active Contract Marking

Status: validated.

Goal:

- Add a current canonical contract summary near the top of this plan.
- Mark Milestone 10 as historical/superseded and point readers to Milestones
  18, 20, and 21 for active behavior.
- Avoid leaving old command names that imply active migration lifecycle work.

TDD:

- document scan rejects old migration-focused hosted-integrations test command
  and old migration test filename references
- document scan keeps current final acceptance commands on
  `integration-hub-replacement`
- current canonical contract names environment configs, hosted/MCP separation,
  offline parity/test-input boundaries, and Tool Developer

Validation:

```text
rg -n "test -- migratio[n]|test/migratio[n]\\.test\\.ts" docs/hosted-integrations-implementation-plan.md
rg -n "Current Canonical Contract|Milestone 10: Legacy Integration-Hub Migration|Milestone 21: Historical Plan Hygiene" docs/hosted-integrations-implementation-plan.md
```

Evidence on 2026-08-15:

- Added the current canonical contract summary near the top of this plan.
- Marked Milestone 10 as historical/superseded and pointed future work to the
  current Milestone 18+20+21 contract.
- Removed stale hosted-integrations test command/file references from the plan.
- Validation scans passed: no old migration test command or old migration test
  filename references remain; canonical contract markers are present.

### Slice 21.2: Legacy Replacement Terminology Cleanup

Status: validated.

Goal:

- Rename active integration-hub test-support and operator fixtures from
  migration/migrated/imported terminology to replacement/parity/reference
  terminology.
- Keep database migration terminology and TypeScript import statements
  untouched outside this legacy integration-hub replacement context.

TDD:

- active integration-hub replacement tests compile using `Replacement` symbol
  names
- focused tests pass with `integration-hub-replacement`
- active replacement/test-support/operator files contain no
  `migration/migrated/imported` terminology

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement naming
rg -n "migration|Migration|migrated|Migrated|MIGRATED|imported|Imported|IMPORTED" packages/hosted-integrations/test/integration-hub-replacement.test.ts packages/hosted-integrations/test-support/integration-hub packages/server/test-support/integration-hub packages/server/test/hosted-integration-live-parity.test.ts packages/server/test/tools-hosted-integrations.test.ts
```

Evidence on 2026-08-15:

- Renamed active integration-hub fixture/test terminology to
  replacement/parity/reference symbols.
- `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement naming`
  passed: 27 passed, 1 skipped.
- Active replacement/test-support/operator terminology scan returned no matches.

### Slice 21.3: Build Artifact Boundary And Clean Build Proof

Status: validated.

Goal:

- Make the hosted-integrations package build remove stale `dist` output before
  compiling.
- Prove removed runtime files do not survive as stale JavaScript or sourcemap
  artifacts.

TDD:

- `pnpm --filter @openacme/hosted-integrations build` succeeds from a dirty
  `dist`
- runtime artifact scan finds no legacy integration-hub fixture names or stale
  migration module output in `dist`

Validation:

```text
pnpm --filter @openacme/hosted-integrations build
rg -n "LEGACY_INTEGRATION_HUB|legacy-qualys-source|migration\\.js" packages/hosted-integrations/src packages/hosted-integrations/package.json packages/hosted-integrations/dist
```

Evidence on 2026-08-15:

- Updated hosted-integrations package build to remove `dist` before compiling.
- `pnpm --filter @openacme/hosted-integrations build` passed.
- Runtime artifact scan returned no matches across package `src`,
  `package.json`, and freshly emitted `dist`.

### Slice 21.4: Operator And Test-Support Typecheck Boundary

Status: validated.

Goal:

- Add an explicit hosted-integrations test-support typecheck.
- Keep server script/test-support typecheck as the owner for parity scripts outside
  runtime `src`.

TDD:

- `check-types:test-support` typechecks hosted integration `test-support`
  modules without adding them to package root exports
- server script/test-support typecheck still covers integration-hub parity code
- runtime source scans prove no server or hosted runtime imports operator/test
  support conversion modules

Validation:

```text
pnpm --filter @openacme/hosted-integrations check-types:test-support
pnpm --filter @openacme/server check-types:operator
rg -n "LEGACY_INTEGRATION_HUB|legacy-qualys-source|migration\\.js" packages/hosted-integrations/src packages/hosted-integrations/package.json packages/hosted-integrations/dist
rg -n "LEGACY_INTEGRATION_HUB|integration-hub-parity|hosted-integration-live-parity" packages/server/src
```

Evidence on 2026-08-15:

- Added `packages/hosted-integrations/tsconfig.test-support.json`.
- Added `pnpm --filter @openacme/hosted-integrations check-types:test-support`.
- `pnpm --filter @openacme/hosted-integrations check-types:test-support`
  passed.
- `pnpm --filter @openacme/server check-types:operator` passed.
- Hosted runtime and server runtime boundary scans returned no matches.

### Slice 21.5: Role Naming Boundary Audit

Status: validated.

Goal:

- Confirm hosted integration lifecycle docs, skills, and seeded agent
  templates use Tool Developer as the maintainer persona.
- Avoid introducing a generic engineering maintainer role into the hosted
  integration lifecycle.

TDD:

- role scan over hosted integration docs/skills/templates finds no generic
  engineering maintainer wording in the hosted lifecycle
- package/server/tools/web focused acceptance still passes after wording
  changes

Validation:

```text
rg -n "Software Enginee[r]|software enginee[r]" docs/hosted-integrations-architecture.md docs/hosted-integrations-implementation-plan.md packages/skills/builtin/hosted-integrations-development packages/agent-catalog/templates/tool-developer packages/server/test/e2e
```

Evidence on 2026-08-15:

- Hosted integration lifecycle wording now describes Tool Developer as the
  maintainer persona.
- Role scan over hosted integration docs, skill guidance, templates, and e2e
  tests returned no matches for the disallowed generic maintainer role wording.

## Milestone 22: Environment Config Boundary Audit

Status: implemented and validated in the isolated hosted-integrations worktree.

Goal:

- Re-verify and harden the post-Milestone 18 config model across active code,
  APIs, tools, UI, skills, and tests.
- Ensure active product surfaces expose only family-level environment configs
  for `prod` and `test_debug`, plus per-agent hosted-tool bindings for access,
  default environment, and optional generation pin.
- Ensure legacy config-scope concepts remain only in historical docs or explicit
  negative tests. No backward compatibility aliases are allowed.

Contract:

- Valid hosted integration environments are exactly `prod` and `test_debug`.
- Environment config identity is derived from `(familyId, environment)`.
  Humans, agents, and APIs must not create arbitrary config ids.
- Agent-specific choices are not config records. They live only in
  hosted-tool bindings.
- Agent hosted-tool bindings may carry allowed/default environments and an
  optional generation pin. They must not carry config values, secret refs,
  endpoint overrides, tenant overrides, credential selectors, custom
  environment config ids, or config revision pins.
- Product routes, management tools, Agent Settings, Hosted Tools UI, Tool
  Developer guidance, and runtime dispatch must not expose `config scope` as an
  active concept.
- Execution logs, debug/example runs, regression close validation, artifacts,
  and failure-bucket evidence must not invent synthetic environment config ids
  such as `debug`, `regression`, or `<family>-test`.
- Runs for tools whose runtime config contract declares required config or
  secret keys must resolve a real canonical environment config before
  execution. Normal prod invocation uses `<familyId>-prod`; debug, example,
  validation, regression, parity, and dogfood maintenance runs use
  `<familyId>-test_debug` unless prod is explicitly authorized.
- Runs for tools whose runtime config contract declares no required config or
  secret keys are allowed to be config-free. Their execution logs must record
  `environmentConfigId: null`, `configRevision: null`, and an explicit
  `executionPurpose` such as `consumer`, `debug`, `example`, `regression`,
  `validation`, `parity`, or `dogfood`. They must not create or require empty
  placeholder environment configs.
- Web code should not preserve old `Scope`/`scopes` naming for hosted
  integration environment configs. Generic UI concepts such as log display
  scope are allowed, but hosted environment config helpers, callbacks, and
  test names must use environment terminology.
- Existing historical plan sections that mention config scopes are historical
  evidence only and must carry superseded warnings.

### Slice 22.1: Active Surface Inventory

Goal:

- Inventory every remaining config-scope reference and classify it as
  active-to-remove, historical-doc-only, DB migration/history, or explicit
  legacy-negative test.
- Make active product references fail a deterministic scan gate.

TDD:

- Scan active product paths for `configScopeId`, `config_scope_id`,
  `allowedConfigScopeIds`, `defaultConfigScopeId`,
  `/api/hosted-integrations/config-scopes`,
  `hosted_integration_config_scope_`, `config scope`, and `config-scope`.
- Scan active hosted integration UI helpers/tests for misleading hosted
  environment naming such as `hostedScopes`, `DefaultScope`, or “family
  scopes”; classify generic display-scope identifiers separately.
- Scan execution-log writers and tests for synthetic environment config ids:
  `environmentConfigId: "debug"`, `environmentConfigId: "regression"`, and
  `<family>-test`.
- Scan excludes historical docs only after each historical section has an
  explicit superseded warning.

Validation:

```text
rg -n "configScopeId|config_scope_id|allowedConfigScopeIds|defaultConfigScopeId|/api/hosted-integrations/config-scopes|hosted_integration_config_scope_|config scope|config-scope" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin apps/web/app packages/config/src
rg -n "hostedScopes|DefaultScope|family scopes|config-scope|config scope" apps/web/app apps/web/test
rg -n "environmentConfigId: \"(debug|regression)\"|environmentConfigId: \"[a-zA-Z0-9_-]+-test\"" packages/hosted-integrations/src packages/server/src packages/tools/src packages/hosted-integrations/test packages/server/test packages/tools/test
```

### Slice 22.2: Environment Config Contract Lock

Goal:

- Reconfirm one canonical environment config per `(familyId, environment)`.
- Reject arbitrary environment/config ids such as `demo`, `parity`, `stage`,
  `local`, `qualys-live-demo`, and `qualys-live-parity`.

TDD:

- `prod` and `test_debug` validate.
- Any other environment label rejects.
- Upsert for the same `(familyId, environment)` is idempotent and cannot create
  a second config record.
- Config responses expose sanitized required/configured/missing metadata only;
  no secret values are returned.
- Execution-log `environmentConfigId` values are canonical
  `<familyId>-prod` / `<familyId>-test_debug` ids when the tool declares any
  required config or secret key.
- Execution-log `environmentConfigId` and `configRevision` are `null` only when
  the tool declares no required config or secret keys, and the log carries an
  explicit `executionPurpose`.
- The execution-log TypeScript interfaces, Zod schemas, file store, DB store,
  row serialization, API DTOs, and web admin DTOs must all share this nullable
  config-free contract. UI code must render config-free logs as an explicit
  purpose, not as an empty or synthetic environment config.
- Hosted Tools UI action-state helpers must not require an environment config id
  for config-free debug runs. Debug controls should be enabled from readiness
  state plus tool operation/local argument validity, and should label
  config-free runs by purpose instead of "selected environment config".
- Execution log list/detail UI must display config-backed runs with canonical
  environment config id and revision, and config-free runs with
  `executionPurpose` and no config revision label. Accessible labels must use
  the same wording.
- Promoted generation metadata must preserve the manifest runtime config
  contract. Add `runtimeConfig` to generation metadata during promotion in both
  file-backed and DB-backed generation stores. Gateway invocation must not add
  ad hoc promoted-manifest file reads for this decision.
- Policy may resolve the requested/default environment from the agent binding,
  but policy must not imply that a concrete environment config record exists.
  Environment config existence is a gateway readiness concern that depends on
  the generation runtime config contract.
- API and management-tool wrappers must not pre-require an environment config
  before the gateway/runtime-config contract decision. This includes debug
  routes, Tool Developer `hosted_tool_debug_run`, and async job creation.
- Add one shared resolver in `packages/hosted-integrations` for execution config
  resolution, used by gateway invocation, debug routes, Tool Developer debug,
  async job creation, and debug/invocation readiness. The resolver input is
  actor/purpose, family, tool, requested/default environment, generation
  metadata, policy decision, and available environment config. Its output is
  either `config_backed` with canonical environment config id/revision/config
  and secret-read target, `config_free` with null config id/revision and empty
  config/secrets, or a normalized readiness error.
- Readiness endpoints and management-tool readiness checks must use this shared
  runtime-config-aware resolver. Debug and invocation readiness must not report
  `environment_missing` for config-free tools that have no environment config
  record.
- Async hosted job request fingerprints must include canonical config id and
  revision only for config-backed runs. Config-free async jobs include
  `environmentConfigId: null`, `configRevision: null`, and the same explicit
  execution purpose used by execution logs.

### Slice 22.3: API Route Rectification

Goal:

- Confirm active API routes are `/environment-configs` only.
- Confirm old `/config-scopes` routes are not registered as lifecycle routes or
  compatibility aliases.

TDD:

- `GET/POST/PUT /api/hosted-integrations/config-scopes...` returns platform
  default 404, not a hosted integration lifecycle payload.
- `GET/PUT /api/hosted-integrations/environment-configs/:familyId/:environment`
  works for valid environments.
- Invalid environment returns a deterministic validation error.
- Secret updates remain human-only; agents cannot read or write secret values.

### Slice 22.4: Agent Binding Contract Rectification

Goal:

- Reconfirm agent-specific runtime selection lives only in hosted-tool
  bindings.
- Remove or reject any old payload shape that carries config-scope ids.

TDD:

- Binding `defaultEnvironment` must be in `allowedEnvironments`.
- Binding with custom config id, config values, endpoint override, credential
  selector, or config revision pin rejects.
- Hosted tool allowlist alone is insufficient; hosted-tool binding is required.
- Remote MCP allowlist cannot authorize hosted tools, and hosted
  hosted allowlist cannot authorize remote MCP tools.
- Generation pin resolves only from the binding.

### Slice 22.5: Readiness, Publish, Debug, And Invoke Rules

Goal:

- Keep readiness deterministic when environment configs are missing or
  incomplete.

TDD:

- Tool with no runtime config contract does not block publish on config.
- Tool with required runtime config blocks GA publish unless `prod` readiness is
  satisfied.
- `test_debug` readiness is sufficient for validate/example/debug/parity, but
  not for GA publish.
- Normal prod invocation without prod config returns `config_missing`.
- Prod debug requires explicit authorized human/internal permission.
- Draft example runs and regression close validation do not write synthetic
  `debug` or `regression` environment config ids to execution logs.
- Draft example, validation, debug, regression, parity, and dogfood runs for a
  tool with required runtime config/secrets resolve the real `test_debug`
  environment config before execution.
- Draft example, validation, debug, regression, parity, dogfood, and consumer
  runs for a tool with no required runtime config/secrets may execute without
  any environment config and log the explicit config-free representation.
- Gateway invocation must resolve the active/captured generation and its
  runtime config contract before treating a missing environment config as a
  readiness blocker. A config-free tool must not be blocked before dispatch just
  because no environment config record exists.
- Generation promotion and DB/file generation stores preserve
  `runtimeConfig.requiredConfigKeys` and `runtimeConfig.requiredSecretKeys` in
  generation metadata, and gateway tests cover both file-backed and DB-backed
  reads.
- Debug API route, Tool Developer management debug tool, and async job creation
  use the same config resolution helper as normal invocation. Config-free tools
  are accepted without environment config records; config-backed tools still
  fail deterministically when the required `test_debug` or authorized `prod`
  config is missing/incomplete.
- `/api/hosted-integrations/readiness/debug`,
  `/api/hosted-integrations/readiness/invocation`, and
  `hosted_tool_readiness_get` return ready environment readiness for
  config-free tools after policy/generation checks, without requiring an
  environment config record.
- Hosted Tools debug controls and log rendering have config-backed and
  config-free tests. Config-free debug has no environment config dropdown
  dependency, and config-free logs do not render blank config ids or numeric
  fake revisions.
- Telemetry spans include `executionPurpose` and whether the run was
  `config_backed` or `config_free`; they do not emit fake environment config
  attributes for config-free runs.
- Async job idempotency tests cover config-backed and config-free fingerprints
  so two config-free requests do not depend on a fake environment config id.

### Slice 22.6: UI Rectification

Goal:

- Hosted Tools and Agent Settings show `Prod` and `Test/debug` only.
- Family config requirements and missing secret/config status are visible
  without raw secret values.
- Agent Settings shows each hosted tool binding with environment and optional
  generation pin.

TDD:

- UI tests do not find user-facing `config scope` text.
- Hosted integration Agent Settings/Admin code does not use old hosted
  `Scope` naming for environment config variables, callbacks, or test labels.
- UI does not render arbitrary environment/config labels.
- Save payloads use environment config plus hosted-tool binding contract only.

### Slice 22.7: Skill And Docs Cleanup

Goal:

- Tool Developer guidance teaches environment configs and hosted-tool bindings,
  not config scopes.
- Historical milestone warnings remain explicit where older sections contain
  config-scope evidence.

TDD:

- Skill scan finds no active `config scope`, `config-scope`, or `configScopeId`
  guidance.
- Skill examples use only `prod` and `test_debug`.
- Hosted/native tool naming guidance remains intact.

### Slice 22.8: No Backward Compatibility Proof

Goal:

- Remove or rewrite old agent defs/test fixtures to the new binding model.
- Reject old config-scope payloads explicitly; do not parse them for
  compatibility.

TDD:

- Payload with `allowedConfigScopeIds` rejects.
- Payload with `defaultConfigScopeId` rejects.
- Old config-scope route rejects.
- Synthetic execution-log environment ids such as `debug`, `regression`, and
  `<family>-test` are rejected or no longer produced.
- Seeded/test agent defs validate with the current hosted-tool binding shape.

Evidence on 2026-08-15:

- Added a shared execution-config resolver in `packages/hosted-integrations`
  and wired gateway invocation, debug routes, Tool Developer debug/example
  paths, async job creation, regression close validation, and debug/invocation
  readiness to the runtime-config-aware contract.
- Promoted file-backed and DB-backed generations preserve `runtimeConfig`, so
  runtime config decisions come from generation metadata instead of ad hoc
  promoted-manifest reads.
- Execution logs now support config-backed runs with canonical environment
  config id/revision and config-free runs with `environmentConfigId: null`,
  `configRevision: null`, and explicit `executionPurpose`.
- Hosted Tools UI renders config-free logs explicitly and allows read-safe
  config-free debug without an environment config dropdown dependency.
- Telemetry spans include config mode and execution purpose, and do not invent
  fake environment config ids for config-free runs.
- Integration-hub replacement fixtures remain test-support inputs only; their
  generated test manifests now carry runtime config contracts without adding
  legacy source to package runtime code.
- Active-source scan found no legacy config-scope aliases, synthetic
  environment config ids, or Tool Developer skill references to config-scope
  guidance outside historical docs/negative-test boundaries.

Validated:

```text
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server check-types
pnpm --filter web check-types
pnpm --filter @openacme/hosted-integrations test -- gateway db-store execution-log failure-buckets retention readiness
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations runtime
pnpm --filter web test -- hosted-integrations-admin hosted-integration-agent-settings
pnpm --filter @openacme/hosted-integrations build
pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help
```

Final validation:

```text
pnpm --filter @openacme/hosted-integrations test -- environment-configs hosted-tool-bindings readiness policy gateway validation
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations runtime
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/tools test -- hosted-integration-management
pnpm --filter @openacme/tools check-types
pnpm --filter web test -- hosted-integration-agent-settings hosted-integrations-admin hosted-integrations-rich-editor
pnpm --filter web check-types
```

Boundary scans:

```text
rg -n "configScopeId|config_scope_id|allowedConfigScopeIds|defaultConfigScopeId|/api/hosted-integrations/config-scopes|hosted_integration_config_scope_|config scope|config-scope" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin apps/web/app packages/config/src
rg -n "hostedScopes|DefaultScope|family scopes|config-scope|config scope" apps/web/app apps/web/test
rg -n "environmentConfigId: \"(debug|regression)\"|environmentConfigId: \"[a-zA-Z0-9_-]+-test\"" packages/hosted-integrations/src packages/server/src packages/tools/src packages/hosted-integrations/test packages/server/test packages/tools/test
rg -n "qualys-live-demo|qualys-live-parity|demo config|parity config|environment.*demo|environment.*parity" packages/hosted-integrations/src packages/server/src packages/tools/src apps/web/app packages/config/src packages/skills/builtin
```

## Next Implementation Order

The package skeleton, MVP lifecycle, management tools, failure loop, Agent
Settings integration, first Qualys hosted-help dogfood, local/real-LLM
dogfood, deterministic source model, human-native editor, DB-backed
persistence, first live Qualys parity validation, Milestone 18 rectification,
Milestone 20 offline parity/test-input boundary, and Milestone 21 historical
artifact hygiene have already landed in the isolated worktree.
Milestone 22 has since become the active environment-config boundary contract.
Milestone 23's tool catalog revision/session notice work, Milestone 24's
derived-only runtime rectification, Milestone 25's hosted family delete, and
Milestone 26's isolated test-env rectification have landed.

Recommended future order:

1. Keep newly identified production hardening slices from parity or dogfood
   findings.

Why this order:

- The accepted Milestone 23-26 correction packet is validation-backed and ready
  to remain the current baseline.
- The deterministic source model, rich editor, generation diff, DB persistence,
  and hosted/hosted tool boundary are now implemented enough for broader
  parity validation.
- Milestone 18 corrected the product-boundary issue that dogfood surfaced:
  internal/agent-specific purposes are now modeled as hosted-tool bindings, not
  extra family environment configs.

Expected final acceptance validation:

```text
pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement validation python-runtime readiness environment-configs hosted-tool-bindings help source-view generation-diff db-store store-contract naming family-delete draining
pnpm --filter @openacme/hosted-integrations check-types
pnpm --filter @openacme/hosted-integrations check-types:test-support
pnpm --filter @openacme/hosted-integrations build
pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations hosted-integration-live-parity hosted-integrations-legacy-surface runtime
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/server check-types:operator
pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help registry-order
pnpm --filter @openacme/tools check-types
pnpm --filter web test -- hosted-integration-agent-settings hosted-integrations-admin hosted-integrations-rich-editor tool-catalog-notices
pnpm --filter web check-types
pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/chat.e2e.ts test/e2e/tasks.e2e.ts test/e2e/session-timeline.e2e.ts -t "resolves catalog refresh once|emits a catalog notice|agent_ask target sessions emit catalog notices|dispatcher turns emit catalog notices|filters durable timeline events by eventType"
curl -sS -m 5 http://127.0.0.1:3466/api/health
```

Current final acceptance validation on 2026-08-15:

- `pnpm --filter @openacme/hosted-integrations test -- integration-hub-replacement validation python-runtime readiness environment-configs hosted-tool-bindings help source-view generation-diff db-store store-contract naming family-delete draining --reporter=dot`
  passed: 111 passed, 1 skipped.
- `pnpm --filter @openacme/hosted-integrations check-types` passed.
- `pnpm --filter @openacme/hosted-integrations check-types:test-support`
  passed.
- `pnpm --filter @openacme/hosted-integrations build` passed.
- `pnpm --filter @openacme/server test -- hosted-integrations-routes tools-hosted-integrations hosted-integration-live-parity hosted-integrations-legacy-surface runtime`
  passed: 84 passed.
- `pnpm --filter @openacme/server check-types` passed.
- `pnpm --filter @openacme/server check-types:operator` passed.
- `pnpm --filter @openacme/tools test -- hosted-integration-management hosted-integration-help registry-order --reporter=dot`
  passed: 19 passed.
- `pnpm --filter @openacme/tools check-types` passed.
- `pnpm --filter web test -- hosted-integration-agent-settings hosted-integrations-admin hosted-integrations-rich-editor tool-catalog-notices --reporter=dot`
  passed: 45 passed.
- `pnpm --filter web check-types` passed.
- `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/chat.e2e.ts test/e2e/tasks.e2e.ts test/e2e/session-timeline.e2e.ts -t "resolves catalog refresh once|emits a catalog notice|agent_ask target sessions emit catalog notices|dispatcher turns emit catalog notices|filters durable timeline events by eventType" --reporter=dot`
  passed: 5 passed, 21 skipped.
- The isolated local test env was rectified with
  `OPENACME_DATA_DIR="$HOME/.openamce-hosted-integrations-test-env" pnpm --filter @openacme/server exec tsx scripts/hosted-integrations-rectify-derived-only-data.ts`;
  stale legacy dispatch artifacts were archived under that env's
  `archived-legacy` directory while family environment config and secret
  metadata remained in place.
- Test-env scan returned no matches for `handlerDispatch`, `legacy_call_tool`,
  or `def call_tool(` in active hosted source, generation, and draft surfaces.
- `curl -sS -m 5 http://127.0.0.1:3466/api/health` returned
  `{"status":"ok","version":"0.14.0","agents":3,"skills":3}`.
- `GET /api/tools` on port 3466 returned 39 hosted tools using canonical
  `hosted_<family>__<tool>` business names and `hosted_tool_*` management-tool
  names.
- Live Qualys parity passed with five matching cases:
  `live_parity_dbda7b87-fa48-4198-b082-a45089e42ade`.
- Live Microsoft Graph parity passed with one matching service-root case:
  `live_parity_67f731da-a2a5-45f5-8aad-9d2bdb2d7ad4`.
- The current Qualys live parity artifact was scanned for
  `Bearer`, `access_token`, `client_secret`, `MSGRAPH_CLIENT_SECRET`,
  `QUALYS_PASSWORD`, `QUALYS_USERNAME`, `SPLUNK_TOKEN`, `raw-secret`, and
  `password` markers; no matches were found.
- Boundary scans returned no matches for:
  - `rg -n "LEGACY_INTEGRATION_HUB|legacy-qualys-source|migration\\.js" packages/hosted-integrations/src packages/hosted-integrations/package.json`
  - `rg -n "LEGACY_INTEGRATION_HUB|integration-hub-parity|hosted-integration-live-parity" packages/server/src`
  - `rg -n "integration-hub replacement|migration readiness|readiness/migration|resolveMigrationReadiness|target_type.*migration" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin apps/web/app`
- Live Splunk remains credential-gated by the expired legacy MCP env JWT:
  `SPLUNK_TOKEN expired at 2026-08-14T14:57:55.000Z (source: legacy MCP env)`.
  The operator script now supports shell env overrides, so a refreshed
  `SPLUNK_TOKEN` can override the stale legacy MCP env without editing
  `mcp.json`.
- Live MDE and defender-alert remain credential-gated until their family-native
  credentials are configured; current diagnostics explicitly say legacy MCP env,
  runner config override, and runner secret override were checked.

## Milestone 23: Tool Catalog Revision And Session Notice

Goal:

- Let already-open chat sessions pick up hosted tool catalog changes on the
  next turn without requiring a new session.
- Keep the existing explicit Agent Settings grant model: an agent can only call
  tools listed in `agent.tools` with the corresponding hosted-tool binding data
  when config is required.
- Avoid introducing a new granting/capability system for this milestone.
- Treat the registry revision as a cache-invalidation signal for cached Agent
  instances, not as an access-policy source.

Non-goals:

- No mid-flight model request mutation. A turn already sent to the model keeps
  the tool schema snapshot captured at turn start.
- No implicit access to newly promoted business hosted tools unless Agent
  Settings has already granted that exact `hosted_<family>__<tool>` name.
- No wildcard/prefix grant mechanism and no remote MCP/hosted-tool grant
  unification.

### Slice 23.1: ToolRegistry Revision And Emitted-Name Snapshot Helper

Status: done.

Goal:

- ToolRegistry revision contract: use the existing `toolRegistry.generation`
  counter as the canonical catalog revision exposed to cache consumers.
- ToolRegistry snapshot helper: add a small public helper for emitted tool-name
  snapshots, for example `getEmittedToolNames(toolNames?, options?)`, that uses
  the same filtering path as `getDefinitions()`/`getVercelTools()` without
  constructing tool execution closures or JSON schemas.
- Hosted lifecycle integration: promotion, delete, registry sync, and registry
  remove paths must bump the registry generation through normal ToolRegistry
  `register`/`deregister` behavior. Hosted adapter `clear` invalidates by
  deregistering every registered hosted family tool.

TDD:

- `ToolRegistry.generation` is stable across read-only `getInfo()` and
  `getVercelTools()` calls.
- `ToolRegistry.generation` increments on register and deregister; hosted
  `syncFamily`, `removeFamily`, and adapter `clear` paths invalidate through
  those existing registry operations.
- ToolRegistry emitted-name helper returns exactly the names that
  `getVercelTools()` would expose for the same `toolNames` filter and `checkFn`
  state, without creating executable tool objects.

Evidence:

- `pnpm --filter @openacme/tools exec vitest run test/registry-order.test.ts --reporter=dot`
  passed.
- `pnpm --filter @openacme/tools build` passed so downstream server tests use
  the refreshed `@openacme/tools` package output.

### Slice 23.2: Agent Cache Revision Invalidation

Status: done.

Goal:

- Agent cache invalidation: cache Agent instances with the catalog generation
  they were built from and evict/rebuild on the next `getAgent()` cache hit when
  the current registry generation differs.
- Runtime scope: hosted tools are not per-agent MCP servers. They are global
  ToolRegistry entries whose availability to a specific agent is filtered by
  that agent's `agent.tools` allowlist and hosted-tool bindings at Agent
  creation/turn execution time.
- Authorization boundary: Agent Settings remains the only user-facing grant
  surface for business hosted tools; revision invalidation only refreshes
  schemas for agents that are already configured to receive those tools.

TDD:

- A cached Agent built at catalog generation `N` is reused while the registry
  remains at `N`.
- A cached Agent built at catalog generation `N` is evicted and rebuilt before
  the next turn when the registry is at `N + 1`.
- Agent cache entries carry `agent`, `toolCatalogGeneration`, and the base
  model-facing tool-name snapshot for that agent. The base snapshot must be
  computed through ToolRegistry emission rules including registered tool
  presence and per-tool `checkFn` gating; it must not be derived from the raw
  allowlist alone.
- If `ToolRegistry.generation` changes but the effective model-facing tool-name
  snapshot is unchanged, the Agent is still rebuilt but the refresh result marks
  no added/removed effective tool names. This prevents downstream notice
  producers from showing noisy notices for idempotent hosted registry syncs that
  replace equivalent entries.

Evidence:

- `pnpm --filter @openacme/server exec vitest run test/app-routes.test.ts -t "rebuilds cached agents" --reporter=dot`
  passed. The test registers the granted probe before agent creation, proves
  cache reuse while the catalog generation is stable, then registers an
  unselected tool to bump the catalog and proves the agent rebuilds with no
  added/removed effective tool names.
- `pnpm --filter @openacme/server exec vitest run test/hosted-integrations-routes.test.ts -t "evicts cached agents|removes.*api/tools|delete" --reporter=dot`
  passed, covering hosted family delete/draining registry removal and cached
  agent eviction behavior.
- `pnpm --filter @openacme/server check-types` passed.

### Slice 23.3: Session-Aware Turn Refresh And Catalog Notice Event

Status: done.

Goal:

- Session-aware turn entrypoint: `getAgent(id)` can stay the generic cache
  accessor, but chat-visible catalog notices must be emitted from a
  session-aware turn boundary that has `sessionId` and the pending response/turn
  identity. Interactive chat, autonomous dispatcher turns, and `agent_ask`
  target turns are the relevant boundaries.
- Turn-scoped agent resolution: each turn resolves the Agent/cache refresh once
  and reuses that Agent for preflight, memory recall, model execution, post-turn
  extractor/title work, and notice emission. Interactive chat must not call a
  fresh `getAgent(agentId)` separately for preflight and execution in a way that
  can observe two different catalog generations inside one turn.
- Chat visibility: when a session activation rebuilds because the tool catalog
  revision changed, persist a session timeline event and broadcast a UI-only
  session context notice that tells the user which newly available tools were
  noticed and added to that turn's model-facing tool set. Do not persist this
  notice as a user/assistant chat message and do not materialize it into the
  model input.
- Event contract: use session timeline event type
  `session.tool_catalog.changed` and SSE kind `tool_catalog_notice`. The payload
  contains only sanitized metadata: `agentId`, `previousGeneration`,
  `currentGeneration`, `addedToolNames`, `removedToolNames`,
  `addedHostedTools` with Agent Settings grant status, and optional
  `responseMessageId`/`taskId`. It must not include tool arguments, config
  values, secrets, source code, or raw registry entry objects.

TDD:

- Interactive chat resolves the Agent once per turn and uses the same cache
  refresh result for preflight compression, memory recall, `runStream`, and
  post-turn extractor/title hooks.
- Autonomous dispatcher turns and `agent_ask` target turns use the same
  session-aware refresh helper and record/broadcast equivalent catalog notices.
- Session-aware turn refresh computes the turn-effective snapshot by applying
  any turn-level `toolFilter` to the refreshed Agent before recording a notice.
  This keeps `agent_ask` and other restricted calls from reporting tools that
  were not actually offered to that model request.
- Rebuild on generation mismatch returns a refresh result to the session-aware
  turn boundary; that boundary records the sanitized session timeline/context
  event with previous generation, current generation, added tool names, removed
  tool names, response/turn anchor, and whether each added hosted tool was
  already granted by Agent Settings.

Evidence:

- `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/chat.e2e.ts -t "resolves catalog refresh once|emits a catalog notice" --reporter=dot`
  passed. This proves interactive turns resolve one catalog refresh boundary
  and emit a metadata-only `tool_catalog_notice` plus durable
  `session.tool_catalog.changed` timeline event when a granted tool becomes
  model-visible.
- `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/tasks.e2e.ts -t "agent_ask target sessions emit catalog notices|dispatcher turns emit catalog notices" --reporter=dot`
  passed. This proves `agent_ask` target sessions and autonomous dispatcher
  turns use the same refresh/notice seam.
- `pnpm --filter @openacme/server check-types` passed.

### Slice 23.4: Timeline Filter And Chat UI Rendering

Status: done.

Goal:

- Finding: the current chat UI does not render session timeline events by
  default. `GET /api/sessions/:id/timeline` exists as an operator/API surface,
  but `useLiveSession` only handles live stream events such as
  `ui_message_part`, `messages_appended`, `session_state`, `session_title`,
  `task_event`, inbox queue events, and usage events.
- Finding: persisting the catalog notice as a normal user or assistant message
  would make the explanation part of canonical chat history and risk leaking it
  into later model input. That is the wrong surface for an explanatory UI
  event.
- Consume the explicit UI-only session broadcast event for catalog context
  notices, separate from `messages_appended`.
- Recover the durable session timeline event written by Slice 23.3 so page
  reloads and forensic review can show when the session noticed the catalog
  change.
- Extend the session timeline store and `GET /api/sessions/:id/timeline` with
  an `eventType` filter so reload recovery can fetch only
  `session.tool_catalog.changed` records instead of scanning a broad timeline
  page and possibly missing older notices behind the limit.
- `useLiveSession` must handle the new broadcast event and keep it in a UI-side
  notice collection rather than in `messages`.
- Initial history load and running-to-idle refresh must merge relevant catalog
  notices from `GET /api/sessions/:id/timeline` by event type, so the notice
  survives refresh and late page load.
- Both full-page chat (`apps/web/app/routes/index.tsx`) and the Acme panel
  (`apps/web/app/components/AcmePanel.tsx`, through the shared `useChatSession`
  path) render the same catalog notice model. The copy should name added tools,
  removed tools if any, and the fact that Agent Settings had already granted any
  added hosted tool that became model-visible.
- Notices are anchored to a response/turn id when available and otherwise
  sorted by timeline timestamp. The UI renders them between conversation items
  without changing message order or message ids.
- Non-change: this notice does not grant access, does not alter `agent.tools`,
  does not create hosted-tool bindings, and does not enter model context.

TDD:

- `useLiveSession` handles `tool_catalog_notice` separately from
  `messages_appended` so catalog notices do not become canonical chat history.
- Timeline store and route tests prove `eventType=session.tool_catalog.changed`
  filters only catalog notices and paginates deterministically.
- Initial session history load or running-to-idle refresh can recover these
  notices from `GET /api/sessions/:id/timeline` by event type, so a page reload
  does not lose the explanation.
- Full-page chat and the Acme panel render catalog context notices inline with
  conversation context, using the same visual pattern as modal/context notices,
  so the user can see when a new tool became available in the session and why.

Evidence:

- `pnpm --filter @openacme/server exec vitest run --config vitest.e2e.config.ts test/e2e/session-timeline.e2e.ts -t "filters durable timeline events by eventType" --reporter=dot`
  passed. This proves `GET /api/sessions/:id/timeline?eventType=session.tool_catalog.changed`
  returns only catalog notice events.
- `pnpm --filter web test -- tool-catalog-notices --reporter=dot` passed.
  This proves the web parser accepts only `session.tool_catalog.changed`
  timeline payloads and dedupes notice state.
- `pnpm --filter web check-types`, `pnpm --filter @openacme/db build`, and
  `pnpm --filter @openacme/server check-types` passed.
- UI implementation notes: `useLiveSession` handles `tool_catalog_notice` via
  a dedicated callback, not `messages_appended`; full-page chat and Acme panel
  render `ToolCatalogNotice` from UI-side notice state; session load and
  running-to-idle refresh recover notices through the timeline `eventType`
  filter.

### Slice 23.5: Access Boundary And Draining Proof

Status: done.

Goal:

- Draining scope: publish/update/delete draining waits only for in-flight
  hosted tool invocations against the affected generation or family, across
  whichever agents started those calls. Idle agents and open sessions with no
  active affected tool call do not block draining.
- Preserve the hosted tool / remote MCP naming boundary and the existing Agent
  Settings grant model.

TDD:

- A same-session follow-up turn can see a newly registered hosted management
  tool when the agent definition already includes that management tool.
- A same-session follow-up turn can see a promoted business hosted tool only
  when `agent.tools` already includes the exact canonical hosted tool name.
- Removing or deleting a hosted family invalidates cached Agents that selected
  removed hosted tools and prevents the removed tools from being emitted on the
  next turn.
- Draining tests prove a long-running call from one agent blocks only the
  affected generation/family finalization, while unrelated hosted tools and
  idle agents continue normally.
- In-flight turns continue using their starting tool schema snapshot and fail
  through the existing gateway readiness/draining checks if the referenced
  generation becomes unavailable.
- Regression coverage proves remote MCP tool names cannot grant hosted tools
  and hosted tool names cannot enable remote MCP tools.

Evidence:

- `pnpm --filter @openacme/hosted-integrations test -- draining naming`
  passed. This covers hosted draining behavior and canonical naming boundary.
- `pnpm --filter @openacme/server exec vitest run test/tools-hosted-integrations.test.ts -t "without hiding remote MCP|cannot invoke|canonical hosted" --reporter=dot`
  passed. This proves hosted replacements do not hide remote MCP tools in
  `/api/tools`.
- `pnpm --filter @openacme/server exec vitest run test/hosted-integrations-routes.test.ts -t "refreshes /api/tools|deletes a hosted family|drains active invocations|drains real gateway" --reporter=dot`
  passed. This covers promotion registry refresh, cached agent eviction,
  hosted family delete, and delete-draining behavior.
- Slice 23.3 e2e evidence proves same-session follow-up turns pick up newly
  model-visible granted tools through catalog refresh without requiring a new
  session.

## Milestone 24: Derived-Only Runtime Contract Rectification

Status: done.

Goal:

- Remove the temporary `legacy_call_tool` compatibility path and the
  now-useless `handlerDispatch` field from product hosted integration
  runtime/schema/validation.
- Keep the single accepted tool mapping rule:
  `def tool_<tool_name>(args, context)`.
- Ensure integration-hub replacement fixtures used by tests/operator workflows
  also generate derived handler source, so test inputs do not reintroduce a
  product-style legacy dispatch contract.
- Preserve legacy remote MCP references only as parity/source evidence, not as
  hosted runtime dispatch behavior.

Non-goals:

- No migration fallback for already-promoted legacy hosted generations.
- No manifest handler aliases.
- No `call_tool(name, args, context)` runtime dispatch in product code.

### Slice 24.1: Schema, Runtime, Validation, And Fixture Cleanup

Status: done.

Goal:

- Remove `runtime.handlerDispatch` from the manifest schema.
- Remove Python runtime dispatch to module-level `call_tool`.
- Make validation reject legacy dispatch manifests and entrypoints that lack
  deterministic handlers.
- Convert route, management-tool, promotion, and integration-hub replacement
  fixtures to deterministic handlers with standard hooks where validation runs.

TDD:

- schema rejects any `handlerDispatch` runtime field
- runtime ignores module-level `call_tool` and returns a normal missing-handler
  failure when the deterministic handler is absent
- validation rejects explicit legacy dispatch metadata
- promoted/draft route fixtures validate with
  `tool_<tool_name>(args, context)` and standard hooks
- integration-hub replacement fixtures validate/promote without generating
  legacy dispatch source

Evidence:

- `pnpm --filter @openacme/hosted-integrations test -- validation python-runtime promotion integration-hub-replacement --reporter=dot`
  passed: 55 passed, 1 skipped.
- `pnpm --filter @openacme/server exec vitest run test/hosted-integrations-routes.test.ts test/tools-hosted-integrations.test.ts -t "invokes selected hosted integration|runs examples and promotes|failure bucket repair|creates drafts|readiness|promotes a draft|deletes a hosted family|drains active invocations|requires human approval" --reporter=dot`
  passed: 11 passed, 44 skipped.
- `pnpm --filter @openacme/server check-types` passed.

### Slice 24.2: Remove Redundant Dispatch Field

Status: done.

Goal:

- Remove the redundant `runtime.handlerDispatch` field entirely after Slice
  24.1 proved there is only one valid dispatch behavior.
- Keep source-view manifest excerpts focused on useful runtime facts:
  `entrypoint` plus selected tool metadata.
- Ensure runtime fixture helpers build requests without dispatch metadata.
- Remove stale dispatch metadata from active web admin types and real LLM
  dogfood source generation.

TDD:

- runtime settings schema rejects any `handlerDispatch` field because the schema
  is strict
- focused source-view manifest excerpt no longer exposes `handlerDispatch`
- Python runtime tests pass without injecting dispatch metadata
- product source scan finds no active `handlerDispatch` references
- active web/server script surfaces contain no `handlerDispatch` type and no
  generated `def call_tool` dogfood source

Evidence:

- `pnpm --filter @openacme/hosted-integrations test -- schemas source-view validation python-runtime --reporter=dot`
  passed.
- `pnpm --filter @openacme/hosted-integrations check-types` passed.
- `pnpm --filter web check-types` passed.
- `pnpm --filter @openacme/server check-types` passed.
- `pnpm --filter @openacme/server check-types:operator` passed.
- Product source scan returned no matches:
  `rg -n "handlerDispatch" packages/hosted-integrations/src packages/server/src packages/tools/src packages/skills/builtin/hosted-integrations-development/SKILL.md docs/hosted-integrations-architecture.md`.
- Active UI/script scan returned no matches:
  `rg -n "handlerDispatch|def call_tool\\(" apps/web/app apps/web/test packages/server/scripts packages/server/test-support packages/hosted-integrations/test-support packages/tools/src packages/server/src packages/hosted-integrations/src -g '!**/dist/**'`.

### Slice 24.3: Remove Duplicate Plan Artifact

Status: done.

Goal:

- Keep `docs/hosted-integrations-implementation-plan.md` as the single
  canonical hosted integrations implementation plan.
- Remove stale duplicate plan artifacts that can mislead future agent work with
  superseded wording such as `managed_<family>__<tool>`,
  `integration-hub-import`, `handlerDispatch`, or legacy router references.

TDD:

- duplicate plan artifact path does not exist
- repo scan finds no references to the duplicate path
- canonical plan and architecture remain the only hosted integrations planning
  documents used by this workstream

Evidence:

- Removed the untracked stale duplicate plan snapshot.
- Shell existence check for the stale duplicate path passed.
- Repository reference scan for the stale duplicate plan naming pattern returned
  no matches.

## Milestone 25: Hosted Family Delete And Draining Rectification

Status: done.

Goal:

- Add an explicit Tool Developer-only API delete action for removing an
  incorrect hosted family from active lifecycle and registry surfaces.
- Delete active/proposed source, drafts, locks, active pointers, environment
  configs, secret files, disablements, and workspaces for the target family.
- Keep promoted generation rows/files, historical runs, artifacts, approvals,
  and failure buckets as forensic evidence; DB-backed stores disable retained
  generations so cold-start registry sync cannot re-expose them.
- Remove the family's hosted registry tools immediately and evict agents using
  those tools.
- If the family has in-flight invocations, return `delete_draining`, disable the
  family for new calls, remove registry tools immediately, and finalize cleanup
  automatically when in-flight count reaches zero.

Non-goals:

- No human-facing custom delete workflow beyond the Tool Developer-only API
  route in this slice.
- No durable delete-operation store in the first implementation slice.
- No restart-resilient delete-draining sweeper in the first implementation
  slice.

### Slice 25.1: API Delete, Registry Removal, And Agent Eviction

Status: done.

Goal:

- Implement `DELETE /api/hosted-integrations/families/:familyId`.
- Require Tool Developer actor authorization for delete.
- Route family deletion through the hosted integrations service and package
  deleter seam instead of route-local cleanup.
- Remove the family's hosted registry tools immediately and evict cached agents
  that selected those hosted tools.

TDD:

- `DELETE /api/hosted-integrations/families/:familyId` requires Tool Developer
  actor authorization.
- Deleting a promoted family removes it from `/api/hosted-integrations/families`.
- Deleting a promoted family removes `hosted_<family>__<tool>` from `/api/tools`.
- Deleting a family evicts cached agents that selected the removed hosted tool.

Evidence:

- `pnpm --filter @openacme/server exec vitest run test/hosted-integrations-routes.test.ts -t "deletes a hosted family|drains active invocations|drains real gateway|requires Tool Developer" --reporter=dot`
  passed: 3 passed, 43 skipped.
- `pnpm --filter @openacme/server check-types` passed.

### Slice 25.2: Delete Cleanup Contract For File And DB Stores

Status: done.

Goal:

- File-backed deletion removes active/proposed source, drafts, locks, active
  generation pointers, environment configs, secret files, family disablements,
  and workspaces.
- DB-backed deletion removes mutable lifecycle state and secret metadata while
  retaining immutable generation rows/files, historical execution logs,
  artifacts, approvals, and failure buckets as forensic evidence.
- DB-backed deletion disables retained generations so registry cold-start sync
  cannot re-expose deleted family tools.

TDD:

- Deleting a family clears its source, disablements, env configs, secrets,
  drafts, locks, active generation pointer, and workspaces.
- DB-backed deletion retains immutable generation rows/files with disabled
  status and preserves execution logs.
- Deletion is idempotent for already-deleted or partially deleted families.

Evidence:

- `pnpm --filter @openacme/hosted-integrations exec vitest run test/family-delete.test.ts test/db-store.test.ts test/draining.test.ts --reporter=dot`
  passed: 18 passed.
- File-backed deletion now preserves generation files as forensic evidence,
  removes the active pointer, and writes disabled generation state.
- DB-backed deletion retains generation rows/files, disables retained
  generations, and preserves execution logs.
- `pnpm --filter @openacme/hosted-integrations check-types` passed.
- `pnpm --filter @openacme/hosted-integrations build` passed.

### Slice 25.3: Delete-Draining First Slice

Status: done.

Goal:

- If the target family has in-flight invocations, return `delete_draining`
  instead of deleting mutable state immediately.
- Record a family-level `delete_draining` disablement so new calls fail before
  runtime dispatch.
- Remove registry tools immediately even while final cleanup waits for the
  in-flight count to reach zero.
- Finalize cleanup automatically after the in-flight invocation count reaches
  zero.

TDD:

- Deleting a family with in-flight invocations returns `delete_draining`,
  records a family-level `delete_draining` disablement, and removes the hosted
  registry tool before final cleanup.
- Draining finalization deletes the family after the outstanding invocation is
  completed.
- Draining blocks only the affected family; unrelated hosted tools and idle
  agents do not block finalization.

Evidence:

- `pnpm --filter @openacme/hosted-integrations exec vitest run test/family-delete.test.ts test/db-store.test.ts test/draining.test.ts --reporter=dot`
  passed: 18 passed.
- `pnpm --filter @openacme/server exec vitest run test/hosted-integrations-routes.test.ts -t "deletes a hosted family|drains active invocations|drains real gateway|requires Tool Developer" --reporter=dot`
  passed: 3 passed, 43 skipped.
- `pnpm --filter @openacme/server check-types` passed.

Technical debt:

- Delete-draining finalization currently uses an in-process runtime timer that
  starts only after a `DELETE` request returns `delete_draining`. This is
  acceptable for the first slice, but it is not restart-resilient and does not
  provide a first-class UI-readable operation record. Move this to a durable
  hosted family lifecycle operation store plus startup/runtime sweeper: record
  `delete_draining`, current in-flight count, started/completed timestamps,
  last error, and finalization status; resume finalization after server restart
  by scanning pending delete operations or family-level `delete_draining`
  disablements.

## Milestone 26: Isolated Test Env Derived-Only Data Rectification

Status: done.

Goal:

- Keep the product runtime strictly derived-only with no legacy dispatch
  compatibility.
- Provide an operator/test-env script that can clean isolated hosted
  integrations data dirs after the runtime contract removes
  `runtime.handlerDispatch`.
- Repair only harmless stale `runtime.handlerDispatch=derived` metadata by
  removing the field.
- Archive legacy `legacy_call_tool` generations, active pointers, source
  families, proposed-family records, locks, and drafts that cannot satisfy the
  deterministic `def tool_<tool_name>(args, context)` mapping.
- Preserve family environment config and secret metadata so credentials do not
  need to be re-entered after local test-env cleanup.

Non-goals:

- No product runtime fallback for stale generation metadata.
- No migration route, management tool, or automatic startup compatibility path.
- No edits to local prod data.

### Slice 26.1: Operator Script And Local Test Env Health

Status: done.

Goal:

- Add `packages/server/scripts/hosted-integrations-rectify-derived-only-data.ts`
  as an explicit operator script for isolated data-dir cleanup.
- Run it against
  `$HOME/.openamce-hosted-integrations-test-env` only.
- Prove the test server boots on port 3466 after cleanup.

TDD:

- Operator typecheck includes the rectification script.
- Running the script removes active boot-blocking `handlerDispatch` data from
  active hosted source/generation/draft surfaces.
- Environment config and secret metadata files remain present after cleanup.
- `OPENACME_DATA_DIR="$HOME/.openamce-hosted-integrations-test-env"`
  `OPENACME_PORT=3466` server boot reaches `/api/health`.
- `/api/tools` on the test server exposes canonical hosted names, not legacy
  non-hosted naming or remote-MCP aliases.

Evidence:

- `pnpm --filter @openacme/server check-types:operator` passed.
- `OPENACME_DATA_DIR="$HOME/.openamce-hosted-integrations-test-env" pnpm --filter @openacme/server exec tsx scripts/hosted-integrations-rectify-derived-only-data.ts`
  completed successfully and archived stale legacy hosted artifacts under the
  isolated test env's `archived-legacy` directory.
- Active test-env scan over hosted source, generation, and draft surfaces
  returned no matches for `handlerDispatch`, `legacy_call_tool`, or
  `def call_tool(`.
- `curl -sS -m 5 http://127.0.0.1:3466/api/health` returned
  `{"status":"ok","version":"0.14.0","agents":3,"skills":3}`.
- `GET /api/tools` on port 3466 returned 39 hosted tools using canonical
  `hosted_<family>__<tool>` business names and `hosted_tool_*` management-tool
  names.
