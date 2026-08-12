# Hosted Integrations Implementation Plan

Last revised: 2026-08-12.

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

## Delivery Rules

- Build one milestone slice at a time.
- Each slice starts with a failing test or route-level contract test.
- Keep hosted integrations logic in `packages/hosted-integrations`.
- Keep `packages/tools` adapters thin.
- Keep server routes thin.
- Do not introduce an external MCP server path for hosted integrations.
- Use Python for hosted integration family runtime in the MVP.
- Use file-backed persistence through package-level store ports for the MVP.
  This keeps the first implementation fast and makes a later SQLite-backed store
  a port swap, not a product redesign.
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
- config-scope and human-only secret routes
- agent/tool config-scope bindings with default scope resolution
- Agent Settings as the primary user-facing policy and binding surface for
  hosted integration invocation access
- generation listing and rollback routes
- invocation, run detail, artifact, and debug-run routes
- async job routes
- invocation idempotency and duplicate-submit protection
- deprecation, hiding, disabling, and removal policy
- operational disable/quarantine at family, tool, generation, and config-scope
  levels
- family-level runtime settings for timeouts, inline result spillover threshold,
  concurrency, and sandbox policy
- Python dependency declaration, validation, and generation pinning
- migration/cutover from the current external `integration-hub` MCP setup
- UI visibility for family locks and active generations
- UI draft code editing through the same lock/draft/validation/promotion APIs
- local safe hosted-tool smoke validation in the isolated test environment
- optional OpenTelemetry wiring after execution logs exist

## Milestone 0: Planning Baseline

### Slice 0.1: Architecture Note

Status: done.

Artifact:

```text
docs/hosted-integrations-architecture.md
```

### Slice 0.2: Implementation Plan

Status: this document.

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
GET /api/hosted-integrations/families/:family
GET /api/hosted-integrations/families/:family/tools
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
POST   /api/hosted-integrations/families/:family/lock
POST   /api/hosted-integrations/locks/:lockId/renew
DELETE /api/hosted-integrations/locks/:lockId
GET    /api/hosted-integrations/families/:family/source/files
GET    /api/hosted-integrations/families/:family/source/files/*path
POST   /api/hosted-integrations/families/:family/drafts
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

### Slice 4.11: Example Execution And Promotion Routes

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
- promote route creates a generation and updates active generation atomically
- promote route updates canonical source from the accepted draft
- next draft starts from the promoted source revision
- destructive promotion requires human approval

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/hosted-integrations test -- promotion
```

## Milestone 5: ToolRegistry Surfacing And Management Tools

Goal: integrate hosted integrations into the existing OpenAcme tool surfaces
without inventing a second tool selection system.

### Slice 5.1: Runtime Tool Registry Adapter

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

### Slice 5.2: Invocation Through Existing Agent Tool Path

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

Goal:

- Add `hosted_integration_*` management tools in `packages/tools`.
- Each wrapper delegates to the Hosted Integrations API/control-plane port.
- Add a bindable hosted integrations control-plane interface following the
  existing tools package binding style, so tool handlers do not perform raw HTTP
  calls or import server route code.
- Cover the Tool Developer Agent lifecycle surface: family create/inspect,
  source inspect, lock/draft edit/delete, example list/upsert/run, validation,
  promotion, generation inspect/rollback, config-scope metadata inspect, debug
  run, run/artifact inspect, and failure bucket list/get/assign/close.

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

### Slice 5.4: Tool Developer Agent Template

Goal:

- Add `packages/agent-catalog/templates/tool-developer/AGENT.md`.
- Mark it `managed: true`.
- Bundle the `hosted-integrations-development` skill.

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

### Slice 5.5: Hosted Integrations Development Skill

Goal:

- Add the bundled `hosted-integrations-development` skill.
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

### Slice 5.6: Local Safe Hosted Tool Smoke

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
OPENACME_DATA_DIR=~/.openamce-hosted-integrations-test-env pnpm dev
pnpm --filter @openacme/server test:e2e -- hosted-integrations-safe-tools
```

## Milestone 6: Failure Buckets And Regression Loop

Goal: make promoted hosted integrations resilient by turning code-level failures
into repair work for the Tool Developer Agent.

### Slice 6.1: Execution Log Store

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

### Slice 6.2: Failure Bucket Dedupe

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

### Slice 6.3: Failure Bucket Routes And Tools

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

### Slice 6.4: Repair Task Creation

Goal:

- Assign new owner-actionable buckets to the Tool Developer Agent.
- Create a task with a sanitized repro package reference.
- Keep caller-facing tool result simple: `tool failed`.

Non-goals:

- No caller involvement in repair routing.

TDD:

- first bucket occurrence creates one Tool Developer Agent task
- repeated same bucket does not create duplicate tasks
- task body includes bucket id, latest run ref, family, tool, generation, and
  sanitized error category
- caller result does not include task id or internal routing detail

Validation:

```text
pnpm --filter @openacme/server test -- tasks
pnpm --filter @openacme/hosted-integrations test -- failure-buckets
```

### Slice 6.5: Regression Example On Fix

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
pnpm --filter @openacme/hosted-integrations test -- regression
```

### Slice 6.6: Run Artifact Retention

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

## Milestone 7: Async Jobs And Explicit Cache Tools

Goal: support longer-running hosted integration work without making the MVP
gateway or examples complex.

### Slice 7.1: Async Job Contract

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

### Slice 7.2: Async Job Routes

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

### Slice 7.3: Explicit Cache Contract

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

## Milestone 8: UI Integration

Goal: expose hosted integrations without redesigning Agent Settings.

### Slice 8.1: Agent Settings Tool Grouping

Goal:

- Show hosted integration tools under Hosted Integrations groups.
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

## Milestone 10: Legacy Integration-Hub Migration

Goal: move from the current external `integration-hub` stdio MCP setup to
hosted integrations without breaking existing Qualys, Splunk, Microsoft Graph,
MDE, and defender-alert workflows.

### Slice 10.1: Integration-Hub Compatibility Inventory

Goal:

- Inventory existing `integration-hub` families, tools, schemas, examples,
  result-file behavior, env requirements, and known incidents.
- Produce a migration map from old MCP tool names to hosted integration tool
  names.

Non-goals:

- No code migration yet.

TDD:

- inventory fixture captures every expected old tool name
- migration map rejects missing or duplicate target tool names
- env/config requirements map to config scopes and secret refs

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- migration
```

### Slice 10.2: Migrate First Read-Only Family

Goal:

- Migrate one existing read-only family, preferably `example` or the smallest
  real family, into hosted integrations.
- Validate source, examples, promotion, registry surfacing, and invocation.

Non-goals:

- No broad Qualys migration yet.

TDD:

- migrated family exposes the expected hosted integration tool names
- examples pass through hosted integration runtime
- old result-file expectations map to run artifacts

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- migration
pnpm --filter @openacme/tools test -- hosted-integrations
```

### Slice 10.3: Migrate Security Families

Goal:

- Migrate Qualys, Splunk, Microsoft Graph, MDE, and defender-alert families
  incrementally.
- Preserve read-only/write/destructive classifications.
- Preserve known regression cases from current `ops/incidents.jsonl`.

Non-goals:

- No new target-system capabilities during migration unless needed to preserve
  existing behavior.

TDD:

- each migrated family validates with examples
- known incident reproductions become regression examples
- config scopes replace process-global env requirements
- no hosted migration stores target-system response cache unless the tool is
  explicitly classified as cached/sync

Validation:

```text
pnpm --filter @openacme/hosted-integrations test -- migration
```

### Slice 10.4: Cut Over Agent Tooling

Goal:

- Stop exposing migrated hosted integration families through the external
  `integration-hub` MCP server path.
- Keep hosted integration tools visible through `/api/tools` and Agent Settings.

Non-goals:

- Do not remove the old integration-hub workspace until parity is verified.

TDD:

- migrated hosted integration tools appear without `mcp_<server>__` names
- old MCP tool registrations can be disabled without removing hosted tools
- agents configured for hosted tools receive hosted schemas

Validation:

```text
pnpm --filter @openacme/server test -- hosted-integrations
pnpm --filter @openacme/tools test -- hosted-integrations
```

## First Implementation Slice

Start with Slice 1.1.

Why:

- It creates the package boundary without touching runtime, UI, or agent-core.
- It forces the manifest and tool classification contract into tests.
- It gives later slices stable types instead of inventing local shapes in
  server routes or tools.

Acceptance for the first PR:

- `packages/hosted-integrations` exists.
- `@openacme/hosted-integrations` exports schemas/types for family manifests,
  tool specs, examples, config scopes, runs, generations, and failure buckets.
- Runtime settings and idempotency record types are represented in the exported
  contracts.
- Unit tests cover valid and invalid manifest contracts.
- Source revision metadata is represented in the exported types.
- No server route, registry integration, or Python runtime code is added yet.

Expected validation:

```text
pnpm --filter @openacme/hosted-integrations test
pnpm --filter @openacme/hosted-integrations check-types
```
