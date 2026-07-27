import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { createLogger } from "@openacme/config/logger";
import {
  getAIForensicContext,
  type AIForensicContext,
} from "./forensics-context.js";
import {
  flushForensicWriters,
  getForensicWriter,
  type ForensicWriterJob,
  type WorkerForensicWriter,
} from "./forensics-writer.js";

const log = createLogger("llm-provider.forensics");

type Env = Record<string, string | undefined>;

export interface DisabledForensicsConfig {
  enabled: false;
  reason?: string;
}

export interface EnabledForensicsConfig {
  enabled: true;
  captureRaw: boolean;
  rootDir: string;
  retentionDays: number;
  maxRunBytes: number;
  maxRawFileBytes: number;
  queueMaxJobs: number;
  queueMaxRawBytes: number;
}

export type ForensicsConfig = DisabledForensicsConfig | EnabledForensicsConfig;

export interface RawFileRecord {
  relativePath: string;
  byteLength: number;
  sha256: string;
}

export interface ForensicRecorder {
  enabled: boolean;
  captureRaw?: boolean;
  maxRawFileBytes?: number;
  forensicRunId?: string;
  runDir?: string;
  recordEvent(type: string, data?: Record<string, unknown>): void;
  writeRawFile(
    relativePath: string,
    data: string | Buffer,
  ): RawFileRecord | null;
  flush?(): Promise<void>;
}

export interface ActiveTraceContext {
  traceId: string;
  spanId: string;
}

const TRUE_VALUES = new Set(["1", "true", "yes"]);
const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "chatgpt-account-id",
]);

export function resolveForensicsConfig(
  env: Env = process.env,
  dataDir?: string,
): ForensicsConfig {
  if (!truthy(env["OPENACME_AI_FORENSICS"])) {
    return { enabled: false };
  }
  const resolvedDataDir =
    dataDir ??
    env["OPENACME_DATA_DIR"] ??
    path.join(env["HOME"] ?? "", ".openacme");
  return {
    enabled: true,
    captureRaw: truthy(env["OPENACME_AI_FORENSICS_CAPTURE_RAW"]),
    rootDir:
      env["OPENACME_AI_FORENSICS_DIR"] ??
      path.join(resolvedDataDir, "ai-forensics"),
    retentionDays: parseNonNegativeInt(
      env["OPENACME_AI_FORENSICS_RETENTION_DAYS"],
      30,
    ),
    maxRunBytes: parseNonNegativeInt(
      env["OPENACME_AI_FORENSICS_MAX_RUN_BYTES"],
      0,
    ),
    maxRawFileBytes: parseNonNegativeInt(
      env["OPENACME_AI_FORENSICS_MAX_RAW_FILE_BYTES"],
      1024 * 1024,
    ),
    queueMaxJobs: parseNonNegativeInt(
      env["OPENACME_AI_FORENSICS_QUEUE_MAX_JOBS"],
      10_000,
    ),
    queueMaxRawBytes: parseNonNegativeInt(
      env["OPENACME_AI_FORENSICS_QUEUE_MAX_RAW_BYTES"],
      16 * 1024 * 1024,
    ),
  };
}

export function createForensicRecorder(
  opts: {
    env?: Env;
    dataDir?: string;
    context?: AIForensicContext;
    now?: Date;
  } = {},
): ForensicRecorder {
  const cfg = resolveForensicsConfig(opts.env, opts.dataDir);
  if (!cfg.enabled) return new NoopForensicRecorder();
  try {
    return new FileForensicRecorder(
      cfg,
      opts.context ?? getAIForensicContext() ?? { forensicRunId: randomUUID() },
      opts.now ?? new Date(),
    );
  } catch (err) {
    log.warn({ err }, "failed to initialize AI forensic recorder");
    return new NoopForensicRecorder();
  }
}

export async function flushForensicRecorder(
  recorder: ForensicRecorder | null | undefined,
): Promise<void> {
  await recorder?.flush?.();
}

export { flushForensicWriters };

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function getActiveTraceContext(): ActiveTraceContext | null {
  const span = trace.getActiveSpan()?.spanContext();
  return span ? { traceId: span.traceId, spanId: span.spanId } : null;
}

export function redactHeaders(
  headers: Headers | Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Object.entries(headers);
  for (const [rawKey, rawValue] of entries) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    out[key] = SECRET_HEADERS.has(key)
      ? `[redacted:sha256:${sha256Hex(rawValue)}]`
      : rawValue;
  }
  return out;
}

class NoopForensicRecorder implements ForensicRecorder {
  readonly enabled = false;
  readonly captureRaw = false;

  recordEvent(): void {
    // no-op
  }

  writeRawFile(): RawFileRecord | null {
    return null;
  }

  async flush(): Promise<void> {
    // no-op
  }
}

class FileForensicRecorder implements ForensicRecorder {
  readonly enabled = true;
  readonly captureRaw: boolean;
  readonly maxRawFileBytes: number;
  readonly forensicRunId: string;
  readonly runDir: string;
  private readonly eventsFile: string;
  private readonly writer: WorkerForensicWriter;
  private bytesWritten = 0;

  constructor(
    private readonly cfg: EnabledForensicsConfig,
    private readonly context: AIForensicContext,
    now: Date,
  ) {
    this.captureRaw = cfg.captureRaw;
    this.maxRawFileBytes = cfg.maxRawFileBytes;
    this.forensicRunId = context.forensicRunId;
    const date = now.toISOString().slice(0, 10);
    this.runDir = path.join(
      cfg.rootDir,
      date,
      safeSegment(context.forensicRunId),
    );
    this.eventsFile = path.join(this.runDir, "events.jsonl");
    this.writer = getForensicWriter({
      queueMaxJobs: cfg.queueMaxJobs,
      queueMaxRawBytes: cfg.queueMaxRawBytes,
    });
    this.enqueue({
      type: "initRun",
      runDir: this.runDir,
      runJson: {
        schemaVersion: 1,
        forensicRunId: context.forensicRunId,
        createdAt: now.toISOString(),
        captureRaw: cfg.captureRaw,
        maxRawFileBytes: cfg.maxRawFileBytes,
        context: stripUndefined(context),
      },
    });
  }

  recordEvent(type: string, data: Record<string, unknown> = {}): void {
    try {
      this.enqueue({
        type: "event",
        eventsFile: this.eventsFile,
        row: this.eventRow(type, data),
      });
    } catch (err) {
      log.warn({ err, type }, "failed to enqueue AI forensic event");
    }
  }

  writeRawFile(
    relativePath: string,
    data: string | Buffer,
  ): RawFileRecord | null {
    if (!this.cfg.captureRaw) return null;
    const byteLength = rawByteLength(data);
    if (this.cfg.maxRawFileBytes > 0 && byteLength > this.cfg.maxRawFileBytes) {
      this.recordEvent("raw_file.skipped", {
        relativePath: normalizeRelativePath(relativePath),
        byteLength,
        reason: "max_raw_file_bytes",
        maxRawFileBytes: this.cfg.maxRawFileBytes,
      });
      return null;
    }
    if (
      this.cfg.maxRunBytes > 0 &&
      this.bytesWritten + byteLength > this.cfg.maxRunBytes
    ) {
      this.recordEvent("raw_file.skipped", {
        relativePath,
        byteLength,
        reason: "max_run_bytes",
      });
      return null;
    }
    try {
      const safeRelative = normalizeRelativePath(relativePath);
      ensureInside(this.runDir, path.join(this.runDir, safeRelative));
      const buffer = Buffer.isBuffer(data)
        ? Buffer.from(data)
        : Buffer.from(data, "utf-8");
      const record = {
        relativePath: safeRelative,
        byteLength: buffer.byteLength,
        sha256: sha256Hex(buffer),
      };
      if (
        !this.enqueue(
          {
            type: "rawFile",
            runDir: this.runDir,
            eventsFile: this.eventsFile,
            relativePath: safeRelative,
            data: buffer,
            row: this.eventRow("raw_file.written", record),
          },
          { rawBytes: buffer.byteLength },
        )
      ) {
        return null;
      }
      this.bytesWritten += buffer.byteLength;
      return record;
    } catch (err) {
      log.warn({ err, relativePath }, "failed to enqueue AI forensic raw file");
      return null;
    }
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  private enqueue(
    job: ForensicWriterJob,
    opts: { rawBytes?: number } = {},
  ): boolean {
    return this.writer.enqueue(job, opts);
  }

  private eventRow(
    type: string,
    data: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const span = getActiveTraceContext();
    return {
      timestamp: new Date().toISOString(),
      type,
      forensicRunId: this.context.forensicRunId,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      context: stripUndefined(this.context),
      data: stripUndefined(data),
    };
  }
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function rawByteLength(data: string | Buffer): number {
  return Buffer.isBuffer(data)
    ? data.byteLength
    : Buffer.byteLength(data, "utf-8");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function normalizeRelativePath(value: string): string {
  const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized.replace(/^[/\\]+/, "");
}

function ensureInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`forensic path escapes run dir: ${target}`);
  }
}

function stripUndefined(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
