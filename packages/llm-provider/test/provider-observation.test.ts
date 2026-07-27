import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import {
  createEvidenceRecorder,
  enterAiObservationContext,
  flushEvidenceRecorder,
  sha256Hex,
  type EvidenceRecorder,
} from "../src/ai-observation.js";
import {
  getProviderRequestCountForRun,
  observeProviderRequest,
} from "../src/provider-observation.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-provider-observer-"));
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

describe("observeProviderRequest", () => {
  it("observes request metadata, response metadata, and provider request id without raw wire body capture", async () => {
    const recorder = createEvidenceRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-fetch" },
    });
    const init = {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: '{"input":"hello"}',
    };
    const fetchFn = vi.fn(
      async () =>
        new Response("ok", {
          status: 201,
          headers: { "x-request-id": "req-1", "content-type": "text/plain" },
        }),
    );

    const res = await observeProviderRequest(
      "https://api.openai.test/v1/responses",
      init,
      {
        provider: "openai",
        model: "gpt-test",
        authMode: "oauth",
        preTransformBody: '{"input":"pre"}',
        recorder,
      },
      () => fetchFn("https://api.openai.test/v1/responses", init),
    );

    expect(await res.text()).toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await flushEvidenceRecorder(recorder);
    expect(
      fs.existsSync(
        path.join(
          recorder.runDir!,
          "provider-requests/1-openai-gpt-test/request.pre-transform.body",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          recorder.runDir!,
          "provider-requests/1-openai-gpt-test/request.post-transform.body",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          recorder.runDir!,
          "provider-requests/1-openai-gpt-test/response.body",
        ),
      ),
    ).toBe(false);

    const events = readJsonl(path.join(recorder.runDir!, "events.jsonl"));
    const request = events.find((e) => e.type === "provider.request")!;
    expect(request).toMatchObject({
      data: {
        provider: "openai",
        model: "gpt-test",
        authMode: "oauth",
        ordinal: 1,
        method: "POST",
        requestBodyPresent: true,
        preTransformBodyPresent: true,
        evidenceRef: "openacme://forensics/run-fetch#provider.request:1",
        eventSelector: "type=provider.request ordinal=1",
        relativeEvidenceDir: "provider-requests/1-openai-gpt-test",
      },
    });
    expect((request.data as Record<string, unknown>).headers).toMatchObject({
      authorization: `[redacted:sha256:${sha256Hex("Bearer secret")}]`,
    });
    expect(request.data).not.toHaveProperty("requestBodySha256");
    expect(request.data).not.toHaveProperty("preTransformBodySha256");

    const response = events.find((e) => e.type === "provider.response")!;
    expect(response).toMatchObject({
      data: {
        providerRequestId: "req-1",
        status: 201,
        ok: true,
        evidenceRef: "openacme://forensics/run-fetch#provider.response:1",
        eventSelector: "type=provider.response ordinal=1",
        relativeEvidenceDir: "provider-requests/1-openai-gpt-test",
      },
    });
    expect(response.data).not.toHaveProperty("responseBodySha256");
  });

  it("does not read streaming provider responses before the caller consumes them", async () => {
    const recorder = createEvidenceRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-stream" },
    });
    let pullCount = 0;
    const totalChunks = 10;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        controller.enqueue(new TextEncoder().encode(`chunk-${pullCount}`));
        if (pullCount >= totalChunks) controller.close();
      },
    });

    const res = await observeProviderRequest(
      "https://api.openai.test/v1/responses",
      { method: "POST", body: "request" },
      {
        provider: "openai",
        model: "gpt-test",
        recorder,
      },
      async () => new Response(stream),
    );

    expect(pullCount).toBeLessThan(totalChunks);
    await flushEvidenceRecorder(recorder);
    expect(
      fs.existsSync(
        path.join(
          recorder.runDir!,
          "provider-requests/1-openai-gpt-test/response.body",
        ),
      ),
    ).toBe(false);
    expect(await res.text()).toBe(
      Array.from({ length: totalChunks }, (_, i) => `chunk-${i + 1}`).join(""),
    );
    expect(pullCount).toBe(totalChunks);
  });

  it("records fetch errors and rethrows the original error", async () => {
    const recorder = createEvidenceRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-error" },
    });
    const err = new Error("network down");

    await expect(
      observeProviderRequest(
        "https://api.openai.test/v1/responses",
        {},
        {
          provider: "openai",
          model: "gpt-test",
          recorder,
        },
        async () => {
          throw err;
        },
      ),
    ).rejects.toBe(err);

    await flushEvidenceRecorder(recorder);
    const events = readJsonl(path.join(recorder.runDir!, "events.jsonl"));
    expect(events.find((e) => e.type === "provider.error")).toMatchObject({
      data: { message: "network down" },
    });
  });

  it("keeps provider request behavior when observation sinks throw", async () => {
    const recorder: EvidenceRecorder = {
      enabled: true,
      forensicRunId: "run-sink-failure",
      recordEvent() {
        throw new Error("event sink failed");
      },
      writeRawFile() {
        throw new Error("raw sink failed");
      },
    };

    const res = await observeProviderRequest(
      "https://api.openai.test/v1/responses",
      { method: "POST", body: "request" },
      {
        provider: "openai",
        model: "gpt-test",
        recorder,
      },
      async () => new Response("ok"),
    );

    expect(await res.text()).toBe("ok");
  });

  it("counts provider requests even when local forensics are disabled", async () => {
    const fetchFn = vi.fn(async () => new Response("ok"));

    await enterAiObservationContext(
      { forensicRunId: "run-count" },
      async () => {
        await observeProviderRequest(
          "https://api.openai.test/v1/responses",
          {},
          {
            provider: "openai",
            model: "gpt-test",
          },
          () => fetchFn(),
        );
        await observeProviderRequest(
          "https://api.openai.test/v1/responses",
          {},
          {
            provider: "openai",
            model: "gpt-test",
          },
          () => fetchFn(),
        );
      },
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(getProviderRequestCountForRun("run-count")).toBe(2);
  });

  it("adds evidence locator attributes to provider request spans", async () => {
    const span = fakeSpan();
    const startSpan = vi.fn(() => span);
    vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never);
    vi.spyOn(context, "with").mockImplementation((_ctx, fn) => fn());
    const fetchFn = vi.fn(async () => new Response("ok"));

    await enterAiObservationContext(
      { forensicRunId: "run-span", sessionId: "sess-span" },
      async () => {
        await observeProviderRequest(
          "https://api.openai.test/v1/responses",
          { method: "POST", body: "{}" },
          {
            provider: "openai",
            model: "gpt-test",
          },
          () => fetchFn(),
        );
      },
    );

    expect(startSpan).toHaveBeenCalledWith(
      "openacme.provider.request",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openacme.forensic.lookup": "usage_events.forensic_run_id",
          "openacme.forensic.evidence_ref":
            "openacme://forensics/run-span#provider.request:1",
          "openacme.forensic.event_selector": "type=provider.request ordinal=1",
          "openacme.forensic.relative_evidence_dir":
            "provider-requests/1-openai-gpt-test",
        }),
      }),
    );
  });
});
