import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySchema,
  WasmDatabase,
  createSessionStore,
  createMessageStore,
  createInboxStore,
} from "@openacme/db";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import type { ToolRegistry } from "@openacme/tools";
import type { UIMessage } from "ai";
import { Agent } from "../src/agent.js";
import type { AgentConfig } from "../src/types.js";

const { streamTextMock, getModelMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  getModelMock: vi.fn(() => ({})),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: streamTextMock,
  };
});

vi.mock("@openacme/llm-provider", () => ({
  getModel: getModelMock,
  getEffectiveContextWindow: () => null,
  resolveSubagentModel: (m: unknown) => m,
  supportsToolResultMedia: () => false,
  getActiveTraceContext: () => null,
  getAIForensicContext: () => undefined,
  getAIForensicProviderRequestCount: () => 1,
  buildForensicLocatorAttributes: () => ({}),
  setAIForensicContext: vi.fn(),
  enterAIForensicContext: (_ctx: unknown, fn: () => unknown) => fn(),
  createForensicRecorder: () => ({
    enabled: false,
    recordEvent: vi.fn(),
    writeRawFile: vi.fn(),
  }),
  withOpenAcmeSpan: (_name: string, _attrs: unknown, fn: (span: unknown) => unknown) =>
    fn({ traceId: "trace-helper", spanId: "span-helper" }),
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

const OLD_INPUTS = process.env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"];
const OLD_OUTPUTS = process.env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"];

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

function makeAgent(): Agent {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-telemetry-"));
  const db = freshDb();
  const sessionStore = createSessionStore(db);
  const messageStore = createMessageStore(db);
  const config: AgentConfig = {
    id: "agent-a",
    name: "Agent A",
    model: {
      provider: "openai",
      model: "gpt-5.5",
      auth: "oauth",
    },
    persona: "test",
    tools: [],
    maxSteps: 5,
    workspaceDir: path.join(tmpRoot, "workspace"),
  };
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  return new Agent(config, {
    sessionStore,
    messageStore,
    toolRegistry: stubToolRegistry,
    attachmentsRoot: path.join(tmpRoot, "attachments"),
    memoryStore: new MemoryStore(path.join(tmpRoot, "agents")),
    taskStore: new TaskStore(path.join(tmpRoot, "tasks")),
    inboxStore: createInboxStore(db),
  });
}

describe("Agent.runStream telemetry", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
    process.env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"] = "1";
    delete process.env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"];
    streamTextMock.mockReturnValue({ usage: Promise.resolve({}) });
  });

  afterEach(() => {
    if (OLD_INPUTS === undefined) delete process.env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"];
    else process.env["OPENACME_AI_TELEMETRY_RECORD_INPUTS"] = OLD_INPUTS;
    if (OLD_OUTPUTS === undefined) delete process.env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"];
    else process.env["OPENACME_AI_TELEMETRY_RECORD_OUTPUTS"] = OLD_OUTPUTS;
  });

  it("passes correlation metadata and capture flags to streamText", async () => {
    const agent = makeAgent();
    const history: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      } as UIMessage,
    ];

    await agent.runStream({
      sessionId: "sess-1",
      history,
      usage: {
        kind: "autonomous",
        taskId: "task-1",
        messageId: "msg-1",
      },
      telemetryFunctionId: "custom-function",
    });

    const call = streamTextMock.mock.calls[0]![0]!;
    expect(call.experimental_telemetry).toMatchObject({
      isEnabled: true,
      recordInputs: true,
      recordOutputs: false,
      functionId: "custom-function",
      metadata: {
        agentId: "agent-a",
        sessionId: "sess-1",
        taskId: "task-1",
        messageId: "msg-1",
        kind: "autonomous",
        provider: "openai",
        model: "gpt-5.5",
        authMode: "oauth",
      },
    });
    expect(call.experimental_telemetry.metadata.forensicRunId).toMatch(
      /^[0-9a-f-]{36}$/
    );
  });
});
