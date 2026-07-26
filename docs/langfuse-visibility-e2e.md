# Langfuse Visibility E2E Test Framework

Date: 2026-07-25

## Purpose

Build a guarded live e2e test framework that proves an OpenAcme AI turn is visible in Langfuse and locally correlatable after export. The test is forensic, not a unit substitute: it must exercise the real server chat endpoint, real OpenTelemetry exporter, Langfuse public read API, OpenAcme usage ledger, and local forensic archive.

Canonical Langfuse contracts used by this plan:

- OTLP trace ingest endpoint: `/api/public/otel/v1/traces`.
- Public API base path: `/api/public`.
- Public API auth: Basic auth with public key as username and secret key as password.
- Real-time v4 OTLP ingest: send `x-langfuse-ingestion-version: 4`.
- Visibility read path: Observations API v2 filtered by `traceId` or `sessionId`.

## Milestone 1: Test Contract And Harness

Goal: introduce a dedicated, opt-in Langfuse e2e path that cannot accidentally hit the network in normal test runs.

TDD expectations:

- The test suite is skipped unless `OPENACME_E2E_LANGFUSE=1` and Langfuse credentials are available.
- The test reads `~/.openacme-test/.env` by default, without printing secret values.
- A dedicated package script runs only the Langfuse visibility spec.
- The existing generic e2e suite remains unchanged by default.

Implementation slice:

- Add `packages/server/vitest.langfuse-e2e.config.ts`.
- Add `pnpm --filter @openacme/server test:e2e:langfuse`.
- Add a Langfuse support helper for env resolution, Basic auth, observation polling, and safe failure messages.
- Extend the e2e harness with optional data-dir injection and cleanup control.

## Milestone 2: Live Visibility Canary

Goal: prove a real OpenAcme chat turn appears in Langfuse and can be joined back to local evidence.

TDD expectations:

- The test boots the real server app against the deterministic stub model.
- The test drives a tool-using chat turn through `/api/chat` and SSE.
- The OpenAcme usage ledger records `traceId`, `spanId`, `forensicRunId`, and `forensicPath`.
- The local forensic archive contains `agent.run.start`, `agent.run.finish`, `tool.start`, and `tool.finish`.
- The test shuts down telemetry after the turn so batch spans flush before polling Langfuse.
- The test polls Langfuse Observations API v2 when available, falling back to the legacy v1 observations endpoint for self-hosted Langfuse v3, until `openacme.agent.turn` and `openacme.tool.execute` observations are visible for the usage `traceId`.

Implementation slice:

- Add `packages/server/test/e2e/langfuse-visibility.e2e.ts`.
- Use the existing stub directive with the daemon-side `ping_user` system tool to cover the tool span without paid model calls.
- Query `/api/usage/events` until the matching session row is visible.
- Read the forensic `events.jsonl` for local continuity assertions.
- Poll Langfuse with bounded timeout and interval env knobs.

## Milestone 3: Execution And Reporting

Goal: every run leaves an explicit result: live pass, guarded skip, or actionable failure.

TDD expectations:

- Without Langfuse credentials, the command exits cleanly with the live suite skipped.
- With credentials, failures identify which visibility surface failed: OpenAcme usage, local forensic archive, telemetry export, or Langfuse API readback.
- Secrets are never logged by the helper, assertion messages, or docs.

Commands:

```bash
pnpm --filter @openacme/server test:e2e:langfuse
```

For a live run, set these in the shell or `~/.openacme-test/.env`:

```bash
OPENACME_E2E_LANGFUSE=1
OPENACME_OBSERVABILITY=langfuse
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

Optional live-run knobs:

```bash
OPENACME_E2E_ENV_FILE=$HOME/.openacme-test/.env
OPENACME_E2E_DATA_DIR=$HOME/.openacme-test/langfuse-e2e
OPENACME_E2E_KEEP_DATA=1
OPENACME_E2E_LANGFUSE_TIMEOUT_MS=120000
OPENACME_E2E_LANGFUSE_POLL_MS=3000
```

## Exception Handling Standard

- Missing live env produces a skipped suite, not a failed developer test.
- Langfuse HTTP failures include status code and a truncated response body only.
- Poll timeout includes the trace id, expected observation names, and last safe API error.
- Telemetry shutdown failures fail the live test because an unflushed exporter invalidates the visibility assertion.
- Server cleanup still runs in `afterAll` even if telemetry export or Langfuse polling fails.

## Current Execution Report

Status: framework implemented; live Langfuse path passed against local Docker Langfuse.

What changed:

- Added a dedicated live Langfuse e2e command: `pnpm test:e2e:langfuse`.
- Added `packages/server/vitest.langfuse-e2e.config.ts` so live visibility testing is opt-in.
- Excluded `langfuse-visibility.e2e.ts` from the normal server e2e config.
- Added a guarded Langfuse helper that loads `~/.openacme-test/.env`, resolves live-test env, performs Basic-auth API requests, and polls Observations API v2.
- Added a live canary spec that boots the real server, drives tool-using chat turns, verifies OpenAcme usage correlation, verifies local forensic archive continuity, shuts down telemetry to flush spans, and polls Langfuse for `openacme.agent.turn` plus `openacme.tool.execute`.
- Added live logical tool failure readback: the canary runs a real shell command that exits with code 7, verifies local `tool.finish` has `resultStatus=failure`, then verifies Langfuse observation metadata includes `tool_execution_status=ok`, `tool_result_status=failure`, `tool_result_classifier=shell`, `tool_failure_kind=command_exit_nonzero`, `tool_failure_message=Command exited with code 7`, and `tool_exit_code=7`.
- Added deterministic unit coverage for the Langfuse e2e support helper's env gate, metadata-inclusive public API request construction, and self-hosted v3 legacy observations fallback.
- Extended the e2e harness with optional data-dir injection and cleanup control.
- Added `shutdownOpenAcmeTelemetry()` for deterministic export flushing in tests while keeping existing production shutdown behavior.
- Added local Docker deployment files under `ops/langfuse-local/`.

Environment result:

- Local Langfuse v3 is running at `http://localhost:3000` via Docker Compose.
- Local Langfuse secrets are stored in `~/.openacme-test/langfuse/.env`.
- `~/.openacme-test/.env` contains `OPENACME_E2E_LANGFUSE`, `OPENACME_OBSERVABILITY`, `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and the pre-existing `OPENROUTER_API_KEY`.
- The local Docker deployment is isolated from `~/.openacme`.

Validation run:

- `docker compose --env-file ~/.openacme-test/langfuse/.env -f ops/langfuse-local/docker-compose.yml up -d` - passed.
- `curl http://localhost:3000/api/public/health` - returned 200.
- `pnpm --filter @openacme/server test -- test/langfuse-e2e-support.test.ts` - passed, 4 tests.
- `pnpm --filter @openacme/config test -- langfuse-attribute-span-processor.test.ts` - passed, 2 tests.
- `pnpm test:e2e:langfuse` - passed, 1 live test covering success and logical shell failure readback.
- `pnpm --filter @openacme/config check-types` - passed.
- `pnpm --filter @openacme/server check-types` - passed.
- `pnpm --filter @openacme/config build` - passed.
- `pnpm --filter @openacme/server build` - passed.
- `git diff --check` - passed.

Live e2e evidence:

- The OpenAcme usage ledger produced an `interactive` row with `traceId`, `spanId`, `forensicRunId`, and `forensicPath`.
- The local forensic archive contained `agent.run.start`, `agent.run.finish`, `tool.start`, and `tool.finish`.
- Langfuse readback found `openacme.agent.turn` and `openacme.tool.execute` observations for the same trace.
- Langfuse readback found the shell failure tool observation and confirmed `tool_result_status=failure`, `tool_failure_kind=command_exit_nonzero`, `tool_failure_message=Command exited with code 7`, and `tool_exit_code=7`.

Attempted but not counted as passing:

- `pnpm --filter @openacme/server test:e2e` was started to verify the generic suite after excluding the Langfuse spec. It did not produce a final Vitest summary after more than two minutes and was interrupted. It is not counted as a successful validation.

Re-run:

```bash
pnpm test:e2e:langfuse
```
