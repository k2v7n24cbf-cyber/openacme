import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "@openacme/config";
import {
  createDatabase,
  createCommentStore,
  createSessionStore,
  createInboxStore,
} from "@openacme/db";
import type { SessionTimelineEventInput } from "@openacme/db";
import { TaskStore } from "@openacme/tasks";
import { AutonomousTurnTimeout } from "@openacme/agent-core";
import { Dispatcher } from "../src/dispatcher.js";
import type { AgentManager } from "../src/agent-manager.js";

/**
 * Dispatcher tests against real stores (sqlite in a temp data dir,
 * filesystem TaskStore) with only the AgentManager faked — the
 * dispatcher only calls listAgents / getAgentDef / getAgent on it,
 * and a real manager would build a real Agent (LLM-backed) on spawn.
 */

type TurnCall = { agentId: string; sessionId: string };
type FakeAgentDef = {
  id: string;
  maxConcurrentSessions?: number;
  parallelSchedulingPolicy?: "lane_first" | "chain_first";
};

function fakeManager(
  agentDefs: Array<string | FakeAgentDef>,
  turn: (sessionId: string) => Promise<void> = async () => {},
): { manager: AgentManager; calls: TurnCall[] } {
  const calls: TurnCall[] = [];
  const defs = agentDefs.map((agent) =>
    typeof agent === "string" ? { id: agent } : agent,
  );
  const manager = {
    listAgents: () => defs,
    getAgentDef: (id: string) => defs.find((agent) => agent.id === id) ?? null,
    getAgent: (id: string) => ({
      runAutonomous: async ({ sessionId }: { sessionId: string }) => {
        calls.push({ agentId: id, sessionId });
        await turn(sessionId);
      },
    }),
  } as unknown as AgentManager;
  return { manager, calls };
}

function deferredTurns() {
  const release = new Map<string, () => void>();
  const turn = (sessionId: string) =>
    new Promise<void>((resolve) => release.set(sessionId, resolve));
  return { turn, release };
}

type DeferredTurns = ReturnType<typeof deferredTurns>;

let dataDir: string;
let db: ReturnType<typeof createDatabase>;
let sessionStore: ReturnType<typeof createSessionStore>;
let inboxStore: ReturnType<typeof createInboxStore>;
let taskStore: TaskStore;
let dispatcher: Dispatcher | null;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-dispatch-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  db = createDatabase(config);
  sessionStore = createSessionStore(db);
  inboxStore = createInboxStore(db);
  taskStore = new TaskStore(path.join(dataDir, "tasks"), {
    commentStore: createCommentStore(db),
  });
  dispatcher = null;
});

afterEach(() => {
  dispatcher?.stop();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function makeDispatcher(
  manager: AgentManager,
  opts: {
    now?: () => Date;
    onTimelineEvent?: (event: SessionTimelineEventInput) => void;
  } = {},
): Dispatcher {
  dispatcher = new Dispatcher({
    taskStore,
    sessionStore,
    inboxStore,
    agentManager: manager,
    // Long enough that the unref'd interval never fires in a test;
    // ticks are driven manually.
    tickIntervalMs: 3_600_000,
    ...opts,
  });
  return dispatcher;
}

/** Drive one tick and wait for any spawned turns to finish. */
async function tick(d: Dispatcher): Promise<void> {
  await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
  await d.drain(5_000);
}

async function waitForIdle(d: Dispatcher, sessionId: string): Promise<void> {
  await vi.waitFor(() => expect(d.isRunning(sessionId)).toBe(false), {
    timeout: 5_000,
  });
}

async function releaseTurn(
  gate: DeferredTurns,
  sessionId: string,
): Promise<void> {
  await vi.waitFor(() => expect(gate.release.has(sessionId)).toBe(true), {
    timeout: 5_000,
  });
  gate.release.get(sessionId)!();
}

async function makeBoundTask(
  agentId: string,
  overrides: Record<string, unknown> = {},
) {
  const session = sessionStore.create(agentId);
  const task = await taskStore.create({
    title: `work for ${agentId}`,
    assignee: agentId,
    created_by: "user",
  });
  const bound = await taskStore.update(task.id, {
    session_id: session.id,
    ...overrides,
  });
  return { session, task: bound };
}

describe("Dispatcher spawn rule", () => {
  it("spawns a turn for a session with a ready open task", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const { session } = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });

  it("emits dispatcher and autonomous lifecycle timeline events for a successful wake", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
    const { manager, calls } = fakeManager(["a1"]);
    const { session, task } = await makeBoundTask("a1");

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
    expect(timelineEvents.map((event) => event.eventType)).toEqual([
      "session.dispatcher.wake.started",
      "session.autonomous.started",
      "session.autonomous.finished",
      "session.dispatcher.wake.finished",
    ]);
    expect(timelineEvents[0]).toMatchObject({
      sessionId: session.id,
      agentId: "a1",
      taskId: task.id,
      source: "dispatcher",
      status: "running",
      payload: {
        reason: "task_open_ready",
      },
    });
    expect(timelineEvents[2]).toMatchObject({
      sessionId: session.id,
      agentId: "a1",
      taskId: task.id,
      source: "dispatcher",
      status: "ok",
    });
  });

  it("does not pre-mark a task in_progress before the agent claims it", async () => {
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(["a1"], gate.turn);
    const task = await taskStore.create({
      title: "wake-only",
      assignee: "a1",
      created_by: "user",
    });

    const d = makeDispatcher(manager);
    await d.start();

    expect(calls).toHaveLength(1);
    const observed = taskStore.get(task.id);
    expect(observed?.status).toBe("open");
    expect(observed?.session_id).toBe(calls[0]!.sessionId);

    await releaseTurn(gate, calls[0]!.sessionId);
    await d.drain(5_000);
  });

  it("does not spawn when the only task has a future start_at", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    await makeBoundTask("a1", {
      start_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([]);
  });

  it("waits for dependencies, then spawns once they are done", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    // Dep assigned to an agent the manager doesn't know — it can never
    // be picked up by this dispatcher, so only the dep edge matters.
    const dep = await taskStore.create({
      title: "dep",
      assignee: "ghost",
      created_by: "user",
    });
    await makeBoundTask("a1", { depends_on: [dep.id] });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);

    await taskStore.update(dep.id, { status: "done" });
    await tick(d);
    expect(calls).toHaveLength(1);
  });

  it("leaves unbound dependent tasks unallocated until dependencies are done", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const dep = await taskStore.create({
      title: "dep",
      assignee: "a1",
      created_by: "user",
    });
    const dependent = await taskStore.create({
      title: "dependent",
      assignee: "a1",
      created_by: "user",
      depends_on: [dep.id],
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(taskStore.get(dependent.id)?.session_id).toBeNull();
    expect(calls.map((call) => call.sessionId)).not.toContain(
      taskStore.get(dependent.id)?.session_id,
    );

    for (const task of taskStore.list({ session_id: calls[0]?.sessionId })) {
      await taskStore.update(task.id, { status: "done" });
    }
    await taskStore.update(dep.id, { status: "done" });
    await tick(d);

    expect(taskStore.get(dependent.id)?.session_id).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it("wakes a same-agent dependent in another session after dependency closes", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const s1 = sessionStore.create("a1");
    const s2 = sessionStore.create("a1");
    const blocker = await taskStore.create({
      title: "blocker",
      assignee: "a1",
      created_by: "a1",
      session_id: s1.id,
      status: "in_progress",
    });
    await taskStore.create({
      title: "dependent",
      assignee: "a1",
      created_by: "a1",
      session_id: s2.id,
      depends_on: [blocker.id],
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([{ agentId: "a1", sessionId: s1.id }]);

    await taskStore.update(blocker.id, { status: "done" }, { actor: "a1" });
    await tick(d);
    expect(calls).toEqual([
      { agentId: "a1", sessionId: s1.id },
      { agentId: "a1", sessionId: s2.id },
    ]);
  });

  it("wakes on a pending inbox row even with no tasks", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const session = sessionStore.create("a1", { kind: "task" });
    inboxStore.deliver({
      agentId: "a1",
      kind: "system_notice",
      source: "system",
      relatedSession: session.id,
      payload: { note: "ping" },
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });

  it("does not autonomously wake a taskless chat session with system inbox", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const session = sessionStore.create("a1");
    expect(session.kind).toBe("chat");
    inboxStore.deliver({
      agentId: "a1",
      kind: "system_notice",
      source: "system",
      relatedSession: session.id,
      payload: { note: "background signal" },
    });

    const d = makeDispatcher(manager);
    await tick(d);

    expect(calls).toEqual([]);
  });

  it("does not wake a session with a turn block, even with queued inbox", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
    const { manager, calls } = fakeManager(["a1"]);
    const session = sessionStore.create("a1", { kind: "task" });
    sessionStore.blockTurns(session.id, "context_length_exceeded");
    inboxStore.deliver({
      agentId: "a1",
      kind: "user_message",
      source: "user",
      sourceId: "m-blocked",
      relatedSession: session.id,
      payload: { id: "m-blocked", role: "user", parts: [] },
    });

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([]);
    expect(timelineEvents).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        agentId: "a1",
        taskId: null,
        eventType: "session.dispatcher.blocked.skipped",
        source: "dispatcher",
        status: "skipped",
        payload: expect.objectContaining({
          reason: "inbox",
          blockReason: "context_length_exceeded",
          blockSource: "session",
          hasInbox: true,
        }),
      }),
    );
  });

  it("defer_until suppresses routine wakes but an inbox row bypasses it", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const { session } = await makeBoundTask("a1");
    sessionStore.setDeferUntil(
      session.id,
      Math.floor(Date.now() / 1000) + 3600,
    );

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);

    inboxStore.deliver({
      agentId: "a1",
      kind: "system_notice",
      source: "system",
      relatedSession: session.id,
      payload: { note: "real signal" },
    });
    await tick(d);
    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });

  it("emits a coalesced defer skipped timeline event when defer suppresses ready work", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
    const { manager, calls } = fakeManager(["a1"]);
    const { session, task } = await makeBoundTask("a1");
    const deferUntil = Math.floor(Date.now() / 1000) + 3600;
    sessionStore.setDeferUntil(session.id, deferUntil);

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();
    await d.drain(5_000);
    await tick(d);

    expect(calls).toEqual([]);
    const deferEvents = timelineEvents.filter(
      (event) => event.eventType === "session.dispatcher.defer.skipped",
    );
    expect(deferEvents).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        agentId: "a1",
        taskId: task.id,
        source: "dispatcher",
        status: "skipped",
        payload: expect.objectContaining({
          reason: "task_open_ready",
          deferUntilMs: deferUntil * 1000,
        }),
      }),
    ]);
  });

  it("skips interactive-busy sessions and picks them up on clear", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const { session } = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    d.markInteractiveBusy(session.id);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);
    expect(d.isRunning(session.id)).toBe(true);
    expect(d.runningSessionIds()).toEqual([session.id]);

    // clearInteractiveBusy fires an immediate (unawaited) tick.
    d.clearInteractiveBusy(session.id);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ agentId: "a1", sessionId: session.id });
  });

  it("runs one session per agent per tick", async () => {
    // The fake turn closes out the session's tasks, the way a real
    // agent would — otherwise the same session stays "ready" and wins
    // every subsequent tick.
    const turn = async (sessionId: string) => {
      for (const t of taskStore.list({
        session_id: sessionId,
        status: "open",
      })) {
        await taskStore.update(t.id, { status: "done" });
      }
    };
    const { manager, calls } = fakeManager(["a1"], turn);
    const a = await makeBoundTask("a1");
    const b = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toHaveLength(1);

    await tick(d);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.sessionId))).toEqual(
      new Set([a.session.id, b.session.id]),
    );
  });

  it("keeps default maxConcurrentSessions at one active session", async () => {
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(["a1"], gate.turn);
    const a = await makeBoundTask("a1");
    const b = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();

    expect(calls).toHaveLength(1);
    expect([a.session.id, b.session.id]).toContain(calls[0]?.sessionId);
    expect(d.runningSessionIds()).toEqual([calls[0]!.sessionId]);
    await releaseTurn(gate, calls[0]!.sessionId);
    await d.drain(5_000);
  });

  it("emits capacity queued timeline events when ready work waits for an agent slot", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(
      [{ id: "a1", maxConcurrentSessions: 1 }],
      gate.turn,
    );
    const a = await makeBoundTask("a1");
    const b = await makeBoundTask("a1");

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();

    expect(calls).toHaveLength(1);
    const queued = timelineEvents.find(
      (event) => event.eventType === "session.dispatcher.capacity_queued",
    );
    expect(queued).toMatchObject({
      agentId: "a1",
      source: "dispatcher",
      status: "queued",
      payload: {
        reason: "task_open_ready",
        limit: 1,
        activeCount: 1,
      },
    });
    expect([a.session.id, b.session.id]).toContain(queued?.sessionId);
    expect(queued?.sessionId).not.toBe(calls[0]!.sessionId);

    await releaseTurn(gate, calls[0]!.sessionId);
    await d.drain(5_000);
  });

  it("serializes concurrent kicks before capacity accounting", async () => {
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(["a1"], gate.turn);
    const a = sessionStore.create("a1");
    const b = sessionStore.create("a1");

    const d = makeDispatcher(manager);
    await d.start();
    expect(calls).toEqual([]);

    inboxStore.deliver({
      agentId: "a1",
      kind: "user_message",
      source: "user",
      sourceId: "a",
      relatedSession: a.id,
      payload: { id: "a", role: "user", parts: [{ type: "text", text: "a" }] },
    });
    inboxStore.deliver({
      agentId: "a1",
      kind: "user_message",
      source: "user",
      sourceId: "b",
      relatedSession: b.id,
      payload: { id: "b", role: "user", parts: [{ type: "text", text: "b" }] },
    });

    d.kick("test_a");
    d.kick("test_b");
    await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();

    expect(calls).toHaveLength(1);
    expect([a.id, b.id]).toContain(calls[0]!.sessionId);
    expect(d.runningSessionIds()).toEqual([calls[0]!.sessionId]);

    await releaseTurn(gate, calls[0]!.sessionId);
    await d.drain(5_000);
  });

  it("starts up to maxConcurrentSessions distinct sessions for one agent", async () => {
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(
      [{ id: "a1", maxConcurrentSessions: 2 }],
      gate.turn,
    );
    const a = await makeBoundTask("a1");
    const b = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.sessionId))).toEqual(
      new Set([a.session.id, b.session.id]),
    );
    expect(new Set(d.runningSessionIds())).toEqual(
      new Set([a.session.id, b.session.id]),
    );
    expect(d.isRunning(a.session.id)).toBe(true);
    expect(d.isRunning(b.session.id)).toBe(true);
    for (const call of calls) await releaseTurn(gate, call.sessionId);
    await d.drain(5_000);
  });

  it("backfills another ready session when a capacity slot frees", async () => {
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(
      [{ id: "a1", maxConcurrentSessions: 2 }],
      gate.turn,
    );
    const a = await makeBoundTask("a1");
    const b = await makeBoundTask("a1");
    const c = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();

    expect(calls).toHaveLength(2);
    const firstFinished = calls[0]!.sessionId;
    for (const task of taskStore.list({
      session_id: firstFinished,
      status: "open",
    })) {
      await taskStore.update(task.id, { status: "done" });
    }
    await releaseTurn(gate, firstFinished);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(new Set(calls.map((call) => call.sessionId))).toEqual(
      new Set([a.session.id, b.session.id, c.session.id]),
    );
    for (const call of calls) await releaseTurn(gate, call.sessionId);
    await d.drain(5_000);
  });

  it("prioritizes queued user messages over task wakes when capacity frees", async () => {
    const gate = deferredTurns();
    const { manager, calls } = fakeManager(
      [{ id: "a1", maxConcurrentSessions: 1 }],
      gate.turn,
    );
    const user = sessionStore.create("a1");
    const taskEvent = sessionStore.create("a1");
    const active = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    expect(calls).toEqual([{ agentId: "a1", sessionId: active.session.id }]);

    inboxStore.deliver({
      agentId: "a1",
      kind: "system_notice",
      source: "system",
      sourceId: "task",
      relatedSession: taskEvent.id,
      payload: { eventKind: "comment_added" },
    });
    inboxStore.deliver({
      agentId: "a1",
      kind: "user_message",
      source: "user",
      sourceId: "user",
      relatedSession: user.id,
      payload: {
        id: "user",
        role: "user",
        parts: [{ type: "text", text: "respond first" }],
      },
    });
    d.kick("test_user_priority");

    await taskStore.update(active.task.id, { status: "done" });
    await releaseTurn(gate, active.session.id);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ agentId: "a1", sessionId: user.id });

    await releaseTurn(gate, user.id);
    await d.drain(5_000);
  });

  for (const policy of ["lane_first", "chain_first"] as const) {
    it(`${policy} prioritizes direct messages before user task comments before autonomous task wakes`, async () => {
      const gate = deferredTurns();
      const { manager, calls } = fakeManager(
        [
          {
            id: "a1",
            maxConcurrentSessions: 1,
            parallelSchedulingPolicy: policy,
          },
        ],
        async (sessionId) => {
          inboxStore.claimForSession({
            agentId: "a1",
            sessionId,
            includeAgentWide: true,
          });
          for (const task of taskStore.list({
            session_id: sessionId,
            status: "open",
          })) {
            await taskStore.update(task.id, { status: "done" });
          }
          await gate.turn(sessionId);
        },
      );
      const active = await makeBoundTask("a1");

      const d = makeDispatcher(manager);
      await d.start();
      expect(calls).toEqual([{ agentId: "a1", sessionId: active.session.id }]);

      const commentSession = sessionStore.create("a1");
      await taskStore.create({
        title: "commented task",
        assignee: "a1",
        created_by: "user",
        session_id: commentSession.id,
      });
      inboxStore.deliver({
        agentId: "a1",
        kind: "system_notice",
        source: "system",
        sourceId: null,
        relatedTask: "task-comment",
        relatedSession: commentSession.id,
        payload: {
          eventKind: "comment_added",
          payload: {
            author: "system:user",
            excerpt: "please look at this task comment",
          },
        },
      });
      const taskSession = sessionStore.create("a1");
      await taskStore.create({
        title: "autonomous task should run after comment",
        assignee: "a1",
        created_by: "user",
        session_id: taskSession.id,
      });
      const userSession = sessionStore.create("a1");
      inboxStore.deliver({
        agentId: "a1",
        kind: "user_message",
        source: "user",
        sourceId: "direct-user",
        relatedSession: userSession.id,
        payload: {
          id: "direct-user",
          role: "user",
          parts: [{ type: "text", text: "direct user goes first" }],
        },
      });
      d.kick("test_user_comment_task_priority");

      await releaseTurn(gate, active.session.id);
      await waitForIdle(d, active.session.id);
      await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toEqual({ agentId: "a1", sessionId: userSession.id });

      await releaseTurn(gate, userSession.id);
      await waitForIdle(d, userSession.id);
      await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      expect(calls[2]).toEqual({
        agentId: "a1",
        sessionId: commentSession.id,
      });

      await releaseTurn(gate, commentSession.id);
      await waitForIdle(d, commentSession.id);
      await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
      await vi.waitFor(() => expect(calls).toHaveLength(4));
      expect(calls[3]).toEqual({ agentId: "a1", sessionId: taskSession.id });

      await releaseTurn(gate, taskSession.id);
      await d.drain(5_000);
    });

    it(`${policy} drains all direct-message sessions before user task comments`, async () => {
      const gate = deferredTurns();
      const { manager, calls } = fakeManager(
        [
          {
            id: "a1",
            maxConcurrentSessions: 1,
            parallelSchedulingPolicy: policy,
          },
        ],
        async (sessionId) => {
          inboxStore.claimForSession({
            agentId: "a1",
            sessionId,
            includeAgentWide: true,
          });
          await gate.turn(sessionId);
        },
      );
      const active = await makeBoundTask("a1");

      const d = makeDispatcher(manager);
      await d.start();
      expect(calls).toEqual([{ agentId: "a1", sessionId: active.session.id }]);

      const firstUser = sessionStore.create("a1");
      const commentSession = sessionStore.create("a1");
      await taskStore.create({
        title: "commented task",
        assignee: "a1",
        created_by: "user",
        session_id: commentSession.id,
        status: "blocked",
      });
      const secondUser = sessionStore.create("a1");
      inboxStore.deliver({
        agentId: "a1",
        kind: "user_message",
        source: "user",
        sourceId: "first-direct",
        relatedSession: firstUser.id,
        payload: {
          id: "first-direct",
          role: "user",
          parts: [{ type: "text", text: "first direct" }],
        },
      });
      inboxStore.deliver({
        agentId: "a1",
        kind: "system_notice",
        source: "system",
        sourceId: null,
        relatedTask: "task-comment",
        relatedSession: commentSession.id,
        payload: {
          eventKind: "comment_added",
          payload: {
            author: "system:user",
            excerpt: "comment between direct messages",
          },
        },
      });
      inboxStore.deliver({
        agentId: "a1",
        kind: "user_message",
        source: "user",
        sourceId: "second-direct",
        relatedSession: secondUser.id,
        payload: {
          id: "second-direct",
          role: "user",
          parts: [{ type: "text", text: "second direct" }],
        },
      });
      d.kick("test_multiple_direct_before_comment");

      await releaseTurn(gate, active.session.id);
      await waitForIdle(d, active.session.id);
      await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect([firstUser.id, secondUser.id]).toContain(calls[1]!.sessionId);

      await releaseTurn(gate, calls[1]!.sessionId);
      await waitForIdle(d, calls[1]!.sessionId);
      await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
      await vi.waitFor(() => expect(calls).toHaveLength(3));
      expect(new Set([calls[1]!.sessionId, calls[2]!.sessionId])).toEqual(
        new Set([firstUser.id, secondUser.id]),
      );

      await releaseTurn(gate, calls[2]!.sessionId);
      await waitForIdle(d, calls[2]!.sessionId);
      await (d as unknown as { tickSafe(): Promise<void> }).tickSafe();
      await vi.waitFor(() => expect(calls).toHaveLength(4));
      expect(calls[3]).toEqual({
        agentId: "a1",
        sessionId: commentSession.id,
      });

      await releaseTurn(gate, commentSession.id);
      await d.drain(5_000);
    });
  }

  it("lane_first starts unrun task lanes before continuing a hot chain", async () => {
    const { manager, calls } = fakeManager(
      [
        {
          id: "a1",
          maxConcurrentSessions: 1,
          parallelSchedulingPolicy: "lane_first",
        },
      ],
      async (sessionId) => {
        for (const task of taskStore.list({
          session_id: sessionId,
          status: "open",
        })) {
          await taskStore.update(task.id, { status: "done" });
        }
        if (sessionId === chain.id && calls.length === 1) {
          sessionStore.touch(sessionId);
          await taskStore.create({
            title: "chain step 2",
            assignee: "a1",
            created_by: "user",
            session_id: sessionId,
          });
        }
      },
    );
    const lane = sessionStore.create("a1");
    await taskStore.create({
      title: "lane step 1",
      assignee: "a1",
      created_by: "user",
      session_id: lane.id,
    });
    const chain = sessionStore.create("a1");
    await taskStore.create({
      title: "chain step 1",
      assignee: "a1",
      created_by: "user",
      session_id: chain.id,
    });
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      1,
      lane.id,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      2,
      chain.id,
    );

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls.map((call) => call.sessionId)).toEqual([chain.id]);

    await tick(d);
    expect(calls.map((call) => call.sessionId)).toEqual([chain.id, lane.id]);
  });

  it("chain_first continues a hot task chain before starting an unrun lane", async () => {
    const { manager, calls } = fakeManager(
      [
        {
          id: "a1",
          maxConcurrentSessions: 1,
          parallelSchedulingPolicy: "chain_first",
        },
      ],
      async (sessionId) => {
        for (const task of taskStore.list({
          session_id: sessionId,
          status: "open",
        })) {
          await taskStore.update(task.id, { status: "done" });
        }
        if (sessionId === chain.id && calls.length === 1) {
          sessionStore.touch(sessionId);
          await taskStore.create({
            title: "chain step 2",
            assignee: "a1",
            created_by: "user",
            session_id: sessionId,
          });
        }
      },
    );
    const lane = sessionStore.create("a1");
    await taskStore.create({
      title: "lane step 1",
      assignee: "a1",
      created_by: "user",
      session_id: lane.id,
    });
    const chain = sessionStore.create("a1");
    await taskStore.create({
      title: "chain step 1",
      assignee: "a1",
      created_by: "user",
      session_id: chain.id,
    });
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      1,
      lane.id,
    );
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      2,
      chain.id,
    );

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls.map((call) => call.sessionId)).toEqual([chain.id]);

    await tick(d);
    expect(calls.map((call) => call.sessionId)).toEqual([chain.id, chain.id]);
  });

  it("counts interactive-busy sessions toward agent capacity", async () => {
    const { manager, calls } = fakeManager([
      { id: "a1", maxConcurrentSessions: 1 },
    ]);
    const interactive = sessionStore.create("a1");
    await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    d.markInteractiveBusy(interactive.id);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([]);
    expect(d.runningSessionIds()).toEqual([interactive.id]);
  });

  it("observes maxConcurrentSessions updates without restart", async () => {
    const gate = deferredTurns();
    const agentDef: FakeAgentDef = { id: "a1", maxConcurrentSessions: 1 };
    const { manager, calls } = fakeManager([agentDef], gate.turn);
    await makeBoundTask("a1");
    await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();

    expect(calls).toHaveLength(1);
    agentDef.maxConcurrentSessions = 2;
    d.kick("test_capacity_update");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(new Set(d.runningSessionIds())).toEqual(
      new Set(calls.map((call) => call.sessionId)),
    );

    for (const call of calls) await releaseTurn(gate, call.sessionId);
    await d.drain(5_000);
  });

  it("binds unbound ready tasks to a fresh session and spawns it", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const task = await taskStore.create({
      title: "Write the launch post",
      assignee: "a1",
      created_by: "user",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    const bound = taskStore.get(task.id);
    expect(bound?.session_id).toBeTruthy();
    expect(calls).toEqual([{ agentId: "a1", sessionId: bound!.session_id }]);
    const session = sessionStore.get(bound!.session_id!);
    expect(session?.title).toBe("Write the launch post");
    expect(session?.kind).toBe("task");
  });

  it("clears dangling session bindings before rebinding ready work", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const ghost = sessionStore.create("a1");
    const task = await taskStore.create({
      title: "orphaned binding",
      assignee: "a1",
      created_by: "user",
      session_id: ghost.id,
    });
    sessionStore.delete(ghost.id);

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    const rebound = taskStore.get(task.id);
    expect(rebound?.session_id).toBeTruthy();
    expect(rebound?.session_id).not.toBe(ghost.id);
    expect(sessionStore.get(rebound!.session_id!)).not.toBeNull();
    expect(calls).toEqual([{ agentId: "a1", sessionId: rebound!.session_id }]);
  });
});

describe("Dispatcher failure handling", () => {
  it("parks the in-progress task when the turn errors", async () => {
    const { manager, calls } = fakeManager(["a1"], async () => {
      throw new Error("boom");
    });
    const { session, task } = await makeBoundTask("a1", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
    const parked = taskStore.get(task.id);
    expect(parked?.status).toBe("blocked");
    const retryAt = Date.parse(parked!.start_at!);
    // Park backoff is 5 minutes.
    expect(retryAt).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(retryAt).toBeLessThan(Date.now() + 6 * 60_000);
  });

  it("marks an in-progress task system_blocked on OpenAI context overflow", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
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
    const { manager, calls } = fakeManager(["a1"], async () => {
      throw providerError;
    });
    const { session, task } = await makeBoundTask("a1", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
    const blocked = taskStore.get(task.id);
    expect(blocked?.status).toBe("system_blocked");
    expect(blocked?.start_at).toBeNull();
    const comments = taskStore.listComments(task.id, { kinds: ["system"] });
    expect(comments.at(-1)?.body).toContain("context_length_exceeded");
    expect(comments.at(-1)?.body).toContain(
      "Your input exceeds the context window",
    );
    expect(comments.at(-1)?.body).not.toContain("[object Object]");
    expect(timelineEvents).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        agentId: "a1",
        taskId: task.id,
        eventType: "session.turn_blocked",
        source: "dispatcher",
        status: "blocked",
        payload: expect.objectContaining({
          reason: "context_length_exceeded",
          message:
            "Your input exceeds the context window of this model. Please adjust your input and try again.",
          taskIds: [task.id],
        }),
      }),
    );
  });

  it("does not downgrade a task that became system_blocked during a failed turn", async () => {
    let taskId = "";
    const { manager, calls } = fakeManager(["a1"], async () => {
      await taskStore.update(
        taskId,
        { status: "system_blocked", start_at: null },
        { actor: "system:test" },
      );
      throw new Error("late non-system cleanup error");
    });
    const { session, task } = await makeBoundTask("a1", {
      status: "in_progress",
    });
    taskId = task.id;

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
    const blocked = taskStore.get(task.id);
    expect(blocked?.status).toBe("system_blocked");
    expect(blocked?.start_at).toBeNull();
  });

  it("does not wake a system_blocked task, even with queued inbox", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
    const { manager, calls } = fakeManager(["a1"]);
    const { session, task } = await makeBoundTask("a1", {
      status: "system_blocked",
    });
    inboxStore.deliver({
      agentId: "a1",
      kind: "user_message",
      source: "user",
      sourceId: "msg-1",
      relatedSession: session.id,
      payload: {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "try again" }],
      },
    });

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([]);
    expect(timelineEvents).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        agentId: "a1",
        taskId: task.id,
        eventType: "session.dispatcher.blocked.skipped",
        source: "dispatcher",
        status: "skipped",
        payload: expect.objectContaining({
          reason: "inbox",
          blockReason: "task_system_blocked",
          blockSource: "task",
          hasInbox: true,
        }),
      }),
    );
  });

  it("emits autonomous and wake failure timeline events when a turn errors", async () => {
    const timelineEvents: SessionTimelineEventInput[] = [];
    const { manager, calls } = fakeManager(["a1"], async () => {
      throw new Error("boom");
    });
    const { session, task } = await makeBoundTask("a1", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager, {
      onTimelineEvent: (event) => timelineEvents.push(event),
    });
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
    expect(timelineEvents.map((event) => event.eventType)).toEqual([
      "session.dispatcher.wake.started",
      "session.autonomous.started",
      "session.autonomous.failed",
      "session.dispatcher.wake.failed",
    ]);
    expect(timelineEvents[2]).toMatchObject({
      sessionId: session.id,
      agentId: "a1",
      taskId: task.id,
      source: "dispatcher",
      status: "error",
      payload: {
        error: "boom",
      },
    });
    expect(timelineEvents[3]).toMatchObject({
      sessionId: session.id,
      agentId: "a1",
      taskId: task.id,
      source: "dispatcher",
      status: "error",
    });
  });

  it("parks timeout failures with a timeout-specific scheduler comment", async () => {
    const { manager } = fakeManager(["a1"], async (sessionId) => {
      const task = taskStore.list({ session_id: sessionId })[0];
      if (task) await taskStore.update(task.id, { status: "in_progress" });
      throw new AutonomousTurnTimeout("synthetic timeout");
    });
    const { task } = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    const parked = taskStore.get(task.id);
    expect(parked?.status).toBe("blocked");
    const comments = taskStore.listComments(task.id, { kinds: ["system"] });
    expect(comments.at(-1)?.body).toContain("timeout");
  });

  it("parks plain object turn errors with a readable provider message", async () => {
    const { manager } = fakeManager(["a1"], async () => {
      throw {
        status: 400,
        error: {
          message: "Unsupported model gpt-5.2 for OpenAI OAuth",
          type: "invalid_request_error",
        },
      };
    });
    const { task } = await makeBoundTask("a1", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    const parked = taskStore.get(task.id);
    expect(parked?.status).toBe("blocked");
    const comments = taskStore.listComments(task.id, { kinds: ["system"] });
    expect(comments.at(-1)?.body).toContain(
      "Unsupported model gpt-5.2 for OpenAI OAuth",
    );
    expect(comments.at(-1)?.body).not.toContain("[object Object]");
  });

  it("parks only the failing session when parallel turns overlap", async () => {
    const gate = deferredTurns();
    const failing = await makeBoundTask("a1");
    const survivor = await makeBoundTask("a1");
    const { manager, calls } = fakeManager(
      [{ id: "a1", maxConcurrentSessions: 2 }],
      async (sessionId) => {
        if (sessionId === failing.session.id) {
          const task = taskStore.list({ session_id: sessionId })[0];
          if (task) await taskStore.update(task.id, { status: "in_progress" });
          throw new Error("fail one session");
        }
        await gate.turn(sessionId);
      },
    );

    const d = makeDispatcher(manager);
    await d.start();

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await vi.waitFor(() =>
      expect(taskStore.get(failing.task.id)?.status).toBe("blocked"),
    );
    expect(taskStore.get(survivor.task.id)?.status).toBe("open");
    expect(d.isRunning(survivor.session.id)).toBe(true);
    expect(d.isRunning(failing.session.id)).toBe(false);

    await releaseTurn(gate, survivor.session.id);
    await d.drain(5_000);
  });

  it("does not park any task when a failed turn claimed no in_progress task", async () => {
    const { manager, calls } = fakeManager(["a1"], async () => {
      throw new Error("no claim");
    });
    const { task } = await makeBoundTask("a1");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toHaveLength(1);
    expect(taskStore.get(task.id)?.status).toBe("open");
    const comments = taskStore.listComments(task.id, { kinds: ["system"] });
    expect(comments).toHaveLength(0);
  });

  it("leaves tasks open when the referenced agent is unavailable", async () => {
    const { manager, calls } = fakeManager([]);
    const { task } = await makeBoundTask("ghost");

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);

    expect(calls).toEqual([]);
    expect(taskStore.get(task.id)?.status).toBe("open");
  });

  it("startup sweep resets stale in_progress tasks to open", async () => {
    // Assignee unknown to the manager: nothing can spawn, isolating
    // the sweep itself.
    const { manager, calls } = fakeManager([]);
    const { task } = await makeBoundTask("ghost", {
      status: "in_progress",
    });

    const d = makeDispatcher(manager, {
      // Staleness threshold is 10 minutes from updated_at.
      now: () => new Date(Date.now() + 11 * 60_000),
    });
    await d.start();
    await d.drain(5_000);

    expect(taskStore.get(task.id)?.status).toBe("open");
    expect(calls).toEqual([]);
  });
});

describe("Dispatcher recurring wake floor", () => {
  it("does not re-wake an in_progress interval task before its interval elapses", async () => {
    const { manager, calls } = fakeManager(["a1"]);
    const session = sessionStore.create("a1");
    const created = await taskStore.create({
      title: "tick task",
      assignee: "a1",
      created_by: "user",
      recurrence: { kind: "interval", every_ms: 60_000 },
    });
    // One full done-cycle stamps last_run_at; then the agent leaves it
    // claimed in_progress between fires (the pattern the floor exists for).
    await taskStore.update(created.id, {
      session_id: session.id,
      status: "in_progress",
    });
    await taskStore.update(created.id, { status: "done" });
    await taskStore.update(created.id, {
      session_id: session.id,
      status: "in_progress",
    });

    const d = makeDispatcher(manager);
    await d.start();
    await d.drain(5_000);
    expect(calls).toEqual([]);
    d.stop();

    // 61s later the interval has elapsed — the same state now spawns.
    const later = makeDispatcher(manager, {
      now: () => new Date(Date.now() + 61_000),
    });
    await later.start();
    await later.drain(5_000);
    expect(calls).toEqual([{ agentId: "a1", sessionId: session.id }]);
  });
});
