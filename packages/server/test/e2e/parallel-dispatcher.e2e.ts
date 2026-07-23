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
  maxConcurrentSessions = 2
): Promise<void> {
  await c.createAgent(id, id, { maxConcurrentSessions });
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

    const home = await c.json("/api/home");
    const runningIds = new Set(
      (home.running as Array<{ sessionId: string }>).map((row) => row.sessionId)
    );
    expect(runningIds).toEqual(new Set([a.id, b.id]));

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
});
