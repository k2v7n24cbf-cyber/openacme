import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/registry.js";
import {
  bindToolObservation,
  type ToolObservationSpan,
  type ToolObservationSink,
} from "../src/observation.js";
import type { ToolResultClassifier } from "../src/types.js";
import {
  toolCallContext,
  type ToolCallContext,
} from "../src/session-context.js";
import { bindToolHost } from "../src/tool-host-binding.js";

const CTX: ToolCallContext = {
  sessionId: "sess-1",
  agentId: "agent-1",
  workspaceDir: "/tmp/openacme-agent/workspace",
};

type ObservationEvent = { type: string; data?: Record<string, unknown> };
type RawWrite = { relativePath: string; text: string };
type SpanRecord = {
  name: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  setAttributes: Record<string, unknown>[];
  errors: unknown[];
  status: "ok" | "error" | null;
};
type Execute = (
  args: Record<string, unknown>,
  opts?: { toolCallId?: string },
) => Promise<string>;

let events: ObservationEvent[];
let rawWrites: RawWrite[];
let spans: SpanRecord[];

function makeSink(): ToolObservationSink {
  return {
    recordEvent: vi.fn((type: string, data?: Record<string, unknown>) => {
      events.push({ type, data });
    }),
    writeRawFile: vi.fn((relativePath: string, data: string | Buffer) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf-8") : data;
      rawWrites.push({ relativePath, text });
      return {
        relativePath,
        byteLength: Buffer.byteLength(text, "utf-8"),
        sha256: "stub",
      };
    }),
  };
}

function makeSpan(record: SpanRecord): ToolObservationSpan {
  return {
    traceId: "trace-tool",
    spanId: "span-tool",
    setAttributes: vi.fn((attributes) => {
      record.setAttributes.push(attributes);
    }),
    addEvent: vi.fn((name, attributes) => {
      record.events.push({ name, attributes });
    }),
    recordException: vi.fn((error) => {
      record.errors.push(error);
    }),
    setStatusOk: vi.fn(() => {
      record.status = "ok";
    }),
    setStatusError: vi.fn(() => {
      record.status = "error";
    }),
  };
}

function executeOf(reg: ToolRegistry, name = "echo"): Execute {
  const tools = reg.getVercelTools();
  return (tools[name] as { execute: Execute }).execute;
}

function makeRegistry(
  opts: {
    runtime?: "daemon" | "worker";
    result?: string;
    throwError?: Error;
    classifyResult?: ToolResultClassifier;
    maxResultSizeChars?: number;
  } = {},
) {
  const reg = new ToolRegistry();
  reg.register({
    name: "echo",
    toolset: "test",
    description: "echo",
    runtime: opts.runtime,
    maxResultSizeChars: opts.maxResultSizeChars,
    classifyResult: opts.classifyResult,
    parameters: z.object({ msg: z.string() }),
    handler: async (args) => {
      if (opts.throwError) throw opts.throwError;
      return opts.result ?? `echo:${(args as { msg: string }).msg}`;
    },
  });
  return reg;
}

beforeEach(() => {
  events = [];
  rawWrites = [];
  spans = [];
  bindToolObservation({
    getSink: () => makeSink(),
    locatorAttributes: ({ eventType, toolCallId, relativeEvidenceDir }) => ({
      "openacme.forensic.lookup": "usage_events.forensic_run_id",
      "openacme.forensic.evidence_ref": `openacme://forensics/run-tool#${eventType}:${toolCallId}`,
      "openacme.forensic.event_selector": `type=${eventType} toolCallId=${toolCallId}`,
      "openacme.forensic.relative_evidence_dir": relativeEvidenceDir,
    }),
    withSpan: async (name, attributes, fn) => {
      const record: SpanRecord = {
        name,
        attributes,
        events: [],
        setAttributes: [],
        errors: [],
        status: null,
      };
      spans.push(record);
      return await fn(makeSpan(record));
    },
  });
});

afterEach(() => {
  bindToolObservation(null);
  bindToolHost(null as never);
});

describe("tool observations", () => {
  it("records tool args and result facts without changing output", async () => {
    const execute = executeOf(makeRegistry());

    const output = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "hello" }, { toolCallId: "call-1" }),
    );

    expect(output).toBe("echo:hello");
    expect(events.map((event) => event.type)).toEqual([
      "tool.start",
      "tool.finish",
    ]);
    expect(events[0]!.data).toMatchObject({
      toolName: "echo",
      toolset: "test",
      toolCallId: "call-1",
      runtime: "daemon",
      traceId: "trace-tool",
      spanId: "span-tool",
      argsBytes: 20,
      evidenceRef: "openacme://forensics/run-tool#tool.start:call-1",
      eventSelector: "type=tool.start toolCallId=call-1",
      relativeEvidenceDir: "tool-calls/call-1",
    });
    expect(events[0]!.data?.["argsSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(events[1]!.data).toMatchObject({
      toolName: "echo",
      toolCallId: "call-1",
      workerDispatched: false,
      spilled: false,
      traceId: "trace-tool",
      spanId: "span-tool",
      resultPreSpillBytes: 10,
      resultPostSpillBytes: 10,
      evidenceRef: "openacme://forensics/run-tool#tool.finish:call-1",
      eventSelector: "type=tool.finish toolCallId=call-1",
      relativeEvidenceDir: "tool-calls/call-1",
    });
    expect(spans[0]).toMatchObject({
      name: "openacme.tool.execute",
      attributes: {
        "openacme.span.type": "tool_execute",
        "openacme.tool.name": "echo",
        "openacme.toolset": "test",
        "openacme.tool.call_id": "call-1",
        "openacme.tool.runtime": "daemon",
        "openacme.forensic.evidence_ref":
          "openacme://forensics/run-tool#tool.execute:call-1",
      },
      status: "ok",
    });
    expect(spans[0]!.setAttributes[0]).toMatchObject({
      "openacme.tool.result_pre_spill_bytes": 10,
      "openacme.tool.result_post_spill_bytes": 10,
      "openacme.tool.spilled": false,
    });
    expect(events[1]!.data?.["resultPreSpillSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(rawWrites.map((write) => write.relativePath)).toEqual([
      "tool-calls/call-1/args.json",
      "tool-calls/call-1/result.pre-spill.txt",
      "tool-calls/call-1/result.post-spill.txt",
    ]);
  });

  it("records spill facts for large local tool results", async () => {
    const body = "A".repeat(40_000);
    const execute = executeOf(
      makeRegistry({ result: body, maxResultSizeChars: 100 }),
    );

    const output = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "large" }, { toolCallId: "call-large" }),
    );

    expect(output).toContain("[overflow:");
    const finish = events.find((event) => event.type === "tool.finish")!;
    expect(finish.data).toMatchObject({
      spilled: true,
      resultPreSpillBytes: 40_000,
    });
    expect(String(finish.data?.["spillPath"])).toContain("/tool-calls/");
    expect(
      rawWrites.find((write) =>
        write.relativePath.endsWith("result.pre-spill.txt"),
      )?.text,
    ).toBe(body);
  });

  it("records worker-dispatched tool results at the daemon boundary", async () => {
    bindToolHost({
      dispatch: async () => JSON.stringify({ viaWorker: true }),
    });
    const execute = executeOf(makeRegistry({ runtime: "worker" }));

    const output = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "remote" }, { toolCallId: "call-worker" }),
    );

    expect(JSON.parse(output)).toEqual({ viaWorker: true });
    const finish = events.find((event) => event.type === "tool.finish")!;
    expect(finish.data).toMatchObject({
      toolName: "echo",
      toolCallId: "call-worker",
      runtime: "worker",
      workerDispatched: true,
      resultPostSpillBytes: 18,
    });
    expect(finish.data?.["resultPreSpillBytes"]).toBeUndefined();
  });

  it("records tool-specific logical failure classification without changing output", async () => {
    const logicalFailure = JSON.stringify({
      success: false,
      error: "Command exited with code 7",
      exitCode: 7,
    });
    const execute = executeOf(
      makeRegistry({
        result: logicalFailure,
        classifyResult: () => ({
          resultStatus: "failure",
          resultClassifier: "custom-command",
          failureKind: "command_exit_nonzero",
          failureMessage: "Command exited with code 7",
          exitCode: 7,
          outcomeAttributes: { command_family: "shell" },
        }),
      }),
    );

    const output = await toolCallContext.run({ ...CTX }, () =>
      execute({ msg: "bad command" }, { toolCallId: "call-logical-failure" }),
    );

    expect(output).toBe(logicalFailure);
    expect(events.map((event) => event.type)).toEqual([
      "tool.start",
      "tool.finish",
    ]);
    const finish = events.find((event) => event.type === "tool.finish")!;
    expect(finish.data).toMatchObject({
      toolName: "echo",
      toolCallId: "call-logical-failure",
      executionStatus: "ok",
      resultStatus: "failure",
      resultClassifier: "custom-command",
      failureKind: "command_exit_nonzero",
      failureMessage: "Command exited with code 7",
      exitCode: 7,
      outcomeAttributes: { command_family: "shell" },
    });
    expect(spans[0]!.status).toBe("error");
    expect(spans[0]!.setAttributes.at(-1)).toMatchObject({
      "openacme.tool.execution_status": "ok",
      "openacme.tool.result_status": "failure",
      "openacme.tool.result_classifier": "custom-command",
      "openacme.tool.failure_kind": "command_exit_nonzero",
      "openacme.tool.failure_message": "Command exited with code 7",
      "openacme.tool.exit_code": 7,
      "openacme.tool.outcome.command_family": "shell",
    });
    expect(spans[0]!.events).toEqual([
      {
        name: "openacme.tool.logical_failure",
        attributes: {
          "openacme.tool.failure_kind": "command_exit_nonzero",
          "openacme.tool.failure_message": "Command exited with code 7",
        },
      },
    ]);
  });

  it("records tool errors and rethrows the original error", async () => {
    const boom = new TypeError("boom");
    const execute = executeOf(makeRegistry({ throwError: boom }));

    await expect(
      toolCallContext.run({ ...CTX }, () =>
        execute({ msg: "bad" }, { toolCallId: "call-error" }),
      ),
    ).rejects.toBe(boom);

    expect(events.map((event) => event.type)).toEqual([
      "tool.start",
      "tool.error",
    ]);
    expect(events[1]!.data).toMatchObject({
      toolName: "echo",
      toolCallId: "call-error",
      executionStatus: "error",
      resultStatus: "failure",
      resultClassifier: "exception",
      failureKind: "handler_exception",
      errorName: "TypeError",
      errorMessage: "boom",
    });
    expect(spans[0]!.errors).toEqual([boom]);
    expect(spans[0]!.status).toBe("error");
  });

  it("does not let observation sink failures break tool execution", async () => {
    bindToolObservation({
      getSink: () => ({
        recordEvent: () => {
          throw new Error("record failed");
        },
        writeRawFile: () => {
          throw new Error("write failed");
        },
      }),
    });
    const execute = executeOf(makeRegistry());

    await expect(
      toolCallContext.run({ ...CTX }, () =>
        execute({ msg: "still ok" }, { toolCallId: "call-ok" }),
      ),
    ).resolves.toBe("echo:still ok");
  });
});
