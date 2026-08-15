import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { HostedIntegrationFailureBucketSchema } from "./schemas.js";
import { isNodeError, safePathSegment } from "./file-access.js";
import type { HostedIntegrationExecutionLogEntry } from "./gateway.js";
import type { HostedIntegrationFailureBucket, JsonValue } from "./schemas.js";

export type HostedIntegrationFailureBucketClassification =
  | "owner_actionable"
  | "platform_policy"
  | "target_timeout"
  | "non_failed";

export interface FileHostedIntegrationFailureBucketStoreOptions {
  dataDir: string;
  now?: () => Date;
  createId?: () => string;
  ownerActionableTimeouts?: boolean;
}

export interface RecordHostedIntegrationFailureRequest {
  log: HostedIntegrationExecutionLogEntry;
}

export type RecordHostedIntegrationFailureResult =
  | {
      ok: true;
      created: boolean;
      bucket: HostedIntegrationFailureBucket;
    }
  | {
      ok: false;
      reason: "not_owner_actionable";
      classification: Exclude<
        HostedIntegrationFailureBucketClassification,
        "owner_actionable"
      >;
    };

export interface HostedIntegrationFailureBucketStore {
  recordFailure(
    request: RecordHostedIntegrationFailureRequest,
  ): Promise<RecordHostedIntegrationFailureResult>;
  getBucket(bucketId: string): Promise<HostedIntegrationFailureBucket | null>;
  listBuckets(): Promise<HostedIntegrationFailureBucket[]>;
  assignBucket(request: {
    bucketId: string;
    assignedTo: string;
  }): Promise<
    | { ok: true; bucket: HostedIntegrationFailureBucket }
    | { ok: false; reason: "not_found" }
  >;
  closeBucket(request: {
    bucketId: string;
  }): Promise<
    | { ok: true; bucket: HostedIntegrationFailureBucket }
    | { ok: false; reason: "not_found" }
  >;
}

export function createFileHostedIntegrationFailureBucketStore(
  options: FileHostedIntegrationFailureBucketStoreOptions,
): HostedIntegrationFailureBucketStore {
  return new FileHostedIntegrationFailureBucketStore({
    dataDir: options.dataDir,
    now: options.now ?? (() => new Date()),
    createId: options.createId ?? (() => `bucket_${randomUUID()}`),
    ownerActionableTimeouts: options.ownerActionableTimeouts ?? true,
  });
}

class FileHostedIntegrationFailureBucketStore implements HostedIntegrationFailureBucketStore {
  private readonly bucketsDir: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly ownerActionableTimeouts: boolean;

  constructor(parts: {
    dataDir: string;
    now: () => Date;
    createId: () => string;
    ownerActionableTimeouts: boolean;
  }) {
    this.bucketsDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "failure-buckets",
    );
    this.now = parts.now;
    this.createId = parts.createId;
    this.ownerActionableTimeouts = parts.ownerActionableTimeouts;
  }

  async recordFailure(
    request: RecordHostedIntegrationFailureRequest,
  ): Promise<RecordHostedIntegrationFailureResult> {
    const classification = classifyHostedIntegrationFailure(
      request.log,
      this.ownerActionableTimeouts,
    );
    if (classification !== "owner_actionable") {
      return { ok: false, reason: "not_owner_actionable", classification };
    }

    const fingerprint = fingerprintHostedIntegrationFailure(request.log);
    const existing = await this.getBucketByFingerprint(fingerprint);
    const now = this.now().toISOString();
    if (existing) {
      const bucket = HostedIntegrationFailureBucketSchema.parse({
        ...existing,
        count: existing.count + 1,
        latestSeenAt: now,
      });
      await this.writeBucket(bucket);
      return { ok: true, created: false, bucket };
    }

    const bucket = HostedIntegrationFailureBucketSchema.parse({
      id: this.createId(),
      familyId: request.log.familyId,
      toolName: request.log.toolName,
      generationId: request.log.generationId,
      fingerprint,
      status: "open",
      count: 1,
      firstSeenAt: now,
      latestSeenAt: now,
    });
    await this.writeBucket(bucket);
    return { ok: true, created: true, bucket };
  }

  async getBucket(
    bucketId: string,
  ): Promise<HostedIntegrationFailureBucket | null> {
    const buckets = await this.listBuckets();
    return buckets.find((bucket) => bucket.id === bucketId) ?? null;
  }

  async listBuckets(): Promise<HostedIntegrationFailureBucket[]> {
    let entries: string[];
    try {
      entries = await readdir(this.bucketsDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const buckets = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.readBucket(path.join(this.bucketsDir, entry))),
    );
    return buckets.sort((left, right) =>
      left.latestSeenAt.localeCompare(right.latestSeenAt),
    );
  }

  async assignBucket(request: {
    bucketId: string;
    assignedTo: string;
  }): Promise<
    | { ok: true; bucket: HostedIntegrationFailureBucket }
    | { ok: false; reason: "not_found" }
  > {
    const existing = await this.getBucket(request.bucketId);
    if (!existing) return { ok: false, reason: "not_found" };
    const bucket = HostedIntegrationFailureBucketSchema.parse({
      ...existing,
      assignedTo: request.assignedTo,
      latestSeenAt: this.now().toISOString(),
    });
    await this.writeBucket(bucket);
    return { ok: true, bucket };
  }

  async closeBucket(request: {
    bucketId: string;
  }): Promise<
    | { ok: true; bucket: HostedIntegrationFailureBucket }
    | { ok: false; reason: "not_found" }
  > {
    const existing = await this.getBucket(request.bucketId);
    if (!existing) return { ok: false, reason: "not_found" };
    const bucket = HostedIntegrationFailureBucketSchema.parse({
      ...existing,
      status: "closed",
      latestSeenAt: this.now().toISOString(),
    });
    await this.writeBucket(bucket);
    return { ok: true, bucket };
  }

  private async getBucketByFingerprint(
    fingerprint: string,
  ): Promise<HostedIntegrationFailureBucket | null> {
    try {
      return await this.readBucket(this.bucketPath(fingerprint));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async readBucket(
    filePath: string,
  ): Promise<HostedIntegrationFailureBucket> {
    return HostedIntegrationFailureBucketSchema.parse(
      JSON.parse(await readFile(filePath, "utf-8")),
    );
  }

  private async writeBucket(
    bucket: HostedIntegrationFailureBucket,
  ): Promise<void> {
    await mkdir(this.bucketsDir, { recursive: true });
    const filePath = this.bucketPath(bucket.fingerprint);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(bucket, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private bucketPath(fingerprint: string): string {
    return path.join(
      this.bucketsDir,
      `${safePathSegment("fingerprint", fingerprint)}.json`,
    );
  }
}

export function classifyHostedIntegrationFailure(
  log: HostedIntegrationExecutionLogEntry,
  ownerActionableTimeouts: boolean,
): HostedIntegrationFailureBucketClassification {
  if (log.status !== "failed" || !log.error) return "non_failed";
  if (
    [
      "approval_required",
      "auth_failed",
      "bad_arguments",
      "config_missing",
      "missing_config",
      "policy_denied",
    ].includes(log.error.code)
  ) {
    return "platform_policy";
  }
  if (
    log.error.code === "connection_error" ||
    log.error.code === "rate_limited"
  ) {
    return "target_timeout";
  }
  if (log.error.code === "timeout" && !ownerActionableTimeouts) {
    return "target_timeout";
  }
  return "owner_actionable";
}

export function fingerprintHostedIntegrationFailure(
  log: HostedIntegrationExecutionLogEntry,
): string {
  return `sha256:${sha256(
    stableStringify({
      familyId: log.familyId,
      toolName: log.toolName,
      generationId: log.generationId,
      errorCategory: log.error?.code ?? "unknown",
      normalizedErrorHash: sha256(
        stableStringify(normalizedErrorIdentity(log.error)),
      ),
      argsShapeHash: sha256(stableStringify(jsonShape(log.sanitizedArgs))),
    }),
  )}`;
}

function normalizedErrorIdentity(
  error: HostedIntegrationExecutionLogEntry["error"],
): JsonValue {
  if (!error) return null;
  return {
    code: error.code,
    message: normalizeErrorText(error.message),
    details: normalizeDetails(error.details),
  };
}

function normalizeDetails(value: JsonValue | undefined): JsonValue {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalizeDetails);
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "stack" || key === "traceback") {
        out[key] = normalizeErrorText(String(child));
        continue;
      }
      if (key === "vendorCode" || key === "exception_type") {
        out[key] = child;
      }
    }
    return out;
  }
  if (typeof value === "string") return normalizeErrorText(value);
  return value;
}

function normalizeErrorText(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/\/[^,\s)]+/g, "<path>")
    .trim();
}

function jsonShape(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(jsonShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, jsonShape(child)]),
    );
  }
  return value === null ? "null" : typeof value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
