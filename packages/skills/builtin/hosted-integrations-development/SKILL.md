---
name: hosted-integrations-development
description: Lifecycle playbook for the Tool Developer Agent when developing, validating, promoting, debugging, and repairing OpenAcme hosted integration tool families.
tags:
  - openacme
  - hosted-integrations
  - tool-development
---

Use this skill when developing, validating, promoting, debugging, or repairing
hosted integration tool families through the `hosted_integration_*` management
tools.

## Operating boundaries

- Use hosted integration management tools instead of generic filesystem access.
- Work at the tool-family level. A family is the unit of source, shared helper
  code, manifest, runtime settings, examples, generations, and workspace home.
- Acquire a family lock before editing. Respect the lock owner and lock TTL; if
  a lock is held by another actor, stop and report the holder and expiry.
- Do not read, request, or return secret values. Human operators own secret
  values. You may inspect sanitized config-scope metadata and explain which
  config key blocks validation.
- Do not bypass access policy. A hosted tool being visible in the catalog does
  not mean the current agent can call it; Agent Settings owns per-agent tool
  access.
- Do not invent hidden caching. Hosted tools should compute fresh results unless
  the family explicitly implements local sync/cache behavior inside its own
  workspace home.
- Treat destructive or external write behavior as an approval boundary. Prepare
  the exact promotion or invocation target, then stop for human approval.

## Request to promotion lifecycle

1. Discover the current state with `hosted_integration_family_list` and
   `hosted_integration_source_read`.
2. Acquire the family lock with enough TTL for the edit window. Renew it before
   long validation runs if needed.
3. Create a draft from the current generation. Keep edits scoped to the requested
   family behavior and its shared helper code.
4. Patch draft files through `hosted_integration_draft_patch`. Prefer small,
   readable changes and keep runtime settings at the family level when they
   apply to every tool.
5. Register or update examples with `hosted_integration_example_upsert`.
   Promotion requires at least one safe example for every promoted tool.
6. Run `hosted_integration_validate`, then run safe examples with
   `hosted_integration_example_run`.
7. Promote only when validation and required examples pass. Non-destructive
   changes can be promoted by the Tool Developer Agent; destructive changes stop
   at the human approval boundary.
8. Release the lock once the draft is promoted or intentionally abandoned.

## Example policy

Examples are the regression contract for a family. Keep them small, explicit,
and safe to run in the hosted integration runtime.

- Add a smoke example for each new tool.
- Add a regression example before fixing a reproducible failure.
- Include representative config-scope metadata, but never include secret values.
- Prefer deterministic assertions. When an external service is inherently
  variable, assert shape, status, masking, and error taxonomy rather than an
  exact volatile payload.

## Failure repair loop

When a production or debug run fails, the calling agent should see only that the
tool failed. The platform and Tool Developer Agent own the repair process.

1. Inspect sanitized run details with `hosted_integration_run_get`.
2. Fetch oversized sanitized artifacts with `hosted_integration_artifact_get`
   when the choke point returned a response file or diagnostic artifact.
3. Use failure-bucket tools when available to group by stable error identity,
   such as family, tool, generation, exception class, and sanitized stack shape.
4. Assign the bucket to the Tool Developer Agent when the fix is code-owned.
5. Reproduce with `hosted_integration_debug_run` or a new regression example.
6. Patch the draft, rerun validation and the regression example, promote the
   fixed generation, then close the bucket with the generation and example IDs.

## Debug runs

Use a debug run when you need one-off investigation that should not become the
family's permanent example contract yet. A debug run may inspect sanitized
inputs, outputs, logs, artifacts, workspace paths, runtime settings, and error
taxonomy for a single attempted call.

If a debug run proves a durable bug, convert it into a regression example before
promoting the fix. Cancellable behavior belongs to async hosted integration jobs;
do not add cancellation semantics to synchronous calls.

## Runtime and workspace expectations

- Family-level runtime settings own defaults such as timeout, response token
  limits, concurrency, runtime isolation policy, and dependency policy.
- Each family has a dedicated workspace home for durable family-owned state.
- Each call gets a run-specific tmp directory under the hosted integration
  workspace. Use it for transient files and large response artifacts.
- Choke point masking, logging, OpenTelemetry emission, response-size spillover,
  and execution log capture are platform responsibilities. Tool code should
  still avoid returning secrets or unnecessary large payloads.

## Secrets and config

Use config-scope tools to inspect what a family expects and whether a required
key is present. Do not inspect backing `.env`, token, auth, or secret files. If a
missing or invalid secret blocks progress, return the config scope and key name
that a human needs to update.
