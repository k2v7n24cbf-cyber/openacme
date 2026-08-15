import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../config/src/schema.js";
import { createDatabase } from "../../db/src/connection.js";
import {
  createDbHostedIntegrationArtifactStore,
  createDbHostedIntegrationExecutionLogStore,
  createDbHostedIntegrationFailureBucketStore,
  createDbHostedIntegrationRetentionSweeper,
  createFileHostedIntegrationArtifactStore,
  createFileHostedIntegrationExecutionLogStore,
  createFileHostedIntegrationFailureBucketStore,
  createFileHostedIntegrationRetentionSweeper,
  type HostedIntegrationExecutionLogEntry,
} from "../src/index.js";

let dataDir: string;
let runCounter = 0;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-retention-"));
  runCounter = 0;
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration retention sweeper", () => {
  it("sweeps successful old run artifacts and execution logs", async () => {
    const { runId, runDir } = await seedRun({ status: "succeeded" });
    nowMs += 2 * 24 * 60 * 60 * 1000;

    const result = await sweeper().sweep({
      successfulRunMaxAgeMs: 60 * 60 * 1000,
      failedClosedRunMaxAgeMs: 60 * 60 * 1000,
      closedBucketMaxAgeMs: 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      runsDeleted: 1,
      executionLogsDeleted: 1,
      failureBucketsDeleted: 0,
    });
    await expect(stat(runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(executionLogPath(runId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains failed old run artifacts tied to open failure buckets", async () => {
    const { runId, runDir, log } = await seedRun({ status: "failed" });
    await failureBuckets().recordFailure({ log });
    nowMs += 2 * 24 * 60 * 60 * 1000;

    const result = await sweeper().sweep({
      successfulRunMaxAgeMs: 60 * 60 * 1000,
      failedClosedRunMaxAgeMs: 60 * 60 * 1000,
      closedBucketMaxAgeMs: 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      runsDeleted: 0,
      executionLogsDeleted: 0,
      failureBucketsDeleted: 0,
    });
    await expect(stat(runDir)).resolves.toBeTruthy();
    await expect(stat(executionLogPath(runId))).resolves.toBeTruthy();
  });

  it("sweeps failed old run artifacts once their bucket is closed", async () => {
    const { runId, runDir, log } = await seedRun({ status: "failed" });
    const recorded = await failureBuckets().recordFailure({ log });
    if (!recorded.ok) throw new Error("expected bucket");
    await failureBuckets().closeBucket({ bucketId: recorded.bucket.id });
    nowMs += 2 * 24 * 60 * 60 * 1000;

    const result = await sweeper().sweep({
      successfulRunMaxAgeMs: 60 * 60 * 1000,
      failedClosedRunMaxAgeMs: 60 * 60 * 1000,
      closedBucketMaxAgeMs: 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      runsDeleted: 1,
      executionLogsDeleted: 1,
      failureBucketsDeleted: 1,
    });
    await expect(stat(runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(executionLogPath(runId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never deletes active running run directories", async () => {
    const { runId, runDir } = await seedRun({ status: "running" });
    nowMs += 2 * 24 * 60 * 60 * 1000;

    const result = await sweeper().sweep({
      successfulRunMaxAgeMs: 60 * 60 * 1000,
      failedClosedRunMaxAgeMs: 60 * 60 * 1000,
      closedBucketMaxAgeMs: 60 * 60 * 1000,
    });

    expect(result.runsDeleted).toBe(0);
    expect(result.executionLogsDeleted).toBe(0);
    await expect(stat(runDir)).resolves.toBeTruthy();
    await expect(stat(executionLogPath(runId))).resolves.toBeTruthy();
  });

  it("logs only counts and bytes, not artifact content", async () => {
    await seedRun({
      status: "succeeded",
      result: { token: "super-secret-token", safe: "visible" },
    });
    nowMs += 2 * 24 * 60 * 60 * 1000;
    const messages: unknown[] = [];

    const result = await sweeper({
      info: (entry) => messages.push(entry),
    }).sweep({
      successfulRunMaxAgeMs: 60 * 60 * 1000,
      failedClosedRunMaxAgeMs: 60 * 60 * 1000,
      closedBucketMaxAgeMs: 60 * 60 * 1000,
    });

    expect(result.bytesDeleted).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toContain("runsDeleted");
    expect(JSON.stringify(messages)).not.toContain("super-secret-token");
    expect(JSON.stringify(messages)).not.toContain("visible");
  });
});

describe("DB-backed hosted integration retention sweeper", () => {
  it("sweeps by DB metadata without scanning unrelated run directories", async () => {
    const db = createTestDatabase();
    try {
      const { runId, runDir } = await seedDbRun(db, { status: "succeeded" });
      const orphanDir = path.join(
        dataDir,
        "hosted-integrations",
        "workspaces",
        "qualys",
        "runs",
        "orphan_without_db_row",
      );
      await mkdir(orphanDir, { recursive: true });
      await writeFile(path.join(orphanDir, "keep.txt"), "not indexed");
      nowMs += 2 * 24 * 60 * 60 * 1000;

      const result = await createDbHostedIntegrationRetentionSweeper({
        db,
        dataDir,
        now: () => new Date(nowMs),
      }).sweep({
        successfulRunMaxAgeMs: 60 * 60 * 1000,
        failedClosedRunMaxAgeMs: 60 * 60 * 1000,
        closedBucketMaxAgeMs: 60 * 60 * 1000,
      });

      expect(result).toMatchObject({
        runsDeleted: 1,
        executionLogsDeleted: 1,
        failureBucketsDeleted: 0,
      });
      expect(result.bytesDeleted).toBeGreaterThan(0);
      await expect(stat(runDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(orphanDir)).resolves.toBeTruthy();
      expect(
        db
          .prepare("SELECT retention_state FROM hosted_integration_runs WHERE id = ?")
          .get(runId),
      ).toMatchObject({ retention_state: "deleted" });
      expect(
        db
          .prepare("SELECT run_id FROM hosted_integration_execution_logs WHERE run_id = ?")
          .get(runId),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("retains failed DB run artifacts while an owner-actionable bucket is open", async () => {
    const db = createTestDatabase();
    try {
      const { runId, runDir, log } = await seedDbRun(db, { status: "failed" });
      await createDbHostedIntegrationFailureBucketStore({
        db,
        dataDir,
        now: () => new Date(nowMs),
        createId: () => "bucket_1",
      }).recordFailure({ log });
      nowMs += 2 * 24 * 60 * 60 * 1000;

      const result = await createDbHostedIntegrationRetentionSweeper({
        db,
        dataDir,
        now: () => new Date(nowMs),
      }).sweep({
        successfulRunMaxAgeMs: 60 * 60 * 1000,
        failedClosedRunMaxAgeMs: 60 * 60 * 1000,
        closedBucketMaxAgeMs: 60 * 60 * 1000,
      });

      expect(result).toMatchObject({
        runsDeleted: 0,
        executionLogsDeleted: 0,
        failureBucketsDeleted: 0,
      });
      await expect(stat(runDir)).resolves.toBeTruthy();
      expect(
        db
          .prepare("SELECT retention_state FROM hosted_integration_runs WHERE id = ?")
          .get(runId),
      ).toMatchObject({ retention_state: "active" });
    } finally {
      db.close();
    }
  });
});

function artifacts() {
  return createFileHostedIntegrationArtifactStore({
    dataDir,
    now: () => new Date(nowMs),
    createRunId: () => `call_${++runCounter}`,
  });
}

function logs() {
  return createFileHostedIntegrationExecutionLogStore({ dataDir });
}

function failureBuckets() {
  return createFileHostedIntegrationFailureBucketStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `bucket_${runCounter}`,
  });
}

function sweeper(logger?: { info(entry: unknown): void }) {
  return createFileHostedIntegrationRetentionSweeper({
    dataDir,
    now: () => new Date(nowMs),
    logger,
  });
}

async function seedRun(input: {
  status: "running" | "succeeded" | "failed";
  result?: unknown;
}): Promise<{
  runId: string;
  runDir: string;
  log: HostedIntegrationExecutionLogEntry;
}> {
  const artifactStore = artifacts();
  const { run, runDir } = await artifactStore.createRun({
    familyId: "qualys",
    toolName: "qualys_count_assets",
    generationId: "gen_1",
    actorId: "agent:analyst",
    input: {},
  });
  const log: HostedIntegrationExecutionLogEntry = {
    runId: run.id,
    familyId: run.familyId,
    toolName: run.toolName,
    generationId: run.generationId,
    actorId: "agent:analyst",
    environmentConfigId: "qualys-test_debug",
    configRevision: 1,
    sanitizedArgs: {},
    status: input.status,
    startedAt: run.startedAt,
    ...(input.status === "running"
      ? {}
      : { endedAt: new Date(nowMs).toISOString(), durationMs: 0 }),
    ...(input.status === "failed"
      ? { error: { code: "tool_bug", message: "ValueError: boom" } }
      : {}),
  };
  await logs().startLog(log);

  if (input.status === "succeeded") {
    await artifactStore.completeRunSuccess({
      runId: run.id,
      familyId: run.familyId,
      result: input.result ?? { ok: true },
    });
  }
  if (input.status === "failed") {
    await artifactStore.completeRunError({
      runId: run.id,
      familyId: run.familyId,
      error: log.error ?? { code: "tool_bug", message: "boom" },
    });
  }
  if (input.status === "running") {
    await mkdir(path.join(runDir, "tmp"), { recursive: true });
    await writeFile(path.join(runDir, "tmp", "in-flight.txt"), "work");
  }
  return { runId: run.id, runDir, log };
}

function executionLogPath(runId: string): string {
  return path.join(
    dataDir,
    "hosted-integrations",
    "execution-logs",
    `${runId}.json`,
  );
}

function createTestDatabase() {
  return createDatabase(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
  );
}

async function seedDbRun(
  db: ReturnType<typeof createDatabase>,
  input: {
    status: "running" | "succeeded" | "failed";
    result?: unknown;
  },
): Promise<{
  runId: string;
  runDir: string;
  log: HostedIntegrationExecutionLogEntry;
}> {
  const artifactStore = createDbHostedIntegrationArtifactStore({
    db,
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `call_${++runCounter}`,
  });
  const { run, runDir } = await artifactStore.createRun({
    familyId: "qualys",
    toolName: "qualys_count_assets",
    generationId: "gen_1",
    actorId: "agent:analyst",
    input: {},
  });
  const log: HostedIntegrationExecutionLogEntry = {
    runId: run.id,
    familyId: run.familyId,
    toolName: run.toolName,
    generationId: run.generationId,
    actorId: "agent:analyst",
    environmentConfigId: "qualys-test_debug",
    configRevision: 1,
    sanitizedArgs: {},
    status: input.status,
    startedAt: run.startedAt,
    ...(input.status === "running"
      ? {}
      : { endedAt: new Date(nowMs).toISOString(), durationMs: 0 }),
    ...(input.status === "failed"
      ? { error: { code: "tool_bug", message: "ValueError: boom" } }
      : {}),
  };
  await createDbHostedIntegrationExecutionLogStore({ db }).startLog(log);

  if (input.status === "succeeded") {
    await artifactStore.completeRunSuccess({
      runId: run.id,
      familyId: run.familyId,
      result: input.result ?? { ok: true },
    });
  }
  if (input.status === "failed") {
    await artifactStore.completeRunError({
      runId: run.id,
      familyId: run.familyId,
      error: log.error ?? { code: "tool_bug", message: "boom" },
    });
  }
  return { runId: run.id, runDir, log };
}
