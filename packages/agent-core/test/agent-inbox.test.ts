import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySchema,
  WasmDatabase,
  createInboxStore,
  createMessageStore,
  createSessionStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";

const stubToolRegistry = {
  get: () => undefined,
  getVercelTools: () => ({}),
} as unknown as ToolRegistry;

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function emptyStreamResult(): Awaited<ReturnType<Agent["runStream"]>> {
  return {
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    usage: Promise.resolve({}),
  } as unknown as Awaited<ReturnType<Agent["runStream"]>>;
}

function makeHarness() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-inbox-"));
  const db = freshDb();
  const sessionStore = createSessionStore(db);
  const messageStore = createMessageStore(db);
  const inboxStore = createInboxStore(db);
  const config: AgentConfig = {
    id: "agent-a",
    name: "Agent A",
    model: {
      provider: "openai",
      model: "test",
      apiKey: "x",
      auth: "api_key",
    },
    persona: "test",
    tools: [],
    maxSteps: 2,
    memoryExtractionEnabled: false,
    workspaceDir: path.join(tmpRoot, "workspace"),
  };
  const agent = new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "attachments"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore,
  });
  return { agent, sessionStore, messageStore, inboxStore };
}

describe("Agent inbox drain", () => {
  it("does not drain session-targeted system notices for another session at turn start", async () => {
    const { agent, sessionStore, messageStore, inboxStore } = makeHarness();
    sessionStore.create("agent-a", { id: "session-a" });
    sessionStore.create("agent-a", { id: "session-b" });
    const otherSessionRow = inboxStore.deliver({
      agentId: "agent-a",
      kind: "system_notice",
      source: "system",
      sourceId: "task",
      relatedSession: "session-b",
      payload: { eventKind: "task_done", payload: { taskId: "task-1" } },
    });

    vi.spyOn(agent, "runStream").mockResolvedValue(emptyStreamResult());
    await expect(agent.runAutonomous({ sessionId: "session-a" })).rejects.toThrow(
      "produced no assistant message"
    );

    expect(inboxStore.pendingFor("agent-a").map((row) => row.id)).toEqual([
      otherSessionRow,
    ]);
    const renderedHistory = JSON.stringify(messageStore.getHistory("session-a"));
    expect(renderedHistory).not.toContain("session-b");
    expect(renderedHistory).not.toContain("task_done");
  });

  it("does not inject or delete another session's system notice during mid-turn drain", async () => {
    const { agent, sessionStore, inboxStore } = makeHarness();
    sessionStore.create("agent-a", { id: "session-a" });
    sessionStore.create("agent-a", { id: "session-b" });
    let preparedStep: unknown;
    let otherSessionRow = 0;
    let remainingRows: number[] = [];

    vi.spyOn(agent, "runStream").mockImplementation(async (opts) => {
      otherSessionRow = inboxStore.deliver({
        agentId: "agent-a",
        kind: "system_notice",
        source: "system",
        sourceId: "task",
        relatedSession: "session-b",
        payload: { eventKind: "task_done", payload: { taskId: "task-1" } },
      });
      preparedStep = opts.prepareStep?.({
        stepNumber: 1,
        messages: [],
      } as never);
      remainingRows = inboxStore.pendingFor("agent-a").map((row) => row.id);
      return emptyStreamResult();
    });

    await expect(agent.runAutonomous({ sessionId: "session-a" })).rejects.toThrow(
      "produced no assistant message"
    );

    expect(preparedStep).toBeUndefined();
    expect(remainingRows).toEqual([otherSessionRow]);
  });
});
