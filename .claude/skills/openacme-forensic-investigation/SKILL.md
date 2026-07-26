---
name: openacme-forensic-investigation
description: Investigate OpenAcme AI API interactions, Langfuse traces, token spikes, tool-output inflation, session timelines, usage_events rows, and local AI forensic archives. Use when asked to perform a forensic analysis of OpenAcme sessions, traces, forensicRunIds, evidenceRefs, timeline locators, provider requests, model inputs, tool calls, or suspicious token/cost consumption.
---

# OpenAcme Forensic Investigation

## Core Rules

- Default to the test runtime `~/.openacme-test`. Do not read, restart, or
  mutate `~/.openacme` unless the user explicitly asks for production.
- Treat local forensic archives as sensitive evidence. Prefer hashes, byte
  counts, token counts, statuses, ids, timings, and short summaries.
- Do not paste raw prompts, provider bodies, tool outputs, secrets, cookies,
  OAuth tokens, API keys, or customer data into chat.
- Use Langfuse as the trace/correlation UI, `usage_events` as the accounting
  ledger, `session_timeline_events` as the session index, and local forensics
  as the raw evidence archive.
- Keep investigation actions read-only unless the user asks for a test run or
  a remediation change.

## Investigation Flow

1. Identify the anchor:
   - `sessionId`: query the session timeline first.
   - `traceId` or Langfuse observation: read `forensic_run_id` or
     `openacme.forensic.evidence_ref` from metadata/attributes.
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

## Detailed Reference

Read `references/evidence-map.md` when you need concrete field names, SQL,
API calls, evidenceRef parsing rules, raw file locations, or reporting
templates.
