import { describe, expect, it, vi } from "vitest";
import { context, propagation } from "@opentelemetry/api";
import {
  isSafeOpenAcmeBaggageKey,
  OpenAcmeBaggageSpanProcessor,
} from "../src/openacme-baggage-span-processor.js";

describe("OpenAcmeBaggageSpanProcessor", () => {
  it("copies safe canonical OpenAcme baggage entries to each started span", () => {
    const processor = new OpenAcmeBaggageSpanProcessor();
    const parentContext = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({
        "openacme.session.id": { value: "sess-1" },
        "openacme.agent.id": { value: "agent-a" },
        "openacme.forensic.run_id": { value: "run-1" },
        "openacme.authorization": { value: "Bearer secret" },
        "openacme.__proto__.bad": { value: "pollution" },
        "langfuse.session.id": { value: "sess-1" },
      })
    );
    const span = {
      attributes: {
        "openacme.agent.id": "child-agent",
      },
      setAttribute: vi.fn(),
    };

    processor.onStart(span as never, parentContext);

    expect(span.setAttribute).toHaveBeenCalledWith(
      "openacme.session.id",
      "sess-1"
    );
    expect(span.setAttribute).toHaveBeenCalledWith(
      "openacme.forensic.run_id",
      "run-1"
    );
    expect(span.setAttribute).not.toHaveBeenCalledWith(
      "openacme.agent.id",
      expect.anything()
    );
    expect(span.setAttribute).toHaveBeenCalledTimes(2);
  });

  it("reports only non-sensitive canonical baggage keys as safe", () => {
    expect(isSafeOpenAcmeBaggageKey("openacme.session.id")).toBe(true);
    expect(isSafeOpenAcmeBaggageKey("openacme.forensic.evidence_ref")).toBe(true);
    expect(isSafeOpenAcmeBaggageKey("langfuse.session.id")).toBe(false);
    expect(isSafeOpenAcmeBaggageKey("openacme.authorization")).toBe(false);
    expect(isSafeOpenAcmeBaggageKey("openacme.constructor.bad")).toBe(false);
    expect(isSafeOpenAcmeBaggageKey("openacme.tool.failure_message")).toBe(false);
  });
});
