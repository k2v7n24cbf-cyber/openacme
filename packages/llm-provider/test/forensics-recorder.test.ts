import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trace, TraceFlags } from "@opentelemetry/api";
import {
  createForensicRecorder,
  flushForensicRecorder,
  redactHeaders,
  resolveForensicsConfig,
  sha256Hex,
} from "../src/forensics-recorder.js";
import {
  enterAIForensicContext,
  getAIForensicContext,
} from "../src/forensics-context.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-forensics-"));
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveForensicsConfig", () => {
  it("is disabled by default", () => {
    expect(resolveForensicsConfig({})).toMatchObject({ enabled: false });
  });

  it("derives default dir from dataDir when enabled", () => {
    expect(
      resolveForensicsConfig({ OPENACME_AI_FORENSICS: "1" }, "/tmp/acme"),
    ).toMatchObject({
      enabled: true,
      captureRaw: false,
      rootDir: "/tmp/acme/ai-forensics",
      retentionDays: 30,
      maxRunBytes: 0,
    });
  });
});

describe("forensic recorder", () => {
  it("writes nothing when disabled", () => {
    const root = tmpRoot();
    const recorder = createForensicRecorder({
      env: { OPENACME_AI_FORENSICS_DIR: root },
      context: { forensicRunId: "run-disabled" },
    });

    recorder.recordEvent("test.event", { ok: true });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(recorder.enabled).toBe(false);
  });

  it("writes run metadata and JSONL events in metadata-only mode", async () => {
    const root = tmpRoot();
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_DIR: root,
      },
      context: {
        forensicRunId: "run-1",
        agentId: "agent-a",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-5.5",
      },
    });

    recorder.recordEvent("provider.request", { ordinal: 1 });
    await flushForensicRecorder(recorder);

    expect(recorder.enabled).toBe(true);
    expect(readJson(path.join(recorder.runDir!, "run.json"))).toMatchObject({
      schemaVersion: 1,
      forensicRunId: "run-1",
      context: {
        agentId: "agent-a",
        sessionId: "sess-1",
        provider: "openai",
        model: "gpt-5.5",
      },
    });
    expect(
      readJsonl(path.join(recorder.runDir!, "events.jsonl"))[0],
    ).toMatchObject({
      type: "provider.request",
      forensicRunId: "run-1",
      data: { ordinal: 1 },
    });
    expect(recorder.writeRawFile("request.body", "secret prompt")).toBeNull();
  });

  it("writes raw files with hashes and restrictive permissions when raw capture is enabled", async () => {
    const root = tmpRoot();
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "true",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: root,
      },
      context: { forensicRunId: "run-raw" },
    });

    const raw = recorder.writeRawFile(
      "provider-requests/1/request.body",
      "hello",
    );
    await flushForensicRecorder(recorder);

    expect(raw).toMatchObject({
      relativePath: "provider-requests/1/request.body",
      byteLength: 5,
      sha256: sha256Hex("hello"),
    });
    const abs = path.join(recorder.runDir!, raw!.relativePath);
    expect(fs.readFileSync(abs, "utf-8")).toBe("hello");
    expect(fs.statSync(recorder.runDir!).mode & 0o777).toBe(0o700);
    expect(fs.statSync(abs).mode & 0o777).toBe(0o600);
  });

  it("does not use sync fs calls in the main recorder implementation", async () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/forensics-recorder.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(
      /\b(?:mkdirSync|chmodSync|writeFileSync|appendFileSync)\b/,
    );

    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
      },
      context: { forensicRunId: "run-async" },
    });
    recorder.recordEvent("provider.request", { ordinal: 1 });
    recorder.writeRawFile("provider-requests/1/request.body", "hello");

    await flushForensicRecorder(recorder);
    expect(readJsonl(path.join(recorder.runDir!, "events.jsonl"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "provider.request" }),
        expect.objectContaining({ type: "raw_file.written" }),
      ]),
    );
  });

  it("skips oversized raw files instead of copying them into the archive queue", async () => {
    const root = tmpRoot();
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: root,
        OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES: "4",
      },
      context: { forensicRunId: "run-raw-cap" },
    });

    expect(
      recorder.writeRawFile("provider-requests/1/request.body", "hello"),
    ).toBeNull();
    await flushForensicRecorder(recorder);

    const events = readJsonl(path.join(recorder.runDir!, "events.jsonl"));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "raw_file.skipped",
          data: expect.objectContaining({
            relativePath: "provider-requests/1/request.body",
            byteLength: 5,
            reason: "max_raw_file_bytes",
          }),
        }),
      ]),
    );
    expect(
      fs.existsSync(
        path.join(recorder.runDir!, "provider-requests/1/request.body"),
      ),
    ).toBe(false);
  });

  it("drops archive jobs without throwing when the writer queue is full", async () => {
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: tmpRoot(),
        OPENACME_AI_FORENSICS_QUEUE_MAX_JOBS: "0",
      },
      context: { forensicRunId: "run-queue-full" },
    });

    expect(() => recorder.recordEvent("provider.request")).not.toThrow();
    expect(() =>
      recorder.writeRawFile("provider-requests/1/request.body", "hello"),
    ).not.toThrow();
    expect(
      recorder.writeRawFile("provider-requests/1/request.body", "hello"),
    ).toBeNull();
    await expect(flushForensicRecorder(recorder)).resolves.toBeUndefined();
  });

  it("redacts secret headers with hashed markers", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret",
        "x-api-key": "key",
        "chatgpt-account-id": "acct-123",
        "content-type": "application/json",
      }),
    ).toEqual({
      authorization: `[redacted:sha256:${sha256Hex("Bearer secret")}]`,
      "x-api-key": `[redacted:sha256:${sha256Hex("key")}]`,
      "chatgpt-account-id": `[redacted:sha256:${sha256Hex("acct-123")}]`,
      "content-type": "application/json",
    });
  });

  it("does not throw when the archive root is unwritable or invalid", () => {
    const fileRoot = path.join(tmpRoot(), "not-a-dir");
    fs.writeFileSync(fileRoot, "x");
    const recorder = createForensicRecorder({
      env: {
        OPENACME_AI_FORENSICS: "1",
        OPENACME_AI_FORENSICS_CAPTURE_RAW: "1",
        OPENACME_AI_FORENSICS_DIR: fileRoot,
      },
      context: { forensicRunId: "run-fail" },
    });

    expect(() => recorder.recordEvent("x")).not.toThrow();
    expect(() => recorder.writeRawFile("x", "y")).not.toThrow();
  });

  it("separates concurrent runs", async () => {
    const root = tmpRoot();
    const a = createForensicRecorder({
      env: { OPENACME_AI_FORENSICS: "1", OPENACME_AI_FORENSICS_DIR: root },
      context: { forensicRunId: "run-a" },
    });
    const b = createForensicRecorder({
      env: { OPENACME_AI_FORENSICS: "1", OPENACME_AI_FORENSICS_DIR: root },
      context: { forensicRunId: "run-b" },
    });

    expect(a.runDir).not.toBe(b.runDir);
    await flushForensicRecorder(a);
    await flushForensicRecorder(b);
    expect(fs.existsSync(path.join(a.runDir!, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(b.runDir!, "run.json"))).toBe(true);
  });

  it("records active OpenTelemetry trace and span ids", async () => {
    const root = tmpRoot();
    const span = trace.wrapSpanContext({
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
      traceFlags: TraceFlags.SAMPLED,
    });
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);

    const recorder = createForensicRecorder({
      env: { OPENACME_AI_FORENSICS: "1", OPENACME_AI_FORENSICS_DIR: root },
      context: { forensicRunId: "run-trace" },
    });
    recorder.recordEvent("with.trace");
    await flushForensicRecorder(recorder);
    expect(
      readJsonl(path.join(recorder.runDir!, "events.jsonl"))[0],
    ).toMatchObject({
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    });
  });
});

describe("AI forensic context", () => {
  it("scopes context through AsyncLocalStorage", () => {
    enterAIForensicContext(
      { forensicRunId: "run-context", sessionId: "s1" },
      () => {
        expect(getAIForensicContext()).toMatchObject({
          forensicRunId: "run-context",
          sessionId: "s1",
        });
      },
    );
    expect(getAIForensicContext()).toBeUndefined();
  });
});
