import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isNodeError } from "./file-access.js";
import { fingerprintHostedIntegrationFailure } from "./failure-buckets.js";
import type { HostedIntegrationExecutionLogEntry } from "./gateway.js";
import type {
  HostedIntegrationFailureBucket,
  HostedIntegrationRun,
} from "./schemas.js";

export interface FileHostedIntegrationRetentionSweeperOptions {
  dataDir: string;
  now?: () => Date;
  logger?: { info(entry: HostedIntegrationRetentionSweepLog): void };
}

export interface HostedIntegrationRetentionPolicy {
  successfulRunMaxAgeMs: number;
  failedClosedRunMaxAgeMs: number;
  closedBucketMaxAgeMs: number;
}

export interface HostedIntegrationRetentionSweepResult {
  runsDeleted: number;
  executionLogsDeleted: number;
  failureBucketsDeleted: number;
  bytesDeleted: number;
}

export interface HostedIntegrationRetentionSweepLog extends HostedIntegrationRetentionSweepResult {
  event: "hosted_integration_retention_sweep";
}

export interface HostedIntegrationRetentionSweeper {
  sweep(
    policy: HostedIntegrationRetentionPolicy,
  ): Promise<HostedIntegrationRetentionSweepResult>;
}

export function createFileHostedIntegrationRetentionSweeper(
  options: FileHostedIntegrationRetentionSweeperOptions,
): HostedIntegrationRetentionSweeper {
  return new FileHostedIntegrationRetentionSweeper({
    dataDir: options.dataDir,
    now: options.now ?? (() => new Date()),
    logger: options.logger,
  });
}

class FileHostedIntegrationRetentionSweeper implements HostedIntegrationRetentionSweeper {
  private readonly root: string;
  private readonly workspacesDir: string;
  private readonly executionLogsDir: string;
  private readonly failureBucketsDir: string;
  private readonly now: () => Date;
  private readonly logger?: {
    info(entry: HostedIntegrationRetentionSweepLog): void;
  };

  constructor(
    parts: Required<
      Omit<FileHostedIntegrationRetentionSweeperOptions, "logger">
    > & {
      logger?: { info(entry: HostedIntegrationRetentionSweepLog): void };
    },
  ) {
    this.root = path.join(parts.dataDir, "hosted-integrations");
    this.workspacesDir = path.join(this.root, "workspaces");
    this.executionLogsDir = path.join(this.root, "execution-logs");
    this.failureBucketsDir = path.join(this.root, "failure-buckets");
    this.now = parts.now;
    this.logger = parts.logger;
  }

  async sweep(
    policy: HostedIntegrationRetentionPolicy,
  ): Promise<HostedIntegrationRetentionSweepResult> {
    assertPolicy(policy);
    const logs = await this.readExecutionLogs();
    const buckets = await this.readFailureBuckets();
    const openBucketFingerprints = new Set(
      buckets
        .filter((entry) => entry.bucket.status === "open")
        .map((entry) => entry.bucket.fingerprint),
    );
    const protectedRunIds = new Set(
      logs
        .filter(
          (entry) =>
            entry.log.status === "failed" &&
            entry.log.error &&
            openBucketFingerprints.has(
              fingerprintHostedIntegrationFailure(entry.log),
            ),
        )
        .map((entry) => entry.log.runId),
    );

    const result: HostedIntegrationRetentionSweepResult = {
      runsDeleted: 0,
      executionLogsDeleted: 0,
      failureBucketsDeleted: 0,
      bytesDeleted: 0,
    };

    await this.sweepRunDirectories(policy, protectedRunIds, result);
    await this.sweepExecutionLogs(policy, protectedRunIds, logs, result);
    await this.sweepClosedBuckets(policy, buckets, result);

    this.logger?.info({
      event: "hosted_integration_retention_sweep",
      ...result,
    });
    return result;
  }

  private async sweepRunDirectories(
    policy: HostedIntegrationRetentionPolicy,
    protectedRunIds: Set<string>,
    result: HostedIntegrationRetentionSweepResult,
  ): Promise<void> {
    const familyDirs = await readDirectoryEntries(this.workspacesDir);
    for (const familyDir of familyDirs.filter((entry) => entry.isDirectory())) {
      const runsDir = path.join(this.workspacesDir, familyDir.name, "runs");
      const runDirs = await readDirectoryEntries(runsDir);
      for (const runDirEntry of runDirs.filter((entry) =>
        entry.isDirectory(),
      )) {
        const runDir = path.join(runsDir, runDirEntry.name);
        const run = await readJsonFile<HostedIntegrationRun>(
          path.join(runDir, "metadata.json"),
        );
        if (!run || run.status === "running") continue;
        if (protectedRunIds.has(run.id)) continue;
        if (
          !isExpired(
            run.endedAt ?? run.startedAt,
            policyForRun(run, policy),
            this.now(),
          )
        ) {
          continue;
        }
        result.bytesDeleted += await byteSize(runDir);
        await rm(runDir, { recursive: true, force: true });
        result.runsDeleted += 1;
      }
    }
  }

  private async sweepExecutionLogs(
    policy: HostedIntegrationRetentionPolicy,
    protectedRunIds: Set<string>,
    logs: Array<{ log: HostedIntegrationExecutionLogEntry; filePath: string }>,
    result: HostedIntegrationRetentionSweepResult,
  ): Promise<void> {
    for (const entry of logs) {
      if (entry.log.status === "running") continue;
      if (protectedRunIds.has(entry.log.runId)) continue;
      if (
        !isExpired(
          entry.log.endedAt ?? entry.log.startedAt,
          policyForLog(entry.log, policy),
          this.now(),
        )
      ) {
        continue;
      }
      result.bytesDeleted += await byteSize(entry.filePath);
      await rm(entry.filePath, { force: true });
      result.executionLogsDeleted += 1;
    }
  }

  private async sweepClosedBuckets(
    policy: HostedIntegrationRetentionPolicy,
    buckets: Array<{
      bucket: HostedIntegrationFailureBucket;
      filePath: string;
    }>,
    result: HostedIntegrationRetentionSweepResult,
  ): Promise<void> {
    for (const entry of buckets) {
      if (entry.bucket.status !== "closed") continue;
      if (
        !isExpired(
          entry.bucket.latestSeenAt,
          policy.closedBucketMaxAgeMs,
          this.now(),
        )
      ) {
        continue;
      }
      result.bytesDeleted += await byteSize(entry.filePath);
      await rm(entry.filePath, { force: true });
      result.failureBucketsDeleted += 1;
    }
  }

  private async readExecutionLogs(): Promise<
    Array<{ log: HostedIntegrationExecutionLogEntry; filePath: string }>
  > {
    const entries = await readDirectoryEntries(this.executionLogsDir);
    const logs: Array<{
      log: HostedIntegrationExecutionLogEntry;
      filePath: string;
    }> = [];
    for (const entry of entries.filter(
      (candidate) => candidate.isFile() && candidate.name.endsWith(".json"),
    )) {
      const filePath = path.join(this.executionLogsDir, entry.name);
      const log =
        await readJsonFile<HostedIntegrationExecutionLogEntry>(filePath);
      if (log) logs.push({ log, filePath });
    }
    return logs;
  }

  private async readFailureBuckets(): Promise<
    Array<{ bucket: HostedIntegrationFailureBucket; filePath: string }>
  > {
    const entries = await readDirectoryEntries(this.failureBucketsDir);
    const buckets: Array<{
      bucket: HostedIntegrationFailureBucket;
      filePath: string;
    }> = [];
    for (const entry of entries.filter(
      (candidate) => candidate.isFile() && candidate.name.endsWith(".json"),
    )) {
      const filePath = path.join(this.failureBucketsDir, entry.name);
      const bucket =
        await readJsonFile<HostedIntegrationFailureBucket>(filePath);
      if (bucket) buckets.push({ bucket, filePath });
    }
    return buckets;
  }
}

async function readDirectoryEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function byteSize(filePath: string): Promise<number> {
  const entry = await stat(filePath);
  if (entry.isFile()) return entry.size;
  if (!entry.isDirectory()) return 0;
  const children = await readdir(filePath, { withFileTypes: true });
  let total = 0;
  for (const child of children) {
    total += await byteSize(path.join(filePath, child.name));
  }
  return total;
}

function policyForRun(
  run: HostedIntegrationRun,
  policy: HostedIntegrationRetentionPolicy,
): number {
  return run.status === "succeeded"
    ? policy.successfulRunMaxAgeMs
    : policy.failedClosedRunMaxAgeMs;
}

function policyForLog(
  log: HostedIntegrationExecutionLogEntry,
  policy: HostedIntegrationRetentionPolicy,
): number {
  return log.status === "succeeded"
    ? policy.successfulRunMaxAgeMs
    : policy.failedClosedRunMaxAgeMs;
}

function isExpired(timestamp: string, maxAgeMs: number, now: Date): boolean {
  const then = Date.parse(timestamp);
  return Number.isFinite(then) && now.getTime() - then > maxAgeMs;
}

function assertPolicy(policy: HostedIntegrationRetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
}
