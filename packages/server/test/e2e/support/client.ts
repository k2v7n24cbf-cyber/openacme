import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { e2eToken, type SSEEvent } from "./harness.js";

/** Thin HTTP client over a running e2e daemon. Auth is always on, so every
 *  request carries the harness-seeded operator session as a bearer token. */
export function makeClient(baseUrl: string, token: string = e2eToken()) {
  function req(p: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("host", "127.0.0.1");
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${baseUrl}${p}`, { ...init, headers });
  }

  async function json(p: string, init?: RequestInit): Promise<any> {
    const res = await req(p, init);
    return res.json();
  }

  function post(p: string, body: unknown, init: RequestInit = {}): Promise<Response> {
    return req(p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.headers as object) },
      body: JSON.stringify(body),
      ...init,
    });
  }

  async function createAgent(
    id: string,
    name = id,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const res = await post("/api/agents", { id, name, ...extra });
    expect(res.status, `create agent ${id}`).toBe(201);
  }

  /** Fire a chat turn. Returns the session + user-message ids. */
  async function chat(
    agentId: string,
    text: string,
    sessionId = randomUUID()
  ): Promise<{ sessionId: string; userMessageId: string }> {
    const userMessageId = randomUUID();
    const res = await post("/api/chat", {
      agentId,
      sessionId,
      messages: [{ id: userMessageId, role: "user", parts: [{ type: "text", text }] }],
    });
    expect(res.status, "POST /api/chat").toBe(200);
    return { sessionId, userMessageId };
  }

  async function messages(
    sessionId: string
  ): Promise<Array<{ id?: string; role: string; parts: any[]; metadata?: unknown }>> {
    return json(`/api/sessions/${sessionId}/messages`);
  }

  return { req, json, post, createAgent, chat, messages };
}

export function assistantText(parts: any[]): string {
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text)
    .join("");
}

export const isState = (state: string) => (e: SSEEvent) =>
  e.event === "session_state" && e.data["state"] === state;

/** Poll a predicate until true or timeout — for state that lands in the store
 *  rather than over SSE (task transitions, memory writes). */
export async function waitUntil(
  fn: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 150 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
