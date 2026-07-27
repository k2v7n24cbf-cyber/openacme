import { describe, expect, it } from "vitest";
import {
  buildForensicEvidenceRef,
  buildForensicLocatorAttributes,
} from "../src/evidence-locator.js";

describe("forensic evidence locators", () => {
  it("formats deterministic evidence refs without exposing filesystem paths", () => {
    expect(
      buildForensicEvidenceRef({
        forensicRunId: "run-1",
        eventType: "provider.request",
        selector: "1",
      }),
    ).toBe("openacme://forensics/run-1#provider.request:1");
  });

  it("returns no locator attributes when required ids are unavailable", () => {
    expect(
      buildForensicLocatorAttributes({
        eventType: "provider.request",
        selector: "1",
      }),
    ).toEqual({});
  });

  it("returns lookup, evidence, selector, and relative evidence dir attributes", () => {
    expect(
      buildForensicLocatorAttributes({
        forensicRunId: "run-1",
        sessionId: "sess-1",
        eventType: "provider.request",
        selector: "2",
        eventSelector: "type=provider.request ordinal=2",
        relativeEvidenceDir: "provider-requests/2-openai-gpt-test",
      }),
    ).toEqual({
      "openacme.forensic.lookup": "usage_events.forensic_run_id",
      "openacme.forensic.evidence_ref":
        "openacme://forensics/run-1#provider.request:2",
      "openacme.forensic.event_selector": "type=provider.request ordinal=2",
      "openacme.forensic.relative_evidence_dir":
        "provider-requests/2-openai-gpt-test",
    });
  });
});
