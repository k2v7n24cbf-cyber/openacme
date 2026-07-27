# Non-Blocking Local Forensic Archive Plan

## Goal

Make local AI forensic collection a bounded, non-blocking side effect. The main
Node process may construct small correlation metadata, but it must not perform
sync filesystem writes, unbounded raw payload copies, or large prompt snapshots
on the request/agent hot path.

This plan covers the local forensic archive only. Dispatcher stuck-session
cleanup and hard subagent timeout are separate runtime slices.

## Architecture Contract

1. Core execution keeps ownership of execution.
   Provider registry owns provider HTTP. Agent/core owns `streamText` and helper
   model calls. Tool registry owns tool execution.

2. Local forensic archive is a sink.
   `recordEvent` and `writeRawFile` enqueue bounded archive jobs and return
   immediately. They never await disk I/O and never throw into core execution.

3. Provider wire bodies are not telemetry.
   Raw provider request and response bodies are not captured by the provider
   observer. Production telemetry records provider/model/auth, request ordinal,
   status, provider request id, timing, trace/span ids, and evidence locators.
   If raw incident capture is ever needed, it must be a separate explicit local
   mode with short retention and hard caps, not the default provider observer.

4. Worker-backed persistence owns disk and heavy serialization.
   The archive writer worker owns `mkdir`, `chmod`, `append`, JSONL
   serialization, and raw file writes. Queue overflow drops archive jobs instead
   of delaying provider/tool/agent execution.

5. Snapshot capture is lazy.
   Agent/model input snapshots and helper prompt snapshots are only materialized
   when local raw capture is enabled and the payload is under the hard cap.

6. Shutdown flush is explicit.
   Entry points that care about draining evidence call the exported flush hook
   during graceful or fatal shutdown. Flush has a short timeout and never blocks
   indefinitely.

## Milestone M9 - Worker-Backed Forensic Writer

Goal:

- Replace sync local forensic file writes with a bounded worker-backed writer.

TDD:

- Add recorder tests proving `createForensicRecorder`, `recordEvent`, and
  `writeRawFile` do not call sync `fs` methods on the main thread.
- Add tests proving `flushForensicRecorder` drains queued `run.json`,
  `events.jsonl`, and raw files before readback.
- Add tests proving raw files above
  `OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES` are skipped with a metadata event.
- Add tests proving queue overflow does not throw or delay the caller.

Implementation:

- Add queue config:
  `OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES` default `1048576`,
  `OPENACME_AI_FORENSICS_QUEUE_MAX_JOBS` default `10000`, and
  `OPENACME_AI_FORENSICS_QUEUE_MAX_RAW_BYTES` default `16777216`.
- Add `flushForensicRecorder` / `flushForensicWriters` public hooks.
- Keep `ForensicRecorder.writeRawFile` return shape for callers, but return
  `null` for skipped oversized raw files.

Review checklist:

- No `*Sync` filesystem calls remain in the main recorder implementation.
- `ForensicRecorder` methods remain best-effort and non-throwing.
- Existing timeline/local evidence readback passes after explicit flush.

## Milestone M10 - Remove Provider Raw Bodies And Lazy Snapshot Capture

Goal:

- Remove provider wire body capture and remove unbounded prompt/helper snapshot
  materialization from hot paths.

TDD:

- Provider observation does not buffer, hash, or write provider request/response
  bodies.
- Provider observation keeps provider fetch behavior and records status/request
  metadata.
- Agent run observation does not stringify model input snapshots when raw
  capture is disabled.
- Helper observations write raw snapshots only when raw capture is enabled.

Implementation:

- Provider observation records body presence/type metadata only; it does not
  materialize provider body bytes.
- Agent run observation computes `messagesJson` and `toolsJson` only when the
  recorder reports raw capture enabled.
- Helper call sites keep prompt/model-call ownership in their original modules,
  but only send bounded raw evidence to the sink.

Review checklist:

- No provider response stream is consumed for observation.
- No core execution path awaits forensic archive writes.
- Large payloads produce small skip metadata, not large memory copies.

## Milestone M11 - Shutdown Flush Integration

Goal:

- Drain queued forensic jobs during normal daemon shutdown and process-level
  fatal guard handling without adding package dependency cycles.

TDD:

- CLI/server process guard tests verify a supplied forensic flush hook is called
  before telemetry shutdown and process exit.
- Flush timeout failures are logged and swallowed.

Implementation:

- Keep `@openacme/config` independent from `@openacme/llm-provider`.
- Compose telemetry flush and evidence flush in CLI/server entrypoints.
- Use a small timeout so shutdown cannot hang indefinitely.

Review checklist:

- Config package has no dependency on llm-provider.
- Graceful shutdown still closes the manager.
- Fatal shutdown still exits with code `1`.

## Validation

Focused:

```sh
pnpm --filter @openacme/llm-provider test -- forensics-recorder.test.ts provider-observation.test.ts
pnpm --filter @openacme/agent-core test -- agent-forensics.test.ts helper-observation.test.ts agent-compress.test.ts
pnpm --filter @openacme/config test -- process-exception-guard.test.ts
```

Type/build:

```sh
pnpm --filter @openacme/llm-provider check-types
pnpm --filter @openacme/agent-core check-types
pnpm --filter @openacme/config check-types
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/cli check-types
```

Live test environment:

- Use `/Users/alenbohcelyan/.openacme-test` only.
- Run the Langfuse/local forensic telemetry canary after focused tests pass.
- Confirm local evidence still appears after flush and Langfuse readback still
  has trace/span/session correlation.

## Milestone Review - 2026-07-27

M9 status: completed.

- Added `packages/llm-provider/src/forensics-writer.ts`, a bounded
  worker-thread archive writer.
- `packages/llm-provider/src/forensics-recorder.ts` no longer performs
  `mkdirSync`, `chmodSync`, `writeFileSync`, or `appendFileSync`.
- Added public flush hooks:
  `flushForensicRecorder` / `flushForensicWriters` and
  `flushEvidenceRecorder` / `flushEvidenceWriters`.
- Added hard raw-file cap and queue cap coverage, including queue-full behavior
  that drops evidence without throwing.

M10 status: completed.

- Provider observation no longer buffers, hashes, or writes provider raw request
  or response bodies.
- Provider request/response events keep correlation metadata, redacted headers,
  body presence/kind, status, provider request id, trace/span ids, and evidence
  locators.
- Agent model-input snapshots and compression memory-flush snapshots are lazy:
  they are only materialized when local raw capture is enabled and under
  `OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES`.

M11 status: completed.

- CLI and server entrypoints compose evidence flush with OpenTelemetry shutdown.
- Shutdown flush is bounded to 2 seconds and sits at the entrypoint layer, so
  `@openacme/config` does not depend on `@openacme/llm-provider`.

Focused validation completed:

```sh
pnpm --filter @openacme/llm-provider test -- forensics-recorder.test.ts provider-observation.test.ts ai-observation-public-api.test.ts evidence-locator.test.ts
pnpm --filter @openacme/llm-provider check-types
pnpm --filter @openacme/llm-provider build
pnpm --filter @openacme/config test -- process-exception-guard.test.ts
pnpm --filter @openacme/config check-types
pnpm --filter @openacme/agent-core check-types
pnpm --filter @openacme/agent-core test -- agent-observation.test.ts agent-forensics.test.ts helper-observation.test.ts agent-compress.test.ts agent-telemetry.test.ts
pnpm --filter @openacme/server check-types
pnpm --filter @openacme/cli check-types
```

Static gates completed:

- No sync filesystem calls remain in
  `packages/llm-provider/src/forensics-recorder.ts`.
- No provider raw body capture helpers or body hash fields remain in
  `packages/llm-provider/src`.
- No unconditional `JSON.stringify(args.messages)` or
  `JSON.stringify(flushMessages)` patterns remain in the agent observation hot
  paths.

Observed test notes:

- The invalid archive-root test logs expected worker warnings for `ENOTDIR`.
  The caller still does not throw.

Live validation completed against `/Users/alenbohcelyan/.openacme-test`:

- Rebuilt affected runtime packages and restarted only the test daemon:
  `pnpm agent restart -d /Users/alenbohcelyan/.openacme-test --no-service --no-browser`.
- Local Langfuse health passed at `http://127.0.0.1:3001/api/public/health`
  with version `3.224.1`.
- Ran
  `OPENACME_VERIFY_AGENT_ID=langfuse-canary-local OPENACME_TEST_BASE_URL=http://127.0.0.1:3457 OPENACME_TEST_DATA_DIR=/Users/alenbohcelyan/.openacme-test LANGFUSE_VERIFY_TIMEOUT_MS=180000 node ops/langfuse-local/verify-openacme-test-telemetry.mjs`.
  Passed with direct session `5df72b34-142c-47f8-80b1-83ce371b8b09`
  and tool session `6688e4b0-72c1-4add-a4bd-d6c5a5936ed4`.
- Telemetry canary confirmed Langfuse `openacme.agent.turn`,
  `openacme.provider.request`, and `openacme.tool.execute` visibility, plus
  OpenAcme timeline/local evidence correlation through `forensicRunId`.
- Ran
  `OPENACME_TEST_BASE_URL=http://127.0.0.1:3457 OPENACME_TEST_DATA_DIR=/Users/alenbohcelyan/.openacme-test LANGFUSE_VERIFY_TIMEOUT_MS=180000 node ops/langfuse-local/verify-openacme-test-compression.mjs`.
  Passed with compression session `fd1a0396-0de6-405d-a660-49824fa17ea0`.
- Compression canary confirmed summarizer/extractor usage rows, helper spans,
  provider request/response events, local evidence locators, and no timeline
  leakage of raw/local paths.
- Temporary fake provider on `127.0.0.1:45671` was stopped after validation.
- Final test daemon status, checked outside the sandbox:
  `~/.openacme-test` running on pid `42709`, health `200 OK`.
