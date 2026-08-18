---
name: hosted-integrations-development
description: Lifecycle playbook for the Tool Developer Agent when developing, validating, promoting, debugging, and repairing OpenAcme hosted integration tool families.
tags:
  - openacme
  - hosted-integrations
  - tool-development
---

Use this skill when developing, validating, promoting, debugging, or repairing
hosted integration tool families through the `hosted_tool_*` management
tools.

This is not a script to follow blindly. Use it as the operating model for
deciding what kind of work is in front of you, which platform surface owns that
work, and what evidence is required before you promote or close anything.

## Triage first

Classify the request before editing:

- New capability: add or extend a tool-family behavior. Expect a draft, source
  patch, smoke examples, validation, example runs, and promotion if
  non-destructive.
- Bug or production failure: inspect sanitized run and failure-bucket evidence,
  reproduce with a debug run or regression example, patch, validate, promote,
  then close the bucket with regression evidence.
- Config issue: inspect sanitized environment config readiness and metadata
  only. Report the missing or invalid environment/config key and stop; do not
  patch source to compensate for missing credentials.
- Question or investigation: inspect family, generation, examples, logs, or
  artifacts and answer from sanitized evidence. Do not acquire a lock unless a
  source change is actually needed.
- Destructive or external write behavior: prepare the target and evidence, then
  stop for human approval before promotion or invocation.

## Operating boundaries

- Use hosted tool management tools instead of generic filesystem access.
- Do not delegate hosted integration source edits, examples, validation,
  promotion, debug runs, or repair buckets to Acme. You own this lifecycle; ask
  Acme only for platform setup or workforce configuration that is outside the
  hosted tool management surface.
- Work at the tool-family level. A family is the unit of source, shared helper
  code, runtime settings, hosted MCP tool contract, examples, generations, and
  workspace home.
- Treat `tools.yaml` as the source of truth for the hosted MCP surface. It owns
  the official MCP tool fields, input/output schemas, selection guidance,
  parameter help, examples, safety classification, and family-native handler
  mapping. `family.yaml` owns family/runtime/config metadata only.
- Keep large or shared provider vocabularies in family-local `references/`
  files and reference them from `tools.yaml` parameter help. Do not duplicate a
  filter field catalog, enum-like provider value list, or response-field
  vocabulary into every tool `inputSchema`.
- Do not invent complex provider API behavior. If auth semantics, endpoint
  behavior, pagination, destructive side effects, response parsing, or public
  output shape is not documented, imported, or safely observed, stop with
  `EVIDENCE_REQUIRED` and name the missing source. Acceptable evidence is
  imported integration source, official provider docs, provider-supplied
  OpenAPI/SDK docs, or approved sanitized read-only debug output.
- Complex provider client design is out of scope unless the source or contract
  is imported/provided. Your default job is hosted surface mapping, wrappers,
  validation, help, examples, small fixes, and harness troubleshooting.
- When a complete hosted family package is provided, use package import/export
  instead of replaying many individual draft patches. Package import still
  creates or updates a draft only; it does not promote, grant access, or bypass
  validation/readiness.
- Keep agent-usability/live dogfood scenarios in the repository-owned scenario
  manifest, not embedded in runner code. Unguided scenario prompts must not name
  hosted tools, `hosted_tool_help`, remote MCP tools, legacy `managed_*` tool
  names, or exact JSON argument shapes; analyzers own the required evidence.
- Do not claim improved unguided model usability from chat memory, deterministic
  analyzer fixtures, or unrecorded console output. A passing live scenario must
  be persisted as an accepted artifact in
  `docs/hosted-tools-live-evaluation-scenarios.yaml` under the scenario's
  `acceptedArtifacts`, with a `runId` that matches the JSON artifact filename,
  the artifact `path`, `status: pass`, `secretScan: pass`, and a concise
  evidence summary.
- For shared vocabulary, hosted help, or example-readiness changes, use
  `docs/hosted-tools-vocabulary-acceptance-matrix.yaml` to choose the required
  deterministic validation bundle. Live Qualys proof remains required only when
  claiming real provider behavior or unguided model usability.
- Keep native and hosted registry tool names separate. Family manifests, examples,
  debug runs, failure buckets, and all `hosted_tool_*` management-tool
  `tool_name` parameters use the family-native name such as `splunk_search`.
  Agent Settings and model-facing invocation tools use the hosted canonical
  registry name such as `hosted_splunk__splunk_search`.
- Acquire a family lock before editing. Respect the lock owner and lock TTL; if
  a lock is held by another actor, stop and report the holder and expiry.
- Do not read, request, or return secret values. Human operators own secret
  values. You may inspect sanitized environment config metadata and readiness
  blockers, then explain which environment/config key blocks validation or
  publish.
- Do not bypass access policy. A hosted tool being visible in the catalog does
  not mean the current agent can call it; Agent Settings owns per-agent tool
  access.
- Do not invent hidden caching. Hosted tools should compute fresh results unless
  the family explicitly implements local sync/cache behavior inside its own
  workspace home.
- Treat destructive or external write behavior as an approval boundary. Prepare
  the exact promotion or invocation target, then stop for human approval.

## Tool surface map

Use the management tools by intent:

- Discover families/source: `hosted_tool_family_list`,
  `hosted_tool_source_read`, and tool-focused
  `hosted_tool_source_view`.
- Move complete family packages: `hosted_tool_family_import` and
  `hosted_tool_family_export`. Import creates or updates drafts from exact
  package file sets. Export returns sanitized source packages and never includes
  raw secrets, run directories, execution logs, or failure-bucket internals.
- Create or prepare work: `hosted_tool_family_create`,
  `hosted_tool_lock_acquire`, `hosted_tool_lock_renew`,
  `hosted_tool_draft_create`.
- Edit draft source: `hosted_tool_draft_get`,
  `hosted_tool_draft_patch`, `hosted_tool_draft_delete`.
- Maintain examples: `hosted_tool_example_list`,
  `hosted_tool_example_upsert`, `hosted_tool_example_run`.
- Validate and promote: `hosted_tool_validate`,
  `hosted_tool_promote`.
- Inspect or rollback generations: `hosted_tool_generation_list`,
  `hosted_tool_generation_get`,
  `hosted_tool_generation_rollback`.
- Inspect environment config metadata:
  `hosted_tool_environment_config_list`,
  `hosted_tool_environment_config_get`.
- Inspect lifecycle readiness before acting:
  `hosted_tool_readiness_get`.
- Investigate runs: `hosted_tool_debug_run`,
  `hosted_tool_run_get`, `hosted_tool_artifact_get`.
- Repair buckets: `hosted_tool_failure_bucket_list`,
  `hosted_tool_failure_bucket_get`,
  `hosted_tool_failure_bucket_assign`,
  `hosted_tool_failure_bucket_close`.

## Request to promotion lifecycle

1. Discover the current state with `hosted_tool_family_list`,
   `hosted_tool_source_read`, and `hosted_tool_source_view` when
   you need one tool handler plus relevant hooks/helpers instead of a raw file
   window.
2. Acquire the family lock with enough TTL for the edit window. Renew it before
   long validation runs if needed.
3. Create a draft from the current generation. Keep edits scoped to the requested
   family behavior and its shared helper code.
4. Patch draft files through `hosted_tool_draft_patch`. For large Python
   files, read focused windows with `start_line` and `max_lines`, then prefer
   targeted patch modes such as `replace_text` or `insert_after` with a unique
   source block. Use full-file replacement only for new files or intentionally
   small files. Keep runtime settings at the family level when they apply to
   every tool. Keep public tool schema/help/mapping changes in `tools.yaml`.
   Put reusable parameter vocabularies in `references/` and link them from
   `parameterHelp` with `vocabularyRef`; do not copy the same catalog into
   multiple tools. Vocabulary files may be YAML or JSON.
   Treat aliases as search synonyms only. Exact value checks must use real
   provider values or documented `invalidAliases`; aliases are not accepted
   exact provider values.
5. Register or update examples with `hosted_tool_example_upsert`.
   Promotion requires at least one safe runnable example for every promoted
   tool, unless the tool genuinely requires a discovered provider id/ref before
   invocation and therefore uses `discovery_required` contract evidence.
   Use `discovery_required` only when the example documents a prerequisite
   lookup, such as discovering a provider id or ref before a fetch/get call; it
   is not a ready-to-send invocation payload and must not include placeholder
   ids or refs as arguments.
6. Run `hosted_tool_validate`, then run safe runnable examples with
   `hosted_tool_example_run`. Do not run `discovery_required` examples; use
   them to perform the prerequisite lookup and then create a real runnable
   example only when a safe id/ref is available.
7. Inspect publish readiness with `hosted_tool_readiness_get`. Promote
   only when validation, required examples, and publish readiness pass.
   Non-destructive changes can be promoted by the Tool Developer Agent;
   destructive changes stop at the human approval boundary.
8. Release the lock once the draft is promoted or intentionally abandoned.

Before promotion, check:

- You still own the lock or can renew it.
- The draft source is the intended family only; no unrelated family was edited.
- Every new or changed tool has at least one safe runnable example, or a
  `discovery_required` example when a real provider id/ref must be discovered
  first.
- Any reproduced bug has a regression example.
- `hosted_tool_validate` passed after the final patch.
- Required safe runnable examples passed after the final patch.
- Publish readiness is `ready`, or the blocker is explicitly reported.
- Tool classification is accurate: read, write, destructive, live, cached,
  sync, sync execution, async execution, approval mode.
- Runtime settings are family-level unless a tool-specific override is
  intentional and documented in the manifest.
- Complex filter/query/body parameters have full help, nested parameter help,
  and vocabulary references when the valid values are catalog-backed.
- Every tool has actionable `openacme.errors` guidance for autonomous recovery.
  Tell the caller whether to fix input, update config/permissions, retry, or
  stop for provider evidence.
- Tools with page, limit, cursor, continuation, or truncation inputs have
  `openacme.pagination` guidance that explains bounds, continuation, and
  truncation behavior.
- Large expected responses are allowed to spill to artifacts.
- No source, example, log, artifact, or response includes raw secrets.

## Example policy

Examples are the regression contract for a family. Keep them small, explicit,
and safe to run in the hosted integration runtime.

- Add a smoke example for each new tool.
- Add a regression example before fixing a reproducible failure.
- Use `discovery_required` when a tool cannot be safely invoked until another
  tool discovers a real id/ref. Put the discovery tool and after-discovery
  guidance in `expected`, keep `args` empty unless they are genuinely
  ready-to-send, and never invent placeholder ids.
- Include representative environment config metadata, but never include secret
  values.
- Prefer deterministic assertions. When an external service is inherently
  variable, assert shape, status, masking, and error taxonomy rather than an
  exact volatile payload.

## Failure repair loop

When a production or debug run fails, the calling agent should see only that the
tool failed. The platform and Tool Developer Agent own the repair process.

1. Inspect sanitized run details with `hosted_tool_run_get`.
2. Fetch oversized sanitized artifacts with `hosted_tool_artifact_get`
   when the choke point returned a response file or diagnostic artifact.
3. Use failure-bucket tools when available to group by stable error identity,
   such as family, tool, generation, exception class, and sanitized stack shape.
4. Assign the bucket to the Tool Developer Agent when the fix is code-owned.
5. Reproduce with `hosted_tool_debug_run` or a new regression example.
6. Patch the draft, rerun validation and the regression example, promote the
   fixed generation, then close the bucket with the generation and example IDs.

Close a failure bucket only after you have:

- inspected the bucket and latest sanitized run evidence
- identified whether the cause is source, config, dependency, policy, timeout,
  target-system behavior, or caller misuse
- added or linked a regression example for code-owned fixes
- promoted a generation that includes the fix
- rerun the regression example against that generation
- supplied the bucket close evidence fields requested by the tool, including the
  draft, generation, and regression example identifiers when applicable

## Debug runs

Use a debug run when you need one-off investigation that should not become the
family's permanent example contract yet. A debug run may inspect sanitized
inputs, outputs, logs, artifacts, workspace paths, runtime settings, and error
taxonomy for a single attempted call.

If a debug run proves a durable bug, convert it into a regression example before
promoting the fix. Cancellable behavior belongs to async hosted integration jobs;
do not add cancellation semantics to synchronous calls.

## Async, cache, and lifecycle changes

- Async is opt-in per tool classification. Use async jobs only for tools already
  classified as async; do not retrofit cancellation or progress semantics into
  synchronous calls during a repair.
- Cache is explicit. A cached or sync tool must declare and own cache behavior
  under family home. A live tool must not reuse a previous response as an
  implicit platform cache.
- Deprecation is safer than removal. Hide or deprecate a tool before removal
  unless the request explicitly calls for a breaking change and policy permits
  it.
- Rollback is an operational recovery tool. Prefer fixing forward when the
  current generation is only partially wrong and a small patch is available;
  rollback when the active generation is broadly unsafe and a known-good
  previous generation exists.

## Runtime and workspace expectations

- Family-level runtime settings own defaults such as timeout, response token
  limits, concurrency, runtime isolation policy, and dependency policy.
- Each family has a dedicated workspace home for durable family-owned state.
- Each call gets a run-specific tmp directory under the hosted integration
  workspace. Use it for transient files and large response artifacts.
- Choke point masking, logging, OpenTelemetry emission, response-size spillover,
  and execution log capture are platform responsibilities. Tool code should
  still avoid returning secrets or unnecessary large payloads.

## Readiness, Secrets, And Config

Use `hosted_tool_readiness_get` before promote, debug, or repair actions
when the next step depends on environment config, hosted-tool binding, publish,
debug, or invocation readiness. Treat readiness reads as advisory
snapshots: the API will recheck the same resolver before mutating state.

Use environment config tools to inspect what a family expects and whether a
required key is present. Do not inspect backing `.env`, token, auth, or secret
files. If a missing or invalid secret blocks progress, return the environment
and key name that a human needs to update.

Environment configs are family-level and limited to `prod` and `test_debug`.
Agent-specific access, default environment, and generation pins live in
hosted-tool bindings through Agent Settings; do not create per-agent config
clones or new environment labels such as `demo`, `parity`, `stage`, or `local`.

A hosted integration may be config-free when its runtime config contract has no
required config or secret keys. In that case, do not ask a human to create an
empty environment config and do not treat missing `prod` or `test_debug`
environment config records as a blocker. Debug, example, regression, parity,
dogfood, and consumer runs may proceed config-free when readiness says the tool
does not require config. Execution logs for those runs should show an explicit
purpose with no environment config id or config revision.

When a family declares required config or secret keys, use `prod` for normal
production invocation and GA publish readiness, and use `test_debug` for
debug, examples, validation, regression, parity, and dogfood unless prod debug
is explicitly authorized. Never invent synthetic environment config ids such as
`debug`, `regression`, `<family>-test`, `demo`, or `parity`.

## Done criteria

For development work, you are done only when the source change is promoted or
the reason it cannot be promoted is explicit and actionable.

For repair work, you are done only when the failure is classified, the fix is
validated, regression evidence exists for code-owned bugs, and the failure
bucket is closed or left open with a clear blocker.

For investigation-only work, you are done when the answer cites sanitized
family, generation, run, artifact, environment config, readiness, or bucket
evidence and no edit lock remains held by you.
