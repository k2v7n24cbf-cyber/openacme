import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startE2EServer, openSSE, type E2EServer } from "./support/harness.js";
import {
  makeClient,
  assistantText,
  isState,
  waitUntil,
} from "./support/client.js";

function findJsonField(value: unknown, field: string): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return findJsonField(JSON.parse(value), field);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonField(item, field);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj[field] === "string") return obj[field];
    for (const item of Object.values(obj)) {
      const found = findJsonField(item, field);
      if (found) return found;
    }
  }
  return undefined;
}

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
  await c.createAgent("asker", "Asker");
  await c.createAgent("peer-heavy", "Peer Heavy");
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
      modelContext: {
        kind: string;
        includesProviderRequestEnvelope: boolean;
        messages: Array<{ role: string; parts: unknown[] }>;
      };
      meta: {
        compressed: boolean;
        canonicalMessageCount: number;
        sourceLastMessageId: string;
        semantics: string;
      };
    };

    const modelText = JSON.stringify(snapshot.modelContext.messages);
    expect(snapshot.modelContext.kind).toBe("initial_ui_message_projection");
    expect(snapshot.modelContext.includesProviderRequestEnvelope).toBe(false);
    expect(snapshot.meta.semantics).toBe("ui_message_projection");
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

  it("agent_ask sends prepared snapshot projection instead of reloaded canonical history", async () => {
    const first = await c.chat(
      "asker",
      'ask peer [[mock:tool:agent_ask:{"agent_id":"peer-heavy","message":"first peer"}]]',
    );
    await waitForPeerAskOutput(first.sessionId, 1);
    const firstAssistant = (await c.messages(first.sessionId)).findLast(
      (m) => m.role === "assistant",
    );
    const firstToolPart = firstAssistant?.parts.find(
      (p) => p?.type === "tool-agent_ask",
    );
    const peerSessionId = findJsonField(firstToolPart, "session_id");
    expect(peerSessionId).toBeTruthy();

    const seed: Array<{
      id: string;
      role: "user" | "assistant";
      parts: Array<{ type: "text"; text: string }>;
    }> = [
      {
        id: "peer-raw-marker",
        role: "user" as const,
        parts: [
          {
            type: "text",
            text: "[[mock:error-anywhere:RAW_CANONICAL_AGENT_ASK_WAS_SENT]]",
          },
        ],
      },
    ];
    for (let i = 1; i < 30; i++) {
      seed.push({
        id: `peer-seed-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        parts: [{ type: "text", text: `${i} ${"z".repeat(900)}` }],
      });
    }
    srv.manager.messageStore.appendMany(
      peerSessionId!,
      seed.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
      })),
    );
    srv.manager.contextSnapshotStore.create({
      id: "peer-agent-ask-source-snapshot",
      sessionId: peerSessionId!,
      reason: "proactive",
      compressed: true,
      modelMessages: [
        {
          id: "peer-agent-ask-summary",
          role: "user",
          parts: [
            {
              type: "text",
              text: "[CONTEXT COMPACTION] Existing peer summary",
            },
          ],
        },
      ],
      canonicalMessageCount: seed.length,
      sourceLastMessageId: seed[seed.length - 1]!.id,
      summaryText: "Existing peer summary",
    });

    const runHistories: unknown[] = [];
    const peerAgent = srv.manager.getAgent("peer-heavy");
    const originalRunStream = peerAgent.runStream.bind(peerAgent);
    const runStreamSpy = vi
      .spyOn(peerAgent, "runStream")
      .mockImplementation(async (opts) => {
        runHistories.push(opts.history);
        return originalRunStream(opts);
      });
    const assistantCountBeforeSecond = (await c.messages(first.sessionId)).filter(
      (m) => m.role === "assistant",
    ).length;
    try {
      await c.chat(
        "asker",
        `ask peer again [[mock:tool:agent_ask:{"agent_id":"peer-heavy","session_id":"${peerSessionId}","message":"projection-ok"}]]`,
        first.sessionId,
      );
      await waitForPeerAskOutput(
        first.sessionId,
        assistantCountBeforeSecond + 1,
      );
    } finally {
      runStreamSpy.mockRestore();
    }
    const providerHistoryText = runHistories
      .map((history) => JSON.stringify(history))
      .find(
        (historyText) =>
          historyText.includes("projection-ok") &&
          !historyText.includes("memory extraction subagent"),
      );
    expect(providerHistoryText).toBeTruthy();
    expect(providerHistoryText).toContain("Existing peer summary");
    expect(providerHistoryText).not.toContain(
      "RAW_CANONICAL_AGENT_ASK_WAS_SENT",
    );
    const secondAssistant = (await c.messages(first.sessionId)).findLast(
      (m) => m.role === "assistant",
    );
    const secondToolPart = secondAssistant?.parts.find(
      (p) => p?.type === "tool-agent_ask",
    );
    expect(JSON.stringify(secondToolPart)).toContain("projection-ok");
    expect(JSON.stringify(secondToolPart)).not.toContain(
      "RAW_CANONICAL_AGENT_ASK_WAS_SENT",
    );

    const peerMessages = await c.messages(peerSessionId!);
    const peerAssistant = peerMessages.findLast((m) => m.role === "assistant");
    const metadata = peerAssistant?.metadata as
      | { contextSnapshotId?: string; contextCompressed?: boolean }
      | undefined;
    expect(metadata?.contextCompressed).toBe(true);
    expect(metadata?.contextSnapshotId).toBeTruthy();
  });

  it("does not show proactive compacting status for pure snapshot reuse", async () => {
    const sessionId = randomUUID();
    srv.manager.sessionStore.create("context-heavy", { id: sessionId });
    const seed = [];
    for (let i = 0; i < 20; i++) {
      seed.push({
        id: `reuse-u-${i}`,
        role: "user" as const,
        parts: [{ type: "text", text: `reuse-user-${i} ${"x".repeat(900)}` }],
      });
      seed.push({
        id: `reuse-a-${i}`,
        role: "assistant" as const,
        parts: [
          { type: "text", text: `reuse-assistant-${i} ${"y".repeat(900)}` },
        ],
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
    srv.manager.contextSnapshotStore.create({
      id: "chat-snapshot-reuse-source",
      sessionId,
      reason: "proactive",
      compressed: true,
      modelMessages: [
        {
          id: "chat-snapshot-reuse-summary",
          role: "user",
          parts: [
            {
              type: "text",
              text: "[CONTEXT COMPACTION] Existing chat summary",
            },
          ],
        },
      ],
      canonicalMessageCount: seed.length,
      sourceLastMessageId: seed[seed.length - 1]!.id,
      summaryText: "Existing chat summary",
    });

    const finalUser = {
      id: "reuse-final",
      role: "user" as const,
      parts: [{ type: "text", text: "reuse projection [[mock:text:reuse-ok]]" }],
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

    await waitUntil(async () => {
      const assistant = (await c.messages(sessionId)).findLast(
        (m) => m.role === "assistant",
      );
      return assistantText(assistant?.parts ?? []).includes("reuse-ok");
    });
    const statusMessages = sse.events
      .filter((event) => event.event === "ui_message_part")
      .map((event) => event.data["part"])
      .filter(
        (part): part is { type?: string; data?: { message?: string } } =>
          !!part && typeof part === "object",
      )
      .map((part) => part.data?.message)
      .filter(Boolean);
    expect(statusMessages).not.toContain("Compacting older context…");
  });
});

async function waitForPeerAskOutput(
  sessionId: string,
  minAssistantCount: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 80; i++) {
    const assistants = (await c.messages(sessionId)).filter(
      (m) => m.role === "assistant",
    );
    const assistant = assistants.at(-1);
    if (
      assistants.length >= minAssistantCount &&
      assistant?.parts.some(
        (p) => p?.type === "tool-agent_ask" && p.state === "output-available",
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("timed out waiting for agent_ask output");
}
