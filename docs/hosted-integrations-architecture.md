# Hosted Integrations Architecture

Last revised: 2026-08-14.

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
OpenAcme tool registry, and maintained through a hosted tool development lifecycle.

Product principle: OpenAcme is agent-first, but human-native. Agents should be
able to develop, validate, repair, and promote hosted integrations
autonomously where policy allows, but every lifecycle capability must also be
available to authorized humans through first-class UI/API surfaces. A human
operator should be able to inspect families, understand tool mappings, edit
source, validate, run examples/debug calls, compare versions, approve, promote,
rollback, and repair without asking an agent to perform the action.

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
- **Environment config**: Human-owned non-secret config plus secret references
  for a family in one of the two supported runtime environments: `prod` or
  `test_debug`. It is tracked by revision and is not agent-specific.
- **Agent hosted-tool binding**: Per-agent policy and selection data that says
  which hosted tool the agent may use, which environments are allowed, which
  environment is the default, and whether the agent is pinned to a non-current
  generation. These bindings are not separate
  environment configs.
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
- environment configs and secret references
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
failure buckets, or environment configs.

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

Hosted integration tools use hosted canonical names:

```text
hosted_<family>__<tool>
hosted_qualys__qualys_count_assets
hosted_qualys__qualys_list_assets
hosted_splunk__splunk_search
hosted_msgraph__msgraph_get
hosted_mde__mde_get
```

Hosted tool canonical names must be valid model-provider tool/function names. The
canonical-name helper owns the provider-compatible pattern and length cap. It
must reject a family/tool pair that cannot be exposed safely instead of
silently truncating, hashing, aliasing, or rewriting the public tool name.
Family ids may contain hyphens, native tool names may contain underscores, and
the `__` separator keeps parsing unambiguous.

The family manifest still owns family-native tool names. The hosted prefix is
added only at the OpenAcme tool registry boundary. Runtime, examples, generation
metadata, direct Hosted Integrations API calls, async jobs, disablements,
execution logs, failure buckets, artifacts, and family source keep the
family-native tool name plus the family id. Agent Settings, model-facing tool
schemas, and registry dispatch use the hosted canonical name.

Registry metadata for a hosted integration tool must carry both names:

```text
name: hosted_splunk__splunk_search
source.familyId: splunk
source.toolName: splunk_search
source.generationId: gen_...
```

The registry adapter maps the hosted canonical name selected by an agent back
to the family-native `source.toolName` before invoking the Hosted Integration
Gateway. Policy checks use the hosted canonical name for `agent.tools` and the
family-native name for hosted integration bindings.

Hosted integration management tools remain family-scoped. Their `family_id`,
`tool_name`, example, debug-run, and failure-bucket parameters use
family-native tool names, not hosted canonical names. The Tool Developer Agent
skill must teach this distinction explicitly so developer agents do not put
`hosted_<family>__<tool>` names into family manifests, examples, debug runs, or
bindings.

Remote MCP tools and hosted tools are independent tool
surfaces. A remote MCP allowlist entry must not enable a hosted tool, and a
hosted tool allowlist entry must not enable a remote MCP tool. Offline
parity/replacement metadata may declare that a hosted tool replaces a legacy MCP
tool, for example:

```text
hosted_splunk__splunk_search replaces mcp_integration-hub__splunk_search
```

That relationship is offline operational metadata for parity checks,
replacement evidence, and decommission planning. It is not an authorization
alias and must not
rewrite agent settings or model-facing tool selections implicitly. It must not
be exported from the hosted integration runtime package, exposed as a product
readiness state, or carried by the API/tool surface used by normal hosted
integration lifecycle work.

Live parity validation is an operator command, not CI-required behavior. The
runner connects to the selected legacy MCP server and invokes the matching
hosted tool with equivalent safe read-only intent. Equivalence may use
different argument shapes when the legacy and hosted schemas differ; for
example, legacy Qualys Cloud Agent QPS tools use `criteria`, while hosted
source-backed Qualys tools use GAV `filter_body` plus the hosted QAGENT
constraint. The runner writes sanitized evidence only: match/mismatch status,
summary fingerprints, hosted run ids, failure bucket ids when present, and
artifact references. It must not write target-system state unless the tool is
classified write/destructive and separately approved.

Integration-hub parity/replacement work is additive until a later decommission
milestone is explicitly approved. Developing a hosted tool replacement for a
legacy `integration-hub` tool must not delete the legacy source, remove the
remote MCP server, or hide the remote MCP tool. The hosted replacement appears as a
separate hosted registry entry, and agents opt in by selecting that hosted
tool plus a hosted-tool binding. Parity reports may recommend a replacement,
but the platform must not silently rewrite `mcp_integration-hub__<tool>`
selections to `hosted_<family>__<tool>`.

Integration-hub tool definitions, examples, and environment config blocks may
be read by operator/test scripts as parity inputs. They are not hosted
integration runtime code and must not be embedded into application runtime
modules, package root exports, hosted tool schemas, readiness resolvers, or
HTTP routes. Test scripts that seed hosted replacement tools and run parity are
allowed when they are clearly outside the product runtime and write through the
normal hosted integration store/API boundaries; they must not create a second
lifecycle implementation. Removed legacy URLs may have explicit 404 tombstones
to avoid SPA fallback ambiguity; those tombstones are not lifecycle routes and
must not return readiness payloads.

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
  allowed family/tool/environment/generation surface
- Hosted Integrations access policy evaluates whether an invocation may run
- the Hosted Integration Gateway is the final authorization point

Agent Settings is the primary user-facing policy and binding surface for hosted
integration invocation tools. A user should be able to decide from Agent
Settings which hosted integration tools an agent may see, which product
environment the agent defaults to, whether the agent follows the current active
generation, and whether a binding note explains a non-default pin.
The resulting settings are stored as policy/binding data, not as ordinary model
prompt text.

Environment configs are not a general-purpose place to model every
caller-specific variant. The product-level environment set is intentionally
small: `prod` and `test_debug`. More environment labels such as `dev`,
`stage`, `demo`, or `parity` create avoidable operational choice.
Caller-specific behavior belongs to the agent hosted-tool binding layer:
allowed environments, default environment, optional generation/version pin,
internal runner purpose, and an optional binding note.

Per-agent custom runtime config is explicitly unsupported. Agent hosted-tool
bindings must not carry config values, secret references, endpoint overrides,
tenant overrides, credential selectors, custom environment config ids, or
environment config revision pins. If a future product needs tenant/profile level
config isolation, it must be introduced as a new first-class primitive rather
than by extending agent bindings or resurrecting custom config scopes.

The Hosted Tools settings surface should show the family-level environment
configs and, on the same screen, an agent matrix for that family/tool: which
agents can use the tool, which environment each agent defaults to, whether the
agent follows the current active generation or is pinned to a specific
generation/version, and any binding note explaining a non-default pin. Internal
parity/debug runners should appear as internal agent bindings, not as normal
human-facing environment configs.

Hosted-tool binding controls are part of the hosted tool selection task. They
should render adjacent to the selected hosted tool groups in Agent Settings, not
after the full built-in/MCP/system tool catalog, so the user can complete access
policy setup while the selected hosted tools are still in context.

Agent Settings tool groups should also keep currently selected groups ahead of
unselected catalog groups. An existing agent's active tool/access policy is the
primary inspection target; unselected tools are available catalog choices, not
the first thing a human should scan.

Long hosted tool names in Agent Settings should wrap enough to distinguish the
actual operation. Truncating every selected hosted tool at the common
`hosted_<family>__...` prefix hides the policy target and forces the user to
infer access from descriptions. The same rule applies to hosted tool access
binding rows; environment and generation controls should be labeled directly,
not left as unlabeled selects next to a clipped hosted registry name.

Environment config selection is platform-owned. Normal hosted tool schemas must
not ask the model to provide credential, tenant, environment, or config
selection as ordinary tool arguments.

Hosted integration tool bindings should include:

```text
agentId
familyId
toolName
allowedEnvironments: non-empty subset of [prod, test_debug]
defaultEnvironment: prod | test_debug
generationPin: { type: "current" } | { type: "generation", generationId: string }
bindingKind: normal | internal
purpose?: debug | parity | dogfood | maintenance
bindingNote?
updatedAt
updatedBy
```

Binding identity is unique by `(agentId, familyId, toolName)`. Internal runners use
their own stable agent ids, so they do not require multiple bindings for the
same visible human agent. `defaultEnvironment` must be present in
`allowedEnvironments`. Normal human-edited bindings default to `prod` when a
`prod` environment config exists, otherwise `test_debug`; internal
debug/parity/dogfood bindings default to `test_debug`.

Reserved internal runner actor ids:

```text
agent:hosted-integrations:debug
agent:hosted-integrations:live-parity
agent:hosted-integrations:dogfood
```

These actors are platform-owned. They may have internal bindings, but they do
not appear as normal workforce agents in Agent Settings. They are used for
platform-initiated runner jobs only. Interactive Tool Developer Agent work keeps
the Tool Developer Agent's own actor id and marks the invocation purpose as
`tool_maintenance`; it does not impersonate the reserved debug actor.

For normal agent invocation, the gateway resolves the environment config from
the agent/tool binding and policy. Normal model-facing tool calls do not carry a
environment config id or environment argument. Debug control-plane calls accept
an optional `environment` field that defaults to `test_debug`; `prod` is
accepted only when the actor is an authorized human or internal maintenance
actor and the request includes `allowProdEnvironment: true`. The gateway still
enforces the actor's binding, operation class, and approval policy before
runtime dispatch.

Generation pin resolution is part of tool surfacing, not only invocation. When a
binding uses `{ type: "current" }`, the ToolRegistry exposes the active
generation's schema for that family/tool and carries the captured generation id
into the gateway call. When a binding uses `{ type: "generation" }`, the
ToolRegistry exposes that pinned generation's schema and the gateway accepts
only that captured generation id for the call. If the pinned generation is
retired, disabled, or no longer available for draining, the tool is hidden from
new turns and stale in-flight calls fail before runtime dispatch.

Agent Settings can grant invocation access only within the caller's own
administrative permissions. It cannot grant hosted integration management-tool
access to normal agents, cannot expose secret values, and cannot bypass
destructive-operation approval requirements.

Hosted-tool bindings are stored on the existing `AgentDefinition` model. Hosted
Integrations must not introduce a second authoritative policy store for the same
agent/tool access decision. The Hosted Integrations API may expose computed
read-models such as an agent matrix for a family/tool, but binding writes route
through the existing Agent Settings/agent-definition persistence path and update
that single source of truth.

Agent Settings should avoid presenting disabled or policy-ineligible hosted
integration tools as ordinary selectable tools when the agent context is known.
If a stale or hand-edited agent config still selects a denied tool, invocation
fails at the gateway before runtime dispatch.

## Workflow State And Readiness Resolvers

Hosted integrations must not spread lifecycle decisions across UI components,
API handlers, management tools, and runtime dispatch. Workflow state is resolved
by shared deterministic readiness resolvers, and every surface renders or
enforces those resolver results.

The canonical resolver layer owns these decisions:

```text
resolveEnvironmentConfigReadiness(familyId, environment)
resolveAgentHostedToolBinding(agentId, familyId, toolName)
resolvePublishReadiness(draftId)
resolveDebugReadiness(actor, familyId, toolName, requestedEnvironment?)
resolveInvocationReadiness(actor, familyId, toolName, capturedGenerationId)
```

Resolver results are structured and sanitized:

```text
status
code
target
blockers[]
sanitizedDetails?
```

Resolvers never return secret values, raw credentials, provider tokens, or
unmasked request/response payloads. They may return missing key names,
environment names, tool/family ids, generation ids, and policy reason codes.

State machines:

- Environment config readiness:
  `missing | incomplete | ready | conflicted | quarantined`
- Hosted-tool binding readiness:
  `missing | invalid | ready | denied | stale_generation`
- Publish readiness:
  `draft_missing | lock_required | validation_required | validation_failed |
runtime_config_contract_missing | production_config_missing |
production_config_incomplete | ready`
- Debug readiness:
  `ready | actor_denied | approval_required | environment_missing |
environment_incomplete | prod_environment_requires_explicit_allow |
tool_not_debuggable`
- Invocation readiness:
  `ready | tool_not_enabled | binding_missing | binding_invalid |
environment_missing | environment_incomplete | generation_stale |
tool_disabled | approval_required`

The UI uses resolver output to decide which actions are visible, disabled, or
blocked and to explain blockers with the same reason codes the API returns. API
handlers enforce the same resolver decisions before mutating state. Management
tools call the API instead of reimplementing readiness logic. The gateway
rechecks invocation readiness immediately before runtime dispatch because stale
prompts, retired generations, policy edits, and draining windows can change
between tool surfacing and tool execution.

Hosted integration generation changes can add, change, hide, disable, or remove
tool schemas. On every promoted generation change, OpenAcme must refresh the
ToolRegistry adapter state and evict cached Agent instances whose prompts may
contain stale hosted integration tool schemas. Existing in-flight turns finish
with the tool schema snapshot they started with; new turns use the refreshed
schema set.

The registry revision is a cache-invalidation signal, not an authorization
model. Cached Agent instances are built against the current
`ToolRegistry.generation`; if the registry generation changes, the next
activation rebuilds the Agent before emitting model-facing tool schemas. Agent
Settings still owns the grant: the agent only receives exact tool names already
listed in its configured tool allowlist and hosted-tool binding data. This lets
already-open sessions pick up hosted tool changes on the next turn without
introducing wildcard grants or mixing remote MCP grants with hosted tools.

Hosted tools are global ToolRegistry entries, not per-agent MCP servers. Agent
specificity is applied by the existing agent tool allowlist and hosted-tool
binding resolver when an Agent is built or a turn emits model-facing tools.
Draining is also not per-agent: update/delete lifecycle waits only for active
invocation leases against the affected generation or family, regardless of which
agent started them. Idle agents and sessions without an in-flight affected call
do not block draining.

When a session picks up a newer catalog generation, the platform should make
that fact visible in the chat without adding model-visible history. Generic
agent lookup does not know the session, so catalog refresh returns enough
metadata for session-aware turn entrypoints such as interactive chat,
autonomous dispatcher turns, and `agent_ask` target turns to record the
sanitized session timeline event and broadcast a UI-only session context
notice. The notice contains the previous generation, the new generation,
added/removed effective tool names, a response/turn anchor, and whether each
added hosted tool was already granted through Agent Settings. If the registry
generation changed but the effective model-facing tool-name set did not, the
Agent is rebuilt but no chat notice is shown. The chat UI renders notices inline
using the same pattern as other context notices, and reloads can recover them
from the session timeline by event type. This event is explanatory only; it
must not expand the agent's access or become a user/assistant message in the
model input.

Each turn should resolve the Agent and catalog-refresh metadata once, then reuse
that resolved Agent through preflight, memory recall, model execution, and
post-turn hooks. This prevents a single turn from preparing context against one
tool catalog generation and executing against another. Effective tool-name
snapshots must be derived from the same ToolRegistry emission rules as the
provider call, including registered tool presence, per-tool `checkFn` gating,
and turn-level filters such as `agent_ask` excluding itself. The registry should
provide a lightweight emitted-name helper so this snapshot does not require
constructing provider tool objects or JSON schemas.

UI delivery is explicit because timeline persistence and chat rendering are
separate surfaces. `useLiveSession` must handle the catalog notice as its own
SSE event, not as `messages_appended`; full-page chat and the Acme panel keep
the notice in UI-side state and render it between messages. History reloads
merge matching timeline events back into that UI-side notice state. This keeps
the human explanation durable and visible while preserving canonical chat
history as only user/assistant conversation.

The catalog notice contract uses durable timeline event type
`session.tool_catalog.changed` and SSE kind `tool_catalog_notice`. The payload
is metadata-only: agent id, previous/current catalog generation, added/removed
effective tool names, hosted-tool grant status for added hosted tools, and
optional response message/task anchors. It must never include tool arguments,
config values, secrets, source code, or raw registry entries. The timeline API
supports filtering by `eventType` so UI reload recovery can fetch catalog
notices directly instead of scanning unrelated timeline pages.

The schema snapshot must include the hosted integration generation id for each
tool. When `registry.getVercelTools()` creates callable adapters for a turn, the
adapter carries that generation id into the gateway invocation. This prevents a
tool call shaped by an older prompt schema from accidentally dispatching to a
newer generation after promotion. If the captured generation is no longer
available for draining, the gateway returns a normalized stale-generation tool
failure before runtime dispatch.

## Human-Native Hosted Tools UX

Hosted Tools is a human-native admin surface over the same hosted integration
control plane used by agents. The UI must let an authorized human inspect and
change every lifecycle detail without exposing the human to unnecessary
internal choreography.

The surface follows these principles:

- **Selection and identity live once**: the left rail owns family/tool
  selection. The work pane may show a compact context line, but it should not
  start with another large family/tool restatement after the user has already
  selected `family > tool`.
- **Navigation identity is runtime-first**: if the control plane has both an
  active family summary and a proposed draft summary for the same family id, the
  normal family/tool navigation resolves that identity to the active runtime
  family. Proposed drafts belong in explicit creation/review flows, not as
  duplicate primary navigation identities for the same family.
- **Navigable state is URL-addressable**: selected family, selected tool,
  primary tab, and meaningful sub-tab state belong in the URL for top-level
  Hosted Tools surfaces. Refresh, back/forward, and shared links should restore
  the user's work location instead of falling back to the first family or a
  default tab. Component memory can cache transient edit fields, but it must not
  be the only source for navigation identity.
- **The work pane starts with work**: after a family/tool is selected, the right
  pane should start at the active task, such as source, help, files, logs, or
  publish state. Intermediary banners, registry summaries, or "workbench"
  strips are justified only when they directly change what the user can decide
  or do next.
- **Navigation is bounded on constrained screens**: family/tool navigation is a
  selection aid, not the work surface. On mobile and other constrained
  viewports, the navigation region must not push the active tool workspace out
  of reach; it should use bounded scrolling, single-row scrollable tab strips,
  compact horizontal selectors, or collapse/expand behavior while preserving
  access to every family, tool, file, and task tab. Bounded selectors must also
  be width-contained so their scrollable content does not expand the work pane,
  and the current target should remain visible without requiring horizontal
  scrolling first. Auto-scrolling a selected tab or selector item should use
  contained alignment and scroll padding so the selected target is readable
  without leaving a clipped fragment of a neighboring label visible as broken
  UI text. Horizontal task strips also need enough trailing scroll room for
  end-of-list tabs to align cleanly; otherwise later tabs can never become the
  first readable item and the viewport exposes partial labels from earlier
  tasks.
- **Top-level placement is cross-viewport**: if Hosted Tools is promoted to a
  top-level product surface, both desktop and mobile primary navigation expose
  it, and command/search navigation can route to it by name. Mobile bottom
  navigation stays a single row; adding a surface must not wrap the bar into a
  second row or hide the current page behind Settings.
- **Name UI by user task, not platform plumbing**: primary actions use lifecycle
  verbs such as `Edit`, `Save`, `Validate`, `Test`, `Publish`, `Rollback`, and
  `Discard`. Labels such as `Registry`, `Workbench`, `Workspace`, or `Controls`
  are allowed only when that section owns a concrete task that cannot be named
  more directly. Internal primitives such as lock acquisition, draft creation,
  generation ids, source revisions, and expiry timestamps remain metadata or
  diagnostic details.
- **Section headers must own decisions**: a named section is not useful merely
  because the backend has a matching concept. If `Hosted Tools`, family/tool
  navigation, or the active tab already explains the context, another
  `Registry`, family title, or status band should be removed, collapsed, or
  converted into a small action/status row. Page-level utility actions can live
  in the page header only when their scope is truly page-wide.
- **Empty states stay quiet**: "nothing here yet" surfaces such as no agents,
  no files, no examples, or no logs should use whitespace, muted text, and a
  small familiar icon instead of table borders, top/bottom rules, nested boxes,
  or heavy section chrome. Empty states should explain the absence and, only
  when there is a direct next action, show that action nearby.
- **Prerequisites are not empty states**: when a tab cannot be used until the
  human selects a tool, grants permission, adds environment config, or satisfies
  a policy constraint, the UI should show a requirement notice instead of a
  quiet empty state. Requirement notices use a compact left icon, a small status
  label, restrained warning accent, and direct setup language so they read as
  "do this to use the screen", not "there is nothing to show". They should feel
  actionable and cautionary without using destructive error styling.
- **Compact visible labels need target-aware action names**: visible button text
  can stay short when the surrounding layout already gives context, but the
  action identity must still name the concrete target for assistive review,
  automated UI checks, and agent-driven operation. A visible `Refresh`, `Edit`,
  `Save`, task tab, mode toggle, or selected row is acceptable only when the
  accessible/action label resolves to the operated surface, family, tool, file,
  example, run, or version. Status chips, file sizes, and badges must not
  accidentally merge into names such as `QualysActive` or
  `qualys.py34726 bytes`; encode the target and state deliberately, for example
  `Select family Qualys, active`, `Show Code for qualys_gav_asset_count`, or
  `Select current file qualys.py, 34726 bytes`. Scope toggles follow the same
  rule: visible `Selected tool`, `Family`, or `Refresh logs` labels are concise
  only if their action names identify the concrete tool or family being
  inspected. Repair actions must identify the concrete failure bucket target,
  including at least the tool and version relation, even when the visible label
  remains a compact `Assign repair`. Embedded editors follow the same rule:
  visible headers can stay compact, but the actual textarea/input name should
  identify the concrete payload target when the generic label would be
  ambiguous, for example `Debug arguments for qualys_gav_asset_count` instead
  of only `Arguments`, or `Published example payload for
qualys_gav_asset_count_source_backed` instead of only `Published example
  payload`. Help editors use the same target-aware input names for tool-level
  fields, selected parameter details, editable parameter table rows, and
  numbered examples. Parameter row controls name the tool plus the parameter or
  row ordinal, not only `Parameter 1 name`, `Summary`, or `Remove parameter`.
  Code source and schema editors name the selected handler or tool, not just the
  generic source pane. Files mode toggles and file source editors name the
  current family or file path, not only `Current`, `Changes`, or
  `Changed source`. Version diff and rollback result editors name the selected
  previous-version target. Validate/Publish actions and raw result editors name
  the edited family/change set, not just generic pending changes. Test/debug
  result editors name the example, tool, and environment config target that
  produced the output. Execution-log detail editors and artifact load actions name the
  concrete run and artifact, not only `Sanitized arguments`, `Error`, or
  `Artifact`. Disclosure summaries are action controls too: visible labels such
  as `Schema and diagnostics`, `Advanced help fields`, `Help examples`, or
  `Raw result` stay compact only when their accessible/action names identify
  the selected tool, family, change set, or result target. Selector controls in
  dense task rows follow the same rule: visible labels such as `Examples` or
  `Environment` must produce combobox names that include the selected tool or
  family target, not anonymous/select-value-only controls.
- **Inspect first, edit explicit**: default mode is read-only inspection. When
  the user starts editing, the UI may acquire a lock and prepare a draft
  automatically; the user should not have to understand whether a separate
  draft object exists before making a change. Unless the caller explicitly
  selects a source revision, editing starts from the active generation currently
  served to agents.
- **Draft is a working set, not default chrome**: for the common human path,
  entering edit mode creates or reuses the editable working set. `New draft`
  should not appear as a parallel default action next to edit/lock controls.
  Explicit draft creation belongs only to advanced flows such as starting from a
  non-current version, discarding and restarting, or diagnostic recovery.
- **One transition, one control**: do not expose both the platform primitive and
  the human verb for the same transition. `Edit` may acquire a lock and prepare
  a draft; once editing is active, the same control position can become
  `Unlock` or `Discard` according to policy. `New draft`, parallel
  acquire/release controls, and similar primitives are reserved for explicit
  diagnostic/admin details.
- **Visible actions require active owned targets**: actions appear as actions
  only when the current human has a concrete, selected, actionable object the
  action will operate on. A backend object existing somewhere is not enough.
  `Save`, `Discard`, `Validate`, and `Publish` require the current human's
  editable draft/change set; `Publish` also requires the latest validation for
  that change set to have passed; `Rollback` requires a selected prior version;
  `Unlock` requires a held edit session; run/artifact actions require a selected
  run or artifact; repair actions require an open failure bucket.
- **Action targets are explicit view-model facts**: every lifecycle action or
  lifecycle tab is rendered from a concrete target descriptor, not from a static
  list of possible commands. The descriptor must name the target kind, selected
  target identity, current human ownership, and readiness state. If the view
  model cannot answer `which exact draft/version/run/artifact/bucket would this
operate on right now?`, the UI should show task guidance or omit the action
  instead of exposing a disabled placeholder.
- **Lifecycle verbs are promises, not menu inventory**: a visible lifecycle
  action tells the user "this can be done now." If no draft exists, there is
  nothing to publish; if no previous version is selected, there is nothing to
  rollback; if no run/artifact/bucket is selected, there is nothing to inspect
  or repair. The UI should not show a full lifecycle command inventory and
  rely on disabled controls to explain missing state. A lifecycle tab or lane
  follows the same rule: it appears because the selected state has entered that
  task, not because the platform can theoretically perform that command later.
- **Unavailable commands are not primary UI**: hiding, moving into details, or
  replacing a command with state guidance is usually clearer than rendering a
  disabled primary button. Disabled controls are acceptable only when the user
  already owns the right target and the missing prerequisite is local and
  immediately fixable, such as invalid JSON in the same editor. If there is no
  current draft/change set, previous version, run, artifact, or open bucket,
  the related command should not appear as the primary action.
- **Public verbs stay human-facing**: internal API verbs such as `promote`
  should not leak into the default human workflow when a clearer lifecycle verb
  exists. Humans publish a validated change set; the platform may implement
  that by promoting a generation. Therefore `Publish` appears only for the
  current human's validated editable draft, while `promote` remains an API,
  management-tool, or diagnostic term.
- **Publish is a result of a real change set**: there is no human-facing
  publish lane until the current human has an editable change set. After edits
  exist, the lane leads with `Validate` or `Validate again` until the latest
  validation for that same change set passes; only then does `Publish` become
  the primary action. A static `Promote`/`Publish` control before that state is
  platform inventory, not useful UI. The question "what would this action
  operate on if clicked right now?" must have a concrete answer before the
  action is rendered as a primary command.
- **Invocation access and lifecycle management are different tasks**: normal
  Agent Settings tool catalogs show invocation tools and hosted tool help, not
  hosted integration management tools such as draft, lock, validate, promote,
  generation, failure-bucket, or artifact lifecycle commands. Those management
  tools belong to the Tool Developer Agent workflow and explicit admin/debug
  surfaces, so a human cannot accidentally grant lifecycle control while trying
  to grant a consumer agent read access.
- **State creates the workspace**: tabs, lanes, sections, and primary controls
  appear because a real lifecycle state exists, not because the page has static
  chrome for every possible operation. If there is no editable change set,
  selected prior version, open failure bucket, selected run, or selected
  artifact, the related workspace is absent or reduced to contextual guidance.
- **Action availability is decided before render**: primary lifecycle controls
  should not be mounted first and then disabled as a substitute for state
  design. The view model decides whether the current human owns a valid target,
  whether the target is ready for the next transition, and whether the command
  belongs in the current tab at all. Disabled primary controls are the exception
  for local, fixable prerequisites on an owned target; they are not a way to
  advertise future lifecycle commands.
- **Lifecycle lanes open at the first useful step**: a lane such as
  Validate/Publish starts only when the current human has an editable change set.
  Within that lane, the primary verb advances with state: `Validate` for untested
  changes, `Validate again` after a failed or stale validation, and `Publish`
  only after the latest validation for that same change set passed. Before that
  lane exists, the page may guide the user toward `Edit`; it should not reserve a
  static tab or button for publishing.
- **Empty states teach the next real step**: when a lifecycle object does not
  exist yet, the screen explains what state is missing and points to the next
  valid task instead of rendering inert primary controls. For example, before a
  draft-backed edit exists, the publish area can say there are no pending
  changes and direct the user to `Edit`; it should not show a targetless
  `Publish` button. Empty-state text should name the relevant family, tool, or
  mode when the surrounding layout might not be enough, for example current
  files vs changed files for a selected family. Structured Help empty states
  should also name the selected tool and parameter where relevant, instead of
  generic copy such as `No summary documented`, `No parameter help entries`, or
  `No help examples`. Test example empty states should name the selected tool and
  whether the user is inspecting current published examples or editing saved
  draft examples. Debug unavailable states should name the selected tool/family
  and the actual missing prerequisite, such as permission, read-safe
  classification, or environment config readiness. Code source empty states
  should name the selected handler and tool so stale-generation or
  missing-handler diagnostics have a concrete investigation target. Version empty states should name the
  selected family and distinguish missing previous-version selection from a
  family with no published versions.
- **Each tab has one job**: code editing, help editing, files, tests/debug,
  logs, failures, and publish/version management are separated by task. A tab
  should expose one obvious primary action and move secondary/internal actions
  into details or overflow controls.
- **Sub-tabs separate detail families, not lifecycle tasks**: when a task tab
  still contains distinct information families, use a compact sub-bar inside
  that tab instead of one long mixed page. For Help, tool-level guidance
  belongs under `Tool details`, while parameter summaries, full details, rules,
  shapes, and parameter examples belong under `Parameters`. Do not duplicate the
  selected family/tool identity in the sub-tab content when the left rail and
  task tab already establish context.
- **Sub-tabs replace same-scope disclosure stacks**: after a sub-tab separates
  the selected information family, avoid adding collapse/expand sections for
  the same tool-level content unless the content is raw diagnostics, audit
  evidence, or unusually expensive to render. A `Tool details` sub-tab should
  show its summary, full detail, usage guidance, and examples as direct
  sections instead of hiding them behind another disclosure layer.
- **Avoid separator overload**: do not turn every logical group into a bordered
  section. When a form already has labeled fields, multiline editors, and a
  sub-tab boundary, prefer a continuous field flow with sparse spacing. Use
  separator lines only when the next content changes type, such as moving from
  guidance fields into example payloads.
- **Tab content does not need opening and closing rules**: the task tab bar
  already separates navigation from work. Do not add generic top or bottom
  borders around every tab content shell. Keep separators inside the content
  only when they distinguish rows, tables, editor chrome, or a meaningful change
  in content type.
- **Avoid summary-only toolbars**: do not reserve a full row for facts such as
  handler count or for mode toggles that belong to the editor they affect. Put
  editor-local actions, mode switches, and status beside the editor title when
  the controls only affect that editor surface.
- **Do not invent missing example metadata**: the current help template stores
  tool-level examples as payload values. Human UI may summarize payload shape
  and render examples as a table, but it must not imply that title,
  description, or purpose metadata exists until the help contract explicitly
  adds those fields.
- **Example presence and no-example justification are mutually exclusive**:
  when examples exist, hide `noExampleJustification` from the normal human
  surface. Show the justification only when the selected help scope has no
  examples, because its purpose is to explain absence rather than accompany
  present examples.
- **Task switches start at the task**: switching tool-work tabs should land the
  user at the start of the selected task surface. Scroll position from a long
  tab should not leave a short tab with blank space above its content, and
  mobile task switches must not leave clipped family/tool navigation fragments
  above the selected task. If the scroll container cannot align the editor start
  because it has reached the bottom, the surface needs enough trailing scroll
  room for the task header to sit cleanly under the page header.
- **Primary actions stay with their work**: a save/run/validate action should
  sit beside the field, list, or lifecycle state it operates on. Standalone
  toolbar bands are reserved for page-level actions that truly affect the
  whole work pane; otherwise they consume viewport space without adding task
  clarity. When a tab and its primary action share the same visible lifecycle
  verb, the action's accessible name should include the target state, such as
  `Validate pending changes`, so navigation and execution controls remain
  distinct. When a compact action operates on a selected file, version, run, or
  bucket, its accessible name should include that target even if the visible
  label remains short.
- **Compact target rows still label controls**: dense rows may keep labels small,
  but target selectors, environment selectors, operation classifications, and
  mode controls must not appear as unlabeled values beside an action. The row
  should answer what the value controls before the user reaches the action.
- **Form actions follow reviewed inputs**: actions that execute, test, debug, or
  publish user-controlled payloads should appear after the relevant editable
  inputs and validation messages. A user should not see the primary execution
  command before the arguments it will run.
- **Editors are viewport-bounded work surfaces**: code, JSON, payload, and diff
  editors should use stable viewport-aware heights with internal scrolling.
  They should not create one giant page-height textarea or sit inside another
  decorative frame that repeats the editor's own border and header.
  Decorative editor gutters, line numbers, and cursor chrome are visual aids;
  they must not become the primary accessible text for the editor or overwhelm
  snapshots and assistive review.
- **Progressive disclosure follows task timing**: raw JSON, raw schemas,
  internal ids, diagnostics, lock metadata, generation diffs, publish controls,
  rollback controls, repair controls, and artifact details are available only
  when they are useful for the current state, or behind explicit detail
  controls.
- **Structured forms first, raw data second**: help, parameter docs, examples,
  config, and schema metadata should be editable through human forms/tables
  where practical. Raw JSON remains a fallback and audit surface, not the
  default editor for structured concepts. Large audit payloads such as version
  diffs should open with scannable summary facts and keep the raw payload behind
  an explicit disclosure.
- **Schema and diagnostics are summaries first**: schema views should lead with
  parameter, type, required, and description/default/enum details in a compact
  table before offering raw JSON. Diagnostics should be grouped by
  severity/code/message and show repeat counts instead of listing identical
  warnings line by line. Raw schema/source metadata stays available behind one
  explicit disclosure for audit and debugging.
- **Focused source is inherently partial**: a focused handler view is a bounded
  convenience view, not proof that every possible runtime reference has been
  shown. Do not emit user-facing diagnostics merely because dynamic Python call
  patterns could make static helper discovery incomplete. Reserve diagnostics
  for concrete source-view problems such as missing handlers, parse failures,
  unresolved named helper references, and configured view limits.
- **Parameter help is first-class help**: if a tool carries parameter-level
  `full`, `rules`, `shape`, or `examples`, the UI must expose those fields from
  the parameter help workflow, not only the short summary. Missing detail should
  be visible as missing coverage so humans can fill the gap.
- **Top-level inputs and nested help paths are different things**: the contract
  view shows executable top-level input schema properties. Help may also
  document nested paths such as `filter_body.filters.field`; those are field
  details inside a top-level input, not additional callable parameters. Human UI
  should keep them in the same parameter table, place each nested path
  immediately under its top-level parent with a small branch marker, and label
  the count separately, so the table stays calm while parameter counts do not
  contradict the executable schema.
- **Runtime env requirements must be explicit**: the Hosted Tools surface must
  show `prod` and `test_debug` environment configs, non-secret config key names,
  secret key names, and configured/missing secret status before a human runs
  tests or debug. Secret values are write-only: humans can set or rotate a
  required secret through targeted password inputs, but read views, DOM text,
  logs, diff, and exported view models must never expose raw secret values.
- **Field shape follows content shape**: long summaries, parameter explanations,
  rules, examples, and payloads should use multiline controls or tables that
  keep the value readable. Single-line inputs are for genuinely short names,
  ids, paths, and compact scalar settings.
- **Diagnostics are contextual**: code parse errors belong beside code,
  schema/help errors beside schema/help, example failures in test/debug, and
  publish blockers in publish/version management. Global error banners are only
  for cross-cutting failures.
- **Transient results follow the selected target**: debug results, test results,
  version diffs, rollback responses, artifact previews, and expanded run details
  are not global page state. When the selected tool, log scope, family, version,
  run, or artifact changes, stale result panes from the previous target must
  clear or be explicitly labeled as historical evidence inside the correct audit
  surface.
- **Task tab movement stays on one axis**: mobile task tabs may auto-scroll
  horizontally to keep the selected tab visible, but they must not trigger their
  own vertical `scrollIntoView`. The workspace root owns vertical alignment so
  task switches do not leave clipped navigation fragments above the active
  task.
- **No visual nesting spiral**: avoid card-in-card and panel-in-panel layouts.
  Use a stable left navigation plus a calm right work area, restrained borders,
  compact status lines, and table/form/editor primitives instead of stacks of
  framed boxes.
- **Tool mapping is navigable**: the UI must make the relationship between
  family-native tool name, handler function, input schema, help, examples, and
  promoted hosted registry name visible. Clicking a tool should focus the
  relevant handler and de-emphasize unrelated handlers by default.
- **No duplicate facts or microcopy**: the same family name, tool name,
  version, lock state, status, count, description, or action explanation should
  not be repeated in multiple visible places unless the repetition changes
  context or supports a different task. Familiar repeated affordances should use
  icon buttons with hover tooltips instead of visible text every time.
- **Completeness does not require constant visibility**: human-native means an
  authorized human can reach every lifecycle detail and update path, not that
  every detail is visible at once. Advanced state, raw payloads, ids, locks,
  draft metadata, and diagnostics should be one deliberate step away from the
  task that needs them, rather than competing with the default work path.
- **Every section earns its space**: a visible section must either add new
  information, enable a current task, or make the screen easier to understand
  at a glance. Sections that only restate context, introduce decorative chrome,
  or occupy space without decision value should be removed or folded into a
  smaller control/status line.
- **Repeated records stay scannable**: logs, failures, versions, examples, and
  files should keep the default row focused on the few fields needed to choose
  the next action. Repeated secondary metadata should collapse into a compact
  mobile meta line or expand details, instead of making every row a tall block.
  Editable repeated rows follow the same rule: compact row actions such as
  remove/delete stay beside the row identity on constrained screens, while the
  longer editable value keeps the readable width below it. Row actions should
  not create their own mostly empty mobile row unless the action itself needs
  supporting content.
  In scoped tables, column labels must match the row's actual primary
  identifier; for example, selected-tool logs lead with version relation, while
  family logs lead with tool name. When responsive layouts keep both desktop
  columns and mobile summaries in the DOM, interactive row accessible names
  should be synthesized once so assistive review does not hear the same status,
  result, duration, or count twice.
- **Status words must not contradict lifecycle state**: a row that has already
  succeeded, failed, published, closed, or retired must not use active-state
  labels such as `running`, `pending`, `open`, or `editing` for missing or
  unavailable secondary metadata. Missing duration, artifact, or timestamp data
  should be labeled as missing/not recorded rather than implying an active
  process. Entering edit mode may create a `Changes` working set, but it should
  not be labeled as `pending` until there is a concrete validation/publish
  result or pending approval state.
- **Recovery flows are first-class**: authorized humans can inspect and resolve
  locks, discard drafts, compare versions, inspect failure buckets, view
  execution logs/artifacts, rollback, and continue repair loops without asking
  an agent to perform the action.
- **UX principles are living acceptance criteria**: when implementation review
  exposes a new repeatable confusion pattern, the rule belongs in this document
  before or alongside the code change. Examples, screenshot findings, and
  human-review objections should tune the canonical principles instead of
  remaining only in chat history or local implementation memory.

UX language must be consistent across every Hosted Tools surface. The same
platform concept must always use the same user-facing term. Do not call the
same action `Edit` in one tab, `Acquire lock` in another, and `Create draft` in
a third. Canonical UI terms are:

```text
Edit: enter edit mode; platform may acquire lock and prepare draft.
Save: persist changes to the active draft.
Discard: abandon the active draft or edit session where policy allows.
Validate: run deterministic structure, schema, dependency, and example checks.
Test: run registered examples or read-safe debug calls.
Publish: promote a validated draft to an active generation.
Rollback: restore a previous generation as the active generation.
Version: human-facing label for generation/source revision history.
Current: the active source, files, help, or version currently served to agents.
Changes: the editable work set being prepared for validation and publishing.
Tool: family-native callable operation in the selected family.
Hosted tool: model-facing registry tool name `hosted_<family>__<tool>`.
Family: hosted integration ownership/reload unit.
Environment config: family-level `prod` or `test_debug` runtime config.
Hosted-tool binding: per-agent access, default environment, and generation pin.
Execution log: audit/debug record of a tool call.
Failure bucket: deduplicated runtime failure group assigned for repair.
```

Internal terms may appear only in metadata/detail areas:

```text
lock
draft
generation id
source revision id
run directory
artifact id
```

Every Hosted Tools page or tab is human-ready only when:

- the user can tell what family/tool/version they are viewing within three
  seconds
- constrained viewports show both navigation context and the active tool
  workspace without unbounded navigation pushing the workspace below the fold
- compact horizontal selectors keep the current family, tool, file, example, or
  version target visible first
- the primary action for the current tab is obvious
- the primary action sits near the concrete work target it affects
- primary action accessible names distinguish the action target from same-word
  navigation tabs
- compact target rows label selectors, operation state, and mode state even
  when the visual treatment is dense
- code, JSON, payload, and diff editors are bounded to the viewport and avoid
  redundant outer frames
- code/editor line-number gutters are decorative and hidden from assistive
  content review
- editable and read-only states are visually distinct
- raw/internal data is available without being the default view
- form controls match the expected content length, so summaries and parameter
  explanations are readable instead of clipped in single-line fields
- diagnostics appear near the thing that caused them
- tab switches preserve the selected family/tool and do not lose unsaved work
- tab switches return the work pane to the selected task start instead of
  preserving stale scroll offset from a previous long tab
- agent and human actions use the same hosted integration API contracts
- terminology is consistent with the canonical UI language above
- visible facts are not duplicated without a task-specific reason
- repeated small controls use icons and tooltips instead of repeated visible
  microcopy where the icon is familiar
- every visible section passes the space test: new information, active task, or
  faster comprehension
- scoped table headings match the row label actually shown in that scope
- completed historical records do not display active-state labels merely because
  optional secondary metadata is missing
- work panes do not start with duplicated family/tool context already owned by
  the navigation
- named chrome such as registry/workbench sections has a concrete task owner or
  is removed
- right panes start with the selected task rather than an intermediate summary
  band that repeats navigation context
- named sections answer a concrete decision or action; backend-concept headings
  without task value are removed or collapsed
- page-level utility actions sit in the page header only when their scope is
  genuinely page-wide
- lifecycle actions are state-aware and hidden, disabled, or moved to metadata
  when the current state has no corresponding task
- lifecycle verbs are not rendered as a command inventory; each visible verb
  must be immediately true for the current selected state
- unavailable lifecycle commands are hidden, moved into details, or replaced by
  guidance unless the user already owns the target and the missing prerequisite
  is local and immediately fixable
- public lifecycle labels use human-facing terms such as `Publish`; internal
  terms such as `promote` stay in APIs, management tools, or diagnostic details
- Agent Settings for normal agents does not render hosted integration
  management tools as ordinary selectable catalog entries
- lifecycle action availability is computed from concrete hosted integration
  state rather than static page layout
- primary lifecycle controls are rendered from view-model state after target
  ownership and readiness are known, not rendered as an always-present disabled
  command inventory
- lifecycle action availability requires the current human's active owned target;
  a draft, generation, run, or bucket that exists elsewhere in backend state is
  not enough to render a primary action
- lifecycle actions and lifecycle tabs are backed by explicit view-model target
  descriptors containing target kind, selected target identity, ownership, and
  readiness; missing descriptors render guidance or no action, not disabled
  command inventory
- draft creation is folded behind edit for the common path
- `New draft` is absent from the default path unless the user explicitly enters
  an advanced start-over or start-from-version flow
- publish is validation-gated and cannot appear as the next action before a
  validated change set exists
- publish does not appear as a primary workspace before the current human owns
  an editable change set
- Validate/Publish lanes open at the first useful state for the current human:
  no editable change set means no publish lane; unvalidated or stale changes show
  `Validate`/`Validate again`; only the latest passed validation shows `Publish`
- empty states explain the missing lifecycle object and route the user toward
  the next real task instead of exposing inert lifecycle controls
- every visible action has a concrete target object and a predictable result
- one state transition is represented by one primary control, even when the
  backend performs multiple primitives behind it
- controls transform in place when they represent the same lifecycle lane
- advanced controls appear only after the related task state exists
- any new repeated UX problem found during review is folded back into these
  principles and the matching implementation-plan acceptance notes

## Hosted Tool Help

Hosted integrations need a hosted-tool-only help surface so normal
agents can learn how to call agent-developed tools without memorizing every
target-system detail in prompt text.

The platform exposes this as a reserved built-in support tool, not as a remote
MCP helper and not as a canonical hosted integration invocation tool:

```text
hosted_tool_help
```

`hosted_tool_help` intentionally starts with `hosted_tool_` for agent-facing
clarity, but it is not a valid hosted tool name because canonical hosted
integration invocation tools must contain exactly one family/tool separator:

```text
hosted_<family>__<tool>
```

`hosted_tool_help` accepts only hosted tool names:

```text
hosted_<family>__<tool>
```

It must reject remote MCP names, built-in tool names, and family-native names.
Any code that classifies hosted integration invocation tools must use the
canonical parser/source metadata, not a raw `hosted_` prefix check. This keeps
the hosted integration surface independent from the MCP surface and prevents
the help support tool from being treated as a hosted family tool.

The help request supports four levels of information:

```json
{
  "tool_name": "hosted_qualys__qualys_cloud_agent_hostasset_count",
  "tool_detail": "summary",
  "include_examples": true,
  "parameters": [
    {
      "name": "filter_body",
      "detail": "full",
      "include_examples": true
    },
    {
      "name": "filter_body.filters.field",
      "detail": "summary",
      "include_examples": true
    }
  ]
}
```

`tool_detail` may be `summary`, `full`, or `none`. Parameter detail may be
`summary` or `full`. If `parameters` is omitted or `null`, the response returns
the tool-level help plus documented parameters automatically. With
`tool_detail: "summary"` those parameters are summary-level; with
`tool_detail: "full"` they are expanded with full parameter details. If
`include_examples` is false, example payloads are omitted but example ids and
categories may still be listed when useful.

The response is normalized across all hosted tools:

```json
{
  "tool_name": "hosted_qualys__qualys_cloud_agent_hostasset_count",
  "family_id": "qualys",
  "family_tool_name": "qualys_cloud_agent_hostasset_count",
  "generation_id": "gen_...",
  "tool_help": {
    "summary": "...",
    "full": "...",
    "when_to_use": ["..."],
    "when_not_to_use": ["..."],
    "no_example_justification": "..."
  },
  "parameters": {
    "filter_body": {
      "summary": "...",
      "full": "...",
      "shape": {},
      "rules": ["..."],
      "examples": []
    }
  },
  "examples": []
}
```

Help content is source-controlled with the hosted family and promoted into each
generation. It may live inline in `family.yaml` for small tools or in separate
family files for larger domains:

```text
families/
  qualys/
    family.yaml
    help/
      qualys_cloud_agent_hostasset_count.md
      gav-filter-body.md
      gav-filter-fields.json
```

The manifest owns the stable help contract:

```yaml
tools:
  - name: qualys_cloud_agent_hostasset_count
    description: Short selection-oriented description.
    inputSchema: {}
    help:
      summary: One or two sentence calling summary.
      full: help/qualys_cloud_agent_hostasset_count.md
      noExampleJustification: Optional reason when examples would be misleading.
      parameters:
        filter_body:
          summary: Native GAV FilterRequest JSON body.
          full: help/gav-filter-body.md
        filter_body.filters.field:
          summary: Native Qualys GAV filter token, not a response field.
          full: help/gav-filter-fields.json
```

For large target-system vocabularies, help should not bloat the model-facing
tool description. The help metadata may point to a family-local reference file
or a family-local reference tool. Qualys GAV filter fields are the first case:
the tool description stays short, `hosted_tool_help` explains the filter-body
contract, and a Qualys quickref/reference tool can perform domain lookup when
the agent needs exact field discovery.

Access policy applies to help:

- `hosted_tool_help` itself is selectable from Agent Settings like an ordinary
  built-in tool; it is not an always-on system tool
- an agent can ask for help only for hosted tools it can see or invoke
- management-only tools remain hidden from normal agents
- secret values and config values are never returned
- disabled tools may return high-level help plus disabled status, but not
  invocation guidance that bypasses the disablement
- agent-facing `hosted_tool_help` responses pass through the common
  tool-result spillover choke point; the HTTP help route returns normal
  control-plane JSON

Promotion validation should require enough help for active hosted tools:

- every active tool has a short description for selection
- every active tool has a `help.summary`
- every public input parameter has at least a short parameter summary
- complex parameters, filter DSLs, enum-like catalogs, pagination, result-file
  behavior, cache semantics, and destructive risk require full parameter help
- every active tool has at least one registered/help example or an explicit
  `noExampleJustification`

This help surface teaches normal agents how to call tools. The
Tool Developer Agent still uses hosted integration management tools and the
`hosted-integrations-development` skill to edit, validate, and promote help
content.

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

The runtime contract should stay family-first while keeping individual tool
handlers deterministic and inspectable. A family may be a single Python file,
but each tool maps to a predictable handler function:

```python
def tool_qualys_cloud_agent_hostasset_count(args: dict, ctx: ToolContext) -> ToolResult: ...
def tool_qualys_cloud_agent_hostasset_search(args: dict, ctx: ToolContext) -> ToolResult: ...
```

Tool names are stable public API. Rename and removal follow the deprecation
rules below.

The handler name is derived from the family-native tool name:

```text
handler = "tool_" + tool_name
```

where `tool_name` must already satisfy the hosted integration tool-name
character set. The runtime should dispatch directly to this derived function
instead of allowing each family to invent arbitrary handler names or hide a
large custom `if name == ...` router. Shared helpers, clients, constants, and
auth code can still live in the same file.

Families should also expose structured lifecycle hooks for cross-tool behavior
instead of duplicating setup/teardown/authentication inside every handler:

```python
def authenticate(ctx: ToolContext) -> AuthState: ...
def before_tool_call(tool_name: str, args: dict, ctx: ToolContext, auth: AuthState) -> dict: ...
def after_tool_call(tool_name: str, args: dict, ctx: ToolContext, result: ToolResult, auth: AuthState) -> ToolResult: ...
```

`authenticate` is the standard place for credential/config validation, token
creation/refresh, target-client construction, and auth-specific error
normalization. `before_tool_call` is the standard place for request shaping that
applies to every tool in the family, correlation metadata, shared validation,
and family-level telemetry annotations. `after_tool_call` is the standard place
for response normalization, shared masking, pagination/result metadata, and
family-level cleanup. Tool handlers should receive whatever normalized/auth
state the runtime contract exposes rather than re-reading secrets or rebuilding
auth independently.

The runtime invocation order is deterministic:

```text
authenticate
before_tool_call
tool_<tool_name>
after_tool_call
gateway response masking/artifact spillover/logging
```

Hosted integration manifests do not declare a dispatch mode. Product runtime
always calls `tool_<tool_name>(args, context)` by convention and does not
provide a `call_tool(name, args, context)` compatibility dispatch path.
The Python runtime executes available standard hooks around derived handlers in
the order above. If a hook is absent because the manifest contains a matching
`hookJustifications` entry, runtime treats it as a no-op. `authenticate`
returns auth state, which the runtime exposes to the handler as
`context["auth"]` and passes to pre/post hooks.

Validation should require these hooks for new production families unless a hook
is explicitly marked unnecessary with a short justification. The hook names and
signatures are platform contract, not per-family inventions.

The manifest-level field for intentionally omitted hooks is
`hookJustifications`. Its keys match the Python hook names:

```yaml
hookJustifications:
  authenticate: No credentials are needed for this public read-only family.
  before_tool_call: No shared request normalization is needed.
  after_tool_call: No shared response normalization is needed.
```

The draft validator enforces the first part of this contract before promotion:
for every non-removed manifest tool, the Python entrypoint must expose a
top-level `tool_<tool_name>(args, context)` handler. The validator inspects the
entrypoint with Python AST rather than model inference or text guessing.
Entrypoints that expose only `call_tool(name, args, context)` fail validation.
Manifest-level handler aliases are not part of the schema; the derived handler
name is the only accepted mapping.

For new-format families, the same AST-backed validator also checks standard
hook functions when no `hookJustifications` entry is present:

```python
def authenticate(ctx): ...
def before_tool_call(tool_name, args, ctx, auth): ...
def after_tool_call(tool_name, args, ctx, result, auth): ...
```

Management/debug APIs should expose a targeted source view for a single tool:

```text
family.yaml excerpt for the tool, including inputSchema/help/classification
selected handler function body
shared helper references when requested
other tool handlers collapsed behind a short placeholder; exact wording is an
implementation detail
```

The control-plane HTTP route is:

```text
POST /api/hosted-integrations/source-view
```

The Tool Developer Agent-facing management wrapper is:

```text
hosted_tool_source_view
```

Both accept a family-native `toolName`/`tool_name`, optional draft or generation
target, and focused-view options for hooks, shared helpers, full-family source,
helper depth, helper snippet count, and max source size. These are management
surfaces; normal consumer agents must not receive focused source access merely
because they can invoke the hosted tool.

This lets an investigating agent read only the failing tool's executable code
and input contract by default, while still making the full family source
available on explicit request.

Helper inclusion must also be deterministic. Focused source views should derive
helper dependencies from Python structure where practical, not from model
guessing. The resolver should build a bounded helper graph from the selected
handler and standard hooks, include referenced family-local helper functions in
stable source order, and report unresolved or dynamic references as diagnostics.
The focused view contract should expose depth/size limits so agents and humans
know when they are seeing a partial helper set and can request full-family
source for broader refactors.

The human UI should use the same focused source model. A family page should let
the human select a family, inspect its tools and mappings, and open a rich code
editor. Clicking a tool name should navigate to and highlight the deterministic
handler for that tool, show the tool's input schema/help/classification beside
the code, and collapse or visually de-emphasize unrelated tool handlers by
default. The UI should still offer an explicit full-family source view for
cross-tool refactors.

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
- resolve the hosted-tool binding, environment config, and secret references
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
- create or update failure buckets for owner-actionable consumer failures

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

## Persistence Contract

Production hosted integration persistence is DB-backed. File-backed stores stay
available as dev/test adapters, but runtime and API code must depend on store
ports, not concrete file-backed stores.

Runtime backend selection is explicit. `hostedIntegrations.persistenceBackend`
may be `auto`, `file`, or `db`. `auto` keeps local trusted loopback deployments
on file-backed persistence and selects DB-backed persistence for authenticated
deployments. Explicit `file` persistence is rejected in authenticated
deployments. The active backend is reported by
`GET /api/hosted-integrations/persistence`.

The executable contract lives in
`packages/hosted-integrations/src/persistence-contract.ts`. That file is the
handoff from architecture into DB schema and adapter work: every record family
listed there needs file-backed contract coverage now and either a concrete
DB-backed factory or an explicit delegated storage decision once the DB adapter
lands in Slice 17.3.

Minimum DB-backed record families:

- catalog family manifests and diagnostics
- source revisions and source files
- drafts, draft files, and draft revisions
- examples
- proposed family lifecycle records
- family edit locks
- environment configs and secret metadata
- approvals and promotion provenance
- disablements
- immutable generations, generation files, generation status, active generation
  pointers, and invocation/draining records
- async jobs and progress events
- run records, artifact metadata, artifact byte refs, and diagnostics artifacts
- execution logs
- failure buckets and bucket events
- idempotency records
- retention state over runs and artifacts

Transactional boundaries:

- source replacement, draft file mutation, lock mutation, environment config
  writes, disablement writes, idempotency reserve/complete, promotion, rollback,
  and run completion are transactional DB writes
- approvals, jobs, execution logs, failure bucket events, and generation
  promotion/rollback events are append-only or event-style records where
  practical
- generation rows, generation file rows, promotion provenance, approval records,
  failure bucket events, artifact byte refs, and request hashes are immutable
  after creation

The DB stores environment config metadata and secret metadata only. Raw secret
values remain human-owned runtime secret material and must not be placed in
general hosted integration DB rows by the hosted-integrations package.

The DB stores artifact metadata, content hashes, sizes, retention state, and
file/object refs. Large artifact bytes may remain in file/object storage.
DB-backed retention sweeps use DB run/artifact/log/bucket metadata as the
candidate index and must not discover candidates by scanning run directories.

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
network: allowed target egress declared by family/environment config
timeout: family default with optional tool override
concurrency: family/tool limit
```

Secrets and config are delivered through `ToolContext`, not by leaking the full
daemon environment to family code.

Execution locality and ownership are separate:

```text
caller context
  actor, session, resolved environment config, path policy

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
environment config
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
hosted_tool_family_list
hosted_tool_family_create
hosted_tool_source_read
hosted_tool_lock_acquire
hosted_tool_lock_renew
hosted_tool_lock_release
hosted_tool_draft_create
hosted_tool_draft_get
hosted_tool_draft_patch
hosted_tool_draft_delete
hosted_tool_example_list
hosted_tool_example_upsert
hosted_tool_example_run
hosted_tool_validate
hosted_tool_promote
hosted_tool_generation_list
hosted_tool_generation_get
hosted_tool_generation_diff
hosted_tool_generation_rollback
hosted_tool_environment_config_list
hosted_tool_environment_config_get
hosted_tool_readiness_get
hosted_tool_debug_run
hosted_tool_run_get
hosted_tool_artifact_get
hosted_tool_failure_bucket_list
hosted_tool_failure_bucket_get
hosted_tool_failure_bucket_assign
hosted_tool_failure_bucket_close
```

These tools should wrap the Hosted Integrations API. They should not duplicate
the package's lifecycle logic.

These are OpenAcme model-facing tools, not tools discovered from an external MCP
server. They may use the same JSON-schema tool shape as other OpenAcme tools,
but they are registered through `packages/tools` and executed through OpenAcme's
own runtime.

Mapping from management tools to API routes:

```text
hosted_tool_family_list
  -> GET /api/hosted-integrations/families

hosted_tool_family_create
  -> POST /api/hosted-integrations/families

hosted family delete API
  -> DELETE /api/hosted-integrations/families/:familyId

hosted_tool_source_read
  -> GET /api/hosted-integrations/families/:familyId
  -> GET /api/hosted-integrations/families/:familyId/source/files
  -> GET /api/hosted-integrations/families/:familyId/source/files/*path
  -> GET /api/hosted-integrations/drafts/:draftId/files/*path

hosted_tool_lock_acquire
  -> POST /api/hosted-integrations/families/:familyId/lock

hosted_tool_lock_renew
  -> POST /api/hosted-integrations/locks/:lockId/renew

hosted_tool_lock_release
  -> DELETE /api/hosted-integrations/locks/:lockId

hosted_tool_draft_create
  -> POST /api/hosted-integrations/families/:familyId/drafts

hosted_tool_draft_get
  -> GET /api/hosted-integrations/drafts/:draftId
  -> GET /api/hosted-integrations/drafts/:draftId/files
  -> GET /api/hosted-integrations/drafts/:draftId/files/*path

hosted_tool_draft_patch
  -> PUT /api/hosted-integrations/drafts/:draftId/files/*path

hosted_tool_draft_delete
  -> DELETE /api/hosted-integrations/drafts/:draftId/files/*path

hosted_tool_example_list
  -> GET /api/hosted-integrations/drafts/:draftId/examples

hosted_tool_example_upsert
  -> POST /api/hosted-integrations/drafts/:draftId/examples

hosted_tool_example_run
  -> POST /api/hosted-integrations/drafts/:draftId/run-example

hosted_tool_validate
  -> POST /api/hosted-integrations/drafts/:draftId/validate

hosted_tool_promote
  -> POST /api/hosted-integrations/drafts/:draftId/promote

hosted_tool_generation_list
  -> GET /api/hosted-integrations/generations

hosted_tool_generation_get
  -> GET /api/hosted-integrations/generations/:generationId

hosted_tool_generation_diff
  -> GET /api/hosted-integrations/generations/:baseGenerationId/diff/:compareGenerationId

hosted_tool_generation_rollback
  -> POST /api/hosted-integrations/generations/:generationId/rollback

hosted_tool_environment_config_list
  -> GET /api/hosted-integrations/environment-configs

hosted_tool_environment_config_get
  -> GET /api/hosted-integrations/environment-configs/:familyId/:environment

hosted_tool_readiness_get
  -> GET /api/hosted-integrations/readiness/environment-configs/:familyId/:environment
  -> GET /api/hosted-integrations/readiness/bindings/:agentId/:familyId/:toolName
  -> GET /api/hosted-integrations/readiness/drafts/:draftId/publish
  -> GET /api/hosted-integrations/readiness/debug

hosted_tool_debug_run
  -> POST /api/hosted-integrations/debug-runs

hosted_tool_run_get
  -> GET /api/hosted-integrations/runs/:runId

hosted_tool_artifact_get
  -> GET /api/hosted-integrations/runs/:runId/artifacts/:name

hosted_tool_failure_bucket_list
  -> GET /api/hosted-integrations/failure-buckets

hosted_tool_failure_bucket_get
  -> GET /api/hosted-integrations/failure-buckets/:bucketId

hosted_tool_failure_bucket_assign
  -> POST /api/hosted-integrations/failure-buckets/:bucketId/assign

hosted_tool_failure_bucket_close
  -> POST /api/hosted-integrations/failure-buckets/:bucketId/close
```

The API remains useful for UI and automation. The tools make the same lifecycle
available to the Tool Developer Agent without giving that agent filesystem or
secret access beyond the Hosted Integrations access policy.

The management-tool surface is the agent-facing OpenAcme built-in tool surface
for hosted integration lifecycle work. It is not an external MCP server and does
not use remote MCP discovery. If OpenAcme exposes these tools through an
internal MCP-compatible protocol later, that protocol is only a transport over
the same `hosted_tool_*` OpenAcme tool definitions and Hosted
Integrations API routes; it must not create a second lifecycle implementation or
let remote MCP allowlist entries enable hosted tools.

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
GET /api/hosted-integrations/families/:familyId
DELETE /api/hosted-integrations/families/:familyId
GET /api/hosted-integrations/families/:familyId/tools
GET /api/hosted-integrations/families/:familyId/tools/:toolName/agent-bindings
```

`GET /families` returns active runtime families by default for normal navigation
and settings surfaces. Proposed draft families are included only when the caller
explicitly requests `includeProposed=true`, so creation/review flows can inspect
them without polluting primary runtime navigation.

`DELETE /families/:familyId` is a Tool Developer maintenance action for
removing an incorrect or retired hosted family from active lifecycle and
registry surfaces. If the family has in-flight invocations, delete enters
`delete_draining`: the family is operationally disabled, hosted registry tools
are removed for new turns/calls, and existing leased invocations may complete
against their captured generation. When in-flight count reaches zero, the
runtime finalizes deletion automatically. If no invocation is in flight, the
same request finalizes synchronously.

Finalization removes active/proposed source, drafts, locks, active pointers,
environment configs, secret files, disablements, workspaces, and hosted tool
registry exposure. Promoted generation history is immutable: DB-backed stores
retain generation rows/files and mark the family generations disabled so
cold-start registry sync cannot re-expose them. Historical run logs, artifacts,
approvals, and failure buckets remain forensic evidence and are not purged by
this endpoint.

`GET /families/:familyId/tools/:toolName/agent-bindings` is a read-only matrix
view derived from `AgentDefinition` bindings plus hosted tool catalog state. It
does not own binding writes. Mutations still go through the existing Agent
Settings path:

```http
PATCH /api/agents/:id
```

Locks, source, and drafts:

```http
POST   /api/hosted-integrations/families/:familyId/lock
POST   /api/hosted-integrations/locks/:lockId/renew
DELETE /api/hosted-integrations/locks/:lockId

GET  /api/hosted-integrations/families/:familyId/source/files
GET  /api/hosted-integrations/families/:familyId/source/files/*path

POST /api/hosted-integrations/families/:familyId/drafts
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
GET  /api/hosted-integrations/generations/:baseGenerationId/diff/:compareGenerationId
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

Readiness:

```http
GET /api/hosted-integrations/readiness/environment-configs/:familyId/:environment
GET /api/hosted-integrations/readiness/bindings/:agentId/:familyId/:toolName
GET /api/hosted-integrations/readiness/drafts/:draftId/publish
GET /api/hosted-integrations/readiness/debug?familyId=:familyId&toolName=:toolName&environment=:environment
```

Readiness endpoints return the shared resolver result shape and never return
secret values. Mutation endpoints still call the same resolvers immediately
before mutating state; readiness reads are advisory snapshots for UI,
automation, and Tool Developer Agent planning.

Environment configs and secrets:

```http
GET /api/hosted-integrations/environment-configs
GET /api/hosted-integrations/environment-configs/:familyId/:environment
PUT /api/hosted-integrations/environment-configs/:familyId/:environment
PUT /api/hosted-integrations/environment-configs/:familyId/:environment/secrets
```

Secret endpoints are human-only. Read endpoints never return secret values. The
route `:environment` parameter accepts only `prod` or `test_debug`.

## Environment Configs And Secrets

Secret values are human-owned. Agents may inspect only sanitized environment
config metadata. Hosted integrations support two product-level runtime
environments:

- `prod`: the production/runtime environment intended for normal agent use.
- `test_debug`: the non-production environment used for tool development,
  debug runs, parity, and safe dogfood.

Agent-specific choices, generation pins, and internal runner defaults are stored
as agent hosted-tool bindings. They must not create extra environment names such
as `demo`, `parity`, `stage`, or per-agent config clones.

The canonical environment config identity is:

```text
family_id + environment
```

The canonical persisted id is derived from that identity as
`<family_id>-<environment>`, for example `qualys-prod` or
`qualys-test_debug`. Humans and agents should not provide custom environment
config ids. Storage must enforce uniqueness for `(family_id, environment)`.
Creating/updating an environment config is idempotent through
`PUT /environment-configs/:familyId/:environment`: if the canonical record
exists, its non-secret config and secret metadata revision are updated; if it
does not exist, the canonical record is created. No API creates a second record
for the same `(family_id, environment)`.

Legacy `/config-scopes` routes are not compatibility aliases for new code.
Offline parity scripts may read legacy persisted files/rows directly as test
inputs, but active product APIs and agent-facing management tools use
`/environment-configs` only.

Debug environment selection is intentionally narrow. Tool Developer Agent debug,
parity, and dogfood runs default to `test_debug`. A `prod` debug run is allowed
only through the hosted integration control plane for an authorized human or
internal maintenance actor with an explicit `allowProdEnvironment` flag; write
or destructive operations still require the existing operation-class approval
path. Normal agents never choose `prod` or `test_debug` at call time.

OpenAcme already keeps credentials out of user-editable config files and writes
credential files with atomic `0600` semantics. Hosted integrations should use
the same pattern.

Suggested layout:

```text
<dataDir>/hosted-integrations/
  environment-configs/
    qualys-prod.json
    qualys-test_debug.json
  secrets/
    qualys-prod.json
    qualys-test_debug.json
```

Environment config file:

```json
{
  "id": "qualys-prod",
  "family_id": "qualys",
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
  "environment_config_id": "qualys-prod",
  "environment": "prod",
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

Generation diff is a first-class control-plane capability. Tool Developer,
repair workflows, and authorized humans should be able to compare two promoted
generations without reading raw store internals. The diff API should support:

- full generation file diff
- path-filtered diff
- tool-focused diff using the deterministic handler/source-view rules
- manifest-only diff for schema/help/classification changes
- summary mode for changed files, changed tool names, and risk-relevant
  metadata changes
- unified patch text when an agent needs normal code-review context

Diff output must be sanitized like source-read output and must not include
secret values or environment config secret material.

The HTTP route is:

```text
GET /api/hosted-integrations/generations/:baseGenerationId/diff/:compareGenerationId
```

The Tool Developer Agent management wrapper is:

```text
hosted_tool_generation_diff
```

Supported modes are `summary`, `unified`, `manifest`, and `tool_focused`.
`path` limits file diffs to one generation file. `toolName`/`tool_name` is
required for `tool_focused` mode and must be a family-native tool name.
Tool-focused diff reuses the same deterministic focused source-view model used
for repair reads.

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
- environment
- hosted-tool binding
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

Tool Developer test, example, and debug failures are retained in execution logs
and artifacts, but they do not create failure buckets or repair tasks. The
gateway makes this decision from an explicit tool-maintenance invocation
purpose set by management/debug surfaces, not from the actor role alone. Those
calls are part of the development loop; creating another Tool Developer task for
each failed validation attempt would create avoidable churn. Bucket/task
automation starts from normal consumer invocations and other owner-actionable
runtime failures.

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

- exact hosted integration DB table DDL and migrations for the persistence
  contract in `packages/hosted-integrations/src/persistence-contract.ts`
- exact worker process lifecycle and generation loading protocol
- exact sandbox enforcement implementation for filesystem/process/network
- exact visual layout for hosted integration family management
- exact retention defaults for successful and failed run artifacts
- exact policy file/schema shape
- maintenance/debug authority source. MVP may guard platform maintenance
  surfaces with the canonical Tool Developer agent id, but this is a
  refactor target. The durable model should resolve authority from platform
  managed-agent/template metadata and, when family-level ownership exists, the
  family maintainer/active lock/failure-bucket assignment rather than a
  hard-coded id or caller-supplied role string.
