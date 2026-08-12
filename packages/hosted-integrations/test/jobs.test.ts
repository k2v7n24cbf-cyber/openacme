import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHostedIntegrationJobStore } from "../src/index.js";

let dataDir: string;
let jobCounter = 0;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-jobs-"));
  jobCounter = 0;
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration async job store", () => {
  it("rejects async start for sync-only tools", async () => {
    await expect(
      store().startJob({
        familyId: "qualys",
        toolName: "qualys_count_assets",
        generationId: "gen_1",
        actorId: "agent:analyst",
        executionMode: "sync",
      }),
    ).resolves.toEqual({ ok: false, reason: "sync_only" });
  });

  it("starts async tools with a job id", async () => {
    await expect(startAsyncJob()).resolves.toMatchObject({
      ok: true,
      job: {
        id: "job_1",
        familyId: "qualys",
        toolName: "qualys_export_assets",
        generationId: "gen_1",
        actorId: "agent:analyst",
        status: "queued",
      },
    });
  });

  it("status returns the latest progress snapshot", async () => {
    const started = await startAsyncJob();
    if (!started.ok) throw new Error("expected job");
    nowMs += 1_000;
    await store().markRunning({
      jobId: started.job.id,
      runId: "call_1",
      progress: { phase: "exporting", percent: 25 },
    });
    nowMs += 1_000;
    await store().updateProgress({
      jobId: started.job.id,
      progress: { phase: "uploading", percent: 75 },
    });

    await expect(store().getJob(started.job.id)).resolves.toMatchObject({
      id: "job_1",
      status: "running",
      runId: "call_1",
      progress: { phase: "uploading", percent: 75 },
    });
  });

  it("cancels only running async jobs", async () => {
    const started = await startAsyncJob();
    if (!started.ok) throw new Error("expected job");

    await expect(
      store().cancelJob({
        jobId: started.job.id,
        cancelledBy: "agent:analyst",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_running" });

    await store().markRunning({ jobId: started.job.id, runId: "call_1" });
    await expect(
      store().cancelJob({
        jobId: started.job.id,
        cancelledBy: "agent:analyst",
      }),
    ).resolves.toMatchObject({
      ok: true,
      job: { id: "job_1", status: "cancelled" },
    });
  });

  it("returns result_ref only after the async job succeeds", async () => {
    const started = await startAsyncJob();
    if (!started.ok) throw new Error("expected job");

    await expect(store().getResult(started.job.id)).resolves.toEqual({
      ok: false,
      reason: "not_ready",
    });

    await store().markRunning({ jobId: started.job.id, runId: "call_1" });
    await store().completeJob({
      jobId: started.job.id,
      resultEnvelopeRef: "call_1/output.json",
    });

    await expect(store().getResult(started.job.id)).resolves.toEqual({
      ok: true,
      result_ref: "call_1/output.json",
    });
  });
});

function store() {
  return createFileHostedIntegrationJobStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `job_${++jobCounter}`,
  });
}

function startAsyncJob() {
  return store().startJob({
    familyId: "qualys",
    toolName: "qualys_export_assets",
    generationId: "gen_1",
    actorId: "agent:analyst",
    executionMode: "async",
  });
}
