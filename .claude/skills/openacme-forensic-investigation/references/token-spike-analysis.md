# Token Spike Analysis

## 4M Token Investigation Sequence

When a user reports a session consumed about 4M tokens and you have only a
`usage_events` row with `session_id`, `forensic_run_id`, `forensic_path`,
`trace_id`, `span_id`, `provider`, `model`, `total_tokens`, and
`provider_request_count`:

1. Confirm the runtime boundary. Default to `~/.openacme-test`; do not inspect
   `~/.openacme` unless the user explicitly asks for production.
2. Record the correlation set:

   ```text
   sessionId, traceId, spanId, usageEventId if known, forensicRunId,
   forensicPath, provider, model, totalTokens, providerRequestCount
   ```

3. Fetch the ordered timeline:

   ```bash
   curl -sS "http://127.0.0.1:3457/api/sessions/<sessionId>/timeline?includeForensics=1&forensicRunId=<runId>&limit=300"
   ```

   If the API is unavailable, read `session_timeline_events` ordered by
   `created_at_ms ASC, rowid ASC`.

4. Query all `usage_events` rows for the same `session_id`, ordered by
   `created_at ASC, rowid ASC`. Include helper rows, not only the largest row.
5. Read `<forensic_path>/run.json` and `<forensic_path>/events.jsonl`. Start
   with hashes, byte counts, token counts, ordinals, statuses, and relative
   evidence dirs.
6. Compare `agent.model_input.snapshot` bytes/hashes with each
   `provider.request` ordinal. Check whether the provider request body grows
   after a tool result, memory recall, compression, or helper turn.
7. For each `provider.request` from `1..provider_request_count`, record
   provider/model, request body bytes/hash, pre-transform bytes/hash, status,
   response bytes/hash, duration, and provider request id when present.
8. Inspect `tool.start`, `tool.finish`, and `tool.error` events between
   provider requests. Large `resultPreSpillBytes` or `resultPostSpillBytes`,
   `spilled=true`, or a failure status can explain the next request's growth.
9. Check compression, memory, title, selector, subagent, and autonomous events
   listed below.
10. Inspect raw files only if hashes/byte counts are insufficient and the user
    needs content-level proof. If raw inspection is necessary, do it locally
    and report summaries, hashes, sizes, and relative paths only.

## Token Growth Causes To Classify

Classify the likely cause as one or more of:

```text
history size / uncompressed conversation
system prompt size
tool schema size
tool output included in next model input
provider retry or multiple provider.request ordinals
compression helper usage
memory selection or extraction helper usage
title generation helper usage
autonomous dispatcher-driven turn
subagent/helper turn
reasoning tokens
cache behavior: cached_input_tokens or cache_write_tokens
provider/model/auth change
```

## Compression And History Compaction

Timeline event names:

```text
session.compression.started
session.compression.finished
session.compression.failed
session.compression.noop
session.compression.memory_flush.started
session.compression.memory_flush.finished
session.compression.memory_flush.failed
session.compression.memory_flush.skipped
session.compression.summarizer.started
session.compression.summarizer.finished
session.compression.summarizer.failed
```

Local forensic event names:

```text
compression.memory_flush.start
compression.memory_flush.finish
compression.memory_flush.error
compression.summarizer.start
compression.summarizer.finish
compression.summarizer.error
```

Usage kinds:

```text
kind = summarizer   compression summarizer tokens
kind = extractor    memory extraction or pre-compaction memory flush tokens
```

Memory flush and summarizer are different:

```text
memory flush   pre-compaction helper that extracts/preserves durable memory
               before the visible conversation is compacted; usage usually
               appears as kind=extractor
summarizer     compression helper that creates the compacted conversation
               summary; usage appears as kind=summarizer
```

For compression suspicion, verify the order:

```text
session.compression.started
session.compression.memory_flush.*
compression.memory_flush.*
session.compression.summarizer.*
compression.summarizer.*
session.compression.finished or failed/noop
```

## Hidden Helper Rows

Always include these `usage_events.kind` values in session accounting:

```text
interactive   user-facing chat turn
autonomous    dispatcher-driven agent turn
extractor     memory extraction or memory flush helper
title         background title generation
selector      memory recall selection helper
summarizer    history compression summarizer
```

Related timeline prefixes:

```text
session.title.started
session.title.finished
session.title.failed
session.memory.selection.started
session.memory.selection.finished
session.memory.selection.failed
session.memory.selection.skipped
session.memory.extraction.started
session.memory.extraction.finished
session.memory.extraction.failed
session.memory.extraction.skipped
session.subagent.started
session.subagent.finished
session.subagent.failed
```

## Autonomous And Background Work

For autonomous/background token inflation, correlate:

```text
taskId
sessionId
agentId
usage_events.kind = autonomous
session.dispatcher.wake.started
session.dispatcher.wake.finished
session.dispatcher.wake.failed
session.dispatcher.capacity_queued
session.dispatcher.defer.skipped
session.autonomous.started
session.autonomous.finished
session.autonomous.failed
```

Use `taskId` to connect dispatcher events, autonomous usage rows, and the
session timeline. A token spike can be legitimate background work even when no
new user message appears in the same session window.
