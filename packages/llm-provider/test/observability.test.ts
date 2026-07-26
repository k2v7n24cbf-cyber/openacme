import { afterEach, describe, expect, it, vi } from "vitest";
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  TraceFlags,
  type Context,
} from "@opentelemetry/api";
import {
  sanitizeSpanAttributes,
  startOpenAcmeSpan,
  withOpenAcmeSpan,
} from "../src/observability.js";

function fakeSpan() {
  return {
    spanContext: vi.fn(() => ({
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: TraceFlags.SAMPLED,
    })),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeSpanAttributes", () => {
  it("keeps supported OpenTelemetry attribute values and drops unsafe values", () => {
    expect(
      sanitizeSpanAttributes({
        "openacme.agent.id": "agent-a",
        "openacme.duration_ms": 42,
        "openacme.enabled": true,
        "openacme.tags": ["ai", "prod"],
        "openacme.counts": [1, 2],
        "openacme.flags": [true, false],
        "openacme.undefined": undefined,
        "openacme.null": null,
        "openacme.object": { nope: true },
        "openacme.mixed": ["x", 1],
        "openacme.nan": Number.NaN,
        "openacme.__proto__.bad": "pollution",
        "openacme.authorization": "Bearer secret",
      })
    ).toEqual({
      "openacme.agent.id": "agent-a",
      "openacme.duration_ms": 42,
      "openacme.enabled": true,
      "openacme.tags": ["ai", "prod"],
      "openacme.counts": [1, 2],
      "openacme.flags": [true, false],
      "openacme.authorization": "[redacted]",
    });
  });
});

describe("OpenAcme spans", () => {
  it("starts a span, exposes ids, and runs code through the active context", () => {
    const span = fakeSpan();
    const startSpan = vi.fn(() => span);
    vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never);
    let activeContext: Context | null = null;
    const withSpy = vi
      .spyOn(context, "with")
      .mockImplementation((ctx, fn) => {
        activeContext = ctx;
        return fn();
      });

    const handle = startOpenAcmeSpan("openacme.agent.turn", {
      "openacme.agent.id": "agent-a",
      "openacme.session.id": "sess-1",
      "openacme.forensic.run_id": "run-1",
      "openacme.authorization": "Bearer secret",
    });
    const result = handle.run(() => "ok");

    expect(result).toBe("ok");
    expect(startSpan).toHaveBeenCalledWith("openacme.agent.turn", {
      kind: 0,
      attributes: {
        "openacme.agent.id": "agent-a",
        "openacme.session.id": "sess-1",
        "openacme.forensic.run_id": "run-1",
        "openacme.authorization": "[redacted]",
      },
    });
    expect(withSpy).toHaveBeenCalledTimes(1);
    expect(
      propagation.getBaggage(activeContext!)?.getEntry("openacme.session.id")
        ?.value
    ).toBe("sess-1");
    expect(
      propagation
        .getBaggage(activeContext!)
        ?.getEntry("openacme.forensic.run_id")?.value
    ).toBe("run-1");
    expect(
      propagation
        .getBaggage(activeContext!)
        ?.getEntry("openacme.agent.id")?.value
    ).toBe("agent-a");
    expect(
      propagation.getBaggage(activeContext!)?.getEntry("langfuse.session.id")
    ).toBeUndefined();
    expect(
      propagation.getBaggage(activeContext!)?.getEntry("openacme.authorization")
    ).toBeUndefined();
    expect(handle.traceId).toBe("1234567890abcdef1234567890abcdef");
    expect(handle.spanId).toBe("1234567890abcdef");
    expect(handle.sampled).toBe(true);
  });

  it("records app exceptions, sets error status, ends the span, and rethrows the original object", async () => {
    const span = fakeSpan();
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: vi.fn(() => span),
    } as never);
    vi.spyOn(context, "with").mockImplementation((_ctx, fn) => fn());
    const err = new Error("boom");

    await expect(
      withOpenAcmeSpan("openacme.test", {}, () => {
        throw err;
      })
    ).rejects.toBe(err);

    expect(span.recordException).toHaveBeenCalledWith(err);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("runs app code once without telemetry if span setup fails before callback start", () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("otel unavailable");
    });
    const fn = vi.fn(() => "fallback");

    expect(startOpenAcmeSpan("openacme.test").run(fn)).toBe("fallback");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not rerun app code when the active callback throws", () => {
    const span = fakeSpan();
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: vi.fn(() => span),
    } as never);
    vi.spyOn(context, "with").mockImplementation((_ctx, fn) => fn());
    const err = new Error("app failed");
    const fn = vi.fn(() => {
      throw err;
    });

    expect(() => startOpenAcmeSpan("openacme.test").run(fn)).toThrow(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("falls back without active context if context activation fails before app code starts", () => {
    const span = fakeSpan();
    vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: vi.fn(() => span),
    } as never);
    vi.spyOn(context, "with").mockImplementation(() => {
      throw new Error("context manager failed");
    });
    const fn = vi.fn(() => "fallback");

    expect(startOpenAcmeSpan("openacme.test").run(fn)).toBe("fallback");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
