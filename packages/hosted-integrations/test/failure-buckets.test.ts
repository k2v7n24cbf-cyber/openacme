import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationFailureBucketStore,
  type HostedIntegrationExecutionLogEntry,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let bucketCounter = 0;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-failure-buckets-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  bucketCounter = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration failure bucket dedupe", () => {
  it("increments the same bucket for the same owner-actionable failure", async () => {
    const store = createStore();

    const first = await store.recordFailure({ log: failedLog("run_1") });
    nowMs += 1000;
    const second = await store.recordFailure({ log: failedLog("run_2") });

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) throw new Error("expected buckets");
    expect(second.bucket.id).toBe(first.bucket.id);
    expect(second.bucket.count).toBe(2);
    expect(second.bucket.firstSeenAt).toBe(first.bucket.firstSeenAt);
    expect(second.bucket.latestSeenAt).toBe("2026-08-12T10:00:01.000Z");
  });

  it("creates a distinct bucket for a different generation", async () => {
    const store = createStore();

    const first = await store.recordFailure({ log: failedLog("run_1") });
    const second = await store.recordFailure({
      log: failedLog("run_2", { generationId: "gen_2" }),
    });

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: true });
    if (!first.ok || !second.ok) throw new Error("expected buckets");
    expect(second.bucket.id).not.toBe(first.bucket.id);
    expect(second.bucket.count).toBe(1);
  });

  it("does not create repair buckets for policy_denied failures", async () => {
    const store = createStore();

    await expect(
      store.recordFailure({
        log: failedLog("run_1", {
          error: {
            code: "policy_denied",
            message: "hosted integration tool is not enabled for agent",
          },
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "not_owner_actionable",
      classification: "platform_policy",
    });
    await expect(store.listBuckets()).resolves.toEqual([]);
  });

  it("does not create repair buckets for caller argument failures", async () => {
    const store = createStore();

    await expect(
      store.recordFailure({
        log: failedLog("run_1", {
          error: {
            code: "bad_arguments",
            message: "invalid filter field",
          },
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "not_owner_actionable",
      classification: "platform_policy",
    });
    await expect(store.listBuckets()).resolves.toEqual([]);
  });

  it("can classify target timeouts as non-owner-actionable by policy", async () => {
    const store = createStore({ ownerActionableTimeouts: false });

    await expect(
      store.recordFailure({
        log: failedLog("run_1", {
          error: { code: "timeout", message: "timed out after 1000ms" },
        }),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "not_owner_actionable",
      classification: "target_timeout",
    });
  });
});

function createStore(options: { ownerActionableTimeouts?: boolean } = {}) {
  return createFileHostedIntegrationFailureBucketStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `bucket_${++bucketCounter}`,
    ownerActionableTimeouts: options.ownerActionableTimeouts,
  });
}

function failedLog(
  runId: string,
  overrides: Partial<HostedIntegrationExecutionLogEntry> = {},
): HostedIntegrationExecutionLogEntry {
  return {
    runId,
    familyId: "qualys",
    toolName: "qualys_count_assets",
    generationId: "gen_1",
    actorId: "agent:analyst",
    environmentConfigId: "qualys-test_debug",
    configRevision: 1,
    sanitizedArgs: {
      query: "severity:5",
      token: "[REDACTED]",
    },
    status: "failed",
    startedAt: "2026-08-12T09:59:59.000Z",
    endedAt: "2026-08-12T10:00:00.000Z",
    durationMs: 1000,
    error: {
      code: "tool_bug",
      message: "ValueError: bad asset id 12345",
      details: {
        exception_type: "ValueError",
        vendorCode: "E_ASSET",
        stack: "File /tmp/run/a.py, line 10, in call_tool",
      },
    },
    ...overrides,
  };
}
