import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRunObservation } from "../src/agent-observation.js";

const {
  createEvidenceRecorderMock,
  recordEventMock,
  writeRawFileMock,
  setAiObservationContextMock,
} = vi.hoisted(() => ({
  createEvidenceRecorderMock: vi.fn(),
  recordEventMock: vi.fn(),
  writeRawFileMock: vi.fn(),
  setAiObservationContextMock: vi.fn(),
}));

vi.mock("@openacme/llm-provider", () => ({
  buildEvidenceLocatorAttributes: () => ({}),
  createEvidenceRecorder: createEvidenceRecorderMock,
  getActiveTraceContext: () => null,
  getProviderRequestCountForRun: () => 1,
  setAiObservationContext: setAiObservationContextMock,
  startOpenAcmeSpan: () => ({
    traceId: "trace-agent",
    spanId: "span-agent",
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    recordException: vi.fn(),
    setStatusOk: vi.fn(),
    setStatusError: vi.fn(),
    end: vi.fn(),
    run: (fn: () => unknown) => fn(),
  }),
}));

describe("createAgentRunObservation", () => {
  beforeEach(() => {
    createEvidenceRecorderMock.mockReset();
    recordEventMock.mockReset();
    writeRawFileMock.mockReset();
    setAiObservationContextMock.mockReset();
  });

  it("does not stringify model input snapshots when raw capture is disabled", () => {
    createEvidenceRecorderMock.mockReturnValue({
      enabled: true,
      captureRaw: false,
      maxRawFileBytes: 1024,
      forensicRunId: "run-no-raw",
      runDir: "/tmp/openacme-forensics/run-no-raw",
      recordEvent: recordEventMock,
      writeRawFile: writeRawFileMock,
    });
    const messages = {
      toJSON() {
        throw new Error("messages should not be stringified");
      },
    };
    const observation = createAgentRunObservation({
      agentId: "agent-a",
      sessionId: "sess-1",
      usageKind: "interactive",
      usageModel: { provider: "openai", model: "gpt-test" },
      functionId: "agent-a",
      system: "system",
      messages,
      tools: {},
      reportTimelineEvent: vi.fn(),
      reportUsage: vi.fn(),
    });

    expect(observation.run(() => "ok")).toBe("ok");
    expect(writeRawFileMock).not.toHaveBeenCalled();
  });

  it("skips oversized model input snapshots before full JSON stringify", () => {
    createEvidenceRecorderMock.mockReturnValue({
      enabled: true,
      captureRaw: true,
      maxRawFileBytes: 8,
      forensicRunId: "run-small-cap",
      runDir: "/tmp/openacme-forensics/run-small-cap",
      recordEvent: recordEventMock,
      writeRawFile: writeRawFileMock,
    });
    const observation = createAgentRunObservation({
      agentId: "agent-a",
      sessionId: "sess-1",
      usageKind: "interactive",
      usageModel: { provider: "openai", model: "gpt-test" },
      functionId: "agent-a",
      system: "system",
      messages: [{ role: "user", content: "this is too large" }],
      tools: {},
      reportTimelineEvent: vi.fn(),
      reportUsage: vi.fn(),
    });

    observation.run(() => "ok");

    expect(writeRawFileMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(
      "agent.model_input.snapshot.skipped",
      expect.objectContaining({ reason: "max_raw_file_bytes" }),
    );
  });
});
