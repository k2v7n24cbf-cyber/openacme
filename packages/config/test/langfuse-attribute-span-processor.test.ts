import { describe, expect, it, vi } from "vitest";
import { context } from "@opentelemetry/api";
import {
  LangfuseAttributeSpanProcessor,
  mapOpenAcmeToLangfuseAttributes,
} from "../src/langfuse-attribute-span-processor.js";

describe("mapOpenAcmeToLangfuseAttributes", () => {
  it("maps canonical OpenAcme attributes to Langfuse attributes in the adapter", () => {
    expect(
      mapOpenAcmeToLangfuseAttributes({
        "openacme.session.id": "sess-1",
        "openacme.agent.id": "agent-a",
        "openacme.task.id": "task-1",
        "openacme.forensic.run_id": "run-1",
        "openacme.forensic.evidence_ref":
          "openacme://forensics/run-1#agent.run",
        "openacme.session.timeline_locator":
          "/api/sessions/sess-1/timeline?includeForensics=1",
        "openacme.tool.execution_status": "ok",
        "openacme.tool.result_status": "failure",
        "openacme.tool.failure_kind": "command_exit_nonzero",
        "openacme.tool.failure_message": "Command exited with code 7",
        "openacme.tool.exit_code": 7,
      })
    ).toEqual({
      "langfuse.session.id": "sess-1",
      "langfuse.trace.metadata.agent_id": "agent-a",
      "langfuse.trace.metadata.task_id": "task-1",
      "langfuse.trace.metadata.forensic_run_id": "run-1",
      "langfuse.observation.metadata.evidence_ref":
        "openacme://forensics/run-1#agent.run",
      "langfuse.observation.metadata.timeline_locator":
        "/api/sessions/sess-1/timeline?includeForensics=1",
      "langfuse.observation.metadata.tool_execution_status": "ok",
      "langfuse.observation.metadata.tool_result_status": "failure",
      "langfuse.observation.metadata.tool_failure_kind":
        "command_exit_nonzero",
      "langfuse.observation.metadata.tool_failure_message":
        "Command exited with code 7",
      "langfuse.observation.metadata.tool_exit_code": "7",
    });
  });
});

describe("LangfuseAttributeSpanProcessor", () => {
  it("adds Langfuse attributes from canonical span attributes before export", () => {
    const processor = new LangfuseAttributeSpanProcessor();
    const span = {
      attributes: {
        "openacme.session.id": "sess-1",
        "openacme.agent.id": "agent-a",
      },
      setAttribute: vi.fn(),
    };

    processor.onStart(span as never, context.active());

    expect(span.setAttribute).toHaveBeenCalledWith(
      "langfuse.session.id",
      "sess-1"
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "langfuse.trace.metadata.agent_id",
      "agent-a"
    );
  });
});
