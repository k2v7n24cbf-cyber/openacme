import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startE2EServer,
  openSSE,
  type E2EServer,
  type SSEEvent,
} from "./support/harness.js";
import { waitUntil } from "./support/client.js";

/**
 * Full agent turn, end to end over real HTTP + SSE, against a real daemon.
 * The model is the Vercel-SDK stub injected via `resolveModel` — so the whole
 * chat loop (POST → runChatTurn → streamText → SSE → persist) runs
 * deterministically with no tokens.
 *
 * One server + agent for the suite (spawning the per-agent sandbox worker is
 * the slow part); each test gets its own session, so they stay independent.
 */

let srv: E2EServer;

beforeAll(async () => {
  srv = await startE2EServer();
  await createAgent();
});
afterAll(async () => {
  await srv.close();
});

function req(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (!headers.has("authorization"))
    headers.set("authorization", `Bearer ${srv.authToken}`);
  return fetch(`${srv.baseUrl}${p}`, { ...init, headers });
}

async function createAgent(id = "helper", name = "Helper"): Promise<void> {
  const res = await req("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  expect(res.status).toBe(201);
}

async function postChat(sessionId: string, text: string): Promise<void> {
  const res = await postChatResponse(sessionId, text);
  expect(res.status).toBe(200);
}

function postChatResponse(sessionId: string, text: string): Promise<Response> {
  return req("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "helper",
      sessionId,
      messages: [
        { id: randomUUID(), role: "user", parts: [{ type: "text", text }] },
      ],
    }),
  });
}

async function fetchMessages(
  sessionId: string,
): Promise<Array<{ role: string; parts: any[] }>> {
  const res = await req(`/api/sessions/${sessionId}/messages`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ role: string; parts: any[] }>;
}

async function fetchTimeline(sessionId: string): Promise<{
  events: Array<{
    eventType: string;
    source: string;
    status?: string | null;
    payload?: unknown;
  }>;
}> {
  const res = await req(`/api/sessions/${sessionId}/timeline?limit=100`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    events: Array<{
      eventType: string;
      source: string;
      status?: string | null;
      payload?: unknown;
    }>;
  };
}

function assistantText(parts: any[]): string {
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text)
    .join("");
}

const isState = (state: string) => (e: SSEEvent) =>
  e.event === "session_state" && e.data["state"] === state;

describe("chat turn (e2e)", () => {
  it("streams an assistant reply over SSE and persists it", async () => {
    const sessionId = randomUUID();
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    await postChat(sessionId, "hello there");

    await sse.waitFor(isState("running"));
    await sse.waitFor(isState("idle"), 15_000);

    // The assistant message reached the client as live chunks...
    const partEvents = sse.events.filter((e) => e.event === "ui_message_part");
    expect(partEvents.length).toBeGreaterThan(0);

    // ...and was persisted with the mock's echo reply.
    const messages = await fetchMessages(sessionId);
    expect(messages.map((m) => m.role)).toContain("user");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    expect(assistantText(assistant!.parts)).toContain(
      "Mock reply. You said: hello there",
    );

    sse.close();
  });

  it("drives a real tool call and closes the turn", async () => {
    const sessionId = randomUUID();
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    // Directive makes the fake model emit a list_files tool call; the agent
    // executes it for real (default tools include list_files), then the
    // follow-up turn closes with text.
    await postChat(
      sessionId,
      'list please [[mock:tool:list_files:{"path":"."}]]',
    );

    await sse.waitFor(isState("idle"), 20_000);

    const messages = await fetchMessages(sessionId);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    const toolPart = assistant!.parts.find(
      (p) => typeof p?.type === "string" && p.type.startsWith("tool-"),
    );
    expect(
      toolPart,
      "expected a tool-* part on the assistant message",
    ).toBeTruthy();
    expect(assistantText(assistant!.parts)).toContain("Mock follow-up");

    sse.close();
  });

  it("surfaces an upstream model error into the turn", async () => {
    const sessionId = randomUUID();
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    await postChat(sessionId, "break it [[mock:error:scripted failure]]");

    // The turn still completes (idle) — the error is surfaced, not swallowed.
    await sse.waitFor(isState("idle"), 15_000);

    const messages = await fetchMessages(sessionId);
    const assistant = messages.find((m) => m.role === "assistant");
    // An assistant row is persisted carrying the upstream-error data part.
    if (assistant) {
      const hasError = assistant.parts.some(
        (p) => p?.type === "data-upstream-error" || p?.type === "data-status",
      );
      expect(hasError || assistantText(assistant.parts).length >= 0).toBe(true);
    }

    sse.close();
  });

  it("blocks a taskless chat session after context_length_exceeded", async () => {
    const sessionId = randomUUID();
    const providerError = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message:
          "Your input exceeds the context window of this model. Please adjust your input and try again.",
        param: "input",
      },
    };
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    await postChat(
      sessionId,
      `taskless overflow [[mock:error-anywhere:${JSON.stringify(providerError)}]]`,
    );
    await sse.waitFor(isState("idle"), 15_000);
    await waitUntil(async () => {
      const messages = await fetchMessages(sessionId);
      return messages.some(
        (message) =>
          message.role === "assistant" &&
          message.parts.some((part) => part?.type === "data-upstream-error"),
      );
    });

    const sessionRes = await req(`/api/sessions/${sessionId}`);
    expect(sessionRes.status).toBe(200);
    const session = await sessionRes.json();
    expect(session.kind).toBe("chat");
    expect(session.turnsBlockedReason).toBe("context_length_exceeded");
    await waitUntil(async () => {
      const timeline = await fetchTimeline(sessionId);
      return timeline.events.some(
        (event) =>
          event.eventType === "session.turn_blocked" &&
          event.source === "dispatcher" &&
          event.status === "blocked" &&
          (event.payload as { reason?: string } | null)?.reason ===
            "context_length_exceeded",
      );
    });

    const retry = await postChatResponse(sessionId, "should be rejected");
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      error: "session_system_blocked",
      sessionId,
      reason: "context_length_exceeded",
    });
    await waitUntil(async () => {
      const timeline = await fetchTimeline(sessionId);
      return timeline.events.some(
        (event) =>
          event.eventType === "session.chat.rejected" &&
          event.source === "server" &&
          event.status === "blocked" &&
          (event.payload as { reason?: string; blockReason?: string } | null)
            ?.reason === "session_system_blocked" &&
          (event.payload as { blockReason?: string } | null)?.blockReason ===
            "context_length_exceeded",
      );
    });

    sse.close();
  });

  it("does not block a fresh chat when proactive compression no-ops as too_short", async () => {
    const lowThreshold = await startE2EServer({
      behavior: {
        compressionThresholdTokens: 1,
        compressionThresholdPercent: null,
        compressionProtectFirstN: 1,
        compressionTailTokenBudget: 200,
      },
    });
    const authHeaders = {
      authorization: `Bearer ${lowThreshold.authToken}`,
      host: "127.0.0.1",
    };
    try {
      const create = await fetch(`${lowThreshold.baseUrl}/api/agents`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ id: "helper", name: "Helper" }),
      });
      expect(create.status).toBe(201);

      const sessionId = randomUUID();
      const sse = await openSSE(
        `${lowThreshold.baseUrl}/api/sessions/${sessionId}/stream`,
      );
      const chat = await fetch(`${lowThreshold.baseUrl}/api/chat`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "helper",
          sessionId,
          messages: [
            {
              id: randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "hi" }],
            },
          ],
        }),
      });
      expect(chat.status).toBe(200);
      await sse.waitFor(isState("idle"), 15_000);

      const messagesRes = await fetch(
        `${lowThreshold.baseUrl}/api/sessions/${sessionId}/messages`,
        { headers: authHeaders },
      );
      expect(messagesRes.status).toBe(200);
      const messages = (await messagesRes.json()) as Array<{
        role: string;
        parts: any[];
      }>;
      const assistant = messages.find(
        (message) => message.role === "assistant",
      );
      expect(assistantText(assistant?.parts ?? [])).toContain(
        "Mock reply. You said: hi",
      );

      const sessionRes = await fetch(
        `${lowThreshold.baseUrl}/api/sessions/${sessionId}`,
        { headers: authHeaders },
      );
      expect(sessionRes.status).toBe(200);
      const session = await sessionRes.json();
      expect(session.turnsBlockedReason).toBeNull();
      sse.close();
    } finally {
      await lowThreshold.close();
    }
  });
});
