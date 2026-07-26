import { describe, it, expect, beforeEach } from "vitest";
import { WasmDatabase } from "../src/wasm/adapter.js";
import { applySchema } from "../src/connection.js";
import { createSessionTimelineStore } from "../src/stores/session-timeline-store.js";

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const T0 = 1_785_000_000_000;

describe("SessionTimelineStore", () => {
  let store: ReturnType<typeof createSessionTimelineStore>;

  beforeEach(() => {
    store = createSessionTimelineStore(freshDb());
  });

  it("records and roundtrips correlation fields and structured payload", () => {
    const row = store.record({
      id: "timeline-1",
      createdAtMs: T0,
      sessionId: "session-1",
      agentId: "agent-1",
      messageId: "message-1",
      taskId: "task-1",
      eventType: "session.turn.finished",
      source: "agent",
      status: "ok",
      traceId: "trace-1",
      spanId: "span-1",
      forensicRunId: "forensic-1",
      usageEventId: "usage-1",
      durationMs: 123,
      payload: {
        totalTokens: 42,
        rawPath: "provider-requests/1/response.body",
      },
    });

    expect(row).toMatchObject({
      id: "timeline-1",
      createdAtMs: T0,
      sessionId: "session-1",
      agentId: "agent-1",
      messageId: "message-1",
      taskId: "task-1",
      eventType: "session.turn.finished",
      source: "agent",
      status: "ok",
      traceId: "trace-1",
      spanId: "span-1",
      forensicRunId: "forensic-1",
      usageEventId: "usage-1",
      durationMs: 123,
      payload: {
        totalTokens: 42,
        rawPath: "provider-requests/1/response.body",
      },
    });
  });

  it("lists a session timeline oldest-first with same-millisecond row order", () => {
    store.record({
      id: "other",
      createdAtMs: T0,
      sessionId: "other-session",
      eventType: "session.turn.started",
      source: "agent",
    });
    store.record({
      id: "a",
      createdAtMs: T0,
      sessionId: "session-1",
      eventType: "session.user_message.received",
      source: "server",
    });
    store.record({
      id: "b",
      createdAtMs: T0,
      sessionId: "session-1",
      eventType: "session.turn.started",
      source: "agent",
    });
    store.record({
      id: "c",
      createdAtMs: T0 + 1,
      sessionId: "session-1",
      eventType: "session.turn.finished",
      source: "agent",
    });

    const page = store.list({ sessionId: "session-1" }, { limit: 10 });
    expect(page.events.map((event) => event.id)).toEqual(["a", "b", "c"]);
    expect(page.nextCursor).toBeNull();
  });

  it("supports forward pagination and forensic/correlation filters", () => {
    store.record({
      id: "a",
      createdAtMs: T0,
      sessionId: "session-1",
      eventType: "session.turn.started",
      source: "agent",
      traceId: "trace-1",
      forensicRunId: "forensic-1",
    });
    store.record({
      id: "b",
      createdAtMs: T0 + 1,
      sessionId: "session-1",
      eventType: "session.usage.finalized",
      source: "usage",
      usageEventId: "usage-1",
      forensicRunId: "forensic-1",
    });
    store.record({
      id: "c",
      createdAtMs: T0 + 2,
      sessionId: "session-1",
      eventType: "session.turn.started",
      source: "agent",
      traceId: "trace-2",
      forensicRunId: "forensic-2",
    });

    const first = store.list({ sessionId: "session-1" }, { limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toEqual({ createdAtMs: T0 + 1, rowid: 2 });

    const second = store.list(
      { sessionId: "session-1" },
      { limit: 2, after: first.nextCursor! }
    );
    expect(second.events.map((event) => event.id)).toEqual(["c"]);

    expect(
      store
        .list({ sessionId: "session-1", source: "usage" })
        .events.map((event) => event.id)
    ).toEqual(["b"]);
    expect(
      store
        .list({ sessionId: "session-1", traceId: "trace-2" })
        .events.map((event) => event.id)
    ).toEqual(["c"]);
    expect(
      store
        .list({ sessionId: "session-1", forensicRunId: "forensic-1" })
        .events.map((event) => event.id)
    ).toEqual(["a", "b"]);
    expect(
      store
        .list({ sessionId: "session-1", usageEventId: "usage-1" })
        .events.map((event) => event.id)
    ).toEqual(["b"]);
  });
});
