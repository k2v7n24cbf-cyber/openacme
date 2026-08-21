import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySchema,
  WasmDatabase,
  createSessionStore,
  createMessageStore,
  createInboxStore,
  createContextSnapshotStore,
  createObjectiveStore,
  type ObjectiveStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import type { UIMessage, UIMessageChunk } from "ai";
import { Agent, type AutonomousBroadcaster } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";

const {
  streamTextMock,
  generateTextMock,
  getModelMock,
  getEffectiveContextWindowMock,
} = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  generateTextMock: vi.fn(),
  getModelMock: vi.fn(() => ({})),
  getEffectiveContextWindowMock: vi.fn<(config: unknown) => number | null>(
    () => null,
  ),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: streamTextMock,
    generateText: generateTextMock,
  };
});

vi.mock("@openacme/llm-provider", () => ({
  getModel: getModelMock,
  resolveSubagentModel: (m: unknown) => m,
  getEffectiveContextWindow: getEffectiveContextWindowMock,
  supportsToolResultMedia: () => false,
  getActiveTraceContext: () => null,
  getAiObservationContext: () => undefined,
  getProviderRequestCountForRun: () => 1,
  buildEvidenceEventSelector: (
    eventType: string,
    fields: Record<string, string | number | undefined | null> = {},
  ) =>
    [
      `type=${eventType}`,
      ...Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`),
    ].join(" "),
  buildEvidenceLocatorAttributes: () => ({}),
  buildEvidenceLocatorPayload: () => ({}),
  setAiObservationContext: vi.fn(),
  enterAiObservationContext: (_ctx: unknown, fn: () => unknown) => fn(),
  createEvidenceRecorder: () => ({
    enabled: false,
    recordEvent: vi.fn(),
    writeRawFile: vi.fn(),
  }),
  withOpenAcmeSpan: (
    _name: string,
    _attrs: unknown,
    fn: (span: unknown) => unknown,
  ) => fn({ traceId: "trace-helper", spanId: "span-helper" }),
  startOpenAcmeSpan: () => ({
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    recordException: vi.fn(),
    setStatusOk: vi.fn(),
    setStatusError: vi.fn(),
    end: vi.fn(),
    run: (fn: () => unknown) => fn(),
  }),
}));

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

const stubToolRegistry = {
  get: () => undefined,
  // Return a deterministic tool blob so the estimator counts something.
  getVercelTools: () => ({ shell: { description: "shell tool" } }),
} as unknown as ToolRegistry;

function makeAgent(opts: {
  db: WasmDatabase;
  thresholdTokens: number | null;
  thresholdPercent?: number | null;
  contextWindow?: number | null;
  protectFirstN?: number;
  tailTokenBudget?: number;
  tools?: string[];
  taskStore?: TaskStore;
  objectiveStore?: ObjectiveStore;
  toolRegistry?: ToolRegistry;
  broadcaster?: AutonomousBroadcaster;
}): Agent {
  const sessionStore = createSessionStore(opts.db);
  const messageStore = createMessageStore(opts.db);
  const contextSnapshotStore = createContextSnapshotStore(opts.db);
  const config: AgentConfig = {
    id: "a1",
    name: "Agent A1",
    model: {
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "x",
      auth: "api_key",
      cacheTtl: "5m",
    },
    persona: "test",
    tools: opts.tools ?? ["shell"],
    maxSteps: 1,
    workspaceDir: "/tmp/openacme-preflight-test-ws",
    compression: {
      thresholdTokens: opts.thresholdTokens,
      thresholdPercent: opts.thresholdPercent ?? null,
      contextWindow: opts.contextWindow ?? null,
      protectFirstN: opts.protectFirstN ?? 1,
      tailTokenBudget: opts.tailTokenBudget ?? 200,
      summaryTargetRatio: 0.2,
      summarizerInputCharBudget: 80_000,
    },
  };
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-preflight-test-"),
  );
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: opts.toolRegistry ?? stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "attachments"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: opts.taskStore ?? new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore: createInboxStore(opts.db),
    contextSnapshotStore,
    objectiveStore: opts.objectiveStore,
    broadcaster: opts.broadcaster,
  });
}

function bigUserMsg(id: string, charCount: number): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "x".repeat(charCount) }],
  } as UIMessage;
}

function bigAssistantMsg(id: string, charCount: number): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "y".repeat(charCount) }],
  } as UIMessage;
}

function messageText(message: UIMessage): string {
  return (message.parts ?? [])
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String(part.text ?? "")
        : "",
    )
    .join("\n");
}

function successfulAssistantStream(
  text: string,
): Awaited<ReturnType<Agent["runStream"]>> {
  return {
    toUIMessageStream: () =>
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: "start", messageId: "assistant-ok" });
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({
            type: "text-delta",
            id: "text-1",
            delta: text,
          });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({ type: "finish", finishReason: "stop" });
          controller.close();
        },
      }),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    }),
  } as unknown as Awaited<ReturnType<Agent["runStream"]>>;
}

function contextLengthExceededError() {
  return {
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
}

describe("Agent hosted integration tool surface", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getEffectiveContextWindowMock.mockReset();
    getModelMock.mockReturnValue({});
    streamTextMock.mockReturnValue(successfulAssistantStream("ok"));
  });

  it("passes selected hosted integration tools to the model tool surface", async () => {
    const db = freshDb();
    createSessionStore(db).create("a1", { id: "hosted-selected" });
    const seenToolSets: Array<Set<string> | undefined> = [];
    const registry = {
      get(name: string) {
        return name === "qualys_count_assets"
          ? { name, description: "Count Qualys assets.", toolset: "hosted" }
          : undefined;
      },
      getVercelTools(toolNames?: Set<string>) {
        seenToolSets.push(toolNames);
        return toolNames?.has("qualys_count_assets")
          ? {
              qualys_count_assets: {
                description: "Count Qualys assets.",
              },
            }
          : {};
      },
    } as unknown as ToolRegistry;
    const agent = makeAgent({
      db,
      thresholdTokens: null,
      tools: ["qualys_count_assets"],
      toolRegistry: registry,
    });

    await agent.runStream({
      sessionId: "hosted-selected",
      history: [bigUserMsg("u1", 10)],
    });

    expect([...seenToolSets[0]!]).toEqual(["qualys_count_assets"]);
    expect(streamTextMock.mock.calls[0]![0]!.tools).toHaveProperty(
      "qualys_count_assets",
    );
  });

  it("does not pass unselected hosted integration tools to the model tool surface", async () => {
    const db = freshDb();
    createSessionStore(db).create("a1", { id: "hosted-not-selected" });
    const registry = {
      get(name: string) {
        return name === "shell"
          ? { name, description: "Shell.", toolset: "terminal" }
          : undefined;
      },
      getVercelTools(toolNames?: Set<string>) {
        return toolNames?.has("qualys_count_assets")
          ? {
              qualys_count_assets: {
                description: "Count Qualys assets.",
              },
            }
          : {};
      },
    } as unknown as ToolRegistry;
    const agent = makeAgent({
      db,
      thresholdTokens: null,
      tools: ["shell"],
      toolRegistry: registry,
    });

    await agent.runStream({
      sessionId: "hosted-not-selected",
      history: [bigUserMsg("u1", 10)],
    });

    expect(streamTextMock.mock.calls[0]![0]!.tools).not.toHaveProperty(
      "qualys_count_assets",
    );
  });
});

describe("Agent.preflightCompress", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    getModelMock.mockReset();
    getEffectiveContextWindowMock.mockReset();
    getModelMock.mockReturnValue({});
    // Summarizer aux model: any string output satisfies the pipeline.
    generateTextMock.mockResolvedValue({ text: "## Active Task\nNone." });
    // Default: no override — preflight uses config.contextWindow.
    getEffectiveContextWindowMock.mockReturnValue(null);
  });

  it("no-ops when compression config is missing", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    // makeAgent always sets compression — manually null it out.
    const agent = makeAgent({ db, thresholdTokens: null });
    (agent.config as { compression?: unknown }).compression = undefined;
    const newId = await agent.preflightCompress("s1", []);
    expect(newId).toBe("s1");
  });

  it("no-ops when threshold can't be resolved (no tokens and no percent+window)", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    const agent = makeAgent({
      db,
      thresholdTokens: null,
      thresholdPercent: null,
      contextWindow: null,
    });
    const newId = await agent.preflightCompress("s1", []);
    expect(newId).toBe("s1");
  });

  it("estimates request tokens without throwing on circular tool schemas", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    sessions.create("a1", { id: "s1" });
    const circular: Record<string, unknown> = { description: "circular" };
    circular.self = circular;
    const toolRegistry = {
      get: () => undefined,
      getVercelTools: () => ({ workflow_validate: circular }),
    } as unknown as ToolRegistry;
    const agent = makeAgent({
      db,
      thresholdTokens: 10_000,
      tools: ["workflow_validate"],
      toolRegistry,
    });

    const prepared = await agent.prepareModelHistory("s1", [
      bigUserMsg("u1", 20),
    ]);

    expect(prepared.compressed).toBe(false);
    expect(prepared.estimatedTokens).toBeGreaterThan(0);
  });

  it("no-ops when history is under threshold", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "small" });

    const seed: UIMessage[] = [
      bigUserMsg("u1", 100),
      bigAssistantMsg("a1", 100),
    ];
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      })),
    );

    const agent = makeAgent({
      db,
      // 10K-token threshold — seed is well under
      thresholdTokens: 10_000,
    });
    const newId = await agent.preflightCompress(parent.id, seed);
    expect(newId).toBe(parent.id);
    expect(sessions.findChildOf(parent.id)).toBeNull();
  });

  it("counts the objectives snapshot as part of the preflight system prompt", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", { id: "objective-context" });
    const objectiveStore = createObjectiveStore(db);
    const taskStore = new TaskStore(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-preflight-tasks-")),
      { db },
    );
    const objectiveToolRegistry = {
      get: () => ({}),
      getVercelTools: () => ({
        objective_create: { description: "objective create" },
        objective_view: { description: "objective view" },
      }),
    } as unknown as ToolRegistry;

    for (let i = 0; i < 8; i++) {
      const objective = objectiveStore.createObjective({
        id: `objective-${i}`,
        title: `Objective ${i} ${"x".repeat(80)}`,
        ownerAgentId: "a1",
        ownerSessionId: parent.id,
        createdBy: "a1",
        createdInSessionId: parent.id,
        closeoutPrompt: `Review ${i} ${"y".repeat(60)}`,
      });
      await taskStore.create({
        title: `Task for ${objective.id}`,
        assignee: "a1",
        created_by: "a1",
        session_id: parent.id,
        objective_id: objective.id,
      });
    }

    const withoutObjectives = makeAgent({
      db,
      thresholdTokens: 10_000,
      tools: ["objective_create", "objective_view"],
      taskStore,
      toolRegistry: objectiveToolRegistry,
    });
    const withObjectives = makeAgent({
      db,
      thresholdTokens: 10_000,
      tools: ["objective_create", "objective_view"],
      taskStore,
      objectiveStore,
      toolRegistry: objectiveToolRegistry,
    });

    const withoutPrepared = await withoutObjectives.prepareModelHistory(
      parent.id,
      [],
      "proactive",
    );
    const withPrepared = await withObjectives.prepareModelHistory(
      parent.id,
      [],
      "proactive",
    );

    expect(withPrepared.estimatedTokens ?? 0).toBeGreaterThan(
      (withoutPrepared.estimatedTokens ?? 0) + 100,
    );
  });

  it("prepares compressed model context without mutating canonical history", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", { id: "big" });

    // Seed enough messages to push the estimate over a 1K-token threshold.
    // Each user msg ~500 chars + each assistant ~500 chars = ~1000 chars
    // per turn ≈ 250 tokens per turn. 20 turns ≈ 5K tokens. Plus tools.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      })),
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );
    expect(prepared.compressed).toBe(true);
    expect(prepared.snapshotId).toBeTruthy();
    expect(prepared.modelHistory.length).toBeLessThan(seed.length);

    // Canonical history remains under the original session id, unchanged.
    expect(sessions.get(parent.id)?.parentSessionId).toBeNull();
    const postHistory = messages.getHistory(parent.id);
    expect(postHistory.map((m) => m.id)).toEqual(seed.map((m) => m.id));

    // The model-context projection contains the compaction summary.
    const hasSummary = prepared.modelHistory.some((m) => {
      if (m.role !== "user") return false;
      const first = m.parts[0] as { type?: string; text?: string };
      return (
        first.type === "text" &&
        (first.text ?? "").includes("[CONTEXT COMPACTION")
      );
    });
    expect(hasSummary).toBe(true);

    const snapshot = snapshots.get(prepared.snapshotId!);
    expect(snapshot?.canonicalMessageCount).toBe(seed.length);
    expect(snapshot?.sourceLastMessageId).toBe(seed[seed.length - 1]!.id);
    expect(snapshot?.modelMessages.length).toBe(prepared.modelHistory.length);
  });

  it("reports required compression failure without mutating canonical history", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "preflight-empty-summary" });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      })),
    );
    generateTextMock
      .mockResolvedValueOnce({ text: "## Active Task\nNone." })
      .mockResolvedValueOnce({ text: "" });

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    expect(prepared.compressionRequired).toBe(true);
    expect(prepared.compressed).toBe(false);
    expect(prepared.compressionFailureReason).toBe(
      "proactive_summarizer_failed",
    );
    expect(prepared.modelHistory).toBe(seed);
    expect(sessions.get(parent.id)?.parentSessionId).toBeNull();
    expect(messages.getHistory(parent.id).map((m) => m.id)).toEqual(
      seed.map((m) => m.id),
    );
  });

  it("retries a transient main-model summarizer failure before giving up", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", { id: "preflight-retry-transient" });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }

    generateTextMock
      .mockResolvedValueOnce({ text: "## Active Task\nNone." })
      .mockRejectedValueOnce(new Error("other side closed"))
      .mockResolvedValueOnce({ text: "## Active Task\nRecovered summary." });

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    expect(prepared.compressionRequired).toBe(true);
    expect(prepared.compressed).toBe(true);
    expect(prepared.compressionFailureReason).toBeUndefined();
    expect(prepared.modelHistory).not.toBe(seed);
    expect(
      generateTextMock.mock.calls.filter(
        ([arg]) =>
          arg?.experimental_telemetry?.functionId === "compression-summarizer",
      ),
    ).toHaveLength(2);
    expect(
      prepared.modelHistory.some((message) =>
        messageText(message).includes("Recovered summary."),
      ),
    ).toBe(true);
  });

  it("reuses a successful snapshot plus small canonical tail before fresh proactive compression", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-snapshot-fast-path",
    });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    const snapshotModelHistory: UIMessage[] = [
      {
        id: "snapshot-summary-fast",
        role: "user",
        parts: [
          {
            type: "text",
            text: "[CONTEXT COMPACTION] Existing successful summary",
          },
        ],
      } as UIMessage,
    ];
    const sourceLastMessageId = seed[37]!.id;
    snapshots.create({
      id: "snapshot-fast-ok",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: snapshotModelHistory,
      canonicalMessageCount: 38,
      sourceLastMessageId,
      summaryText: "Existing successful summary",
    });

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    const functionIds = generateTextMock.mock.calls.map(
      ([arg]) => arg?.experimental_telemetry?.functionId,
    );
    expect(functionIds).not.toContain("a1:memory-flush");
    expect(functionIds).not.toContain("compression-summarizer");
    expect(prepared.compressed).toBe(true);
    expect(prepared.compressionRequired).toBe(false);
    expect(prepared.modelHistory.map((message) => message.id)).toEqual([
      ...snapshotModelHistory.map((message) => message.id),
      ...seed.slice(38).map((message) => message.id),
    ]);
  });

  it("materializes an exact snapshot ledger when snapshot reuse adds canonical tail", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-snapshot-fast-path-ledger",
    });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    const snapshotModelHistory: UIMessage[] = [
      {
        id: "snapshot-ledger-summary",
        role: "user",
        parts: [
          {
            type: "text",
            text: "[CONTEXT COMPACTION] Existing ledger summary",
          },
        ],
      } as UIMessage,
    ];
    snapshots.create({
      id: "snapshot-ledger-source",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: snapshotModelHistory,
      canonicalMessageCount: 38,
      sourceLastMessageId: seed[37]!.id,
      summaryText: "Existing ledger summary",
    });

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    expect(prepared.snapshotId).toBeTruthy();
    expect(prepared.snapshotId).not.toBe("snapshot-ledger-source");
    const snapshot = snapshots.get(prepared.snapshotId!);
    expect(snapshot?.modelMessages).toEqual(prepared.modelHistory);
    expect(snapshot?.sourceLastMessageId).toBe(seed[seed.length - 1]!.id);
    expect(snapshot?.canonicalMessageCount).toBe(seed.length);
    expect(snapshot?.summaryText).toBe("Existing ledger summary");
    expect(snapshot?.summarySha256).toBeTruthy();
  });

  it("compresses an over-threshold snapshot projection instead of raw canonical history", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-snapshot-incremental-compression",
    });

    const seed: UIMessage[] = [];
    seed.push(bigUserMsg("raw-old-marker", 100));
    seed[0]!.parts = [
      {
        type: "text",
        text: "RAW_OLD_CONTEXT_SHOULD_NOT_BE_SENT_TO_INCREMENTAL_SUMMARIZER",
      },
    ];
    for (let i = 1; i < 24; i++) {
      seed.push(
        i % 2 === 0 ? bigUserMsg(`u${i}`, 500) : bigAssistantMsg(`a${i}`, 500),
      );
    }

    snapshots.create({
      id: "snapshot-incremental-source",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: [
        {
          id: "snapshot-incremental-summary",
          role: "user",
          parts: [
            {
              type: "text",
              text: "[CONTEXT COMPACTION] Existing incremental summary",
            },
          ],
        } as UIMessage,
      ],
      canonicalMessageCount: 10,
      sourceLastMessageId: seed[9]!.id,
      summaryText: "Existing incremental summary",
    });

    generateTextMock.mockImplementation(
      async (arg: {
        prompt?: string;
        experimental_telemetry?: { functionId?: string };
      }) => {
        if (arg.experimental_telemetry?.functionId === "a1:memory-flush") {
          return { text: "## Active Task\nNone." };
        }
        if (
          arg.experimental_telemetry?.functionId === "compression-summarizer"
        ) {
          expect(arg.prompt ?? "").not.toContain(
            "RAW_OLD_CONTEXT_SHOULD_NOT_BE_SENT_TO_INCREMENTAL_SUMMARIZER",
          );
          return { text: "## Active Task\nIncremental summary." };
        }
        throw new Error(
          `unexpected generateText call: ${
            arg.experimental_telemetry?.functionId ?? "none"
          }`,
        );
      },
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    expect(prepared.compressed).toBe(true);
    expect(prepared.compressionRequired).toBe(true);
    expect(
      prepared.modelHistory.some((message) =>
        messageText(message).includes("Incremental summary."),
      ),
    ).toBe(true);
  });

  it("selects same-second snapshots newest-first deterministically", () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-snapshot-same-second",
    });

    snapshots.create({
      id: "snapshot-older-same-second",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: [bigUserMsg("older-model", 10)],
      canonicalMessageCount: 1,
      sourceLastMessageId: "older-source",
      summaryText: "older",
    });
    snapshots.create({
      id: "snapshot-newer-same-second",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: [bigUserMsg("newer-model", 10)],
      canonicalMessageCount: 2,
      sourceLastMessageId: "newer-source",
      summaryText: "newer",
    });
    db.exec(
      "UPDATE session_context_snapshots SET created_at = 12345 WHERE session_id = 'preflight-snapshot-same-second'",
    );

    expect(snapshots.listForSession(parent.id).map((s) => s.id)).toEqual([
      "snapshot-newer-same-second",
      "snapshot-older-same-second",
    ]);
  });

  it("uses the latest successful snapshot plus canonical tail after retry exhaustion", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-snapshot-tail-fallback",
    });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    const snapshotModelHistory: UIMessage[] = [
      {
        id: "snapshot-summary",
        role: "user",
        parts: [
          {
            type: "text",
            text: "[CONTEXT COMPACTION] Existing successful summary",
          },
        ],
      } as UIMessage,
      bigAssistantMsg("snapshot-tail-assistant", 20),
    ];
    const sourceLastMessageId = seed[5]!.id;
    snapshots.create({
      id: "snapshot-ok",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: snapshotModelHistory,
      canonicalMessageCount: 6,
      sourceLastMessageId,
      summaryText: "Existing successful summary",
    });

    generateTextMock
      .mockResolvedValueOnce({ text: "## Active Task\nNone." })
      .mockRejectedValue(new Error("other side closed"));

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    const fallbackIds = prepared.modelHistory.map((message) => message.id);
    expect(prepared.compressionRequired).toBe(true);
    expect(prepared.compressed).toBe(true);
    expect(prepared.compressionFailureReason).toBeUndefined();
    expect(fallbackIds).toEqual([
      ...snapshotModelHistory.map((message) => message.id),
      ...seed.slice(6).map((message) => message.id),
    ]);
    expect(fallbackIds).not.toEqual(seed.map((message) => message.id));
  });

  it("emergency-summarizes snapshot plus tail when fallback history still exceeds budget", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const snapshots = createContextSnapshotStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-emergency-summary",
    });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 30; i++) {
      seed.push(bigUserMsg(`u${i}`, 2_000));
      seed.push(bigAssistantMsg(`a${i}`, 2_000));
    }
    snapshots.create({
      id: "snapshot-still-too-large",
      sessionId: parent.id,
      reason: "proactive",
      compressed: true,
      modelMessages: [
        {
          id: "snapshot-summary",
          role: "user",
          parts: [
            {
              type: "text",
              text: "[CONTEXT COMPACTION] Existing successful summary",
            },
          ],
        } as UIMessage,
      ],
      canonicalMessageCount: 2,
      sourceLastMessageId: seed[1]!.id,
      summaryText: "Existing successful summary",
    });

    generateTextMock.mockImplementation(
      async (arg: {
        prompt?: string;
        experimental_telemetry?: { functionId?: string };
      }) => {
        if (arg.experimental_telemetry?.functionId === "a1:memory-flush") {
          return { text: "## Active Task\nNone." };
        }
        const prompt = arg.prompt ?? "";
        if (
          prompt.includes("Reference Files Read") &&
          prompt.includes("re-open the referenced source")
        ) {
          return {
            text:
              "## Active Task\nContinue.\n\n" +
              "## Reference Files Read\n- /tmp/example.ts — reason: test fixture\n\n" +
              "If file/log-specific detail matters and is not explicit here, re-open the referenced source before acting.",
          };
        }
        throw new Error("other side closed");
      },
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    const prompts = generateTextMock.mock.calls.map(
      ([arg]) => arg?.prompt ?? "",
    );
    const emergencyPrompt = prompts.find(
      (prompt) =>
        prompt.includes("Reference Files Read") &&
        prompt.includes("re-open the referenced source"),
    );
    expect(prepared.compressionRequired).toBe(true);
    expect(prepared.compressed).toBe(true);
    expect(prepared.compressionFailureReason).toBeUndefined();
    expect(emergencyPrompt).toBeDefined();
    expect(prepared.modelHistory.map((message) => message.id)).not.toEqual(
      seed.map((message) => message.id),
    );
    expect(
      prepared.modelHistory.some((message) =>
        messageText(message).includes("Reference Files Read"),
      ),
    ).toBe(true);
  });

  it("emergency-summarizes after a successful compression that remains over the hard budget", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-successful-compression-still-oversize",
    });

    const seed: UIMessage[] = [
      bigUserMsg("protected-huge-u", 40_000),
      bigAssistantMsg("old-a", 8_000),
      bigUserMsg("old-u", 8_000),
      bigAssistantMsg("old-a-2", 8_000),
      bigUserMsg("old-u-2", 8_000),
      bigAssistantMsg("tail-a", 500),
      bigUserMsg("tail-u", 500),
    ];

    getEffectiveContextWindowMock.mockReturnValue(5_000);
    generateTextMock.mockImplementation(
      async (arg: {
        prompt?: string;
        experimental_telemetry?: { functionId?: string };
      }) => {
        const functionId = arg.experimental_telemetry?.functionId;
        if (functionId === "a1:memory-flush") {
          return { text: "## Active Task\nNone." };
        }
        if (functionId === "compression-summarizer") {
          return { text: "## Active Task\nNormal compression succeeded." };
        }
        if (functionId === "compression-emergency-summarizer") {
          return {
            text:
              "## Active Task\nContinue.\n\n" +
              "## Reference Files Read\n- /tmp/oversize.ts - reason: test fixture\n\n" +
              "If file/log-specific detail matters and is not explicit here, re-open the referenced source before acting.",
          };
        }
        throw new Error(
          `unexpected generateText call: ${functionId ?? "none"}`,
        );
      },
    );

    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    const functionIds = generateTextMock.mock.calls.map(
      ([arg]) => arg?.experimental_telemetry?.functionId,
    );
    expect(functionIds).toContain("compression-summarizer");
    expect(functionIds).toContain("compression-emergency-summarizer");
    expect(prepared.compressionRequired).toBe(true);
    expect(prepared.compressed).toBe(true);
    expect(prepared.estimatedTokens ?? Number.POSITIVE_INFINITY).toBeLessThan(
      5_000,
    );
    expect(
      prepared.modelHistory.some((message) =>
        messageText(message).includes("Reference Files Read"),
      ),
    ).toBe(true);
  });

  it("recovers from provider context_length_exceeded with reactive compression instead of resending raw history", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", {
      id: "provider-overflow-reactive-recovery",
    });

    const seed: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      seed.push(bigUserMsg(`u${i}`, 500));
      seed.push(bigAssistantMsg(`a${i}`, 500));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      })),
    );

    generateTextMock.mockResolvedValue({ text: "## Active Task\nRecovered." });
    streamTextMock
      .mockImplementationOnce(() => {
        throw contextLengthExceededError();
      })
      .mockReturnValueOnce(successfulAssistantStream("recovered"));
    const broadcasts: Array<{
      sessionId: string;
      event: Parameters<AutonomousBroadcaster["broadcast"]>[1];
    }> = [];
    const broadcaster: AutonomousBroadcaster = {
      broadcast(sessionId, event) {
        broadcasts.push({ sessionId, event });
      },
    };

    const agent = makeAgent({
      db,
      // Keep proactive preflight off so the test exercises actual
      // provider-side overflow and the reactive recovery path.
      thresholdTokens: 10_000,
      protectFirstN: 1,
      tailTokenBudget: 200,
      broadcaster,
    });

    await expect(
      agent.runAutonomous({ sessionId: parent.id }),
    ).resolves.toEqual(
      expect.objectContaining({
        assistant: expect.objectContaining({ id: "assistant-ok" }),
      }),
    );

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    const firstMessages = streamTextMock.mock.calls[0]![0]!
      .messages as unknown[];
    const secondMessages = streamTextMock.mock.calls[1]![0]!
      .messages as unknown[];
    expect(JSON.stringify(firstMessages)).not.toContain("[CONTEXT COMPACTION");
    expect(JSON.stringify(secondMessages)).toContain("[CONTEXT COMPACTION");
    expect(JSON.stringify(secondMessages)).not.toEqual(
      JSON.stringify(firstMessages),
    );
    const statusEvents = broadcasts
      .map((broadcast) => broadcast.event)
      .filter(
        (
          event,
        ): event is {
          kind: "ui_message_part";
          part: {
            type?: string;
            data?: { id?: string; kind?: string; message?: string };
          };
        } =>
          event.kind === "ui_message_part" &&
          typeof event.part === "object" &&
          event.part !== null &&
          (event.part as { type?: unknown }).type === "data-status",
      )
      .map((event) => event.part.data);
    expect(statusEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "compressing",
          message: "Context limit hit. Compacting and retrying...",
        }),
        expect.objectContaining({
          kind: "info",
          message: "",
        }),
      ]),
    );
  });

  it("does not continue autonomous turns with raw history after preflight failure", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", {
      id: "autonomous-preflight-failure",
    });
    const agent = makeAgent({
      db,
      thresholdTokens: 1,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const runStreamSpy = vi.spyOn(agent, "runStream");
    vi.spyOn(agent, "prepareModelHistory").mockRejectedValue(
      new Error("preflight exploded"),
    );

    await expect(
      agent.runAutonomous({ sessionId: parent.id }),
    ).rejects.toThrow();
    expect(runStreamSpy).not.toHaveBeenCalled();
  });

  it("does not require compression when only the base request crosses threshold", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", { id: "preflight-too-short" });
    const seed: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    ];

    const agent = makeAgent({
      db,
      thresholdTokens: 1,
      protectFirstN: 1,
      tailTokenBudget: 200,
    });
    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );

    expect(prepared.compressionRequired).toBe(false);
    expect(prepared.compressed).toBe(false);
    expect(prepared.compressionFailureReason).toBeUndefined();
    expect(prepared.modelHistory).toBe(seed);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("estimates preflight size with the same effective tool filter as the provider call", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const parent = sessions.create("a1", {
      id: "preflight-effective-tool-filter",
    });
    const toolRegistry = {
      get: () => undefined,
      getVercelTools: (names: ReadonlySet<string>) =>
        Object.fromEntries(
          [...names].map((name) => [
            name,
            {
              description:
                name === "heavy_tool" ? "h".repeat(20_000) : "small tool",
            },
          ]),
        ),
    } as unknown as ToolRegistry;
    const agent = makeAgent({
      db,
      thresholdTokens: 1000,
      protectFirstN: 1,
      tailTokenBudget: 200,
      tools: ["small_tool", "heavy_tool"],
      toolRegistry,
    });
    const history: UIMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(
        i % 2 === 0
          ? bigUserMsg(`filtered-u-${i}`, 80)
          : bigAssistantMsg(`filtered-a-${i}`, 80),
      );
    }

    const prepared = await agent.prepareModelHistory(
      parent.id,
      history,
      "proactive",
      { toolFilter: new Set(["small_tool"]) },
    );

    expect(prepared.compressionRequired).toBe(false);
    expect(prepared.compressed).toBe(false);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("matches the aux-failure compression decision matrix", async () => {
    type MatrixCase = {
      name: string;
      history: UIMessage[];
      expectedAttempt: boolean;
      expectedFailureReason?: string;
      expectedRawTurnMayProceed: boolean;
    };
    const turns = (
      count: number,
      charsPerMessage: number,
      prefix: string,
    ): UIMessage[] => {
      const out: UIMessage[] = [];
      for (let i = 0; i < count; i++) {
        out.push(bigUserMsg(`${prefix}-u-${i}`, charsPerMessage));
        out.push(bigAssistantMsg(`${prefix}-a-${i}`, charsPerMessage));
      }
      return out;
    };
    const cases: MatrixCase[] = [
      {
        name: "aux fail + very short single message",
        history: [bigUserMsg("short-u", 2)],
        expectedAttempt: false,
        expectedRawTurnMayProceed: true,
      },
      {
        name: "aux fail + normal single message",
        history: [bigUserMsg("normal-u", 1_200)],
        expectedAttempt: false,
        expectedRawTurnMayProceed: true,
      },
      {
        name: "aux fail + very long single message",
        history: [bigUserMsg("huge-u", 300_000)],
        expectedAttempt: false,
        expectedRawTurnMayProceed: true,
      },
      {
        name: "aux fail + small old history and huge latest message",
        history: [
          bigUserMsg("small-old-u", 20),
          bigAssistantMsg("small-old-a", 20),
          bigUserMsg("huge-latest-u", 300_000),
        ],
        expectedAttempt: false,
        expectedRawTurnMayProceed: true,
      },
      {
        name: "aux fail + normal length multi-turn history",
        history: turns(8, 500, "normal-multi"),
        expectedAttempt: true,
        expectedFailureReason: "proactive_summarizer_failed",
        expectedRawTurnMayProceed: false,
      },
      {
        name: "aux fail + medium 50-turn history",
        history: turns(50, 300, "medium-50"),
        expectedAttempt: true,
        expectedFailureReason: "proactive_summarizer_failed",
        expectedRawTurnMayProceed: false,
      },
      {
        name: "aux fail + large old history and small latest message",
        history: [
          ...turns(30, 800, "large-old"),
          bigUserMsg("small-latest-u", 20),
        ],
        expectedAttempt: true,
        expectedFailureReason: "proactive_summarizer_failed",
        expectedRawTurnMayProceed: false,
      },
      {
        name: "aux fail + tool-heavy old history",
        history: turns(20, 900, "tool-heavy").map((message, index) =>
          message.role === "assistant"
            ? {
                ...message,
                parts: [
                  {
                    type: "text",
                    text: `tool-result-${index}\n${"z".repeat(900)}`,
                  },
                ],
              }
            : message,
        ) as UIMessage[],
        expectedAttempt: true,
        expectedFailureReason: "proactive_summarizer_failed",
        expectedRawTurnMayProceed: false,
      },
    ];

    const observedRows: Array<{
      name: string;
      expectedAttempt: boolean;
      observedAttempt: boolean;
      expectedFailureReason: string | null;
      observedFailureReason: string | null;
      expectedRawTurnMayProceed: boolean;
      observedRawTurnMayProceed: boolean;
      matches: boolean;
    }> = [];

    for (const [index, item] of cases.entries()) {
      generateTextMock.mockReset();
      generateTextMock
        .mockResolvedValueOnce({ text: "## Active Task\nNone." })
        .mockResolvedValueOnce({ text: "" });
      const db = freshDb();
      const sessions = createSessionStore(db);
      const parent = sessions.create("a1", { id: `matrix-${index}` });
      const agent = makeAgent({
        db,
        thresholdTokens: 1,
        protectFirstN: 1,
        tailTokenBudget: 200,
      });
      const prepared = await agent.prepareModelHistory(
        parent.id,
        item.history,
        "proactive",
      );
      const observedAttempt = prepared.compressionRequired;
      const observedFailureReason = prepared.compressionFailureReason ?? null;
      const observedRawTurnMayProceed =
        !prepared.compressionRequired ||
        (prepared.compressed && !prepared.compressionFailureReason);
      const expectedFailureReason = item.expectedFailureReason ?? null;
      const matches =
        observedAttempt === item.expectedAttempt &&
        observedFailureReason === expectedFailureReason &&
        observedRawTurnMayProceed === item.expectedRawTurnMayProceed;
      observedRows.push({
        name: item.name,
        expectedAttempt: item.expectedAttempt,
        observedAttempt,
        expectedFailureReason,
        observedFailureReason,
        expectedRawTurnMayProceed: item.expectedRawTurnMayProceed,
        observedRawTurnMayProceed,
        matches,
      });

      expect(
        observedAttempt,
        `${item.name}: compression attempt mismatch`,
      ).toBe(item.expectedAttempt);
      expect(
        observedFailureReason,
        `${item.name}: failure reason mismatch`,
      ).toBe(expectedFailureReason);
      expect(
        observedRawTurnMayProceed,
        `${item.name}: raw turn continuation mismatch`,
      ).toBe(item.expectedRawTurnMayProceed);
      expect(
        generateTextMock.mock.calls.length > 0,
        `${item.name}: aux call mismatch`,
      ).toBe(item.expectedAttempt);
    }

    console.info(
      `COMPRESSION_AUX_FAILURE_MATRIX ${JSON.stringify(observedRows)}`,
    );
    expect(observedRows.every((row) => row.matches)).toBe(true);
  });

  it("uses the effective context window override when the 1M-latch is on", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "latched" });

    // Seed ~130K rough tokens (520K chars at chars/4): big enough to
    // cross 50% × 200K = 100K when the latch lowers the effective
    // window, but well UNDER 50% × 1M = 500K with the registry value.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 13; i++) {
      seed.push(bigUserMsg(`u${i}`, 20_000));
      seed.push(bigAssistantMsg(`a${i}`, 20_000));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      })),
    );

    // Latch ON: getEffectiveContextWindow returns 200K. Threshold becomes
    // 50% × 200K = 100K — seed (~130K) crosses it.
    getEffectiveContextWindowMock.mockReturnValue(200_000);

    const agent = makeAgent({
      db,
      thresholdTokens: null,
      thresholdPercent: 0.5,
      contextWindow: 1_000_000, // registry value — would normally give 500K threshold
      protectFirstN: 1,
      tailTokenBudget: 1_000,
    });

    const prepared = await agent.prepareModelHistory(
      parent.id,
      seed,
      "proactive",
    );
    expect(prepared.compressed).toBe(true);
    expect(prepared.modelHistory.length).toBeLessThan(seed.length);
    expect(sessions.get(parent.id)?.parentSessionId).toBeNull();
    expect(getEffectiveContextWindowMock).toHaveBeenCalled();
  });

  it("does NOT fork the same session when the latch is OFF and 1M threshold isn't crossed", async () => {
    const db = freshDb();
    const sessions = createSessionStore(db);
    const messages = createMessageStore(db);
    const parent = sessions.create("a1", { id: "ok" });

    // Same seed as the latch test — ~130K rough tokens.
    const seed: UIMessage[] = [];
    for (let i = 0; i < 13; i++) {
      seed.push(bigUserMsg(`u${i}`, 20_000));
      seed.push(bigAssistantMsg(`a${i}`, 20_000));
    }
    messages.appendMany(
      parent.id,
      seed.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        parts: m.parts,
      })),
    );

    // Latch OFF: full 1M window in play. Threshold = 500K. 130K is well under.
    getEffectiveContextWindowMock.mockReturnValue(1_000_000);

    const agent = makeAgent({
      db,
      thresholdTokens: null,
      thresholdPercent: 0.5,
      contextWindow: 1_000_000,
      protectFirstN: 1,
      tailTokenBudget: 1_000,
    });

    const newId = await agent.preflightCompress(parent.id, seed);
    expect(newId).toBe(parent.id);
    // No compaction occurred — the active row did not get re-pointed.
    expect(sessions.get(parent.id)?.parentSessionId).toBeNull();
  });
});
