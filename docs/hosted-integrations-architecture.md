# Hosted Integrations Architecture

Last revised: 2026-08-13.

## Goal

Hosted integrations are OpenAcme-hosted, agent-developed integration families.
They replace the current pattern of running `integration-hub` as an external
stdio MCP server, while preserving the flexible code-development loop that made
that server useful.

The target model is:

```text
Agent / UI / API
  -> ToolRegistry
  -> Hosted Integration Gateway
  -> generation-aware Python family runtime
  -> integration target systems
```

Hosted integrations are not compiled OpenAcme built-in tools. They are also not
external MCP servers. They are hosted by OpenAcme, surfaced through the normal
OpenAcme tool registry, and maintained through a managed development lifecycle.

## Vocabulary

- **Hosted integration**: A tool family hosted by OpenAcme and developed through
  the hosted integrations lifecycle.
- **Tool family**: The ownership and reload unit for related tools, such as
  `qualys`, `splunk`, `msgraph`, or `mde`.
- **Tool**: A callable operation inside a tool family, such as
  `qualys_count_assets`.
- **Tool Developer Agent**: A platform-managed agent, materialized through the
  agent catalog like Acme, that develops, fixes, validates, and promotes hosted
  integrations.
- **Draft**: Mutable source state under an edit lock.
- **Generation**: Immutable, validated, promoted runtime artifact.
- **Proposed family**: A not-yet-promoted family initialized as a draft. It is
  not visible as runtime tools until its first generation is promoted.
- **Config scope**: Human-owned non-secret config plus secret references for a
  family/environment, tracked by revision.
- **Run directory**: Per-invocation workspace for input, output, diagnostics,
  and artifacts.
- **Family home**: Persistent, family-owned workspace for explicit family state
  such as generated indexes or declared caches.
- **Failure bucket**: Deduplicated error group assigned to the Tool Developer
  Agent for repair.

Use `hosted integration` consistently for this layer. Use `built-in tool` only
for existing OpenAcme tools in `packages/tools`. Use `MCP tool` only for tools
discovered from configured MCP servers.

## Package Boundary

The package name is:

```text
packages/hosted-integrations
@openacme/hosted-integrations
```

The package owns:

- hosted integration family source and drafts
- edit locks
- example call registry
- validation and promotion lifecycle
- generation artifacts
- the Hosted Integration Gateway
- config scopes and secret references
- family workspaces and run directories
- execution logs and failure buckets
- async job state for hosted integration calls

Existing packages keep their current roles:

```text
packages/tools
  OpenAcme tool registry and existing built-in callable tools.

packages/tool-host
  Per-agent sandboxed execution host.

packages/agent-catalog
  Platform-managed agent templates, including Acme and the Tool Developer Agent.
```

`packages/tools` should see hosted integrations through thin `ToolEntry`
adapters. It should not own hosted integration source, generations, policies,
failure buckets, or config scopes.

The Hosted Integrations API is the canonical control plane. Agent-facing
management tools are wrappers over that API, not a second implementation of the
lifecycle.

## Agent Settings And Tool Surfacing

Hosted integration tools are surfaced through the existing `ToolRegistry` path.
No separate "give this agent a hosted integration" mechanism is introduced.

Current OpenAcme flow remains the control surface:

```text
ToolRegistry
  -> GET /api/tools
  -> Agent Settings / Tools tab
  -> agent.tools allowlist
  -> Agent.runStream
  -> registry.getVercelTools(selected tools)
  -> model receives tool schemas
```

MCP tools keep their existing canonical names, for example:

```text
mcp_<server>__<tool>
```

Hosted integration tools use managed canonical names:

```text
managed_<family>__<tool>
managed_qualys__qualys_count_assets
managed_qualys__qualys_list_assets
managed_splunk__splunk_search
managed_msgraph__msgraph_get
managed_mde__mde_get
```

Managed canonical names must be valid model-provider tool/function names. The
canonical-name helper owns the provider-compatible pattern and length cap. It
must reject a family/tool pair that cannot be exposed safely instead of
silently truncating, hashing, aliasing, or rewriting the public tool name.
Family ids may contain hyphens, native tool names may contain underscores, and
the `__` separator keeps parsing unambiguous.

The family manifest still owns family-native tool names. The managed prefix is
added only at the OpenAcme tool registry boundary. Runtime, examples, generation
metadata, direct Hosted Integrations API calls, async jobs, disablements,
execution logs, failure buckets, artifacts, and family source keep the
family-native tool name plus the family id. Agent Settings, model-facing tool
schemas, and registry dispatch use the managed canonical name.

Registry metadata for a hosted integration tool must carry both names:

```text
name: managed_splunk__splunk_search
source.familyId: splunk
source.toolName: splunk_search
source.generationId: gen_...
```

The registry adapter maps the managed canonical name selected by an agent back
to the family-native `source.toolName` before invoking the Hosted Integration
Gateway. Policy checks use the managed canonical name for `agent.tools` and the
family-native name for hosted integration bindings.

Hosted integration management tools remain family-scoped. Their `family_id`,
`tool_name`, example, debug-run, and failure-bucket parameters use
family-native tool names, not managed canonical names. The Tool Developer Agent
skill must teach this distinction explicitly so developer agents do not put
`managed_<family>__<tool>` names into family manifests, examples, debug runs, or
bindings.

Remote MCP tools and managed hosted integration tools are independent tool
surfaces. A remote MCP allowlist entry must not enable a managed tool, and a
managed allowlist entry must not enable a remote MCP tool. Migration metadata
may declare that a managed tool replaces a legacy MCP tool, for example:

```text
managed_splunk__splunk_search replaces mcp_integration-hub__splunk_search
```

That relationship is operational metadata for UI, parity checks, and cutover
planning. It is not an authorization alias and must not rewrite agent settings
or model-facing tool selections implicitly.

Integration-hub conversion is additive until a later decommission milestone is
explicitly approved. Porting a legacy `integration-hub` tool to a managed
hosted tool must not delete the legacy source, remove the remote MCP server, or
hide the remote MCP tool. The converted hosted tool appears as a separate
managed registry entry, and agents opt in by selecting that managed tool plus a
hosted integration binding/config scope. Parity reports may recommend a
replacement, but the platform must not silently rewrite
`mcp_integration-hub__<tool>` selections to `managed_<family>__<tool>`.

The UI should group hosted integration tools separately from built-in tools and
MCP tools:

```text
Built-in: filesystem
Built-in: terminal
MCP: github
Hosted Integrations: qualys
Hosted Integrations: splunk
Hosted Integrations: msgraph
```

Normal agents receive only invocation tools selected in their `agent.tools`
allowlist. Hosted integration management tools are reserved for the Tool
Developer Agent.

Tool selection and tool authorization are separate:

- `agent.tools` controls which tool schemas are offered to the model
- hosted integration tool bindings in Agent Settings define the per-agent
  allowed family/tool/config-scope surface
- Hosted Integrations access policy evaluates whether an invocation may run
- the Hosted Integration Gateway is the final authorization point

Agent Settings is the primary user-facing policy and binding surface for hosted
integration invocation tools. A user should be able to decide from Agent
Settings which hosted integration tools an agent may see, which config scopes
the agent may use, and which default config scope is selected for each binding.
The resulting settings are stored as policy/binding data, not as ordinary model
prompt text.

Config scope selection is also platform-owned. Normal tool schemas should not
ask the model to provide credential or tenant selection as ordinary tool
arguments.

Hosted integration tool bindings should include:

```text
agent_id
family
tool
allowed_config_scope_ids
default_config_scope_id
environment
```

For normal agent invocation, the gateway resolves the config scope from the
agent/tool binding and policy. If multiple scopes are allowed and no default is
set, invocation fails with a normalized `config_missing` error before runtime
dispatch. Management/debug tools may specify a config scope explicitly, but the
gateway still enforces policy.

Agent Settings can grant invocation access only within the caller's own
administrative permissions. It cannot grant hosted integration management-tool
access to normal agents, cannot expose secret values, and cannot bypass
destructive-operation approval requirements.

Agent Settings should avoid presenting disabled or policy-ineligible hosted
integration tools as ordinary selectable tools when the agent context is known.
If a stale or hand-edited agent config still selects a denied tool, invocation
fails at the gateway before runtime dispatch.

Hosted integration generation changes can add, change, hide, disable, or remove
tool schemas. On every promoted generation change, OpenAcme must refresh the
ToolRegistry adapter state and evict cached Agent instances whose prompts may
contain stale hosted integration tool schemas. Existing in-flight turns finish
with the tool schema snapshot they started with; new turns use the refreshed
schema set.

The schema snapshot must include the hosted integration generation id for each
tool. When `registry.getVercelTools()` creates callable adapters for a turn, the
adapter carries that generation id into the gateway invocation. This prevents a
tool call shaped by an older prompt schema from accidentally dispatching to a
newer generation after promotion. If the captured generation is no longer
available for draining, the gateway returns a normalized stale-generation tool
failure before runtime dispatch.

## Tool Family Model

The default development boundary is the tool family, not a single micro-tool.
A family owns its shared auth, client, endpoint conventions, pagination, retry
logic, error normalization, helper code, schemas, examples, and tests.

Small and medium families may be single-file Python modules. Larger families
may use a folder layout while still appearing to OpenAcme as one family:

```text
families/
  qualys/
    family.yaml
    __init__.py
    client.py
    filters.py
    tools_assets.py
    tools_detections.py
    examples.yaml
```

The runtime contract should stay family-first:

```python
def get_manifest() -> FamilyManifest: ...
def list_tools() -> list[ToolSpec]: ...
def call_tool(name: str, args: dict, ctx: ToolContext) -> ToolResult: ...
def validate() -> ValidationResult: ...
```

Tool names are stable public API. Rename and removal follow the deprecation
rules below.

## Family Runtime Settings

Family manifests should declare shared runtime settings instead of letting each
tool handler invent them.

Minimum MVP settings:

```text
default_timeout_ms
inline_result_token_limit
max_concurrency
runtime_policy
dependency_policy
```

Tool specs may override these settings only when the manifest allows it.
Promoted generations record the resolved settings they were validated with, so
runtime behavior is reproducible after later source changes.

`inline_result_token_limit` is not a model generation limit. It is the Hosted
Integration Gateway spillover threshold: results above this estimated token
size are returned as artifacts instead of inline JSON. The platform owns the
default and maximum cap. Family/tool manifests may request a lower threshold,
or a higher threshold only when policy allows it.

## Hosted Integration Gateway

All hosted integration calls pass through the Hosted Integration Gateway. A
family handler never writes the final response envelope and never bypasses the
gateway.

Gateway responsibilities:

- identify the actor
- enforce access policy
- resolve config scope and secret references
- validate input
- create the run directory
- start the execution log record
- create telemetry through the existing OpenTelemetry channel when available
- dispatch to the correct generation
- enforce timeouts and duplicate-submission/idempotency rules
- normalize errors
- mask request and response data
- enforce response size limits
- write large responses as artifacts
- finish execution logging
- create or update failure buckets for code-level failures

The caller sees only the normalized tool result. If the platform creates a
failure bucket or repair task, that is internal platform work. The requesting
agent should only see that the tool failed.

## Invocation Idempotency

Hosted integrations should not implicitly cache tool results. Idempotency is a
separate duplicate-submission safety mechanism.

Write, destructive, async-start, promotion, rollback, and lock-changing
operations should accept an idempotency key from the caller or generate one at
the API boundary. The idempotency record stores operation type, actor, target,
argument hash, generation or draft revision, and final result envelope metadata.

Rules:

- a repeated request with the same key and same operation fingerprint returns
  the original final envelope metadata
- a repeated key with a different fingerprint fails before execution
- idempotency records must not store raw secrets or unsanitized large payloads
- read-only invocations may support idempotency for transport retries, but they
  must not become an implicit response cache for later unrelated calls

## Source, Drafts, And Generations

Hosted integration source is mutable. Promoted generations are immutable.
New families start as proposed families: the API creates an edit lock and draft
from a minimal template, but no runtime tool is exposed until the first
validated generation is promoted.

Suggested layout:

```text
<dataDir>/hosted-integrations/
  source/
    families/
      qualys/
  drafts/
    draft_.../
  generations/
    gen_.../
  workspaces/
    qualys/
      home/
      runs/
```

The active runtime must load only promoted generations. It must not import
directly from mutable source or from a draft.

Canonical source may be read through authorized APIs for review and debugging.
It is not patched directly. Durable source changes happen only when an accepted
draft is promoted.

When a draft is promoted, the accepted draft becomes the new canonical family
source through an atomic source update under the family edit lock. The promoted
generation records the resulting source revision. The next draft for that
family starts from this updated source revision, not from the pre-promotion
source.

Promotion flow:

```text
need or failure
  -> Tool Developer Agent acquires family edit lock
  -> draft is created or updated
  -> examples are added or updated
  -> validation runs
  -> examples run
  -> non-destructive changes auto-promote when policy allows
  -> generation swap is applied with request draining
  -> lock is released
```

Destructive changes require human approval. Secret value changes are
human-owned and are not performed by agents.

## Edit Locks

Hosted integrations avoid merge workflows for MVP. Editing a family requires a
family-level lock with a TTL.

Lock shape:

```json
{
  "family": "qualys",
  "lock_id": "lock_...",
  "locked_by": "agent:tool-developer",
  "draft_id": "draft_...",
  "expires_at": "..."
}
```

Rules:

- a family can have only one active edit lock
- the lock owner may renew the lock
- expired locks may be taken over
- promote and cancel release the lock
- the UI must show the lock owner and expiry

## Runtime Isolation

The MVP runtime language is Python.

Hosted integration code should run outside the main daemon process. The
preferred implementation is a generation-aware worker process, reusing the
existing `tool-host` direction where practical. This keeps agent-edited code
close to the requesting agent's execution context without making the promoted
generation depend on that agent's workspace.

Runtime isolation is a policy surface, not only a process boundary. The MVP
should define the runtime policy shape even if enforcement starts conservative
and simple:

```text
filesystem: run_dir + family_home only
process_env: no raw secret export by default
subprocess: denied unless policy allows
network: allowed target egress declared by family/config scope
timeout: family default with optional tool override
concurrency: family/tool limit
```

Secrets and config are delivered through `ToolContext`, not by leaking the full
daemon environment to family code.

Execution locality and ownership are separate:

```text
caller context
  actor, session, selected config scope, path policy

hosted integration generation
  immutable platform-owned artifact

family workspace
  platform-owned family home and per-call run directories
```

## Python Dependencies

Hosted integration families may need Python dependencies. Dependency handling is
part of generation validation, not ad hoc runtime setup.

MVP dependency rules:

- dependencies are declared at the family or generation level
- V0 dependency declarations are exact Python pins under
  `runtime.dependencies`: `{ name, version }`
- `dependency_policy.allowedPackages` is an explicit allow-list; an empty list
  means the family may not declare package dependencies
- dependency installation happens in the build/validation sandbox
- promoted generations pin the resolved dependency set in
  `dependencyResolution`, including normalized package names, exact
  requirements, and a deterministic digest
- promotion provenance stores the same `dependencyResolution` so dependency
  changes are reviewable across generations
- runtime workers execute from the promoted generation artifact, not from a
  mutable development environment
- adding or changing dependencies is treated as a higher-risk non-destructive
  change and must pass validation and examples before promotion

Do not let a family install packages during normal invocation.

## Request Draining

Draining exists only to apply hosted integration changes without interrupting
active calls.

Generation lifecycle:

```text
generation 42: active
generation 43: validated
generation 43: promoted for new calls
generation 42: drains existing calls
generation 42: retired when inflight calls reach zero
```

Draining is not a retry mechanism, job orchestration system, or error-recovery
workflow. It is only the live-swap mechanism for new, updated, removed, or
disabled hosted integration tools.

## Operational Disable

Hosted integrations need a fast disable path for production safety.

Disable can apply at these levels:

```text
family
tool
generation
config scope
```

Disable is different from deprecation. Deprecation is planned API lifecycle.
Disable is an operational control that prevents new invocations from reaching
runtime. Existing calls follow normal draining/cancellation behavior based on
their execution mode.

When disabled, a tool returns a normalized disabled/policy error before runtime
dispatch. The caller still only sees that the tool failed; bucket assignment and
repair routing are platform internal.

## Tool Developer Agent

The Tool Developer Agent is a platform-managed agent created through the same
catalog and materialization path as Acme:

```text
packages/agent-catalog/templates/tool-developer/AGENT.md
managed: true
default_id_hint: tool-developer
```

`ensureManagedAgents()` materializes it if missing. Managed-agent edit/delete
protection applies through the existing AgentManager behavior.

The Tool Developer Agent owns routine hosted integration development:

- implement requested integration capabilities
- add and maintain examples
- validate drafts
- run debug calls
- promote non-destructive changes when policy allows
- investigate failure buckets
- turn fixed failures into regression examples

It should not read or write secret values.

The Tool Developer Agent should be bundled with this skill:

```text
hosted-integrations-development
```

That skill is the operational runbook for the lifecycle. It should explain:

- how to classify an incoming request as new capability, bug, question, or
  config issue
- how to inspect families, tools, generations, examples, and failure buckets
- how to acquire and renew a family edit lock
- how to create or update a draft
- how to add examples
- how to validate a draft
- how to run examples and debug runs
- how to promote non-destructive changes
- how to handle destructive changes by asking for human approval
- how to convert a fixed failure into a regression example
- how to close a failure bucket
- how to avoid reading or writing secret values

The skill should reference this architecture document for contracts, but it
should be written as a practical operator guide for the Tool Developer Agent.
Normal agents do not need this skill.

## Management Tools

The Tool Developer Agent gets hosted integration management tools. Normal
agents should not receive these tools.

Expected management tools:

```text
hosted_integration_family_list
hosted_integration_family_create
hosted_integration_source_read
hosted_integration_lock_acquire
hosted_integration_lock_renew
hosted_integration_lock_release
hosted_integration_draft_create
hosted_integration_draft_get
hosted_integration_draft_patch
hosted_integration_draft_delete
hosted_integration_example_list
hosted_integration_example_upsert
hosted_integration_example_run
hosted_integration_validate
hosted_integration_promote
hosted_integration_generation_list
hosted_integration_generation_get
hosted_integration_generation_rollback
hosted_integration_config_scope_list
hosted_integration_config_scope_get
hosted_integration_debug_run
hosted_integration_run_get
hosted_integration_artifact_get
hosted_integration_failure_bucket_list
hosted_integration_failure_bucket_get
hosted_integration_failure_bucket_assign
hosted_integration_failure_bucket_close
```

These tools should wrap the Hosted Integrations API. They should not duplicate
the package's lifecycle logic.

These are OpenAcme model-facing tools, not tools discovered from an external MCP
server. They may use the same JSON-schema tool shape as other OpenAcme tools,
but they are registered through `packages/tools` and executed through OpenAcme's
own runtime.

Mapping from management tools to API routes:

```text
hosted_integration_family_list
  -> GET /api/hosted-integrations/families

hosted_integration_family_create
  -> POST /api/hosted-integrations/families

hosted_integration_source_read
  -> GET /api/hosted-integrations/families/:family
  -> GET /api/hosted-integrations/families/:family/source/files
  -> GET /api/hosted-integrations/families/:family/source/files/*path
  -> GET /api/hosted-integrations/drafts/:draftId/files/*path

hosted_integration_lock_acquire
  -> POST /api/hosted-integrations/families/:family/lock

hosted_integration_lock_renew
  -> POST /api/hosted-integrations/locks/:lockId/renew

hosted_integration_lock_release
  -> DELETE /api/hosted-integrations/locks/:lockId

hosted_integration_draft_create
  -> POST /api/hosted-integrations/families/:family/drafts

hosted_integration_draft_get
  -> GET /api/hosted-integrations/drafts/:draftId
  -> GET /api/hosted-integrations/drafts/:draftId/files
  -> GET /api/hosted-integrations/drafts/:draftId/files/*path

hosted_integration_draft_patch
  -> PUT /api/hosted-integrations/drafts/:draftId/files/*path

hosted_integration_draft_delete
  -> DELETE /api/hosted-integrations/drafts/:draftId/files/*path

hosted_integration_example_list
  -> GET /api/hosted-integrations/drafts/:draftId/examples

hosted_integration_example_upsert
  -> POST /api/hosted-integrations/drafts/:draftId/examples

hosted_integration_example_run
  -> POST /api/hosted-integrations/drafts/:draftId/run-example

hosted_integration_validate
  -> POST /api/hosted-integrations/drafts/:draftId/validate

hosted_integration_promote
  -> POST /api/hosted-integrations/drafts/:draftId/promote

hosted_integration_generation_list
  -> GET /api/hosted-integrations/generations

hosted_integration_generation_get
  -> GET /api/hosted-integrations/generations/:generationId

hosted_integration_generation_rollback
  -> POST /api/hosted-integrations/generations/:generationId/rollback

hosted_integration_config_scope_list
  -> GET /api/hosted-integrations/config-scopes

hosted_integration_config_scope_get
  -> GET /api/hosted-integrations/config-scopes/:scopeId

hosted_integration_debug_run
  -> POST /api/hosted-integrations/debug-runs

hosted_integration_run_get
  -> GET /api/hosted-integrations/runs/:runId

hosted_integration_artifact_get
  -> GET /api/hosted-integrations/runs/:runId/artifacts/:name

hosted_integration_failure_bucket_list
  -> GET /api/hosted-integrations/failure-buckets

hosted_integration_failure_bucket_get
  -> GET /api/hosted-integrations/failure-buckets/:bucketId

hosted_integration_failure_bucket_assign
  -> POST /api/hosted-integrations/failure-buckets/:bucketId/assign

hosted_integration_failure_bucket_close
  -> POST /api/hosted-integrations/failure-buckets/:bucketId/close
```

The API remains useful for UI and automation. The tools make the same lifecycle
available to the Tool Developer Agent without giving that agent filesystem or
secret access beyond the Hosted Integrations access policy.

## API Surface

Existing tool selection endpoints remain in place:

```http
GET /api/tools
PATCH /api/agents/:id
```

Hosted integration API routes live under:

```http
/api/hosted-integrations
```

Family and tool discovery:

```http
GET /api/hosted-integrations/families
POST /api/hosted-integrations/families
GET /api/hosted-integrations/families/:family
GET /api/hosted-integrations/families/:family/tools
```

Locks, source, and drafts:

```http
POST   /api/hosted-integrations/families/:family/lock
POST   /api/hosted-integrations/locks/:lockId/renew
DELETE /api/hosted-integrations/locks/:lockId

GET  /api/hosted-integrations/families/:family/source/files
GET  /api/hosted-integrations/families/:family/source/files/*path

POST /api/hosted-integrations/families/:family/drafts
GET  /api/hosted-integrations/drafts/:draftId
GET  /api/hosted-integrations/drafts/:draftId/files
GET  /api/hosted-integrations/drafts/:draftId/files/*path
PUT  /api/hosted-integrations/drafts/:draftId/files/*path
DELETE /api/hosted-integrations/drafts/:draftId/files/*path
```

Examples, validation, and promotion:

```http
GET  /api/hosted-integrations/drafts/:draftId/examples
POST /api/hosted-integrations/drafts/:draftId/examples
POST /api/hosted-integrations/drafts/:draftId/validate
POST /api/hosted-integrations/drafts/:draftId/run-example
POST /api/hosted-integrations/drafts/:draftId/promote
```

Generations:

```http
GET  /api/hosted-integrations/generations
GET  /api/hosted-integrations/generations/:generationId
POST /api/hosted-integrations/generations/:generationId/rollback
```

Invocation, debug runs, and async jobs:

```http
POST /api/hosted-integrations/invoke
POST /api/hosted-integrations/debug-runs
GET  /api/hosted-integrations/runs/:runId
GET  /api/hosted-integrations/runs/:runId/artifacts/:name

POST /api/hosted-integrations/jobs
GET  /api/hosted-integrations/jobs/:jobId
POST /api/hosted-integrations/jobs/:jobId/cancel
GET  /api/hosted-integrations/jobs/:jobId/result
```

Failure buckets:

```http
GET  /api/hosted-integrations/failure-buckets
GET  /api/hosted-integrations/failure-buckets/:bucketId
POST /api/hosted-integrations/failure-buckets/:bucketId/assign
POST /api/hosted-integrations/failure-buckets/:bucketId/close
```

Config scopes and secrets:

```http
GET /api/hosted-integrations/config-scopes
GET /api/hosted-integrations/config-scopes/:scopeId
PUT /api/hosted-integrations/config-scopes/:scopeId
PUT /api/hosted-integrations/config-scopes/:scopeId/secrets
```

Secret endpoints are human-only. Read endpoints never return secret values.

## Config Scopes And Secrets

Secret values are human-owned. Agents may inspect only sanitized config-scope
metadata.

OpenAcme already keeps credentials out of user-editable config files and writes
credential files with atomic `0600` semantics. Hosted integrations should use
the same pattern.

Suggested layout:

```text
<dataDir>/hosted-integrations/
  config-scopes/
    qualys-prod-readonly.json
  secrets/
    qualys-prod-readonly.json
```

Config scope file:

```json
{
  "id": "qualys-prod-readonly",
  "family": "qualys",
  "revision": 7,
  "environment": "prod",
  "config": {
    "QUALYS_BASE_URL": "https://..."
  },
  "secrets": {
    "QUALYS_USERNAME": { "configured": true },
    "QUALYS_PASSWORD": { "configured": true }
  },
  "updated_at": "...",
  "updated_by": "human:..."
}
```

Secret file:

```json
{
  "QUALYS_USERNAME": "...",
  "QUALYS_PASSWORD": "..."
}
```

Invocation logs record only:

```json
{
  "config_scope_id": "qualys-prod-readonly",
  "config_revision": 7
}
```

Secret rollback is a human config operation. Hosted integration generation
rollback does not roll back secret values.

Generation rollback is runtime-only. It changes the active generation pointer
but does not rewrite canonical family source. If the source should be reverted,
the Tool Developer Agent creates a new draft from the canonical source, applies
the revert as an explicit source change, validates it, and promotes a new
generation.

## Tool Context

Every hosted integration call receives a `ToolContext` from the gateway.

```python
@dataclass
class ToolContext:
    actor_id: str
    invocation_id: str
    family_name: str
    tool_name: str
    generation_id: str
    family_home: Path
    run_dir: Path
    config: Mapping[str, str]
    secrets: SecretMapping
    logger: ToolLogger
```

Family code should read config and secrets from `ToolContext`, not directly
from process-global environment variables.

## Workspaces And Artifacts

Each family has a persistent family home. Each invocation has a unique run
directory.

Suggested layout:

```text
<dataDir>/hosted-integrations/workspaces/
  qualys/
    home/
      cache/
      indexes/
      reference-data/
    runs/
      call_.../
        input.sanitized.json
        output.json
        error.json
        diagnostics.json
        artifacts/
```

Rules:

- family home is platform-owned, not caller-agent-owned
- run directories are invocation-scoped
- tools should not write to global temp or arbitrary repo paths
- artifacts are read through platform-authorized APIs, not by leaking raw path
  access as the primary contract
- sanitized run/artifact access is allowed for the original caller, authorized
  human admins, and the Tool Developer Agent when assigned to the related
  failure bucket
- raw artifacts, if retained at all, are restricted to explicit elevated
  platform permissions and are never returned through ordinary management tools
- successful run artifacts may expire by retention policy
- failed run artifacts remain until the related failure bucket closes, then
  follow retention policy

## Response Size Governance

The Hosted Integration Gateway decides whether a response is inline or
artifact-backed.

Small response:

```json
{
  "ok": true,
  "result": {}
}
```

Large response:

```json
{
  "ok": true,
  "result_ref": {
    "type": "artifact",
    "run_id": "call_...",
    "name": "output.json",
    "size_bytes": 1842031,
    "estimated_tokens": 420000
  }
}
```

Sanitization happens before caller-visible output is returned or written to
caller-visible artifacts. Raw artifacts, if retained at all, require a separate
restricted permission.

## Access Policy

Access control is enforced in the Hosted Integration Gateway, not in family
code.

Policy dimensions:

- actor
- family
- tool
- operation class
- config scope
- environment
- debug/run mode

Default behavior is deny by default.

Runtime invocation, debug invocation, draft editing, promotion, rollback, and
secret/config editing are separate operation classes.

## Tool Classification

Every tool declares classification metadata in the family manifest.

Minimum fields:

```text
operation: read | write | destructive
freshness: live | cached | sync
idempotency: idempotent | non_idempotent
execution: sync | async
approval: none | confirm | human
```

Destructive changes and destructive tool operations require human approval.
Non-destructive hosted integration changes may be promoted autonomously when
examples and validation pass and policy allows it.

## Human Approval Gate

The MVP does not need a separate approval workflow engine. Human approval means
the operation is performed through a human-authenticated UI/API action and the
approval actor is recorded on the resulting operation metadata.

Agent-facing management tools cannot self-approve destructive changes. They may
prepare the draft, validation result, examples, and approval summary, but the
destructive promotion or destructive invocation is blocked until a human actor
performs the approving action.

## Cache Contract

Hosted integrations do not cache by default.

A tool may use a cache only when cache behavior is explicit in the family
manifest and tool description. Examples:

```text
freshness: live
freshness: cached
freshness: sync
```

Explicit cache metadata should include:

```text
cache_scope
cache_ttl
cache_source
refresh_tool
last_sync_metadata
```

Family-owned caches live under family home. They do not grant the caller agent
write access to the family home.

## Examples And Validation

Examples are first-class lifecycle data. They are used for development,
debugging, promotion, and regression.

Example categories:

```text
smoke
live_safe
regression
mock_only
destructive_requires_human
```

Promotion requires the relevant examples to pass. If a production failure is
fixed, the failing repro becomes a regression example before the failure bucket
is closed.

The Tool Developer Agent may choose the initial example set. If the expected
coverage is ambiguous, it should ask one focused question.

## Error Taxonomy

Hosted integrations use a small standard error taxonomy with room for
family-specific details.

Standard fields:

```text
category:
  bad_args
  policy_denied
  config_missing
  auth_failed
  rate_limited
  target_error
  timeout
  tool_bug
  unknown

retryable: boolean
owner_actionable: boolean
user_visible_message: string
details_ref: optional artifact reference
vendor_code: optional string
family_error_type: optional string
```

The taxonomy should stay small. Family-specific detail belongs in structured
metadata, not in an expanding platform-wide enum.

## Failure Buckets

The platform should expect hosted integration code to fail sometimes. The goal
is proactive repair, not a claim that every promoted tool is perfect.

When the gateway sees a code-level or owner-actionable failure, it creates or
updates a failure bucket. Bucketization should be based on a stable fingerprint:

```text
family
tool
generation
standard error category
normalized stack or vendor code hash
sanitized argument shape/hash when useful
```

Bucket record:

```json
{
  "bucket_id": "bucket_...",
  "family": "qualys",
  "tool": "qualys_count_assets",
  "fingerprint": "sha256:...",
  "count": 3,
  "latest_run_ref": "call_...",
  "assigned_to": "agent:tool-developer",
  "status": "open",
  "first_seen": "...",
  "latest_seen": "..."
}
```

Keep the bucket lifecycle simple:

```text
open -> closed
```

The Tool Developer Agent can use comments, memory, or task notes for richer
investigation state. The canonical repro evidence remains in execution logs and
run artifacts.

## Caller Experience

The caller should not be asked to manage the repair loop.

If a hosted integration fails, the caller receives a normal failed tool result,
for example:

```json
{
  "ok": false,
  "error": {
    "category": "tool_bug",
    "message": "tool failed"
  }
}
```

The failure bucket, assignment, repro package, and repair task are platform
internal.

## Debug Runs

Debug runs use the same gateway and policy model as normal invocations.

Debug runs may target a draft or a promoted generation. They create a run
directory, execution log, diagnostics artifact, and standard result envelope.

Debug and replay permissions are separate from normal invocation permissions.
Replay of write or destructive tools requires the tool classification and
approval policy to allow it.

## Async Jobs

Async support is opt-in per tool.

Minimal contract:

```text
start -> job_id
status(job_id)
cancel(job_id)
result(job_id) -> result_ref
```

Cancellation applies only to async jobs. Progress is returned as the latest
status snapshot. MVP does not require resumable progress event streams.

## Deprecation And Removal

Tool removal is a breaking change and should not happen as a direct delete.

Lifecycle:

```text
deprecated
  -> hidden from new prompts
  -> disabled
  -> removed
```

Breaking schema changes and removals require explicit policy approval. Additive
read-only tools and non-destructive bug fixes may auto-promote when validation
passes.

## Observability

Hosted integrations should emit execution logs as canonical audit/debug
records. They should also use the existing OpenTelemetry channel for spans,
metrics, and events where available.

OpenTelemetry integration is an observability concern, not the defining
capability of hosted integrations. It should not make the MVP lifecycle harder
to use.

## MVP Non-Goals

Do not include these in the MVP:

- TypeScript hosted integration family runtime
- mandatory canary promotion
- merge workflows for simultaneous edits
- resumable progress event streams
- automatic secret rotation
- broad platform-wide error enum expansion
- direct caller involvement in failure repair routing
- treating hosted integrations as external MCP servers

## Open Questions

These remain implementation choices, not unresolved product direction:

- long-term persistence backend after the MVP file-backed stores
- exact worker process lifecycle and generation loading protocol
- exact sandbox enforcement implementation for filesystem/process/network
- exact UI placement for hosted integration family management
- exact retention defaults for successful and failed run artifacts
- exact policy file/schema shape
