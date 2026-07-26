import { describe, it, expect, beforeEach } from "vitest";
import { WasmDatabase } from "../src/wasm/adapter.js";
import { applySchema } from "../src/connection.js";
import {
  createUsageStore,
  type UsageEventInput,
} from "../src/stores/usage-store.js";

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const T0 = 1_750_000_000; // 2025-06-15T15:06:40Z

function ev(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    agentId: "a1",
    sessionId: "s1",
    kind: "interactive",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "api_key",
    inputTokens: 1000,
    outputTokens: 100,
    cachedInputTokens: 0,
    totalTokens: 1100,
    costUsd: 0.005,
    costUsdEquivalent: 0.005,
    costSource: "estimated",
    createdAt: T0,
    ...overrides,
  };
}

describe("UsageStore — record + totals", () => {
  let db: WasmDatabase;
  let store: ReturnType<typeof createUsageStore>;

  beforeEach(() => {
    db = freshDb();
    store = createUsageStore(db);
  });

  it("record roundtrips all columns", () => {
    const row = store.record(
      ev({
        messageId: "m1",
        taskId: "42",
        cacheWriteTokens: 200,
        reasoningTokens: 50,
        steps: 3,
        durationMs: 1234,
        traceId: "trace-1",
        spanId: "span-1",
        forensicRunId: "run-1",
        forensicPath: "/tmp/openacme/ai-forensics/2026-07-25/run-1",
        providerRequestCount: 2,
      })
    );
    expect(row.id).toBeTruthy();
    expect(row.agentId).toBe("a1");
    expect(row.taskId).toBe("42");
    expect(row.cacheWriteTokens).toBe(200);
    expect(row.reasoningTokens).toBe(50);
    expect(row.costSource).toBe("estimated");
    expect(row.steps).toBe(3);
    expect(row.durationMs).toBe(1234);
    expect(row.traceId).toBe("trace-1");
    expect(row.spanId).toBe("span-1");
    expect(row.forensicRunId).toBe("run-1");
    expect(row.forensicPath).toBe("/tmp/openacme/ai-forensics/2026-07-25/run-1");
    expect(row.providerRequestCount).toBe(2);
  });

  it("survives session deletion (no FK cascade)", () => {
    store.record(ev());
    // No sessions row exists at all — insert must not have required one,
    // and nothing cascades.
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM usage_events")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("totals sums, splits by auth mode and kind, respects filters", () => {
    store.record(ev());
    store.record(
      ev({
        agentId: "a2",
        kind: "autonomous",
        authMode: "oauth",
        costUsd: null,
        costSource: "subscription",
        cachedInputTokens: 800,
      })
    );
    store.record(ev({ kind: "title", createdAt: T0 + 10 }));

    const all = store.totals({});
    expect(all.events).toBe(3);
    expect(all.inputTokens).toBe(3000);
    expect(all.cachedInputTokens).toBe(800);
    expect(all.costUsd).toBeCloseTo(0.01);
    expect(all.costUsdEquivalent).toBeCloseTo(0.015);
    expect(all.costUsdByAuthMode.api_key).toBeCloseTo(0.01);
    expect(all.costUsdByAuthMode.oauth).toBe(0);
    expect(all.eventsByKind.interactive).toBe(1);
    expect(all.eventsByKind.autonomous).toBe(1);

    expect(store.totals({ agentId: "a2" }).events).toBe(1);
    expect(store.totals({ kind: "title" }).events).toBe(1);
    expect(store.totals({ from: T0 + 5 }).events).toBe(1);
    expect(store.totals({ to: T0 + 5 }).events).toBe(2);
  });
});

describe("UsageStore — series / breakdown", () => {
  let store: ReturnType<typeof createUsageStore>;

  beforeEach(() => {
    store = createUsageStore(freshDb());
    const day = 86_400;
    store.record(ev({ createdAt: T0 }));
    store.record(ev({ createdAt: T0 + 60, agentId: "a2", costUsd: 0.02, costUsdEquivalent: 0.02 }));
    store.record(ev({ createdAt: T0 + day, model: "claude-haiku-4-5" }));
  });

  it("series buckets by day and groups by agent", () => {
    const rows = store.series({}, "day", "agent");
    // Day 1 has a1 + a2, day 2 has a1 — three (t, key) rows.
    expect(rows).toHaveLength(3);
    const day1a1 = rows.find((r) => r.key === "a1" && r.t === rows[0]!.t);
    expect(day1a1?.events).toBe(1);
    const ts = new Set(rows.map((r) => r.t));
    expect(ts.size).toBe(2);
  });

  it("series buckets by hour", () => {
    const rows = store.series({}, "hour", "kind");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.t % 3600).toBe(0);
  });

  it("breakdown by model orders by spend and carries lastAt", () => {
    const rows = store.breakdown({}, "model");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.key).toBe("claude-sonnet-4-6"); // 2 events, higher spend
    expect(rows[0]!.events).toBe(2);
    expect(rows[0]!.lastAt).toBe(T0 + 60);
  });

  it("breakdown by task skips rows without a task binding", () => {
    store.record(ev({ taskId: "7", createdAt: T0 + 120 }));
    const rows = store.breakdown({}, "task");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("7");
  });
});

describe("UsageStore — pagination + budget feeds", () => {
  let store: ReturnType<typeof createUsageStore>;

  beforeEach(() => {
    store = createUsageStore(freshDb());
  });

  it("listEvents paginates newest-first with stable same-second order", () => {
    // 5 rows in the same epoch second — rowid tie-break must hold.
    for (let i = 0; i < 5; i++) store.record(ev({ id: `e${i}` }));
    const p1 = store.listEvents({}, { limit: 2 });
    expect(p1.events.map((e) => e.id)).toEqual(["e4", "e3"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = store.listEvents({}, { limit: 2, before: p1.nextCursor! });
    expect(p2.events.map((e) => e.id)).toEqual(["e2", "e1"]);
    const p3 = store.listEvents({}, { limit: 2, before: p2.nextCursor! });
    expect(p3.events.map((e) => e.id)).toEqual(["e0"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("listEvents includes nullable forensic correlation fields", () => {
    store.record(
      ev({
        id: "correlated",
        traceId: "trace-list",
        forensicRunId: "run-list",
        forensicPath: "/tmp/forensics/run-list",
        providerRequestCount: 4,
      })
    );

    const event = store.listEvents({}, { limit: 1 }).events[0]!;
    expect(event.id).toBe("correlated");
    expect(event.traceId).toBe("trace-list");
    expect(event.spanId).toBeNull();
    expect(event.forensicRunId).toBe("run-list");
    expect(event.forensicPath).toBe("/tmp/forensics/run-list");
    expect(event.providerRequestCount).toBe(4);
  });

  it("dailyCostByAgent groups per UTC day per agent", () => {
    const day = 86_400;
    store.record(ev({ createdAt: T0 }));
    store.record(ev({ createdAt: T0 + 30, agentId: "a2" }));
    store.record(ev({ createdAt: T0 + day }));
    const rows = store.dailyCostByAgent(T0 - 1);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.day < rows[2]!.day).toBe(true);
    expect(store.dailyCostByAgent(T0 + day - 1)).toHaveLength(1);
  });

  it("agentHourMatrix returns UTC hour cells", () => {
    store.record(ev({ createdAt: T0 }));
    store.record(ev({ createdAt: T0 + 3600 }));
    const cells = store.agentHourMatrix({});
    expect(cells).toHaveLength(2);
    for (const c of cells) {
      expect(c.hour).toBeGreaterThanOrEqual(0);
      expect(c.hour).toBeLessThan(24);
      expect(c.events).toBe(1);
    }
  });
});
