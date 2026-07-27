import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, openSSE, type E2EServer } from "./support/harness.js";
import { makeClient, assistantText, isState } from "./support/client.js";

let srv: E2EServer;
let c: ReturnType<typeof makeClient>;

beforeAll(async () => {
  srv = await startE2EServer({
    behavior: {
      compressionThresholdTokens: 1000,
      compressionThresholdPercent: null,
      compressionProtectFirstN: 1,
      compressionTailTokenBudget: 200,
      compressionSummaryTargetRatio: 0.2,
      compressionSummarizerInputCharBudget: 80_000,
    },
  });
  c = makeClient(srv.baseUrl, srv.authToken);
  await c.createAgent("context-heavy", "Context Heavy");
});

afterAll(async () => {
  await srv?.close();
});

describe("context compression model snapshots (e2e)", () => {
  it("compacts provider input while preserving canonical session history", async () => {
    const sessionId = randomUUID();
    srv.manager.sessionStore.create("context-heavy", { id: sessionId });

    const seed = [];
    for (let i = 0; i < 24; i++) {
      seed.push({
        id: `u-${i}`,
        role: "user" as const,
        parts: [{ type: "text", text: `user-${i} ${"x".repeat(900)}` }],
      });
      seed.push({
        id: `a-${i}`,
        role: "assistant" as const,
        parts: [{ type: "text", text: `assistant-${i} ${"y".repeat(900)}` }],
      });
    }
    srv.manager.messageStore.appendMany(
      sessionId,
      seed.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
      })),
    );

    const finalUser = {
      id: "u-final",
      role: "user" as const,
      parts: [{ type: "text", text: "finish with compression [[mock:text:compressed-ok]]" }],
    };
    const sse = await openSSE(`${srv.baseUrl}/api/sessions/${sessionId}/stream`);
    const res = await c.post("/api/chat", {
      agentId: "context-heavy",
      sessionId,
      messages: [...seed, finalUser],
    });
    expect(res.status).toBe(200);
    await sse.waitFor(isState("idle"), 20_000);
    sse.close();

    const canonical = await c.messages(sessionId);
    const assistant = canonical.findLast((m) => m.role === "assistant");
    expect(assistantText(assistant?.parts ?? [])).toContain("compressed-ok");
    const metadata = assistant?.metadata as
      | { contextSnapshotId?: string; contextCompressed?: boolean }
      | undefined;

    expect(
      metadata?.contextSnapshotId,
      `expected context snapshot metadata; canonicalMessageCountAfter=${canonical.length}`,
    ).toBeTruthy();
    expect(metadata?.contextCompressed).toBe(true);
    expect(canonical.map((m) => m.id).slice(0, seed.length)).toEqual(
      seed.map((m) => m.id),
    );
    expect(canonical.some((m) => m.id === finalUser.id)).toBe(true);

    const snapshotRes = await c.req(
      `/api/sessions/${sessionId}/context-snapshots/${metadata!.contextSnapshotId}`,
    );
    expect(snapshotRes.status).toBe(200);
    const snapshot = (await snapshotRes.json()) as {
      canonical: { messages: Array<{ id: string }> };
      modelContext: { messages: Array<{ role: string; parts: unknown[] }> };
      meta: {
        compressed: boolean;
        canonicalMessageCount: number;
        sourceLastMessageId: string;
      };
    };

    const modelText = JSON.stringify(snapshot.modelContext.messages);
    expect(snapshot.meta.compressed).toBe(true);
    expect(snapshot.meta.canonicalMessageCount).toBe(seed.length + 1);
    expect(snapshot.meta.sourceLastMessageId).toBe(finalUser.id);
    expect(snapshot.canonical.messages.length).toBe(canonical.length);
    expect(
      snapshot.modelContext.messages.length,
      `context compression diagnostic: canonicalMessageCountAfter=${canonical.length}; modelContextMessageCount=${snapshot.modelContext.messages.length}; snapshotId=${metadata!.contextSnapshotId}`,
    ).toBeLessThan(seed.length + 1);
    expect(modelText).toContain("[CONTEXT COMPACTION");
  });
});
