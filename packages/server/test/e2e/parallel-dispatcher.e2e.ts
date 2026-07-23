import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startE2EServer,
  openSSE,
  type E2EServer,
  type SSEHandle,
  type SSEEvent,
} from "./support/harness.js";
import {
  assistantText,
  isState,
  makeClient,
  waitUntil,
} from "./support/client.js";

let srv: E2EServer;
let c: ReturnType<typeof makeClient>;
let sseHandles: SSEHandle[] = [];

beforeEach(async () => {
  srv = await startE2EServer({ dispatcher: true, tickMs: 100 });
  c = makeClient(srv.baseUrl);
  sseHandles = [];
}, 60_000);

afterEach(async () => {
  for (const sse of sseHandles.splice(0)) {
    sse.close();
  }
  if (srv) {
    await srv.close();
  }
}, 60_000);

async function createAgent(
  id = "parallel",
  maxConcurrentSessions: number | null = 2,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await c.createAgent(
    id,
    id,
    {
      ...(maxConcurrentSessions == null ? {} : { maxConcurrentSessions }),
      ...extra,
    }
  );
}

function stateCount(sse: SSEHandle, state: "running" | "idle"): number {
  return sse.events.filter(isState(state)).length;
}

async function waitForStateCount(
  sse: SSEHandle,
  state: "running" | "idle",
  count: number,
  timeoutMs = 12_000
): Promise<void> {
  await waitUntil(
    async () => stateCount(sse, state) >= count,
    { timeoutMs, intervalMs: 50 }
  );
}

async function postChat(
  agentId: string,
  sessionId: string,
  text: string
): Promise<Record<string, unknown>> {
  const userMessageId = randomUUID();
  const res = await c.post("/api/chat", {
    agentId,
    sessionId,
    messages: [
      {
        id: userMessageId,
        role: "user",
        parts: [{ type: "text", text }],
      },
    ],
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function postTaskComment(
  taskId: string,
  body: string
): Promise<Record<string, unknown>> {
  const res = await c.post(`/api/tasks/${taskId}/comments`, { body });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function deliverUserMessage(
  agentId: string,
  sessionId: string,
  text: string
): string {
  const id = randomUUID();
  srv.manager.inboxStore.deliver({
    agentId,
    kind: "user_message",
    source: "user",
    sourceId: id,
    relatedSession: sessionId,
    payload: {
      id,
      role: "user",
      parts: [{ type: "text", text }],
    },
  });
  srv.manager.dispatcher.kick("e2e_user_message");
  return id;
}

async function waitForAssistantText(
  sessionId: string,
  fragment: string,
  timeoutMs = 12_000
): Promise<void> {
  await waitUntil(
    async () => {
      const messages = await c.messages(sessionId);
      return messages.some(
        (message) =>
          message.role === "assistant" &&
          assistantText(message.parts).includes(fragment)
      );
    },
    { timeoutMs, intervalMs: 100 }
  );
}

async function homeRunningIds(): Promise<Set<string>> {
  const home = await c.json("/api/home");
  return new Set(
    (home.running as Array<{ sessionId: string }>).map((row) => row.sessionId)
  );
}

async function waitForHomeRunningIds(
  expected: Set<string>,
  timeoutMs = 8_000
): Promise<void> {
  await waitUntil(
    async () => {
      const running = await homeRunningIds();
      if (running.size !== expected.size) return false;
      return [...expected].every((id) => running.has(id));
    },
    { timeoutMs, intervalMs: 50 }
  );
}

function eventDataIncludes(sse: SSEHandle, text: string): boolean {
  return sse.events.some((event: SSEEvent) =>
    JSON.stringify(event.data).includes(text)
  );
}

async function openSessionStream(sessionId: string): Promise<SSEHandle> {
  const sse = await openSSE(`${srv.baseUrl}/api/sessions/${sessionId}/stream`);
  sseHandles.push(sse);
  return sse;
}

describe("parallel dispatcher (e2e)", () => {
  it("keeps the default agent capacity at one active session", async () => {
    await createAgent("serial", null);
    const a = srv.manager.sessionStore.create("serial");
    const b = srv.manager.sessionStore.create("serial");
    const streams = new Map<string, SSEHandle>([
      [a.id, await openSessionStream(a.id)],
      [b.id, await openSessionStream(b.id)],
    ]);

    deliverUserMessage("serial", a.id, "A [[mock:slow]]");
    deliverUserMessage("serial", b.id, "B [[mock:slow]]");

    let firstRunning = "";
    await waitUntil(
      async () => {
        const running = await homeRunningIds();
        const serialRunning = [a.id, b.id].filter((id) => running.has(id));
        if (serialRunning.length !== 1) return false;
        firstRunning = serialRunning[0]!;
        return true;
      },
      { timeoutMs: 8_000, intervalMs: 50 }
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    let running = await homeRunningIds();
    expect([a.id, b.id].filter((id) => running.has(id))).toHaveLength(1);

    const second = firstRunning === a.id ? b.id : a.id;
    await streams.get(firstRunning)!.waitFor(isState("idle"), 15_000);
    await streams.get(second)!.waitFor(isState("running"), 8_000);
    await streams.get(second)!.waitFor(isState("idle"), 12_000);

    running = await homeRunningIds();
    expect(running.has(a.id)).toBe(false);
    expect(running.has(b.id)).toBe(false);
  });

  it("runs task wakes for two sessions of one agent in parallel and reports both as running", async () => {
    await createAgent("parallel", 2);
    const a = srv.manager.sessionStore.create("parallel");
    const b = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a.id);
    const sseB = await openSessionStream(b.id);

    await srv.manager.taskStore.create({
      title: "Task A [[mock:slow-anywhere]]",
      assignee: "parallel",
      created_by: "user",
      session_id: a.id,
    });
    await srv.manager.taskStore.create({
      title: "Task B [[mock:slow-anywhere]]",
      assignee: "parallel",
      created_by: "user",
      session_id: b.id,
    });
    srv.manager.dispatcher.kick("e2e_parallel_task_wake");

    await Promise.all([
      sseA.waitFor(isState("running"), 8_000),
      sseB.waitFor(isState("running"), 8_000),
    ]);

    await waitForHomeRunningIds(new Set([a.id, b.id]));

    await Promise.all([
      sseA.waitFor(isState("idle"), 15_000),
      sseB.waitFor(isState("idle"), 15_000),
    ]);
    sseA.close();
    sseB.close();
  });

  it("queues a third inbox wake at capacity and backfills it when a slot frees", async () => {
    await createAgent("parallel", 2);
    const a = srv.manager.sessionStore.create("parallel");
    const b = srv.manager.sessionStore.create("parallel");
    const cSession = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a.id);
    const sseB = await openSessionStream(b.id);
    const sseC = await openSessionStream(cSession.id);

    deliverUserMessage("parallel", a.id, "A [[mock:slow-long]]");
    deliverUserMessage("parallel", b.id, "B [[mock:slow-long]]");

    await Promise.all([
      sseA.waitFor(isState("running"), 8_000),
      sseB.waitFor(isState("running"), 8_000),
    ]);
    await waitUntil(
      async () => {
        const home = await c.json("/api/home");
        const runningIds = new Set(
          (home.running as Array<{ sessionId: string }>).map(
            (row) => row.sessionId
          )
        );
        return (
          runningIds.has(a.id) &&
          runningIds.has(b.id) &&
          !runningIds.has(cSession.id)
        );
      },
      { timeoutMs: 4_000, intervalMs: 50 }
    );

    const cRunningBefore = stateCount(sseC, "running");
    deliverUserMessage("parallel", cSession.id, "C [[mock:text:C done]]");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stateCount(sseC, "running")).toBe(cRunningBefore);

    await Promise.race([
      sseA.waitFor(isState("idle"), 15_000),
      sseB.waitFor(isState("idle"), 15_000),
    ]);
    await waitForStateCount(sseC, "running", cRunningBefore + 1, 8_000);
    await sseC.waitFor(isState("idle"), 12_000);
    await waitForAssistantText(cSession.id, "C done");

    sseA.close();
    sseB.close();
    sseC.close();
  });

  it("queues same-session user messages and wakes that session again after the current turn", async () => {
    await createAgent("parallel", 2);
    const sessionId = randomUUID();
    const sse = await openSessionStream(sessionId);

    await postChat("parallel", sessionId, "first [[mock:slow]]");
    await sse.waitFor(isState("running"), 8_000);
    const queued = await postChat(
      "parallel",
      sessionId,
      "second [[mock:text:second reply]]"
    );

    expect(queued).toMatchObject({ queued: true });
    expect(queued.queuedReason).toBeUndefined();
    await waitForStateCount(sse, "idle", 1, 15_000);
    await waitForStateCount(sse, "running", 2, 8_000);
    await waitForStateCount(sse, "idle", 2, 12_000);
    await waitForAssistantText(sessionId, "second reply");

    sse.close();
  });

  it("queues same-session chat sent during an autonomous turn", async () => {
    await createAgent("parallel", 1);
    const session = srv.manager.sessionStore.create("parallel");
    const sse = await openSessionStream(session.id);

    deliverUserMessage("parallel", session.id, "autonomous [[mock:slow]]");
    await sse.waitFor(isState("running"), 8_000);

    const queued = await postChat(
      "parallel",
      session.id,
      "follow-up [[mock:text:autonomous queued reply]]"
    );
    expect(queued).toMatchObject({ queued: true });
    expect(queued.queuedReason).toBeUndefined();

    await waitForStateCount(sse, "idle", 1, 15_000);
    await waitForStateCount(sse, "running", 2, 8_000);
    await waitForStateCount(sse, "idle", 2, 12_000);
    await waitForAssistantText(session.id, "autonomous queued reply");
  });

  it("starts a different session when capacity is available and queues another when full", async () => {
    await createAgent("parallel", 2);
    const a = randomUUID();
    const b = randomUUID();
    const cId = randomUUID();
    const sseA = await openSessionStream(a);
    const sseB = await openSessionStream(b);
    const sseC = await openSessionStream(cId);

    const first = await postChat("parallel", a, "A [[mock:slow-long]]");
    expect(first.queued).toBeUndefined();
    await sseA.waitFor(isState("running"), 8_000);

    const second = await postChat("parallel", b, "B [[mock:slow-long]]");
    expect(second.queued).toBeUndefined();
    await sseB.waitFor(isState("running"), 8_000);

    const third = await postChat("parallel", cId, "C [[mock:text:C queued]]");
    expect(third).toMatchObject({
      queued: true,
      queuedReason: "agent_capacity",
    });
    expect(stateCount(sseC, "running")).toBe(0);

    await Promise.race([
      sseA.waitFor(isState("idle"), 15_000),
      sseB.waitFor(isState("idle"), 15_000),
    ]);
    await sseC.waitFor(isState("running"), 8_000);
    await sseC.waitFor(isState("idle"), 12_000);
    await waitForAssistantText(cId, "C queued");

    sseA.close();
    sseB.close();
    sseC.close();
  });

  it("counts an interactive run against autonomous task capacity", async () => {
    await createAgent("parallel", 1);
    const chatSession = randomUUID();
    const taskSession = srv.manager.sessionStore.create("parallel");
    const sseChat = await openSessionStream(chatSession);
    const sseTask = await openSessionStream(taskSession.id);

    const chat = await postChat("parallel", chatSession, "chat [[mock:slow]]");
    expect(chat.queued).toBeUndefined();
    await sseChat.waitFor(isState("running"), 8_000);

    await srv.manager.taskStore.create({
      title: "Task waits for interactive capacity",
      assignee: "parallel",
      created_by: "user",
      session_id: taskSession.id,
    });
    srv.manager.dispatcher.kick("e2e_interactive_blocks_task");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stateCount(sseTask, "running")).toBe(0);
    await waitForHomeRunningIds(new Set([chatSession]));

    await sseChat.waitFor(isState("idle"), 15_000);
    await sseTask.waitFor(isState("running"), 8_000);
    await sseTask.waitFor(isState("idle"), 12_000);
  });

  it("reserves capacity for simultaneous different-session chat sends", async () => {
    await createAgent("parallel", 2);
    const sessionIds = [randomUUID(), randomUUID(), randomUUID()];
    const streams = new Map<string, SSEHandle>();
    for (const sessionId of sessionIds) {
      streams.set(sessionId, await openSessionStream(sessionId));
    }

    const results = await Promise.all(
      sessionIds.map((sessionId, index) =>
        postChat(
          "parallel",
          sessionId,
          `${String.fromCharCode(65 + index)} ${
            index < 2
              ? "[[mock:slow-long]]"
              : "[[mock:text:simultaneous queued]]"
          }`
        )
      )
    );

    const started = results
      .filter((result) => result.queued !== true)
      .map((result) => result.sessionId as string);
    const queued = results
      .filter((result) => result.queued === true)
      .map((result) => result.sessionId as string);

    expect(started).toHaveLength(2);
    expect(queued).toHaveLength(1);
    expect(results.filter((result) => result.queuedReason === "agent_capacity"))
      .toHaveLength(1);

    await Promise.all(
      started.map((sessionId) =>
        streams.get(sessionId)!.waitFor(isState("running"), 8_000)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stateCount(streams.get(queued[0]!)!, "running")).toBe(0);

    await Promise.race(
      started.map((sessionId) =>
        streams.get(sessionId)!.waitFor(isState("idle"), 15_000)
      )
    );
    await streams.get(queued[0]!)!.waitFor(isState("running"), 8_000);
    await streams.get(queued[0]!)!.waitFor(isState("idle"), 12_000);
    await waitForAssistantText(queued[0]!, "simultaneous queued");
  });

  it("holds a dependent task until its dependency is done", async () => {
    await createAgent("parallel", 2);
    const session = srv.manager.sessionStore.create("parallel");
    const sse = await openSessionStream(session.id);
    const dependency = await srv.manager.taskStore.create({
      title: "Upstream dependency",
      assignee: "ghost",
      created_by: "user",
    });

    await srv.manager.taskStore.create({
      title: "Dependent work",
      assignee: "parallel",
      created_by: "user",
      session_id: session.id,
      depends_on: [dependency.id],
    });
    srv.manager.dispatcher.kick("e2e_dependency_blocked");

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stateCount(sse, "running")).toBe(0);

    await srv.manager.taskStore.update(dependency.id, { status: "done" });
    srv.manager.dispatcher.kick("e2e_dependency_done");

    await sse.waitFor(isState("running"), 8_000);
    await sse.waitFor(isState("idle"), 12_000);
  });

  it("does not wake a dependent task when its dependency is canceled", async () => {
    await createAgent("parallel", 2);
    const session = srv.manager.sessionStore.create("parallel");
    const sse = await openSessionStream(session.id);
    const dependency = await srv.manager.taskStore.create({
      title: "Canceled dependency",
      assignee: "ghost",
      created_by: "user",
    });

    await srv.manager.taskStore.create({
      title: "Dependent work blocked by canceled dependency",
      assignee: "parallel",
      created_by: "user",
      session_id: session.id,
      depends_on: [dependency.id],
    });
    await srv.manager.taskStore.update(dependency.id, { status: "canceled" });
    srv.manager.dispatcher.kick("e2e_dependency_canceled");

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stateCount(sse, "running")).toBe(0);
  });

  it("does not wake a future-start task assignment until start_at clears", async () => {
    await createAgent("parallel", 2);
    const session = srv.manager.sessionStore.create("parallel");
    const sse = await openSessionStream(session.id);
    const task = await srv.manager.taskStore.create({
      title: "Future task",
      assignee: "parallel",
      created_by: "user",
      session_id: session.id,
      start_at: new Date(Date.now() + 60_000).toISOString(),
    });
    srv.manager.dispatcher.kick("e2e_future_start_blocked");

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(stateCount(sse, "running")).toBe(0);

    await srv.manager.taskStore.update(task.id, { start_at: null });
    srv.manager.dispatcher.kick("e2e_future_start_cleared");

    await sse.waitFor(isState("running"), 8_000);
    await sse.waitFor(isState("idle"), 12_000);
  });

  it("wakes the same session after a detached process tool completes", async () => {
    await createAgent("parallel", 1);
    const sessionId = randomUUID();
    const sse = await openSessionStream(sessionId);
    const args = {
      action: "run",
      command: "node -e \"setTimeout(()=>console.log('done'), 300)\"",
      waitMs: 0,
      timeoutMs: 5_000,
    };

    await postChat(
      "parallel",
      sessionId,
      `[[mock:tool:process:${JSON.stringify(args)}]]`
    );

    await waitForStateCount(sse, "idle", 1, 20_000);
    await waitForStateCount(sse, "running", 2, 12_000);
    await waitForStateCount(sse, "idle", 2, 12_000);
    expect(eventDataIncludes(sse, "process_completed")).toBe(true);

    sse.close();
  });

  it("wakes a task creator session from a result event", async () => {
    await c.createAgent("creator", "creator", { maxConcurrentSessions: 1 });
    await c.createAgent("worker", "worker", { maxConcurrentSessions: 1 });
    const creatorSession = srv.manager.sessionStore.create("creator");
    const sse = await openSessionStream(creatorSession.id);
    const task = await srv.manager.taskStore.create({
      title: "Need worker result",
      assignee: "worker",
      created_by: "creator",
    });

    srv.manager.eventStore.append({
      taskId: task.id,
      sessionId: creatorSession.id,
      agentId: "creator",
      actor: "worker",
      kind: "comment_added",
      payload: { mode: "result", body: "worker shipped it" },
    });
    srv.manager.dispatcher.kick("e2e_task_result");

    await sse.waitFor(isState("running"), 8_000);
    await sse.waitFor(isState("idle"), 12_000);
    await waitUntil(async () => eventDataIncludes(sse, "comment_added"));

    sse.close();
  });

  it("keeps session-targeted inbox rows isolated while two sessions run", async () => {
    await createAgent("parallel", 2);
    const a = srv.manager.sessionStore.create("parallel");
    const b = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a.id);
    const sseB = await openSessionStream(b.id);

    deliverUserMessage("parallel", a.id, "A [[mock:slow]]");
    deliverUserMessage("parallel", b.id, "B [[mock:slow]]");
    await Promise.all([
      sseA.waitFor(isState("running"), 8_000),
      sseB.waitFor(isState("running"), 8_000),
    ]);

    srv.manager.inboxStore.deliver({
      agentId: "parallel",
      kind: "system_notice",
      source: "system",
      sourceId: "test",
      relatedSession: b.id,
      payload: { eventKind: "targeted_b", payload: { marker: "only-b" } },
    });

    await Promise.all([
      sseA.waitFor(isState("idle"), 15_000),
      sseB.waitFor(isState("idle"), 15_000),
    ]);
    await waitForStateCount(sseB, "running", 2, 8_000);
    await waitForStateCount(sseB, "idle", 2, 12_000);

    const aHistory = JSON.stringify(await c.messages(a.id));
    const bHistory = JSON.stringify(await c.messages(b.id));
    expect(aHistory).not.toContain("targeted_b");
    expect(bHistory).toContain("targeted_b");

    sseA.close();
    sseB.close();
  });

  it("claims an agent-wide notice once and lets targeted inbox bypass defer", async () => {
    await createAgent("parallel", 2);
    const a = srv.manager.sessionStore.create("parallel");
    const b = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a.id);
    const sseB = await openSessionStream(b.id);
    srv.manager.sessionStore.setDeferUntil(
      a.id,
      Math.floor(Date.now() / 1000) + 3600
    );

    srv.manager.inboxStore.deliver({
      agentId: "parallel",
      kind: "system_notice",
      source: "system",
      sourceId: "test",
      relatedSession: null,
      payload: { eventKind: "agent_wide_once", payload: { marker: "wide" } },
    });
    srv.manager.dispatcher.kick("e2e_agent_wide");
    await Promise.race([
      sseA.waitFor(isState("running"), 8_000),
      sseB.waitFor(isState("running"), 8_000),
    ]);
    await Promise.allSettled([
      sseA.waitFor(isState("idle"), 12_000),
      sseB.waitFor(isState("idle"), 12_000),
    ]);

    let aHistory = JSON.stringify(await c.messages(a.id));
    let bHistory = JSON.stringify(await c.messages(b.id));
    const wideClaims =
      (aHistory.includes("agent_wide_once") ? 1 : 0) +
      (bHistory.includes("agent_wide_once") ? 1 : 0);
    expect(wideClaims).toBe(1);

    const aRunningBefore = stateCount(sseA, "running");
    const aIdleBefore = stateCount(sseA, "idle");
    srv.manager.inboxStore.deliver({
      agentId: "parallel",
      kind: "system_notice",
      source: "system",
      sourceId: "test",
      relatedSession: a.id,
      payload: { eventKind: "defer_bypass", payload: { marker: "defer" } },
    });
    srv.manager.dispatcher.kick("e2e_defer_bypass");
    await waitForStateCount(sseA, "running", aRunningBefore + 1, 8_000);
    await waitForStateCount(sseA, "idle", aIdleBefore + 1, 12_000);
    aHistory = JSON.stringify(await c.messages(a.id));
    bHistory = JSON.stringify(await c.messages(b.id));
    expect(aHistory).toContain("defer_bypass");
    expect(bHistory).not.toContain("defer_bypass");

    sseA.close();
    sseB.close();
  });

  it("holds an agent-wide notice at capacity and claims it once after a slot frees", async () => {
    await createAgent("parallel", 2);
    const a = srv.manager.sessionStore.create("parallel");
    const b = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a.id);
    const sseB = await openSessionStream(b.id);

    deliverUserMessage("parallel", a.id, "A [[mock:slow-long]]");
    deliverUserMessage("parallel", b.id, "B [[mock:slow-long]]");
    await Promise.all([
      sseA.waitFor(isState("running"), 8_000),
      sseB.waitFor(isState("running"), 8_000),
    ]);
    await waitForHomeRunningIds(new Set([a.id, b.id]));

    const aRunningBefore = stateCount(sseA, "running");
    const bRunningBefore = stateCount(sseB, "running");
    srv.manager.inboxStore.deliver({
      agentId: "parallel",
      kind: "system_notice",
      source: "system",
      sourceId: "test",
      relatedSession: null,
      payload: {
        eventKind: "agent_wide_after_capacity",
        payload: { marker: "wide-capacity" },
      },
    });
    srv.manager.dispatcher.kick("e2e_agent_wide_at_capacity");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stateCount(sseA, "running")).toBe(aRunningBefore);
    expect(stateCount(sseB, "running")).toBe(bRunningBefore);

    await waitUntil(
      async () => {
        const aHistory = JSON.stringify(await c.messages(a.id));
        const bHistory = JSON.stringify(await c.messages(b.id));
        const claims =
          (aHistory.includes("agent_wide_after_capacity") ? 1 : 0) +
          (bHistory.includes("agent_wide_after_capacity") ? 1 : 0);
        return claims === 1;
      },
      { timeoutMs: 20_000, intervalMs: 100 }
    );
    await waitUntil(
      async () => (await homeRunningIds()).size === 0,
      { timeoutMs: 20_000, intervalMs: 100 }
    );

    const aHistory = JSON.stringify(await c.messages(a.id));
    const bHistory = JSON.stringify(await c.messages(b.id));
    const claims =
      (aHistory.includes("agent_wide_after_capacity") ? 1 : 0) +
      (bHistory.includes("agent_wide_after_capacity") ? 1 : 0);
    expect(claims).toBe(1);

    sseA.close();
    sseB.close();
  });

  it("keeps real task comment events isolated to their related session", async () => {
    await createAgent("parallel", 2);
    const a = srv.manager.sessionStore.create("parallel");
    const b = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a.id);
    const sseB = await openSessionStream(b.id);
    const task = await srv.manager.taskStore.create({
      title: "Task event belongs to B",
      assignee: "parallel",
      created_by: "user",
      session_id: b.id,
    });

    deliverUserMessage("parallel", a.id, "A [[mock:slow]]");
    deliverUserMessage("parallel", b.id, "B [[mock:slow]]");
    await Promise.all([
      sseA.waitFor(isState("running"), 8_000),
      sseB.waitFor(isState("running"), 8_000),
    ]);

    await srv.manager.taskStore.addComment({
      taskId: task.id,
      author: "user",
      kind: "result",
      body: "task event only for session b",
    });

    await Promise.all([
      sseA.waitFor(isState("idle"), 15_000),
      sseB.waitFor(isState("idle"), 15_000),
    ]);
    await waitForStateCount(sseB, "running", 2, 8_000);
    await waitForStateCount(sseB, "idle", 2, 12_000);

    const aHistory = JSON.stringify(await c.messages(a.id));
    const bHistory = JSON.stringify(await c.messages(b.id));
    expect(aHistory).not.toContain("task event only for session b");
    expect(bHistory).toContain("task event only for session b");

    sseA.close();
    sseB.close();
  });

  it("keeps process completion wakes in the launching session while another session runs", async () => {
    await createAgent("parallel", 2);
    const a = randomUUID();
    const b = srv.manager.sessionStore.create("parallel");
    const sseA = await openSessionStream(a);
    const sseB = await openSessionStream(b.id);
    const args = {
      action: "run",
      command: "node -e \"setTimeout(()=>console.log('done'), 500)\"",
      waitMs: 0,
      timeoutMs: 5_000,
    };

    deliverUserMessage("parallel", b.id, "B [[mock:slow-long]]");
    await sseB.waitFor(isState("running"), 8_000);
    await postChat(
      "parallel",
      a,
      `[[mock:tool:process:${JSON.stringify(args)}]]`
    );

    await waitForStateCount(sseA, "idle", 1, 20_000);
    await waitForStateCount(sseA, "running", 2, 12_000);
    await waitForStateCount(sseA, "idle", 2, 12_000);
    expect(eventDataIncludes(sseA, "process_completed")).toBe(true);

    await sseB.waitFor(isState("idle"), 20_000);
    const aHistory = JSON.stringify(await c.messages(a));
    const bHistory = JSON.stringify(await c.messages(b.id));
    expect(aHistory).toContain("process_completed");
    expect(bHistory).not.toContain("process_completed");

    sseA.close();
    sseB.close();
  });

  it("frees agent capacity after aborting an interactive turn", async () => {
    await createAgent("parallel", 1);
    const a = randomUUID();
    const b = randomUUID();
    const sseA = await openSessionStream(a);
    const sseB = await openSessionStream(b);

    const first = await postChat("parallel", a, "A [[mock:slow-long]]");
    expect(first.queued).toBeUndefined();
    await sseA.waitFor(isState("running"), 8_000);

    const queued = await postChat(
      "parallel",
      b,
      "B [[mock:text:after abort]]"
    );
    expect(queued).toMatchObject({
      queued: true,
      queuedReason: "agent_capacity",
    });
    expect(stateCount(sseB, "running")).toBe(0);

    await waitUntil(
      async () => {
        const res = await c.req(`/api/sessions/${a}/active-turn`, {
          method: "DELETE",
        });
        return res.status === 200;
      },
      { timeoutMs: 3_000, intervalMs: 100 }
    );

    await sseA.waitFor(isState("idle"), 12_000);
    await sseB.waitFor(isState("running"), 8_000);
    await sseB.waitFor(isState("idle"), 12_000);
    await waitForAssistantText(b, "after abort");

    sseA.close();
    sseB.close();
  });

  it("prioritizes a queued user message over autonomous task wakes", async () => {
    await createAgent("parallel", 1);
    const busy = srv.manager.sessionStore.create("parallel");
    const taskSession = srv.manager.sessionStore.create("parallel");
    const userSession = srv.manager.sessionStore.create("parallel");
    const sseBusy = await openSessionStream(busy.id);
    const sseTask = await openSessionStream(taskSession.id);
    const sseUser = await openSessionStream(userSession.id);

    deliverUserMessage("parallel", busy.id, "busy [[mock:slow-long]]");
    await sseBusy.waitFor(isState("running"), 8_000);
    await srv.manager.taskStore.create({
      title: "Autonomous task should wait",
      assignee: "parallel",
      created_by: "user",
      session_id: taskSession.id,
    });
    srv.manager.dispatcher.kick("e2e_user_priority_task_waiting");

    const taskRunningBefore = stateCount(sseTask, "running");
    const queued = await postChat(
      "parallel",
      userSession.id,
      "direct user [[mock:text:user first]]"
    );
    expect(queued).toMatchObject({
      queued: true,
      queuedReason: "agent_capacity",
    });

    await sseBusy.waitFor(isState("idle"), 20_000);
    await sseUser.waitFor(isState("running"), 8_000);
    expect(stateCount(sseTask, "running")).toBe(taskRunningBefore);
    await sseUser.waitFor(isState("idle"), 12_000);
    await waitForAssistantText(userSession.id, "user first");

    await sseTask.waitFor(isState("running"), 8_000);
    await sseTask.waitFor(isState("idle"), 12_000);

    sseBusy.close();
    sseTask.close();
    sseUser.close();
  });

  it("prioritizes a new direct prompt before user task comments and autonomous task wakes", async () => {
    await createAgent("priority-new", 1, {
      parallelSchedulingPolicy: "lane_first",
    });
    const busy = srv.manager.sessionStore.create("priority-new");
    const commentSession = srv.manager.sessionStore.create("priority-new");
    const taskSession = srv.manager.sessionStore.create("priority-new");
    const directSessionId = randomUUID();
    const sseBusy = await openSessionStream(busy.id);
    const sseComment = await openSessionStream(commentSession.id);
    const sseTask = await openSessionStream(taskSession.id);
    const sseDirect = await openSessionStream(directSessionId);

    deliverUserMessage("priority-new", busy.id, "busy [[mock:slow]]");
    await sseBusy.waitFor(isState("running"), 8_000);

    const commentTask = await srv.manager.taskStore.create({
      title: "comment anchor",
      assignee: "priority-new",
      created_by: "user",
      session_id: commentSession.id,
      status: "done",
    });
    await postTaskComment(
      commentTask.id,
      "task comment [[mock:slow-anywhere]] should run after direct prompt"
    );
    await srv.manager.taskStore.create({
      title: "autonomous lane [[mock:slow-anywhere]] should run after comment",
      assignee: "priority-new",
      created_by: "user",
      session_id: taskSession.id,
    });

    const queued = await postChat(
      "priority-new",
      directSessionId,
      "new prompt [[mock:slow-anywhere]] should run first"
    );
    expect(queued).toMatchObject({
      queued: true,
      queuedReason: "agent_capacity",
    });

    await sseBusy.waitFor(isState("idle"), 15_000);
    await sseDirect.waitFor(isState("running"), 8_000);
    expect(stateCount(sseComment, "running")).toBe(0);
    expect(stateCount(sseTask, "running")).toBe(0);

    await sseDirect.waitFor(isState("idle"), 15_000);
    await sseComment.waitFor(isState("running"), 8_000);
    expect(stateCount(sseTask, "running")).toBe(0);

    await sseComment.waitFor(isState("idle"), 15_000);
    await sseTask.waitFor(isState("running"), 8_000);
    await sseTask.waitFor(isState("idle"), 15_000);

    sseBusy.close();
    sseComment.close();
    sseTask.close();
    sseDirect.close();
  });

  for (const policy of ["lane_first", "chain_first"] as const) {
    for (const sessionKind of ["new", "existing"] as const) {
      for (const arrivalOrder of ["comment_first", "message_first"] as const) {
        it(`${policy} prioritizes ${sessionKind} direct messages over task comments when ${arrivalOrder}`, async () => {
          const agentId = `priority-${policy.replace("_", "-")}-${sessionKind}-${arrivalOrder.replace("_", "-")}`;
          await createAgent(agentId, 1, {
            parallelSchedulingPolicy: policy,
          });
          const busy = srv.manager.sessionStore.create(agentId);
          const commentSession = srv.manager.sessionStore.create(agentId);
          const directSessionId =
            sessionKind === "existing" ? srv.manager.sessionStore.create(agentId).id : randomUUID();
          if (sessionKind === "existing") {
            srv.manager.messageStore.append(directSessionId, {
              id: randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "existing session history" }],
            });
          }
          const sseBusy = await openSessionStream(busy.id);
          const sseComment = await openSessionStream(commentSession.id);
          const sseDirect = await openSessionStream(directSessionId);

          deliverUserMessage(agentId, busy.id, "busy [[mock:slow]]");
          await sseBusy.waitFor(isState("running"), 8_000);

          const commentTask = await srv.manager.taskStore.create({
            title: `comment anchor ${arrivalOrder}`,
            assignee: agentId,
            created_by: "user",
            session_id: commentSession.id,
            status: "done",
          });
          const writeComment = () =>
            postTaskComment(
              commentTask.id,
              `task comment ${arrivalOrder} [[mock:slow-anywhere]]`
            );
          const writeMessage = () =>
            postChat(
              agentId,
              directSessionId,
              `${sessionKind} direct message ${arrivalOrder} [[mock:slow-anywhere]]`
            );

          let messageResult: Record<string, unknown>;
          if (arrivalOrder === "comment_first") {
            await writeComment();
            messageResult = await writeMessage();
          } else {
            messageResult = await writeMessage();
            await writeComment();
          }
          expect(messageResult).toMatchObject({
            queued: true,
            queuedReason: "agent_capacity",
          });

          await sseBusy.waitFor(isState("idle"), 15_000);
          await sseDirect.waitFor(isState("running"), 8_000);
          expect(stateCount(sseComment, "running")).toBe(0);

          await sseDirect.waitFor(isState("idle"), 15_000);
          await sseComment.waitFor(isState("running"), 8_000);
          await sseComment.waitFor(isState("idle"), 15_000);

          sseBusy.close();
          sseComment.close();
          sseDirect.close();
        });
      }
    }
  }

  it("preserves order for multiple queued user messages in the same session", async () => {
    await createAgent("parallel", 1);
    const sessionId = randomUUID();
    const sse = await openSessionStream(sessionId);

    await postChat("parallel", sessionId, "first [[mock:slow]]");
    await sse.waitFor(isState("running"), 8_000);
    const second = await postChat(
      "parallel",
      sessionId,
      "second [[mock:text:second reply]]"
    );
    const third = await postChat(
      "parallel",
      sessionId,
      "third [[mock:text:third reply]]"
    );
    expect(second).toMatchObject({ queued: true });
    expect(third).toMatchObject({ queued: true });

    await waitForStateCount(sse, "idle", 1, 15_000);
    await waitForStateCount(sse, "running", 2, 8_000);
    await waitForStateCount(sse, "idle", 2, 12_000);
    await waitForAssistantText(sessionId, "third reply");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stateCount(sse, "running")).toBe(2);

    const userTexts = (await c.messages(sessionId))
      .filter((message) => message.role === "user")
      .map((message) => assistantText(message.parts));
    expect(userTexts).toEqual([
      "first [[mock:slow]]",
      "second [[mock:text:second reply]]",
      "third [[mock:text:third reply]]",
    ]);

    sse.close();
  });

  it("does not let one agent's capacity block another agent", async () => {
    await c.createAgent("busy", "busy", { maxConcurrentSessions: 1 });
    await c.createAgent("free", "free", { maxConcurrentSessions: 1 });
    const busySession = srv.manager.sessionStore.create("busy");
    const freeSession = srv.manager.sessionStore.create("free");
    const sseBusy = await openSessionStream(busySession.id);
    const sseFree = await openSessionStream(freeSession.id);

    deliverUserMessage("busy", busySession.id, "busy [[mock:slow-long]]");
    await sseBusy.waitFor(isState("running"), 8_000);
    deliverUserMessage("free", freeSession.id, "free [[mock:slow]]");
    await sseFree.waitFor(isState("running"), 8_000);
    await waitForHomeRunningIds(new Set([busySession.id, freeSession.id]));

    await Promise.all([
      sseBusy.waitFor(isState("idle"), 20_000),
      sseFree.waitFor(isState("idle"), 12_000),
    ]);

    sseBusy.close();
    sseFree.close();
  });

  it("keeps a deferred targeted wake queued while capacity is full", async () => {
    await createAgent("parallel", 1);
    const deferred = srv.manager.sessionStore.create("parallel");
    const busy = srv.manager.sessionStore.create("parallel");
    const sseDeferred = await openSessionStream(deferred.id);
    const sseBusy = await openSessionStream(busy.id);
    srv.manager.sessionStore.setDeferUntil(
      deferred.id,
      Math.floor(Date.now() / 1000) + 3600
    );

    deliverUserMessage("parallel", busy.id, "busy [[mock:slow-long]]");
    await sseBusy.waitFor(isState("running"), 8_000);
    srv.manager.inboxStore.deliver({
      agentId: "parallel",
      kind: "system_notice",
      source: "system",
      sourceId: "test",
      relatedSession: deferred.id,
      payload: {
        eventKind: "deferred_after_capacity",
        payload: { marker: "defer-capacity" },
      },
    });
    srv.manager.dispatcher.kick("e2e_defer_at_capacity");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stateCount(sseDeferred, "running")).toBe(0);

    await sseBusy.waitFor(isState("idle"), 20_000);
    await sseDeferred.waitFor(isState("running"), 8_000);
    await sseDeferred.waitFor(isState("idle"), 12_000);

    const deferredHistory = JSON.stringify(await c.messages(deferred.id));
    const busyHistory = JSON.stringify(await c.messages(busy.id));
    expect(deferredHistory).toContain("deferred_after_capacity");
    expect(busyHistory).not.toContain("deferred_after_capacity");

    sseDeferred.close();
    sseBusy.close();
  });
});
