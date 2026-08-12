import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNodeError, safePathSegment } from "./file-access.js";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationJobSchema,
  HostedIntegrationToolNameSchema,
  JsonObjectSchema,
  type HostedIntegrationExecutionMode,
  type HostedIntegrationJob,
  type JsonObject,
} from "./schemas.js";

export interface FileHostedIntegrationJobStoreOptions {
  dataDir: string;
  now?: () => Date;
  createId?: () => string;
}

export interface StartHostedIntegrationJobRequest {
  familyId: string;
  toolName: string;
  generationId: string;
  actorId: string;
  executionMode: HostedIntegrationExecutionMode;
  idempotencyKey?: string;
  requestFingerprint?: string;
}

export type StartHostedIntegrationJobResult =
  | { ok: true; replayed: boolean; job: HostedIntegrationJob }
  | { ok: false; reason: "sync_only" | "idempotency_conflict" };

export interface MarkHostedIntegrationJobRunningRequest {
  jobId: string;
  runId: string;
  progress?: JsonObject;
}

export interface UpdateHostedIntegrationJobProgressRequest {
  jobId: string;
  progress: JsonObject;
}

export interface CompleteHostedIntegrationJobRequest {
  jobId: string;
  resultEnvelopeRef: string;
}

export interface FailHostedIntegrationJobRequest {
  jobId: string;
  error: JsonObject;
}

export interface CancelHostedIntegrationJobRequest {
  jobId: string;
  cancelledBy: string;
}

export type MutateHostedIntegrationJobResult =
  | { ok: true; job: HostedIntegrationJob }
  | { ok: false; reason: "not_found" | "not_running" | "terminal" };

export type GetHostedIntegrationJobResultResult =
  | { ok: true; result_ref: string }
  | { ok: false; reason: "not_found" | "not_ready" | "failed" | "cancelled" };

export interface HostedIntegrationJobStore {
  startJob(
    request: StartHostedIntegrationJobRequest,
  ): Promise<StartHostedIntegrationJobResult>;
  getJob(jobId: string): Promise<HostedIntegrationJob | null>;
  markRunning(
    request: MarkHostedIntegrationJobRunningRequest,
  ): Promise<MutateHostedIntegrationJobResult>;
  updateProgress(
    request: UpdateHostedIntegrationJobProgressRequest,
  ): Promise<MutateHostedIntegrationJobResult>;
  completeJob(
    request: CompleteHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult>;
  failJob(
    request: FailHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult>;
  cancelJob(
    request: CancelHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult>;
  getResult(jobId: string): Promise<GetHostedIntegrationJobResultResult>;
}

export function createFileHostedIntegrationJobStore(
  options: FileHostedIntegrationJobStoreOptions,
): HostedIntegrationJobStore {
  return new FileHostedIntegrationJobStore({
    dataDir: options.dataDir,
    now: options.now ?? (() => new Date()),
    createId: options.createId ?? (() => `job_${randomUUID()}`),
  });
}

class FileHostedIntegrationJobStore implements HostedIntegrationJobStore {
  private readonly jobsDir: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(parts: {
    dataDir: string;
    now: () => Date;
    createId: () => string;
  }) {
    this.jobsDir = path.join(parts.dataDir, "hosted-integrations", "jobs");
    this.now = parts.now;
    this.createId = parts.createId;
  }

  async startJob(
    request: StartHostedIntegrationJobRequest,
  ): Promise<StartHostedIntegrationJobResult> {
    if (request.executionMode !== "async") {
      return { ok: false, reason: "sync_only" };
    }
    if (request.idempotencyKey) {
      const existing = await this.getJobByIdempotencyKey(
        request.idempotencyKey,
      );
      if (existing) {
        if (
          existing.requestFingerprint !== request.requestFingerprint ||
          !request.requestFingerprint
        ) {
          return { ok: false, reason: "idempotency_conflict" };
        }
        return { ok: true, replayed: true, job: existing };
      }
    }
    const now = this.now().toISOString();
    const job = HostedIntegrationJobSchema.parse({
      id: this.createId(),
      familyId: HostedIntegrationFamilyIdSchema.parse(request.familyId),
      toolName: HostedIntegrationToolNameSchema.parse(request.toolName),
      generationId: request.generationId,
      actorId: request.actorId,
      ...(request.idempotencyKey
        ? { idempotencyKey: request.idempotencyKey }
        : {}),
      ...(request.requestFingerprint
        ? { requestFingerprint: request.requestFingerprint }
        : {}),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    await this.writeJob(job);
    return { ok: true, replayed: false, job };
  }

  async getJob(jobId: string): Promise<HostedIntegrationJob | null> {
    try {
      return HostedIntegrationJobSchema.parse(
        JSON.parse(await readFile(this.jobPath(jobId), "utf-8")),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async markRunning(
    request: MarkHostedIntegrationJobRunningRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    return this.mutateJob(request.jobId, (job) => {
      if (isTerminal(job.status)) return { ok: false, reason: "terminal" };
      return {
        ok: true,
        job: {
          ...job,
          runId: request.runId,
          status: "running",
          ...(request.progress ? { progress: request.progress } : {}),
        },
      };
    });
  }

  async updateProgress(
    request: UpdateHostedIntegrationJobProgressRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    const progress = JsonObjectSchema.parse(request.progress);
    return this.mutateJob(request.jobId, (job) => {
      if (job.status !== "running") return { ok: false, reason: "not_running" };
      return { ok: true, job: { ...job, progress } };
    });
  }

  async completeJob(
    request: CompleteHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    return this.mutateJob(request.jobId, (job) => {
      if (job.status !== "running") return { ok: false, reason: "not_running" };
      return {
        ok: true,
        job: {
          ...job,
          status: "succeeded",
          resultEnvelopeRef: request.resultEnvelopeRef,
        },
      };
    });
  }

  async failJob(
    request: FailHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    const error = JsonObjectSchema.parse(request.error);
    return this.mutateJob(request.jobId, (job) => {
      if (isTerminal(job.status)) return { ok: false, reason: "terminal" };
      return { ok: true, job: { ...job, status: "failed", error } };
    });
  }

  async cancelJob(
    request: CancelHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    return this.mutateJob(request.jobId, (job) => {
      if (job.status !== "running") return { ok: false, reason: "not_running" };
      return {
        ok: true,
        job: {
          ...job,
          status: "cancelled",
          cancelledBy: request.cancelledBy,
        },
      };
    });
  }

  async getResult(jobId: string): Promise<GetHostedIntegrationJobResultResult> {
    const job = await this.getJob(jobId);
    if (!job) return { ok: false, reason: "not_found" };
    if (job.status === "failed") return { ok: false, reason: "failed" };
    if (job.status === "cancelled") return { ok: false, reason: "cancelled" };
    if (job.status !== "succeeded" || !job.resultEnvelopeRef) {
      return { ok: false, reason: "not_ready" };
    }
    return { ok: true, result_ref: job.resultEnvelopeRef };
  }

  private async mutateJob(
    jobId: string,
    mutate: (job: HostedIntegrationJob) => MutateHostedIntegrationJobResult,
  ): Promise<MutateHostedIntegrationJobResult> {
    const existing = await this.getJob(jobId);
    if (!existing) return { ok: false, reason: "not_found" };
    const result = mutate(existing);
    if (!result.ok) return result;
    const job = HostedIntegrationJobSchema.parse({
      ...result.job,
      updatedAt: this.now().toISOString(),
    });
    await this.writeJob(job);
    return { ok: true, job };
  }

  private async writeJob(job: HostedIntegrationJob): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    const filePath = this.jobPath(job.id);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(job, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private jobPath(jobId: string): string {
    return path.join(this.jobsDir, `${safePathSegment("jobId", jobId)}.json`);
  }

  private async getJobByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<HostedIntegrationJob | null> {
    let entries: string[];
    try {
      entries = await readdir(this.jobsDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const job = await this.getJob(entry.slice(0, -".json".length));
      if (job?.idempotencyKey === idempotencyKey) return job;
    }
    return null;
  }
}

function isTerminal(status: HostedIntegrationJob["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}
