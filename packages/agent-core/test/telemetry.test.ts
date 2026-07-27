import { describe, expect, it } from "vitest";
import {
  buildAiObservationContext,
  buildAiTelemetrySettings,
  resolveAiTelemetryCapture,
} from "../src/telemetry.js";

describe("resolveAiTelemetryCapture", () => {
  it("defaults input and output recording off", () => {
    expect(resolveAiTelemetryCapture({})).toEqual({
      recordInputs: false,
      recordOutputs: false,
    });
  });

  it("honors explicit input and output recording flags", () => {
    expect(
      resolveAiTelemetryCapture({
        OPENACME_AI_TELEMETRY_RECORD_INPUTS: "1",
        OPENACME_AI_TELEMETRY_RECORD_OUTPUTS: "yes",
      })
    ).toEqual({
      recordInputs: true,
      recordOutputs: true,
    });
  });
});

describe("buildAiObservationContext", () => {
  it("mirrors telemetry correlation ids and model metadata", () => {
    expect(
      buildAiObservationContext({
        forensicRunId: "run-helper",
        parentForensicRunId: "run-parent",
        agentId: "agent-a",
        sessionId: "sess-1",
        taskId: "task-1",
        messageId: "msg-1",
        kind: "selector",
        model: { provider: "openai", model: "gpt-5.5", auth: "oauth" },
      })
    ).toEqual({
      forensicRunId: "run-helper",
      parentForensicRunId: "run-parent",
      agentId: "agent-a",
      sessionId: "sess-1",
      taskId: "task-1",
      messageId: "msg-1",
      kind: "selector",
      provider: "openai",
      model: "gpt-5.5",
      authMode: "oauth",
    });
  });
});

describe("buildAiTelemetrySettings", () => {
  it("adds stable correlation metadata and generated forensic run id", () => {
    const out = buildAiTelemetrySettings(
      {
        functionId: "agent-a",
        agentId: "agent-a",
        sessionId: "sess-1",
        taskId: "42",
        messageId: "msg-1",
        kind: "interactive",
        model: { provider: "openai", model: "gpt-5.5", auth: "oauth" },
      },
      {}
    );

    expect(out.forensicRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(out.settings).toMatchObject({
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      functionId: "agent-a",
      metadata: {
        agentId: "agent-a",
        sessionId: "sess-1",
        taskId: "42",
        messageId: "msg-1",
        kind: "interactive",
        provider: "openai",
        model: "gpt-5.5",
        authMode: "oauth",
        forensicRunId: out.forensicRunId,
      },
    });
  });

  it("lets callers pass an existing forensic run id and extra metadata", () => {
    const out = buildAiTelemetrySettings(
      {
        functionId: "compression-summarizer",
        forensicRunId: "run-1",
        kind: "extractor",
        model: { provider: "anthropic", model: "claude", auth: "api_key" },
        metadata: { parentForensicRunId: "parent-1" },
      },
      {
        OPENACME_AI_TELEMETRY_RECORD_INPUTS: "true",
      }
    );

    expect(out.forensicRunId).toBe("run-1");
    expect(out.settings.recordInputs).toBe(true);
    expect(out.settings.recordOutputs).toBe(false);
    expect(out.settings.metadata).toMatchObject({
      forensicRunId: "run-1",
      parentForensicRunId: "parent-1",
      provider: "anthropic",
      model: "claude",
      authMode: "api_key",
    });
  });
});
