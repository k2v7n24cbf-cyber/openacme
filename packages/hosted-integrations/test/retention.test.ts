import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
    configScopeId: "qualys-test",
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
