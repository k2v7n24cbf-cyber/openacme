import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient, waitUntil } from "./support/client.js";

describe("session timeline observability (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;
  const oldEnv = {
    forensics: process.env["OPENACME_AI_FORENSICS"],
    raw: process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"],
  };

  beforeAll(async () => {
    process.env["OPENACME_AI_FORENSICS"] = "1";
    process.env["OPENACME_AI_FORENSICS_CAPTURE_RAW"] = "1";
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
    const res = await c.post("/api/agents", {
      id: "timeline-agent",
      name: "Timeline Agent",
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await srv?.close();
    restore("OPENACME_AI_FORENSICS", oldEnv.forensics);
    restore("OPENACME_AI_FORENSICS_CAPTURE_RAW", oldEnv.raw);
  });

  it("returns semantic turn events plus structured forensic tool events", async () => {
    const { sessionId } = await c.chat(
      "timeline-agent",
      'timeline please [[mock:tool:list_files:{"path":"."}]]',
    );

    await waitUntil(async () => {
      const assistant = (await c.messages(sessionId)).find(
        (m) => m.role === "assistant",
      );
      return !!assistant?.parts.some(
        (p) => p?.type === "tool-list_files" && p.state === "output-available",
      );
    });

    let timeline:
      | {
          events: Array<{
            id: string;
            sessionId: string;
            eventType: string;
            source: string;
            traceId?: string | null;
            forensicRunId?: string | null;
            usageEventId?: string | null;
            payload?: unknown;
          }>;
        }
      | undefined;

    try {
      await waitUntil(
        async () => {
          timeline = await c.json(
            `/api/sessions/${sessionId}/timeline?includeForensics=1&limit=200`,
          );
          const types = new Set(
            timeline?.events.map((event) => event.eventType),
          );
          return (
            types.has("session.user_message.received") &&
            types.has("session.turn.started") &&
            types.has("session.turn.finished") &&
            types.has("session.usage.finalized") &&
            types.has("tool.start") &&
            types.has("tool.finish")
          );
        },
        { timeoutMs: 10_000 },
      );
    } catch (err) {
      const types = [
        ...new Set(timeline?.events.map((event) => event.eventType) ?? []),
      ].sort();
      throw new Error(
        `timeline missing expected event types; saw ${JSON.stringify(types)}`,
        { cause: err },
      );
    }

    const events = timeline!.events;
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true);
    expect(events.some((event) => event.source === "forensic")).toBe(true);

    const finalized = events.find(
      (event) => event.eventType === "session.usage.finalized",
    );
    if (finalized?.traceId != null) {
      expect(typeof finalized.traceId).toBe("string");
    }
    expect(finalized?.forensicRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(finalized?.usageEventId).toBeTruthy();

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("model-input.system.txt");
    expect(serialized).not.toContain("request.post-transform.body");
    expect(serialized).not.toContain("result.post-spill.txt");
  });

  it("merges sanitized compression helper forensic events", async () => {
    const sessionId = randomUUID();
    const forensicRunId = randomUUID();
    const runDir = path.join(
      srv.dataDir,
      "ai-forensics",
      "2026-07-26",
      forensicRunId,
    );
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "compression.summarizer.start",
        forensicRunId,
        traceId: "trace-compression",
        spanId: "span-compression",
        context: { agentId: "timeline-agent" },
        data: {
          provider: "openai",
          model: "gpt-test",
          summaryBudget: 2000,
          promptBytes: 1234,
          promptSha256: "abc123",
          evidenceRef: `openacme://forensics/${forensicRunId}#compression.summarizer`,
          relativeEvidenceDir: "compression/summarizer",
          rawPromptFile: "compression/summarizer/prompt.txt",
          absolutePath: "/tmp/should-not-leak",
        },
      })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    srv.manager.sessionStore.create("timeline-agent", { id: sessionId });
    srv.manager.usageStore.record({
      agentId: "timeline-agent",
      sessionId,
      kind: "summarizer",
      provider: "openai",
      model: "gpt-test",
      authMode: "api_key",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      costSource: "estimated",
      traceId: "trace-compression",
      spanId: "span-compression",
      forensicRunId,
      forensicPath: runDir,
    });

    const timeline = await c.json(
      `/api/sessions/${sessionId}/timeline?includeForensics=1&limit=50`,
    );
    const event = timeline.events.find(
      (row: { eventType?: string }) =>
        row.eventType === "compression.summarizer.start",
    );
    expect(event).toMatchObject({
      source: "forensic",
      sessionId,
      forensicRunId,
      usageEventId: expect.any(String),
      payload: {
        provider: "openai",
        model: "gpt-test",
        promptBytes: 1234,
        evidenceRef: `openacme://forensics/${forensicRunId}#compression.summarizer`,
        timelineLocator: `/api/sessions/${sessionId}/timeline?includeForensics=1&forensicRunId=${forensicRunId}`,
        relativeEvidenceDir: "compression/summarizer",
      },
    });
    const serialized = JSON.stringify(timeline.events);
    expect(serialized).not.toContain("prompt.txt");
    expect(serialized).not.toContain("/tmp/should-not-leak");
  });

  it("projects tool result failures into forensic timeline status", async () => {
    const sessionId = randomUUID();
    const forensicRunId = randomUUID();
    const runDir = path.join(
      srv.dataDir,
      "ai-forensics",
      "2026-07-26",
      forensicRunId,
    );
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "tool.finish",
        forensicRunId,
        traceId: "trace-tool-failure",
        spanId: "span-tool-failure",
        context: { agentId: "timeline-agent" },
        data: {
          toolName: "shell",
          toolset: "terminal",
          toolCallId: "call_failed_shell",
          executionStatus: "ok",
          resultStatus: "failure",
          resultClassifier: "shell",
          failureKind: "command_exit_nonzero",
          failureMessage: "Command exited with code 7",
          exitCode: 7,
          outcomeAttributes: { command_family: "shell" },
          rawPostSpillFile:
            "tool-calls/call_failed_shell/result.post-spill.txt",
          evidenceRef: `openacme://forensics/${forensicRunId}#tool.finish:call_failed_shell`,
          relativeEvidenceDir: "tool-calls/call_failed_shell",
        },
      })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    srv.manager.sessionStore.create("timeline-agent", { id: sessionId });
    srv.manager.usageStore.record({
      agentId: "timeline-agent",
      sessionId,
      kind: "interactive",
      provider: "openai",
      model: "gpt-test",
      authMode: "api_key",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      costSource: "estimated",
      traceId: "trace-tool-failure",
      spanId: "span-tool-failure",
      forensicRunId,
      forensicPath: runDir,
    });

    const timeline = await c.json(
      `/api/sessions/${sessionId}/timeline?includeForensics=1&limit=50`,
    );
    const event = timeline.events.find(
      (row: { eventType?: string }) => row.eventType === "tool.finish",
    );
    expect(event).toMatchObject({
      source: "forensic",
      sessionId,
      forensicRunId,
      status: "error",
      payload: {
        toolName: "shell",
        executionStatus: "ok",
        resultStatus: "failure",
        resultClassifier: "shell",
        failureKind: "command_exit_nonzero",
        failureMessage: "Command exited with code 7",
        exitCode: 7,
        outcomeAttributes: { command_family: "shell" },
        evidenceRef: `openacme://forensics/${forensicRunId}#tool.finish:call_failed_shell`,
        relativeEvidenceDir: "tool-calls/call_failed_shell",
      },
    });
    const serialized = JSON.stringify(timeline.events);
    expect(serialized).not.toContain("result.post-spill.txt");
  });
});

describe("session timeline autonomous dispatcher events (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    srv = await startE2EServer({
      dispatcher: true,
      tickMs: 3_600_000,
    });
    c = makeClient(srv.baseUrl);
    await c.createAgent("timeline-auto-agent");
  });

  afterAll(async () => {
    await srv?.close();
  });

  it("persists dispatcher and autonomous lifecycle events in the session timeline API", async () => {
    const session = srv.manager.sessionStore.create("timeline-auto-agent");
    const task = await srv.manager.taskStore.create({
      title: "Autonomous timeline proof",
      assignee: "timeline-auto-agent",
      created_by: "user",
      session_id: session.id,
    });

    srv.manager.dispatcher.kick("timeline_autonomous_e2e");

    let timeline:
      | {
          events: Array<{
            sessionId: string;
            agentId?: string | null;
            taskId?: string | null;
            eventType: string;
            source: string;
            status?: string | null;
            payload?: unknown;
          }>;
        }
      | undefined;

    await waitUntil(
      async () => {
        timeline = await c.json(
          `/api/sessions/${session.id}/timeline?limit=200`,
        );
        const types = new Set(timeline.events.map((event) => event.eventType));
        return (
          types.has("session.dispatcher.wake.started") &&
          types.has("session.autonomous.started") &&
          types.has("session.autonomous.finished") &&
          types.has("session.dispatcher.wake.finished")
        );
      },
      { timeoutMs: 12_000 },
    );

    const events = timeline!.events.filter(
      (event) =>
        event.eventType.startsWith("session.dispatcher.") ||
        event.eventType.startsWith("session.autonomous."),
    );
    expect(events.every((event) => event.sessionId === session.id)).toBe(true);
    expect(
      events.every((event) => event.agentId === "timeline-auto-agent"),
    ).toBe(true);
    expect(events.every((event) => event.taskId === task.id)).toBe(true);

    const wakeStarted = events.find(
      (event) => event.eventType === "session.dispatcher.wake.started",
    );
    expect(wakeStarted).toMatchObject({
      source: "dispatcher",
      status: "running",
    });
    expect(["inbox", "task_open_ready"]).toContain(
      (wakeStarted?.payload as { reason?: string } | null)?.reason,
    );

    const autonomousFinished = events.find(
      (event) => event.eventType === "session.autonomous.finished",
    );
    expect(autonomousFinished).toMatchObject({
      source: "dispatcher",
      status: "ok",
    });
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
