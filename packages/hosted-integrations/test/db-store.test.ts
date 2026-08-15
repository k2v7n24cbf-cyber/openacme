import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../config/src/schema.js";
import { createDatabase } from "../../db/src/connection.js";
import {
  createDbHostedIntegrationApprovalStore,
  createDbHostedIntegrationArtifactStore,
  createDbHostedIntegrationEnvironmentConfigStore,
  createDbHostedIntegrationDisablementStore,
  createDbHostedIntegrationDraftStore,
  createDbHostedIntegrationExecutionLogStore,
  createDbHostedIntegrationFailureBucketStore,
  createDbHostedIntegrationGenerationStore,
  createDbHostedIntegrationIdempotencyStore,
  createDbHostedIntegrationJobStore,
  createDbHostedIntegrationLockStore,
  createDbHostedIntegrationSecretStore,
  createDbHostedIntegrationService,
  FamilyManifestSchema,
  createDbHostedIntegrationSourceFileStore,
  type HostedIntegrationExecutionLogEntry,
  type HostedIntegrationCatalog,
} from "../src/index.js";

let dataDir: string;
let db: ReturnType<typeof createDatabase>;
let nowMs = Date.parse("2026-08-13T10:00:00.000Z");
let ids: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-hosted-db-store-"));
  db = createDatabase(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
  );
  nowMs = Date.parse("2026-08-13T10:00:00.000Z");
  ids = [];
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("DB-backed hosted integration stores", () => {
  it("matches file lock TTL, renewal, conflict, and release semantics", async () => {
    ids = ["lock_1"];
    const locks = lockStore();

    await expect(
      locks.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({
      ok: true,
      lock: {
        id: "lock_1",
        renewedAt: "2026-08-13T10:00:00.000Z",
        expiresAt: "2026-08-13T10:01:00.000Z",
      },
    });
    await expect(
      locks.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:other",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "locked" });

    nowMs += 30_000;
    await expect(
      locks.renewLock({
        lockId: "lock_1",
        lockedBy: "agent:other",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "conflict" });
    await expect(
      locks.renewLock({
        lockId: "lock_1",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({
      ok: true,
      lock: { expiresAt: "2026-08-13T10:01:30.000Z" },
    });

    await expect(
      locks.releaseLock({
        lockId: "lock_1",
        lockedBy: "agent:tool-developer",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(locks.getActiveLock("qualys")).resolves.toBeNull();
  });

  it("replaces source files and creates mutable drafts from DB rows", async () => {
    ids = ["lock_1", "source_rev_1", "draft_1"];
    const locks = lockStore();
    const source = sourceStore();
    const drafts = draftStore(locks);
    await acquireLock(locks);

    await expect(
      source.replaceSourceFiles({
        familyId: "qualys",
        updatedBy: "agent:tool-developer",
        files: {
          "family.yaml": familyYaml("qualys"),
          "qualys.py": "def tool_qualys_tool(args, context):\n    return {}\n",
        },
      }),
    ).resolves.toEqual({ ok: true, sourceRevisionId: "source_rev_1" });
    await expect(source.listSourceFiles("qualys")).resolves.toEqual({
      ok: true,
      files: [
        { path: "family.yaml", size: Buffer.byteLength(familyYaml("qualys")) },
        {
          path: "qualys.py",
          size: Buffer.byteLength(
            "def tool_qualys_tool(args, context):\n    return {}\n",
          ),
        },
      ],
    });

    const created = await drafts.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });
    expect(created).toMatchObject({ ok: true, draft: { id: "draft_1" } });
    await expect(
      drafts.writeDraftFile({
        draftId: "draft_1",
        lockId: "lock_1",
        path: "qualys.py",
        content:
          "def tool_qualys_tool(args, context):\n    return {'ok': True}\n",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      drafts.readDraftFile({ draftId: "draft_1", path: "qualys.py" }),
    ).resolves.toEqual({
      ok: true,
      content:
        "def tool_qualys_tool(args, context):\n    return {'ok': True}\n",
    });
  });

  it("composes DB-backed stores behind the hosted integration service port", async () => {
    ids = ["lock_1", "source_rev_1", "draft_1"];
    await writeCatalogFamily("qualys");
    const service = createDbHostedIntegrationService({
      db,
      dataDir,
      now,
      createId,
    });

    const lock = await service.locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    expect(lock).toMatchObject({ ok: true, lock: { id: "lock_1" } });
    await expect(
      service.sourceFiles.replaceSourceFiles({
        familyId: "qualys",
        updatedBy: "agent:tool-developer",
        files: {
          "family.yaml": familyYaml("qualys"),
          "qualys.py": "def tool_qualys_tool(args, context):\n    return {}\n",
        },
      }),
    ).resolves.toEqual({ ok: true, sourceRevisionId: "source_rev_1" });
    await expect(
      service.drafts.createDraft({
        familyId: "qualys",
        lockId: "lock_1",
        sourceRevisionId: "source_rev_1",
      }),
    ).resolves.toMatchObject({ ok: true, draft: { id: "draft_1" } });
    await expect(
      service.environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "test_debug",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({ ok: true, environmentConfig: { revision: 1 } });

    await service.gateway.executionLogs.startLog(baseLog());
    await service.gateway.executionLogs.finishLog("run_1", {
      status: "failed",
      endedAt: "2026-08-13T10:00:01.000Z",
      durationMs: 1000,
      error: { code: "tool_bug", message: "boom" },
    });
    await expect(
      service.gateway.executionLogs.getRunLog("run_1"),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "tool_bug" },
    });
  });

  it("promotes drafts transactionally, materializes generation files, drains, and rolls back", async () => {
    ids = ["lock_1", "draft_1", "gen_1", "gen_2"];
    const locks = lockStore();
    const drafts = draftStore(locks);
    const generations = generationStore(drafts);
    await acquireLock(locks);
    await createDraftFromFiles(drafts, "draft_1");

    const first = await generations.promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
      sourceRevisionId: "source_rev_1",
    });
    expect(first).toMatchObject({
      ok: true,
      generation: { id: "gen_1", status: "active" },
    });
    await expect(
      readFile(
        path.join(
          dataDir,
          "hosted-integrations",
          "generations",
          "gen_1",
          "files",
          "qualys.py",
        ),
        "utf-8",
      ),
    ).resolves.toContain("tool_qualys_tool");

    const lease = await generations.beginInvocation({ familyId: "qualys" });
    expect(lease).toMatchObject({
      ok: true,
      lease: { generationId: "gen_1" },
    });
    nowMs += 60_000;
    await generations.promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
      sourceRevisionId: "source_rev_2",
    });
    await expect(generations.getGeneration("gen_1")).resolves.toMatchObject({
      status: "draining",
    });
    if (lease.ok)
      await generations.completeInvocation({ leaseId: lease.lease.id });
    await expect(generations.getGeneration("gen_1")).resolves.toMatchObject({
      status: "retired",
    });

    await expect(
      generations.rollback({
        familyId: "qualys",
        generationId: "gen_1",
        rolledBackBy: "agent:tool-developer",
      }),
    ).resolves.toMatchObject({
      ok: true,
      activeGeneration: { id: "gen_1", status: "active" },
    });
    await expect(generations.getGeneration("gen_2")).resolves.toMatchObject({
      status: "retired",
    });
    expect(
      existsSync(
        path.join(dataDir, "hosted-integrations", "generations", "gen_2"),
      ),
    ).toBe(true);
  });

  it("persists execution logs with finish metadata", async () => {
    const logs = createDbHostedIntegrationExecutionLogStore({ db });
    await logs.startLog(baseLog());
    await logs.finishLog("run_1", {
      status: "succeeded",
      endedAt: "2026-08-13T10:00:01.000Z",
      durationMs: 1000,
      resultEnvelopeRef: "inline:run_1",
      resultMetadata: {
        envelopeRef: "inline:run_1",
        responseMode: "inline",
      },
    });

    await expect(logs.getRunLog("run_1")).resolves.toMatchObject({
      status: "succeeded",
      durationMs: 1000,
      resultMetadata: { responseMode: "inline" },
    });
  });

  it("lists execution logs filtered by family and sorted latest first", async () => {
    const logs = createDbHostedIntegrationExecutionLogStore({ db });
    await logs.startLog({
      ...baseLog(),
      runId: "run_old",
      familyId: "qualys",
      toolName: "qualys_tool",
      startedAt: "2026-08-13T10:00:00.000Z",
    });
    await logs.finishLog("run_old", {
      status: "succeeded",
      endedAt: "2026-08-13T10:00:01.000Z",
      durationMs: 1000,
    });
    await logs.startLog({
      ...baseLog(),
      runId: "run_new",
      familyId: "qualys",
      toolName: "qualys_tool",
      startedAt: "2026-08-13T10:00:02.000Z",
    });
    await logs.finishLog("run_new", {
      status: "failed",
      endedAt: "2026-08-13T10:00:03.000Z",
      durationMs: 1000,
      error: { code: "tool_bug", message: "boom" },
    });
    await logs.startLog({
      ...baseLog(),
      runId: "run_other",
      familyId: "jira",
      toolName: "jira_tool",
      startedAt: "2026-08-13T10:00:04.000Z",
    });

    await expect(
      logs.listRunLogs({ familyId: "qualys", limit: 10 }),
    ).resolves.toMatchObject([
      { runId: "run_new", status: "failed" },
      { runId: "run_old", status: "succeeded" },
    ]);
    await expect(
      logs.listRunLogs({ familyId: "qualys", status: "failed" }),
    ).resolves.toMatchObject([{ runId: "run_new" }]);
  });

  it("persists environment configs and secret metadata while keeping runtime secret values delegated", async () => {
    const environmentConfigs = createDbHostedIntegrationEnvironmentConfigStore({
      db,
      dataDir,
      catalog: catalogWithFamily("qualys"),
      now,
    });
    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "missing-family",
        environment: "test_debug",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({ ok: false, reason: "family_not_found" });
    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "test_debug",
        config: { endpoint: "https://qualys.example" },
        secrets: { QUALYS_API_KEY: { configured: false } },
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({
      ok: true,
      environmentConfig: { id: "qualys-test_debug", revision: 1 },
    });
    nowMs += 1_000;
    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "test_debug",
        config: { endpoint: "https://qualys.example" },
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({
      ok: true,
      environmentConfig: { id: "qualys-test_debug", revision: 2 },
    });

    const secrets = createDbHostedIntegrationSecretStore({
      db,
      dataDir,
      now,
    });
    await secrets.writeHumanOwnedSecrets({
      environmentConfigId: "qualys-test_debug",
      secrets: { QUALYS_API_KEY: "raw-token", QUALYS_USERNAME: "alen" },
      updatedBy: "human:alen",
    });
    await expect(
      secrets.getSecretMetadata({
        environmentConfigId: "qualys-test_debug",
        secretNames: ["QUALYS_API_KEY", "QUALYS_PASSWORD"],
      }),
    ).resolves.toEqual({
      environmentConfigId: "qualys-test_debug",
      secrets: {
        QUALYS_API_KEY: { configured: true },
        QUALYS_PASSWORD: { configured: false },
      },
    });
    await expect(
      secrets.readSecretsForRuntime({ environmentConfigId: "qualys-test_debug" }),
    ).resolves.toEqual({
      QUALYS_API_KEY: "raw-token",
      QUALYS_USERNAME: "alen",
    });
  });

  it("persists canonical environment configs and supports DB-backed secret metadata", async () => {
    const environmentConfigs = createDbHostedIntegrationEnvironmentConfigStore({
      db,
      dataDir,
      catalog: catalogWithFamily("qualys"),
      now,
    });
    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "stage",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_environment" });
    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "test_debug",
        config: { endpoint: "https://qualys.example" },
        secrets: { QUALYS_API_KEY: { configured: false, value: "discard" } },
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({
      ok: true,
      environmentConfig: {
        id: "qualys-test_debug",
        environment: "test_debug",
        revision: 1,
        secrets: { QUALYS_API_KEY: { configured: false } },
      },
    });

    const secrets = createDbHostedIntegrationSecretStore({
      db,
      dataDir,
      now,
    });
    await secrets.writeHumanOwnedSecrets({
      environmentConfigId: "qualys-test_debug",
      secrets: { QUALYS_API_KEY: "raw-token" },
      updatedBy: "human:alen",
    });
    await expect(
      secrets.getSecretMetadata({
        environmentConfigId: "qualys-test_debug",
        secretNames: ["QUALYS_API_KEY", "QUALYS_PASSWORD"],
      }),
    ).resolves.toEqual({
      environmentConfigId: "qualys-test_debug",
      secrets: {
        QUALYS_API_KEY: { configured: true },
        QUALYS_PASSWORD: { configured: false },
      },
    });
    await expect(environmentConfigs.listEnvironmentConfigs()).resolves.toEqual([
      expect.objectContaining({
        id: "qualys-test_debug",
        environment: "test_debug",
      }),
    ]);
  });

  it("persists approvals and disablements with the same caller-visible semantics", async () => {
    ids = ["approval_1"];
    const approvals = createDbHostedIntegrationApprovalStore({
      db,
      dataDir,
      now,
      createId,
    });
    const target = {
      familyId: "qualys",
      draftId: "draft_1",
      draftRevisionId: "rev_1",
      operation: "promote" as const,
      operationClass: "destructive" as const,
      toolNames: ["qualys_tool"],
      destructiveToolNames: ["qualys_tool"],
    };
    await expect(
      approvals.createApproval({
        actor: { id: "agent:tool-developer", kind: "agent" },
        target,
      }),
    ).resolves.toEqual({ ok: false, reason: "human_actor_required" });
    await expect(
      approvals.createApproval({
        actor: {
          id: "human:alen",
          kind: "human",
          email: "alen@example.com",
        },
        target,
      }),
    ).resolves.toMatchObject({
      ok: true,
      approval: { id: "approval_1", approvedBy: "human:alen" },
    });
    await expect(approvals.getApproval("approval_1")).resolves.toMatchObject({
      id: "approval_1",
      operationClass: "destructive",
    });

    const disablements = createDbHostedIntegrationDisablementStore({
      db,
      dataDir,
      now,
    });
    await disablements.setDisabled({
      target: { level: "tool", familyId: "qualys", toolName: "qualys_tool" },
      disabled: true,
      reason: "maintenance",
      updatedBy: "human:alen",
    });
    await expect(
      disablements.findDisabled({
        familyId: "qualys",
        toolName: "qualys_tool",
      }),
    ).resolves.toMatchObject({ disabled: true, reason: "maintenance" });
    await disablements.setDisabled({
      target: { level: "tool", familyId: "qualys", toolName: "qualys_tool" },
      disabled: false,
      updatedBy: "human:alen",
    });
    await expect(
      disablements.findDisabled({
        familyId: "qualys",
        toolName: "qualys_tool",
      }),
    ).resolves.toBeNull();
  });

  it("persists async jobs, progress events, and idempotency records", async () => {
    ids = ["job_1"];
    const jobs = createDbHostedIntegrationJobStore({
      db,
      dataDir,
      now,
      createId,
    });
    await expect(
      jobs.startJob({
        familyId: "qualys",
        toolName: "qualys_tool",
        generationId: "gen_1",
        actorId: "agent:analyst",
        executionMode: "sync",
      }),
    ).resolves.toEqual({ ok: false, reason: "sync_only" });
    await expect(
      jobs.startJob({
        familyId: "qualys",
        toolName: "qualys_tool",
        generationId: "gen_1",
        actorId: "agent:analyst",
        executionMode: "async",
        idempotencyKey: "idem_job",
        requestFingerprint: "fingerprint_1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: false,
      job: { id: "job_1", status: "queued" },
    });
    await expect(
      jobs.startJob({
        familyId: "qualys",
        toolName: "qualys_tool",
        generationId: "gen_1",
        actorId: "agent:analyst",
        executionMode: "async",
        idempotencyKey: "idem_job",
        requestFingerprint: "fingerprint_1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      replayed: true,
      job: { id: "job_1" },
    });
    nowMs += 1_000;
    await jobs.markRunning({
      jobId: "job_1",
      runId: "run_1",
      progress: { phase: "fetching" },
    });
    await jobs.updateProgress({
      jobId: "job_1",
      progress: { phase: "done", percent: 100 },
    });
    await expect(
      jobs.completeJob({
        jobId: "job_1",
        resultEnvelopeRef: "run_1/output.json",
      }),
    ).resolves.toMatchObject({
      ok: true,
      job: { status: "succeeded", resultEnvelopeRef: "run_1/output.json" },
    });
    await expect(jobs.getResult("job_1")).resolves.toEqual({
      ok: true,
      result_ref: "run_1/output.json",
    });

    const idempotency = createDbHostedIntegrationIdempotencyStore({ db });
    await expect(
      idempotency.reserve({
        key: "idem_1",
        actorId: "agent:analyst",
        target: "qualys/qualys_tool/gen_1",
        fingerprint: "fingerprint_1",
        now: now().toISOString(),
      }),
    ).resolves.toEqual({ ok: true, status: "new" });
    await idempotency.complete({
      key: "idem_1",
      resultEnvelopeRef: "run_1/output.json",
      now: now().toISOString(),
    });
    await expect(
      idempotency.reserve({
        key: "idem_1",
        actorId: "agent:analyst",
        target: "qualys/qualys_tool/gen_1",
        fingerprint: "fingerprint_1",
        now: now().toISOString(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "replay",
      record: { resultEnvelopeRef: "run_1/output.json" },
    });
  });

  it("indexes run artifacts in DB and returns large responses by artifact ref", async () => {
    ids = ["call_1"];
    const artifacts = createDbHostedIntegrationArtifactStore({
      db,
      dataDir,
      now,
      createId,
      inlineResultTokenLimit: 1,
    });
    const created = await artifacts.createRun({
      familyId: "qualys",
      toolName: "qualys_tool",
      generationId: "gen_1",
      actorId: "agent:analyst",
      input: { apiKey: "raw-token", query: "nginx" },
    });
    expect(created.run).toMatchObject({ id: "call_1", status: "running" });
    await expect(
      artifacts.readArtifact({
        familyId: "qualys",
        runId: "call_1",
        name: "input.sanitized.json",
      }),
    ).resolves.toContain("[REDACTED]");
    await expect(
      artifacts.completeRunSuccess({
        familyId: "qualys",
        runId: "call_1",
        result: { rows: Array.from({ length: 8 }, (_, index) => ({ index })) },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result_ref: {
        type: "artifact",
        run_id: "call_1",
        name: "output.json",
      },
    });
    await expect(
      artifacts.readArtifact({
        familyId: "qualys",
        runId: "call_1",
        name: "output.json",
      }),
    ).resolves.toContain('"rows"');
  });

  it("dedupes owner-actionable failure buckets like the file store", async () => {
    ids = ["bucket_1"];
    const buckets = createDbHostedIntegrationFailureBucketStore({
      db,
      dataDir,
      now,
      createId,
    });
    const failed = {
      ...baseLog(),
      status: "failed" as const,
      error: { code: "tool_bug", message: "boom 123" },
    };

    await expect(buckets.recordFailure({ log: failed })).resolves.toMatchObject(
      {
        ok: true,
        created: true,
        bucket: { id: "bucket_1", count: 1 },
      },
    );
    nowMs += 1_000;
    await expect(buckets.recordFailure({ log: failed })).resolves.toMatchObject(
      {
        ok: true,
        created: false,
        bucket: { id: "bucket_1", count: 2 },
      },
    );
    await expect(
      buckets.recordFailure({
        log: {
          ...failed,
          runId: "run_2",
          error: { code: "bad_arguments", message: "bad args" },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_owner_actionable",
      classification: "platform_policy",
    });
  });
});

function lockStore() {
  return createDbHostedIntegrationLockStore({
    db,
    dataDir,
    now,
    createId,
  });
}

function sourceStore() {
  return createDbHostedIntegrationSourceFileStore({
    db,
    dataDir,
    now,
    createId,
  });
}

function draftStore(lockStore: ReturnType<typeof lockStore>) {
  return createDbHostedIntegrationDraftStore({
    db,
    dataDir,
    lockStore,
    now,
    createId,
  });
}

function generationStore(draftStore: ReturnType<typeof draftStore>) {
  return createDbHostedIntegrationGenerationStore({
    db,
    dataDir,
    draftStore,
    now,
    createId,
  });
}

async function acquireLock(lockStore: ReturnType<typeof lockStore>) {
  await lockStore.acquireLock({
    familyId: "qualys",
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
}

async function createDraftFromFiles(
  drafts: ReturnType<typeof draftStore>,
  expectedDraftId: string,
) {
  const result = await drafts.createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: {
      "family.yaml": familyYaml("qualys"),
      "qualys.py": "def tool_qualys_tool(args, context):\n    return {}\n",
    },
  });
  expect(result).toMatchObject({ ok: true, draft: { id: expectedDraftId } });
}

function baseLog(): HostedIntegrationExecutionLogEntry {
  return {
    runId: "run_1",
    familyId: "qualys",
    toolName: "qualys_tool",
    generationId: "gen_1",
    actorId: "agent:analyst",
    environmentConfigId: "qualys-test_debug",
    configRevision: 1,
    sanitizedArgs: { query: "nginx" },
    status: "running",
    startedAt: "2026-08-13T10:00:00.000Z",
  };
}

function now(): Date {
  return new Date(nowMs);
}

function createId(): string {
  const id = ids.shift();
  if (!id) throw new Error("test id queue exhausted");
  return id;
}

function catalogWithFamily(familyId: string): HostedIntegrationCatalog {
  const manifest = FamilyManifestSchema.parse({
    id: familyId,
    name: familyId,
    version: 1,
    runtime: {
      language: "python",
      entrypoint: `${familyId}.py`,
      defaultTimeoutMs: 30000,
      inlineResultTokenLimit: 8000,
      maxConcurrency: 1,
      runtimePolicy: {
        filesystem: "run_dir_only",
        processEnv: "tool_context_only",
        subprocess: "denied",
        network: "denied",
      },
      dependencyPolicy: {
        installDuringInvocation: false,
        allowedPackages: [],
      },
    },
    tools: [
      {
        name: `${familyId}_tool`,
        title: `${familyId} tool`,
        description: `${familyId} tool.`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        classification: {
          operation: "read",
          freshness: "live",
          idempotency: "idempotent",
          execution: "sync",
          approval: "none",
        },
      },
    ],
  });
  return {
    async listFamilies() {
      return [
        {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          toolNames: manifest.tools.map((tool) => tool.name),
          status: "active" as const,
        },
      ];
    },
    async getFamily(candidateFamilyId) {
      if (candidateFamilyId !== familyId) return null;
      return {
        summary: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          toolNames: manifest.tools.map((tool) => tool.name),
          status: "active" as const,
        },
        manifest,
      };
    },
    async getDiagnostics() {
      return [];
    },
  };
}

async function writeCatalogFamily(familyId: string): Promise<void> {
  const familyDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  await mkdir(familyDir, { recursive: true });
  await writeFile(path.join(familyDir, "family.yaml"), familyYaml(familyId));
}

function familyYaml(familyId: string): string {
  return `
id: ${familyId}
name: ${familyId}
version: 1
runtime:
  language: python
  entrypoint: ${familyId}.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_only
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
tools:
  - name: ${familyId}_tool
    title: ${familyId} tool
    description: ${familyId} tool.
    inputSchema:
      type: object
      properties: {}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}
