import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ModelConfig } from "@openacme/config";
import { createAiHelperObservation } from "../src/helper-observation.js";

const {
  createEvidenceRecorderMock,
  enterAiObservationContextMock,
  getProviderRequestCountForRunMock,
  withOpenAcmeSpanMock,
} = vi.hoisted(() => ({
  createEvidenceRecorderMock: vi.fn(),
  enterAiObservationContextMock: vi.fn((_ctx: unknown, fn: () => unknown) =>
    fn(),
  ),
  getProviderRequestCountForRunMock: vi.fn(() => 3),
  withOpenAcmeSpanMock: vi.fn(
    (
      _name: string,
      _attrs: Record<string, unknown>,
      fn: (span: unknown) => unknown,
    ) => fn({ traceId: "trace-helper", spanId: "span-helper" }),
  ),
}));

vi.mock("@openacme/llm-provider", () => ({
  buildEvidenceEventSelector: (eventType: string) => `type=${eventType}`,
  buildEvidenceLocatorAttributes: (args: {
    forensicRunId?: string;
    sessionId?: string;
    eventType: string;
    eventSelector?: string;
    relativeEvidenceDir?: string;
  }) => ({
    "openacme.forensic.lookup": "usage_events.forensic_run_id",
    "openacme.forensic.evidence_ref": `openacme://forensics/${args.forensicRunId}#${args.eventType}`,
    "openacme.forensic.event_selector": args.eventSelector,
    "openacme.forensic.relative_evidence_dir": args.relativeEvidenceDir,
  }),
  buildEvidenceLocatorPayload: (args: {
    forensicRunId?: string;
    sessionId?: string;
    eventType: string;
    eventSelector?: string;
    relativeEvidenceDir?: string;
  }) => ({
    evidenceRef: `openacme://forensics/${args.forensicRunId}#${args.eventType}`,
    eventSelector: args.eventSelector,
    relativeEvidenceDir: args.relativeEvidenceDir,
  }),
  createEvidenceRecorder: createEvidenceRecorderMock,
  enterAiObservationContext: enterAiObservationContextMock,
  getAiObservationContext: () => ({ forensicRunId: "parent-run" }),
  getProviderRequestCountForRun: getProviderRequestCountForRunMock,
  withOpenAcmeSpan: withOpenAcmeSpanMock,
}));

const model = {
  provider: "openai",
  model: "gpt-test",
  apiKey: "x",
  auth: "api_key",
} as ModelConfig;

describe("createAiHelperObservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps helper execution successful when evidence sinks fail", async () => {
    createEvidenceRecorderMock.mockImplementation(() => {
      throw new Error("disk unavailable");
    });

    const observation = createAiHelperObservation({
      functionId: "a1:helper",
      agentId: "a1",
      sessionId: "sess-1",
      taskId: "task-1",
      kind: "extractor",
      model,
      eventType: "helper.call",
      eventSelectorType: "helper.call.start",
      relativeEvidenceDir: "helper/call",
    });

    const result = await observation.run((span) => {
      observation.writeRawFile("helper/input.txt", "input");
      observation.recordEvent("helper.start", { ok: true });
      return {
        traceId: span.traceId,
        spanId: span.spanId,
        evidenceRunDir: observation.evidenceRunDir,
        providerRequestCount: observation.providerRequestCount(),
      };
    });

    expect(result).toEqual({
      traceId: "trace-helper",
      spanId: "span-helper",
      evidenceRunDir: undefined,
      providerRequestCount: 3,
    });
    expect(enterAiObservationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        forensicRunId: observation.forensicRunId,
        parentForensicRunId: "parent-run",
        agentId: "a1",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-test",
        authMode: "api_key",
      }),
      expect.any(Function),
    );
    expect(withOpenAcmeSpanMock).toHaveBeenCalledWith(
      "openacme.ai.helper",
      expect.objectContaining({
        "openacme.span.type": "ai_helper",
        "openacme.ai.function_id": "a1:helper",
        "openacme.forensic.parent_run_id": "parent-run",
        "openacme.session.id": "sess-1",
        "openacme.forensic.event_selector": "type=helper.call.start",
      }),
      expect.any(Function),
    );
    expect(getProviderRequestCountForRunMock).toHaveBeenCalledWith(
      observation.forensicRunId,
    );
  });
});
