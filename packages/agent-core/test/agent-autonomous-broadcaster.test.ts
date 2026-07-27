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
import type { UIMessageChunk } from "ai";
import { Agent, type AutonomousBroadcaster } from "../src/agent.js";
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

function messageStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start", messageId: "assistant-1" });
      controller.enqueue({ type: "text-start", id: "text-1" });
      controller.enqueue({
        type: "text-delta",
        id: "text-1",
        delta: "done",
      });
      controller.enqueue({ type: "text-end", id: "text-1" });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });
}

function rejectingStream(error: Error): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.error(error);
    },
  });
}

function streamResultWithRejectingBroadcastBranch(
  error: Error
): Awaited<ReturnType<Agent["runStream"]>> {
  return {
    toUIMessageStream: () =>
      ({
        tee: () => [messageStream(), rejectingStream(error)],
      }) as unknown as ReadableStream<UIMessageChunk>,
    usage: Promise.resolve({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    }),
  } as unknown as Awaited<ReturnType<Agent["runStream"]>>;
}

function makeAgent() {
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-autonomous-broadcaster-")
  );
  const db = freshDb();
  const sessionStore = createSessionStore(db);
  const messageStore = createMessageStore(db);
  const broadcasts: Array<{
    sessionId: string;
    event: Parameters<AutonomousBroadcaster["broadcast"]>[1];
  }> = [];
  const broadcaster: AutonomousBroadcaster = {
    broadcast(sessionId, event) {
      broadcasts.push({ sessionId, event });
    },
  };
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
    inboxStore: createInboxStore(db),
    broadcaster,
  });
  return { agent, sessionStore, messageStore, broadcasts };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Agent.runAutonomous broadcaster fanout", () => {
  it("handles fanout reader failures locally without unhandled rejection", async () => {
    const { agent, sessionStore, messageStore } = makeAgent();
    sessionStore.create("agent-a", { id: "session-a" });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    vi.spyOn(agent, "runStream").mockResolvedValue(
      streamResultWithRejectingBroadcastBranch(
        new Error("broadcaster fanout read failed")
      )
    );

    try {
      const result = await agent.runAutonomous({ sessionId: "session-a" });
      await nextTurn();
      await nextTurn();

      expect(result.assistant.parts).toEqual([
        { type: "text", text: "done", state: "done" },
      ]);
      expect(messageStore.getHistory("session-a")).toContainEqual(
        expect.objectContaining({
          id: "assistant-1",
          role: "assistant",
        })
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
