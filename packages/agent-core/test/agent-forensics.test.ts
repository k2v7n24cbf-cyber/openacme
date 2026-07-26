import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createForensicRecorder } from "@openacme/llm-provider";
import { Agent } from "../src/agent.js";
import type { AgentConfig, UsageReport } from "../src/types.js";

const { streamTextMock, getModelMock, startOpenAcmeSpanMock, spanEndMock } =
  vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  getModelMock: vi.fn(() => ({})),
  spanEndMock: vi.fn(),
  startOpenAcmeSpanMock: vi.fn(() => ({
    traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef",
    sampled: true,
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    recordException: vi.fn(),
    setStatusOk: vi.fn(),
    setStatusError: vi.fn(),
    end: spanEndMock,
    run: (fn: () => unknown) => fn(),
  })),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: streamTextMock,
  };
});

vi.mock("@openacme/llm-provider", async () => {
  const actual = await vi.importActual<typeof import("@openacme/llm-provider")>(
    "@openacme/llm-provider"
  );
  return {
    ...actual,
    buildForensicLocatorAttributes: (args: {
      forensicRunId?: string;
      sessionId?: string;
      eventType: string;
      selector?: string;
      eventSelector?: string;
      relativeEvidenceDir?: string;
    }) => {
      if (!args.forensicRunId) return {};
      const selector = args.selector ? `:${args.selector}` : "";
      const out: Record<string, string> = {
        "openacme.forensic.lookup": "usage_events.forensic_run_id",
        "openacme.forensic.evidence_ref":
          `openacme://forensics/${args.forensicRunId}#${args.eventType}${selector}`,
      };
      if (args.eventSelector) {
        out["openacme.forensic.event_selector"] = args.eventSelector;
      }
      if (args.relativeEvidenceDir) {
        out["openacme.forensic.relative_evidence_dir"] =
          args.relativeEvidenceDir;
      }
      if (args.sessionId) {
        out["openacme.session.timeline_locator"] =
          `/api/sessions/${args.sessionId}/timeline?includeForensics=1&forensicRunId=${args.forensicRunId}`;
      }
      return out;
    },
    getModel: getModelMock,
    getEffectiveContextWindow: () => null,
    resolveSubagentModel: (m: unknown) => m,
    supportsToolResultMedia: () => false,
    startOpenAcmeSpan: startOpenAcmeSpanMock,
  };
});

const OLD_FORENSICS = process.env["OPENACME_AI_FORENSICS"];
const OLD_FORENSICS_DIR = process.env["OPENACME_AI_FORENSICS_DIR"];
const OLD_FORENSICS_RAW = process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"];

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

function makeAgent(
  tmpRoot: string,
  onUsage?: (report: UsageReport) => void
): Agent {
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
    onUsage,
  });
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Agent.runStream forensics", () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    getModelMock.mockReset();
    getModelMock.mockReturnValue({});
    startOpenAcmeSpanMock.mockClear();
    spanEndMock.mockClear();
  });

  afterEach(() => {
    if (OLD_FORENSICS === undefined) delete process.env["OPENACME_AI_FORENSICS"];
    else process.env["OPENACME_AI_FORENSICS"] = OLD_FORENSICS;
    if (OLD_FORENSICS_DIR === undefined) delete process.env["OPENACME_AI_FORENSICS_DIR"];
    else process.env["OPENACME_AI_FORENSICS_DIR"] = OLD_FORENSICS_DIR;
    if (OLD_FORENSICS_RAW === undefined) delete process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"];
    else process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"] = OLD_FORENSICS_RAW;
  });

  it("creates an agent run archive and propagates forensic context into streamText", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-agent-forensics-"));
    const forensicsRoot = path.join(tmpRoot, "ai-forensics");
    process.env["OPENACME_AI_FORENSICS"] = "1";
    process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"] = "1";
    process.env["OPENACME_AI_FORENSICS_DIR"] = forensicsRoot;

    streamTextMock.mockImplementation((args) => {
      const recorder = createForensicRecorder();
      recorder.recordEvent("inside.streamText");
      args.onFinish?.({
        totalUsage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
        },
        steps: [{ usage: {} }],
      });
      return { usage: Promise.resolve({}) };
    });

    const usageReports: UsageReport[] = [];
    const agent = makeAgent(tmpRoot, (report) => usageReports.push(report));
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
      usage: { kind: "interactive", messageId: "msg-1" },
    });

    const telemetry = streamTextMock.mock.calls[0]![0]!.experimental_telemetry;
    const runId = telemetry.metadata.forensicRunId;
    const runDir = path.join(
      forensicsRoot,
      new Date().toISOString().slice(0, 10),
      runId
    );
    const events = readJsonl(path.join(runDir, "events.jsonl"));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "agent.run.start",
        "agent.model_input.snapshot",
        "inside.streamText",
      ])
    );
    expect(events.every((e) => e.forensicRunId === runId)).toBe(true);
    expect(
      fs.existsSync(path.join(runDir, "agent/model-input.messages.json"))
    ).toBe(true);
    expect(usageReports).toHaveLength(1);
    expect(usageReports[0]).toMatchObject({
      forensicRunId: runId,
      forensicPath: runDir,
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    });
    expect(startOpenAcmeSpanMock).toHaveBeenCalledWith(
      "openacme.agent.turn",
      expect.objectContaining({
        "openacme.forensic.run_id": runId,
        "openacme.forensic.lookup": "usage_events.forensic_run_id",
        "openacme.forensic.evidence_ref":
          `openacme://forensics/${runId}#agent.run`,
        "openacme.forensic.event_selector": "type=agent.run.start",
        "openacme.session.timeline_locator":
          `/api/sessions/sess-1/timeline?includeForensics=1&forensicRunId=${runId}`,
        "openacme.agent.id": "agent-a",
        "openacme.session.id": "sess-1",
        "openacme.message.id": "msg-1",
      })
    );
    const spanAttrs = startOpenAcmeSpanMock.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(
      Object.keys(spanAttrs ?? {}).filter((key) => key.startsWith("langfuse."))
    ).toEqual([]);
    expect(spanEndMock).toHaveBeenCalledTimes(1);
  });
});
