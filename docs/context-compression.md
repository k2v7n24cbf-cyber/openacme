# Context Compression

OpenAcme keeps two separate views of a chat:

- Canonical conversation history lives in `messages` and is what readers see.
- Model context is the per-turn projection sent to the provider.

Compression only changes the model context. It must not move, delete, or
replace canonical chat messages.

## Flow

1. `/api/chat` persists the new user message in `messages`.
2. `Agent.prepareModelHistory()` estimates system prompt, history, tools, and
   image costs.
3. If the configured threshold is crossed, `Compressor.compress()` creates a
   `[head + summary + tail]` UIMessage list.
4. The compacted list is stored in `session_context_snapshots`.
5. `Agent.runStream()` receives the compacted list as `history` and converts it
   with `uiToModelMessages()`.
6. The assistant response is appended to canonical `messages` with
   `metadata.contextSnapshotId`.

When no compression is needed, `runStream()` receives the canonical history and
no snapshot is written.

Compression is attempted only when the request is over the proactive threshold
and the conversation has compressible older history. A large base request
(system prompt, tool schemas, memory/context, and the latest user message) must
not trigger compaction by itself when there are no older turns to summarize.

If compression is genuinely required but the summarizer fails or returns no
usable compacted model context, OpenAcme must not fall back to sending raw
canonical history. The turn is aborted with a provider-error style assistant
message, the session gets `turns_blocked_reason = "compression_failed"`, and
any attached in-progress task becomes `system_blocked`.

## Debugging

Assistant messages produced from a compacted context include:

```json
{
  "contextSnapshotId": "...",
  "contextCompressed": true
}
```

The web UI uses that id to render a side-by-side comparison:

- Conversation: canonical `messages`.
- Model Context: exact `session_context_snapshots.model_messages` sent to the
  provider.

The backend endpoint is:

```http
GET /api/sessions/:sessionId/context-snapshots/:snapshotId
```

It returns canonical messages, model-context messages, and snapshot metadata.

## Verification

The live-style e2e test deliberately inflates context and proves compression
without history loss:

```sh
cd packages/server
pnpm vitest run --config vitest.e2e.config.ts test/e2e/context-compression.e2e.ts
```

Expected evidence:

- The log includes `preflight compression: tokens >= threshold`.
- Canonical message count after the turn is greater than the compacted model
  context count.
- The assistant message has `metadata.contextSnapshotId`.
- The snapshot model context contains `[CONTEXT COMPACTION]`.

The session turn-control live verification separately covers compression
failure: when compaction is required but fails, retrying the same session returns
`409 session_system_blocked`.

The `too_short` compression no-op is not a failure. It means the request crossed
the proactive threshold, but there is not enough older conversation history to
compact, so the turn should continue normally.
