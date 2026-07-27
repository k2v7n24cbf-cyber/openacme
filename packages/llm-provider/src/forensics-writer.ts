import { Worker } from "node:worker_threads";
import { createLogger } from "@openacme/config/logger";

const log = createLogger("llm-provider.forensics-writer");

export interface ForensicWriterConfig {
  queueMaxJobs: number;
  queueMaxRawBytes: number;
}

export type ForensicWriterJob =
  | {
      type: "initRun";
      runDir: string;
      runJson: Record<string, unknown>;
    }
  | {
      type: "event";
      eventsFile: string;
      row: Record<string, unknown>;
    }
  | {
      type: "rawFile";
      runDir: string;
      eventsFile: string;
      relativePath: string;
      data: Uint8Array;
      row: Record<string, unknown>;
    };

interface QueuedJob {
  seq: number;
  job: ForensicWriterJob;
  rawBytes: number;
}

interface FlushWaiter {
  resolve(): void;
}

let writer: WorkerForensicWriter | null = null;
let writerKey: string | null = null;

export function getForensicWriter(
  config: ForensicWriterConfig,
): WorkerForensicWriter {
  const key = JSON.stringify(config);
  if (!writer || writerKey !== key) {
    writer?.shutdown();
    writer = new WorkerForensicWriter(config);
    writerKey = key;
  }
  return writer;
}

export async function flushForensicWriters(): Promise<void> {
  await writer?.flush();
}

export class WorkerForensicWriter {
  private readonly worker: Worker;
  private readonly queue: QueuedJob[] = [];
  private readonly flushWaiters: FlushWaiter[] = [];
  private nextSeq = 1;
  private inFlight: QueuedJob | null = null;
  private queuedRawBytes = 0;
  private failed = false;

  constructor(private readonly config: ForensicWriterConfig) {
    this.worker = new Worker(FORENSIC_WORKER_SOURCE, { eval: true });
    this.worker.unref();
    this.worker.on("message", (message) => this.handleMessage(message));
    this.worker.on("error", (err) => {
      this.failed = true;
      log.warn({ err }, "local forensic writer worker failed");
      this.resolveFlushWaiters();
    });
    this.worker.on("exit", (code) => {
      if (code !== 0 && !this.failed) {
        log.warn({ code }, "local forensic writer worker exited");
      }
      this.failed = true;
      this.resolveFlushWaiters();
    });
  }

  enqueue(job: ForensicWriterJob, opts: { rawBytes?: number } = {}): boolean {
    if (this.failed) return false;
    const rawBytes = opts.rawBytes ?? 0;
    if (this.queue.length >= this.config.queueMaxJobs) return false;
    if (
      rawBytes > 0 &&
      this.config.queueMaxRawBytes > 0 &&
      this.queuedRawBytes + rawBytes > this.config.queueMaxRawBytes
    ) {
      return false;
    }
    const queued = { seq: this.nextSeq++, job, rawBytes };
    this.queue.push(queued);
    this.queuedRawBytes += rawBytes;
    this.pump();
    return true;
  }

  flush(): Promise<void> {
    if (this.isDrained()) return Promise.resolve();
    return new Promise((resolve) => {
      this.flushWaiters.push({ resolve });
      this.pump();
    });
  }

  shutdown(): void {
    this.failed = true;
    void this.worker.terminate().catch(() => {});
    this.resolveFlushWaiters();
  }

  private pump(): void {
    if (this.failed || this.inFlight || this.queue.length === 0) {
      this.resolveFlushWaitersIfDrained();
      return;
    }
    const next = this.queue.shift()!;
    this.inFlight = next;
    this.queuedRawBytes -= next.rawBytes;
    try {
      this.worker.postMessage({ seq: next.seq, job: next.job });
    } catch (err) {
      log.warn(
        { err, jobType: next.job.type },
        "local forensic enqueue failed",
      );
      this.inFlight = null;
      this.pump();
    }
  }

  private handleMessage(message: unknown): void {
    const seq =
      message && typeof message === "object"
        ? (message as { seq?: unknown }).seq
        : undefined;
    if (this.inFlight && seq === this.inFlight.seq) {
      const ok = (message as { ok?: unknown }).ok;
      if (!ok) {
        log.warn(
          {
            error: (message as { error?: unknown }).error,
            jobType: this.inFlight.job.type,
          },
          "local forensic writer job failed",
        );
      }
      this.inFlight = null;
    }
    this.pump();
  }

  private isDrained(): boolean {
    return !this.inFlight && this.queue.length === 0;
  }

  private resolveFlushWaitersIfDrained(): void {
    if (this.isDrained()) this.resolveFlushWaiters();
  }

  private resolveFlushWaiters(): void {
    const waiters = this.flushWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }
}

const FORENSIC_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");

parentPort.on("message", async (message) => {
  try {
    await handleJob(message.job);
    parentPort.postMessage({ seq: message.seq, ok: true });
  } catch (error) {
    parentPort.postMessage({
      seq: message.seq,
      ok: false,
      error: error && typeof error === "object" && "message" in error
        ? error.message
        : String(error),
    });
  }
});

async function handleJob(job) {
  if (job.type === "initRun") {
    await ensureDir(job.runDir);
    await writeJsonFile(path.join(job.runDir, "run.json"), job.runJson);
    return;
  }
  if (job.type === "event") {
    await appendJsonLine(job.eventsFile, job.row);
    return;
  }
  if (job.type === "rawFile") {
    const abs = path.join(job.runDir, normalizeRelativePath(job.relativePath));
    ensureInside(job.runDir, abs);
    await ensureDir(path.dirname(abs));
    await fs.writeFile(abs, job.data, { mode: 0o600 });
    await chmod(abs, 0o600);
    await appendJsonLine(job.eventsFile, job.row);
  }
}

async function writeJsonFile(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(stripUndefined(data), null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

async function appendJsonLine(file, row) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, JSON.stringify(stripUndefined(row)) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function chmod(target, mode) {
  try {
    await fs.chmod(target, mode);
  } catch {
  }
}

function normalizeRelativePath(value) {
  const normalized = path.normalize(value).replace(/^(\.\.(\/|\\|$))+/, "");
  return normalized.replace(/^[/\\]+/, "");
}

function ensureInside(root, target) {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("forensic path escapes run dir: " + target);
  }
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = stripUndefined(child);
  }
  return out;
}
`;
