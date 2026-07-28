import { describe, expect, it } from "vitest";
import { classifyError, extractErrorText } from "../src/error-classifier.js";

describe("extractErrorText", () => {
  it("extracts nested provider error messages from plain objects", () => {
    const err = {
      status: 400,
      error: {
        message: "Unsupported model gpt-5.2 for OpenAI OAuth",
        type: "invalid_request_error",
        code: "model_not_found",
      },
    };

    expect(extractErrorText(err)).toBe(
      "Unsupported model gpt-5.2 for OpenAI OAuth"
    );
  });

  it("falls back to readable JSON for object errors without a message", () => {
    const err: Record<string, unknown> = { status: 500, code: "upstream_error" };
    err.self = err;

    expect(extractErrorText(err)).toBe(
      '{"status":500,"code":"upstream_error","self":"[Circular]"}'
    );
  });

  it("does not surface object-stringified Error messages", () => {
    const text = extractErrorText(new Error("[object Object]"));

    expect(text).toBe('{"name":"Error"}');
    expect(text).not.toContain("[object Object]");
  });

  it("dumps fallback values that JSON.stringify would drop or reject", () => {
    function retry() {}
    const text = extractErrorText({
      code: 123n,
      retry,
      marker: Symbol("provider"),
    });

    expect(text).toContain('"code":"123"');
    expect(text).toContain('"retry":"[Function retry]"');
    expect(text).toContain('"marker":"Symbol(provider)"');
  });
});

describe("classifyError", () => {
  it("classifies OpenAI context_length_exceeded responses as context overflow", () => {
    const err = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
        message:
          "Your input exceeds the context window of this model. Please adjust your input and try again.",
        param: "input",
      },
    };

    expect(classifyError(err)).toMatchObject({
      compressionReason: "context_overflow",
      systemBlockReason: "context_length_exceeded",
    });
  });
});
