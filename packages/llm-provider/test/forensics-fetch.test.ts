import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { createForensicRecorder, sha256Hex } from "../src/forensics-recorder.js";
import {
  forensicFetch,
  getAIForensicProviderRequestCount,
} from "../src/forensics-fetch.js";
import { enterAIForensicContext } from "../src/forensics-context.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-forensic-fetch-"));
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

describe("forensicFetch", () => {
  it("records redacted request metadata, raw bodies, response metadata, and provider request id", async () => {
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-fetch" },
    });
    const fetchFn = vi.fn(async () =>
      new Response("ok", {
        status: 201,
        headers: { "x-request-id": "req-1", "content-type": "text/plain" },
      })
    );

    const res = await forensicFetch(
      "https://api.openai.test/v1/responses",
      {
        method: "POST",
        headers: { Authorization: "Bearer secret", "content-type": "application/json" },
        body: "{\"input\":\"hello\"}",
      },
      {
        provider: "openai",
        model: "gpt-test",
        authMode: "oauth",
        preTransformBody: "{\"input\":\"pre\"}",
        fetch: fetchFn,
        recorder,
      }
    );

    expect(await res.text()).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      fs.readFileSync(
        path.join(recorder.runDir!, "provider-requests/1-openai-gpt-test/request.pre-transform.body"),
        "utf-8"
      )
    ).toBe("{\"input\":\"pre\"}");
    expect(
      fs.readFileSync(
        path.join(recorder.runDir!, "provider-requests/1-openai-gpt-test/request.post-transform.body"),
        "utf-8"
      )
    ).toBe("{\"input\":\"hello\"}");
    expect(
      fs.readFileSync(
        path.join(recorder.runDir!, "provider-requests/1-openai-gpt-test/response.body"),
        "utf-8"
      )
    ).toBe("ok");

    const events = readJsonl(path.join(recorder.runDir!, "events.jsonl"));
    const request = events.find((e) => e.type === "provider.request")!;
    expect(request).toMatchObject({
      data: {
        provider: "openai",
        model: "gpt-test",
        authMode: "oauth",
        ordinal: 1,
        method: "POST",
        requestBodySha256: sha256Hex("{\"input\":\"hello\"}"),
        evidenceRef: "openacme://forensics/run-fetch#provider.request:1",
        eventSelector: "type=provider.request ordinal=1",
        relativeEvidenceDir: "provider-requests/1-openai-gpt-test",
      },
    });
    expect((request.data as Record<string, unknown>).headers).toMatchObject({
      authorization: `[redacted:sha256:${sha256Hex("Bearer secret")}]`,
    });

    const response = events.find((e) => e.type === "provider.response")!;
    expect(response).toMatchObject({
      data: {
        providerRequestId: "req-1",
        status: 201,
        ok: true,
        responseBodySha256: sha256Hex("ok"),
        evidenceRef: "openacme://forensics/run-fetch#provider.response:1",
        eventSelector: "type=provider.response ordinal=1",
        relativeEvidenceDir: "provider-requests/1-openai-gpt-test",
      },
    });
  });

  it("captures a cloned streaming response without consuming the original", async () => {
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-stream" },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-1"));
        controller.enqueue(new TextEncoder().encode("chunk-2"));
        controller.close();
      },
    });

    const res = await forensicFetch(
      "https://api.openai.test/v1/responses",
      { method: "POST", body: "request" },
      {
        provider: "openai",
        model: "gpt-test",
        fetch: async () => new Response(stream),
        recorder,
      }
    );

    expect(await res.text()).toBe("chunk-1chunk-2");
    expect(
      fs.readFileSync(
        path.join(recorder.runDir!, "provider-requests/1-openai-gpt-test/response.body"),
        "utf-8"
      )
    ).toBe("chunk-1chunk-2");
  });

  it("records fetch errors and rethrows the original error", async () => {
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-error" },
    });
    const err = new Error("network down");

    await expect(
      forensicFetch("https://api.openai.test/v1/responses", {}, {
        provider: "openai",
        model: "gpt-test",
        fetch: async () => {
          throw err;
        },
        recorder,
      })
    ).rejects.toBe(err);

    const events = readJsonl(path.join(recorder.runDir!, "events.jsonl"));
    expect(events.find((e) => e.type === "provider.error")).toMatchObject({
      data: { message: "network down" },
    });
  });

  it("counts provider requests even when local forensics are disabled", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));

    await enterAIForensicContext({ forensicRunId: "run-count" }, async () => {
      await forensicFetch("https://api.openai.test/v1/responses", {}, {
        provider: "openai",
        model: "gpt-test",
        fetch: fetchFn,
      });
      await forensicFetch("https://api.openai.test/v1/responses", {}, {
        provider: "openai",
        model: "gpt-test",
        fetch: fetchFn,
      });
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(getAIForensicProviderRequestCount("run-count")).toBe(2);
  });

  it("adds evidence locator attributes to provider request spans", async () => {
    const span = fakeSpan();
    const startSpan = vi.fn(() => span);
    vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never);
    vi.spyOn(context, "with").mockImplementation((_ctx, fn) => fn());
    const fetchFn = vi.fn(async () => new Response("ok"));

    await enterAIForensicContext(
      { forensicRunId: "run-span", sessionId: "sess-span" },
      async () => {
        await forensicFetch(
          "https://api.openai.test/v1/responses",
          { method: "POST", body: "{}" },
          {
            provider: "openai",
            model: "gpt-test",
            fetch: fetchFn,
          }
        );
      }
    );

    expect(startSpan).toHaveBeenCalledWith(
      "openacme.provider.request",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openacme.forensic.lookup": "usage_events.forensic_run_id",
          "openacme.forensic.evidence_ref":
            "openacme://forensics/run-span#provider.request:1",
          "openacme.forensic.event_selector":
            "type=provider.request ordinal=1",
          "openacme.forensic.relative_evidence_dir":
            "provider-requests/1-openai-gpt-test",
          "openacme.session.timeline_locator":
            "/api/sessions/sess-span/timeline?includeForensics=1&forensicRunId=run-span",
        }),
      })
    );
  });
});
