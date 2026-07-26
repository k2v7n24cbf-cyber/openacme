---
name: openacme-forensic-investigation
description: Investigate OpenAcme AI API interactions, OpenTelemetry traces, token spikes, tool-output inflation, session timelines, usage_events rows, and local AI forensic archives. Use when asked to perform a forensic analysis of OpenAcme sessions, traces, forensicRunIds, evidenceRefs, timeline locators, provider requests, model inputs, tool calls, or suspicious token/cost consumption.
---

# OpenAcme Forensic Investigation

## Core Rules

- Default to the test runtime `~/.openacme-test`. Do not read, restart, or
  mutate `~/.openacme` unless the user explicitly asks for production.
- Treat local forensic archives as sensitive evidence. Prefer hashes, byte
  counts, token counts, statuses, ids, timings, and short summaries.
- Do not paste raw prompts, provider bodies, tool outputs, secrets, cookies,
  OAuth tokens, API keys, or customer data into chat.
- Inspect the OpenTelemetry/observability config before using a backend UI.
  Use `usage_events` as the accounting ledger, `session_timeline_events` as the
  session index, and local forensics as the raw evidence archive.
- If the active backend is Langfuse, first confirm its configured base URL and
  version/API behavior; do not assume a fixed Langfuse deployment, UI shape, or
  skill name.
- Keep investigation actions read-only unless the user asks for a test run or
  a remediation change.

## Required Reference Loading

For any real investigation, load the reference files first. Do not answer
detailed forensic questions from this `SKILL.md` alone.

1. Always read `references/source-surfaces.md` for data locations, source of
   truth rules, OpenTelemetry backend routing, API endpoints, tables, and
   correlation fields.
2. Always read `references/evidence-resolution.md` when you have a
   `forensicRunId`, `evidenceRef`, `traceId`, `spanId`, `usageEventId`, or
   local forensic archive path.
3. Read `references/token-spike-analysis.md` for token spikes, history
   growth, provider request expansion, compression, hidden helper calls,
   memory selection/extraction, title generation, subagents, and autonomous
   dispatcher work.
4. Read `references/tool-outcomes.md` for tool start/finish/error events,
   wrapper failures versus logical result failures, shell/process/filesystem
   classification, MCP/custom tool classification expectations, and tool
   evidence lookup.
5. Read `references/reporting-and-safety.md` before reporting findings, raw
   evidence decisions, blind spots, failure modes, or production impact.

If a required reference file is unavailable, state that the forensic skill is
missing required reference material and name the missing file. Do not guess.

## Investigation Flow

1. Identify the anchor:
   - `sessionId`: query the session timeline first.
   - `traceId` or OTel backend observation/span: read `forensic_run_id` or
     `openacme.forensic.evidence_ref` from metadata/attributes when available.
   - `forensicRunId` or `evidenceRef`: resolve it through `usage_events`.
   - token/cost anomaly: start from largest `usage_events.total_tokens`.

2. Build the correlation set:
   - `sessionId`, `agentId`, `messageId`, `taskId`
   - `traceId`, `spanId`
   - `usageEventId`
   - `forensicRunId`
   - `evidenceRef`
   - `timelineLocator`

3. Read the ordered timeline:
   - Use `GET /api/sessions/<sessionId>/timeline?includeForensics=1&limit=300`.
   - Filter with `forensicRunId`, `traceId`, or `usageEventId` when available.
   - Confirm the order: user message, turn start, prompt snapshot, provider
     request/response, tool start/finish, usage finalization, turn finish/error.
   - For compression cases, also confirm `session.compression.*`,
     `compression.memory_flush.*`, and `compression.summarizer.*` events.
   - For hidden helper or autonomous cases, also confirm
     `session.title.*`, `session.memory.selection.*`,
     `session.memory.extraction.*`, `session.subagent.*`,
     `session.dispatcher.*`, and `session.autonomous.*` events.

4. Resolve local evidence:
   - Query `usage_events.forensic_run_id` to get `forensic_path`.
   - Read `forensic_path/run.json`.
   - Parse `forensic_path/events.jsonl`.
   - Use `evidenceRef` fragments to match the exact JSONL row.
   - Inspect raw files only when hashes/byte counts are insufficient.

5. Reconstruct token growth:
   - Compare `agent.model_input.snapshot` byte/hash facts.
   - Compare each `provider.request` ordinal and request body size/hash.
   - Inspect `tool.finish` result sizes, spill metadata, and
     `executionStatus`/`resultStatus`/`failureKind`.
   - Check whether the next `provider.request` grew after a tool result.
   - Check hidden helper usage rows: `kind="summarizer"` for compression
     summaries, `kind="extractor"` for memory extraction/pre-compaction memory
     flush, `kind="selector"` for memory recall selection, and `kind="title"`
     for title generation.
   - For autonomous sessions, compare `session.dispatcher.wake.*`,
     `session.dispatcher.capacity_queued`, `session.dispatcher.defer.skipped`,
     and `session.autonomous.*` rows with the related `taskId`.
   - End at `agent.run.finish` and `session.usage.finalized`.

6. Report with evidence:
   - State the anchor ids and exact files/events inspected.
   - Explain the sequence and likely cause.
   - Include token counts, byte counts, hashes, durations, provider/model,
     tool names, and status/error summaries.
   - Name any blind spots, skipped raw inspection, or unavailable telemetry.
