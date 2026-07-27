import { describe, expect, it } from "vitest";
import * as provider from "../src/index.js";

describe("llm-provider AI observation public API", () => {
  it("exposes neutral observation helpers instead of forensic execution APIs", () => {
    expect(provider).toMatchObject({
      createEvidenceRecorder: expect.any(Function),
      enterAiObservationContext: expect.any(Function),
      getAiObservationContext: expect.any(Function),
      setAiObservationContext: expect.any(Function),
      buildEvidenceLocatorAttributes: expect.any(Function),
      buildEvidenceLocatorPayload: expect.any(Function),
      observeProviderRequest: expect.any(Function),
      getProviderRequestCountForRun: expect.any(Function),
    });
    expect(provider).not.toHaveProperty("forensicFetch");
    expect(provider).not.toHaveProperty("createForensicRecorder");
    expect(provider).not.toHaveProperty("enterAIForensicContext");
    expect(provider).not.toHaveProperty("setAIForensicContext");
    expect(provider).not.toHaveProperty("getAIForensicContext");
  });
});
