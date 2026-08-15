import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { registry as toolRegistry } from "@openacme/tools";
import { startE2EServer, openSSE, type E2EServer } from "./support/harness.js";
import { makeClient, isState, waitUntil } from "./support/client.js";

/**
 * The workforce loop, end to end: task tools an agent invokes for real, cross-
 * agent assignment, coworker discovery, and the dispatcher waking an assignee.
 */

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

describe("task tools (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  async function chatAndWait(
    agentId: string,
    text: string,
  ): Promise<{ sessionId: string; userMessageId: string }> {
    const result = await c.chat(agentId, text);
    await waitUntil(
      async () =>
        (await c.messages(result.sessionId)).some(
          (m) => m.role === "assistant",
        ),
      { timeoutMs: 15_000 },
    );
    return result;
  }

  beforeAll(async () => {
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
    await c.createAgent("helper");
    await c.createAgent("worker");
    const quiet = await c.post("/api/agents", {
      id: "quiet",
      name: "Quiet",
      instantMessagesEnabled: false,
    });
    expect(quiet.status).toBe(201);
  });
  afterAll(async () => {
    await srv.close();
  });

  it("an agent creates a task assigned to a coworker", async () => {
    await chatAndWait(
      "helper",
      '[[mock:tool:task_create:{"title":"Ship the docs","assignee":"worker"}]]',
    );

    await waitUntil(async () => {
      const { tasks } = await c.json("/api/tasks");
      return tasks.some((t: any) => t.title === "Ship the docs");
    });

    const { tasks } = await c.json("/api/tasks");
    const task = tasks.find((t: any) => t.title === "Ship the docs");
    expect(task.assignee).toBe("worker");
    expect(task.created_by).toBe("helper");
  });

  it("an agent advances and resolves a task through its lifecycle", async () => {
    await chatAndWait(
      "helper",
      '[[mock:tool:task_create:{"title":"Fix the bug","assignee":"helper"}]]',
    );
    await waitUntil(async () => {
      const { tasks } = await c.json("/api/tasks");
      return tasks.some((t: any) => t.title === "Fix the bug");
    });
    const task = (await c.json("/api/tasks")).tasks.find(
      (t: any) => t.title === "Fix the bug",
    );

    await chatAndWait(
      "helper",
      `[[mock:tool:task_update:${JSON.stringify({ id: task.id, status: "in_progress" })}]]`,
    );
    await waitUntil(
      async () =>
        (await c.json(`/api/tasks/${task.id}`)).task.status === "in_progress",
    );

    await chatAndWait(
      "helper",
      `[[mock:tool:task_comment:${JSON.stringify({ id: task.id, body: "shipped it", mode: "result" })}]]`,
    );
    await waitUntil(async () => {
      const { comments } = await c.json(`/api/tasks/${task.id}/comments`);
      return comments.some((cm: any) => cm.body.includes("shipped it"));
    });

    const { comments } = await c.json(`/api/tasks/${task.id}/comments`);
    expect(comments.some((cm: any) => cm.kind === "result")).toBe(true);
  });

  it("an agent can look up its coworkers", async () => {
    const { sessionId } = await c.chat(
      "helper",
      "who's around? [[mock:tool:agent_list:{}]]",
    );
    await waitUntil(async () => {
      const msgs = await c.messages(sessionId);
      const a = msgs.find((m) => m.role === "assistant");
      return !!a?.parts.some(
        (p) => p?.type === "tool-agent_list" && p.state === "output-available",
      );
    });
    const a = (await c.messages(sessionId)).find(
      (m) => m.role === "assistant",
    )!;
    const toolPart = a.parts.find((p) => p?.type === "tool-agent_list");
    expect(JSON.stringify(toolPart)).toContain("worker");
  });

  it("an agent can ask a coworker directly and receive the answer", async () => {
    const { sessionId } = await c.chat(
      "helper",
      'ask worker [[mock:tool:agent_ask:{"agent_id":"worker","message":"peer answer"}]]',
    );
    await waitUntil(async () => {
      const msgs = await c.messages(sessionId);
      const a = msgs.find((m) => m.role === "assistant");
      return !!a?.parts.some(
        (p) => p?.type === "tool-agent_ask" && p.state === "output-available",
      );
    }, { timeoutMs: 20_000 });
    const a = (await c.messages(sessionId)).find(
      (m) => m.role === "assistant",
    )!;
    const toolPart = a.parts.find((p) => p?.type === "tool-agent_ask");
    expect(JSON.stringify(toolPart)).toContain("peer answer");

    const peerSessionId = findJsonField(toolPart, "session_id");
    expect(peerSessionId).toBeTruthy();
    const peerMessages = await c.messages(peerSessionId!);
    expect(
      peerMessages.some((m) => JSON.stringify(m).includes("peer-request")),
    ).toBe(true);
  });

  it("agent_ask target sessions emit catalog notices on granted tool refresh", async () => {
    const toolName = "agent_ask_catalog_notice_probe";
    await c.createAgent("notice-worker", "Notice Worker", {
      tools: [toolName],
    });

    const first = await c.chat(
      "helper",
      'ask notice worker [[mock:tool:agent_ask:{"agent_id":"notice-worker","message":"before notice"}]]',
    );
    await waitUntil(async () => {
      const msgs = await c.messages(first.sessionId);
      const a = msgs.find((m) => m.role === "assistant");
      return !!a?.parts.some(
        (p) => p?.type === "tool-agent_ask" && p.state === "output-available",
      );
    });
    const firstAssistant = (await c.messages(first.sessionId)).find(
      (m) => m.role === "assistant",
    )!;
    const firstToolPart = firstAssistant.parts.find(
      (p) => p?.type === "tool-agent_ask",
    );
    const peerSessionId = findJsonField(firstToolPart, "session_id");
    expect(peerSessionId).toBeTruthy();

    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${peerSessionId}/stream`,
    );
    try {
      toolRegistry.register({
        name: toolName,
        toolset: "test",
        description: "Agent ask catalog notice probe.",
        parameters: z.object({}),
        handler: async () => JSON.stringify({ ok: true }),
      });
      const second = await c.chat(
        "helper",
        `ask notice worker again [[mock:tool:agent_ask:{"agent_id":"notice-worker","session_id":"${peerSessionId}","message":"after notice"}]]`,
      );
      const notice = await sse.waitFor(
        (event) => event.event === "tool_catalog_notice",
        15_000,
      );
      expect(notice.data).toMatchObject({
        kind: "tool_catalog_notice",
        agentId: "notice-worker",
        addedToolNames: [toolName],
        removedToolNames: [],
      });
      await waitUntil(
        async () => {
          const msgs = await c.messages(second.sessionId);
          const a = msgs.find((m) => m.role === "assistant");
          return !!a?.parts.some(
            (p) =>
              p?.type === "tool-agent_ask" && p.state === "output-available",
          );
        },
        { timeoutMs: 20_000 },
      );
    } finally {
      toolRegistry.deregister(toolName);
      sse.close();
    }
  });

  it("an agent can ask itself in a fresh session", async () => {
    const { sessionId } = await c.chat(
      "helper",
      'ask self [[mock:tool:agent_ask:{"agent_id":"helper","message":"self answer"}]]',
    );
    await waitUntil(
      async () => {
        const msgs = await c.messages(sessionId);
        const a = msgs.find((m) => m.role === "assistant");
        return !!a?.parts.some(
          (p) =>
            p?.type === "tool-agent_ask" && p.state === "output-available",
        );
      },
      { timeoutMs: 20_000 },
    );
    const a = (await c.messages(sessionId)).find(
      (m) => m.role === "assistant",
    )!;
    const toolPart = a.parts.find((p) => p?.type === "tool-agent_ask");
    expect(JSON.stringify(toolPart)).toContain("self answer");

    const peerSessionId = findJsonField(toolPart, "session_id");
    expect(peerSessionId).toBeTruthy();
    expect(peerSessionId).not.toBe(sessionId);
    const peerMessages = await c.messages(peerSessionId!);
    expect(
      peerMessages.some((m) => JSON.stringify(m).includes("peer-request")),
    ).toBe(true);
  });

  it("agent_ask treats fresh session placeholders as a fresh session request", async () => {
    const { sessionId } = await c.chat(
      "helper",
      'ask worker fresh [[mock:tool:agent_ask:{"agent_id":"worker","message":"fresh answer","session_id":"fresh"}]]',
    );
    await waitUntil(async () => {
      const msgs = await c.messages(sessionId);
      const a = msgs.find((m) => m.role === "assistant");
      return !!a?.parts.some(
        (p) => p?.type === "tool-agent_ask" && p.state === "output-available",
      );
    });
    const a = (await c.messages(sessionId)).find(
      (m) => m.role === "assistant",
    )!;
    const toolPart = a.parts.find((p) => p?.type === "tool-agent_ask");
    expect(JSON.stringify(toolPart)).toContain("fresh answer");
    expect(JSON.stringify(toolPart)).not.toContain(
      'Session \\"fresh\\" not found',
    );
  });

  it("agent_ask refuses targets that disabled instant messages", async () => {
    const { sessionId } = await c.chat(
      "helper",
      'ask quiet [[mock:tool:agent_ask:{"agent_id":"quiet","message":"need this now"}]]',
    );
    await waitUntil(async () => {
      const msgs = await c.messages(sessionId);
      const a = msgs.find((m) => m.role === "assistant");
      return !!a?.parts.some(
        (p) => p?.type === "tool-agent_ask" && p.state === "output-available",
      );
    });
    const a = (await c.messages(sessionId)).find(
      (m) => m.role === "assistant",
    )!;
    const toolPart = a.parts.find((p) => p?.type === "tool-agent_ask");
    expect(JSON.stringify(toolPart)).toContain(
      "does not accept instant messages",
    );
  });
});

describe("autonomous dispatch (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    // Short tick so the dispatcher wakes the assignee in ~1 tick, not 60s.
    srv = await startE2EServer({ dispatcher: true, tickMs: 400 });
    c = makeClient(srv.baseUrl);
    await c.createAgent("worker");
  });
  afterAll(async () => {
    await srv.close();
  });

  it("the dispatcher wakes the assignee for a ready task", async () => {
    // Bind to a real session we can watch (the task store requires the
    // session to exist), then open SSE before seeding the task.
    const session = srv.manager.sessionStore.create("worker");
    const sessionId = session.id;
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    // Seed a ready, assigned task bound to that session. The dispatcher's next
    // tick should spawn an autonomous turn into it.
    await srv.manager.taskStore.create({
      title: "Autonomous work",
      assignee: "worker",
      created_by: "user",
      session_id: sessionId,
    });

    // The wake fired: an autonomous turn ran on this exact session.
    await sse.waitFor(isState("running"), 8_000);
    await sse.waitFor(isState("idle"), 12_000);

    sse.close();
  });

  it("dispatcher turns emit catalog notices on granted tool refresh", async () => {
    const toolName = "dispatcher_catalog_notice_probe";
    await c.createAgent("dispatch-notice-worker", "Dispatch Notice Worker", {
      tools: [toolName],
    });
    const session = srv.manager.sessionStore.create("dispatch-notice-worker");
    const sessionId = session.id;
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    const deliver = (text: string) => {
      const messageId = randomUUID();
      srv.manager.inboxStore.deliver({
        agentId: "dispatch-notice-worker",
        kind: "user_message",
        source: "user",
        sourceId: messageId,
        relatedSession: sessionId,
        payload: {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text }],
        },
      });
      srv.manager.dispatcher.kick("catalog_notice_test");
    };

    try {
      deliver("cache dispatcher catalog");
      await sse.waitFor(isState("idle"), 12_000);

      toolRegistry.register({
        name: toolName,
        toolset: "test",
        description: "Dispatcher catalog notice probe.",
        parameters: z.object({}),
        handler: async () => JSON.stringify({ ok: true }),
      });

      deliver("notice dispatcher catalog");
      const notice = await sse.waitFor(
        (event) => event.event === "tool_catalog_notice",
        15_000,
      );
      expect(notice.data).toMatchObject({
        kind: "tool_catalog_notice",
        agentId: "dispatch-notice-worker",
        addedToolNames: [toolName],
        removedToolNames: [],
      });
    } finally {
      toolRegistry.deregister(toolName);
      sse.close();
    }
  });

  it("surfaces autonomous model errors into the session", async () => {
    const session = srv.manager.sessionStore.create("worker");
    const sessionId = session.id;
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );

    const messageId = randomUUID();
    srv.manager.inboxStore.deliver({
      agentId: "worker",
      kind: "user_message",
      source: "user",
      sourceId: messageId,
      relatedSession: sessionId,
      payload: {
        id: messageId,
        role: "user",
        parts: [
          {
            type: "text",
            text: "break autonomous turn [[mock:error:autonomous failure]]",
          },
        ],
      },
    });

    try {
      await sse.waitFor(isState("running"), 8_000);
      await sse.waitFor(isState("idle"), 12_000);

      await waitUntil(async () => {
        const messages = await c.messages(sessionId);
        return messages.some(
          (m) =>
            m.role === "assistant" &&
            m.parts.some((p) => p?.type === "data-upstream-error"),
        );
      });
      const assistant = (await c.messages(sessionId)).find(
        (m) =>
          m.role === "assistant" &&
          m.parts.some((p) => p?.type === "data-upstream-error"),
      );
      const errorPart = assistant!.parts.find(
        (p) => p?.type === "data-upstream-error",
      );
      expect(errorPart.data.message).toContain("autonomous failure");
    } finally {
      sse.close();
    }
  });

  it("marks a task system_blocked on context_length_exceeded provider errors", async () => {
    srv.manager.dispatcher.stop();
    const session = srv.manager.sessionStore.create("worker");
    const sessionId = session.id;
    const task = await srv.manager.taskStore.create({
      title: "Overflowing autonomous work",
      assignee: "worker",
      created_by: "user",
      session_id: sessionId,
      status: "in_progress",
    });
    const sse = await openSSE(
      `${srv.baseUrl}/api/sessions/${sessionId}/stream`,
    );
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
    const messageId = randomUUID();
    srv.manager.inboxStore.deliver({
      agentId: "worker",
      kind: "user_message",
      source: "user",
      sourceId: messageId,
      relatedSession: sessionId,
      payload: {
        id: messageId,
        role: "user",
        parts: [
          {
            type: "text",
            text: `break with context overflow [[mock:error-anywhere:${JSON.stringify(providerError)}]]`,
          },
        ],
      },
    });
    await srv.manager.dispatcher.start();
    srv.manager.dispatcher.kick("e2e_context_overflow");

    try {
      await sse.waitFor(isState("running"), 8_000);
      await sse.waitFor(isState("idle"), 12_000);
      await waitUntil(
        async () =>
          (await c.json(`/api/tasks/${task.id}`)).task.status ===
          "system_blocked",
        { timeoutMs: 8_000 },
      );

      const blocked = (await c.json(`/api/tasks/${task.id}`)).task;
      expect(blocked.status).toBe("system_blocked");
      expect(blocked.start_at).toBeNull();
      const sessionAfter = await c.json(`/api/sessions/${sessionId}`);
      expect(sessionAfter.turnsBlockedReason).toBe("context_length_exceeded");
      const { comments } = await c.json(`/api/tasks/${task.id}/comments`);
      expect(comments.at(-1)?.body).toContain("context_length_exceeded");
      expect(comments.at(-1)?.body).toContain(
        "Your input exceeds the context window",
      );
      const retry = await c.post("/api/chat", {
        agentId: "worker",
        sessionId,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "should be rejected" }],
          },
        ],
      });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({
        error: "session_system_blocked",
        sessionId,
        reason: "context_length_exceeded",
      });
    } finally {
      sse.close();
    }
  });

  it("marks an in-progress task system_blocked on interactive context overflow", async () => {
    const session = srv.manager.sessionStore.create("worker");
    const sessionId = session.id;
    const task = await srv.manager.taskStore.create({
      title: "Overflowing interactive work",
      assignee: "worker",
      created_by: "user",
      session_id: sessionId,
      status: "in_progress",
    });
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
    try {
      const res = await c.chat(
        "worker",
        `interactive overflow [[mock:error-anywhere:${JSON.stringify(providerError)}]]`,
        sessionId,
      );
      expect(res.sessionId).toBe(sessionId);
      await sse.waitFor(isState("idle"), 12_000);
      await waitUntil(
        async () =>
          (await c.json(`/api/tasks/${task.id}`)).task.status ===
          "system_blocked",
        { timeoutMs: 8_000 },
      );

      const blocked = (await c.json(`/api/tasks/${task.id}`)).task;
      expect(blocked.status).toBe("system_blocked");
      const sessionAfter = await c.json(`/api/sessions/${sessionId}`);
      expect(sessionAfter.turnsBlockedReason).toBe("context_length_exceeded");
      const { comments } = await c.json(`/api/tasks/${task.id}/comments`);
      expect(comments.at(-1)?.body).toContain("context_length_exceeded");
      expect(comments.at(-1)?.body).toContain(
        "Your input exceeds the context window",
      );
      const retry = await c.post("/api/chat", {
        agentId: "worker",
        sessionId,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "should be rejected" }],
          },
        ],
      });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({
        error: "session_system_blocked",
        sessionId,
        reason: "context_length_exceeded",
      });
    } finally {
      sse.close();
    }
  });
});
