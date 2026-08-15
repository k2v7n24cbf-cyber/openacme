import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationEnvironmentConfigStore,
  createFileHostedIntegrationGateway,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationPythonRuntime,
} from "../src/index.js";

let dataDir: string;
let generationCounter = 0;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-exec-log-"));
  generationCounter = 0;
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  await seedSourceFamily();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const actor: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

describe("hosted integration execution logs", () => {
  it("writes completed logs with sanitized args, result metadata, and duration", async () => {
    const runtime = fakeRuntime({
      result: { count: 2, apiToken: "token_123" },
      elapsedMs: 250,
    });
    const generation = await seedPromotedGeneration();
    await seedConfig();
    const instance = createFileHostedIntegrationGateway({
      dataDir,
      runtime,
      now: () => new Date(nowMs),
    });

    const result = await instance.invoke(
      allowedInvocation({ args: { query: "severity:5", apiToken: "token_123" } }),
    );
    if (!result.ok || result.replayed) {
      throw new Error(`invoke failed: ${JSON.stringify(result)}`);
    }

    const log = await instance.executionLogs.getRunLog(result.runId);
    expect(log).toMatchObject({
      runId: result.runId,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: generation.id,
      actorId: "agent:analyst",
      environmentConfigId: "qualys-test_debug",
      configRevision: 1,
      status: "succeeded",
      sanitizedArgs: {
        query: "severity:5",
        apiToken: "[REDACTED]",
      },
      durationMs: 250,
      resultMetadata: {
        envelopeRef: `${result.runId}/output.json`,
        responseMode: "inline",
      },
    });
    expect(JSON.stringify(log)).not.toContain("token_123");

    const rawLog = await readExecutionLog(result.runId);
    expect(rawLog).not.toContain("token_123");
  });

  it("writes failed logs with sanitized args and normalized sanitized errors", async () => {
    const runtime = fakeRuntime({
      error: {
        code: "tool_bug",
        message: "ValueError: raw-token failed",
        details: { token: "token_123", stdout: "raw-token" },
      },
      elapsedMs: 75,
    });
    await seedPromotedGeneration();
    await seedConfig();
    const instance = createFileHostedIntegrationGateway({
      dataDir,
      runtime,
      now: () => new Date(nowMs),
    });

    const result = await instance.invoke(
      allowedInvocation({
        args: { query: "severity:5", password: "token_123" },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "tool_bug" },
    });
    if (result.ok || !result.runId) throw new Error("expected failed run");

    const log = await instance.executionLogs.getRunLog(result.runId);
    expect(log).toMatchObject({
      runId: result.runId,
      status: "failed",
      sanitizedArgs: {
        query: "severity:5",
        password: "[REDACTED]",
      },
      durationMs: 75,
      error: {
        code: "tool_bug",
        message: "ValueError: [REDACTED] failed",
        details: { token: "[REDACTED]", stdout: "[REDACTED]" },
      },
    });
    expect(JSON.stringify(log)).not.toContain("token_123");
    expect(JSON.stringify(log)).not.toContain("raw-token");

    const rawLog = await readExecutionLog(result.runId);
    expect(rawLog).not.toContain("token_123");
    expect(rawLog).not.toContain("raw-token");
  });
});

function allowedInvocation(
  overrides: Partial<
    Parameters<ReturnType<typeof createFileHostedIntegrationGateway>["invoke"]>[0]
  > = {},
) {
  return {
    actor,
    familyId: "qualys",
    toolName: "qualys_count_assets",
    environment: "test_debug",
    args: { query: "severity:5" },
    hostedToolBindings: [
      {
        agentId: "agent:analyst",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedEnvironments: ["test_debug"],
        defaultEnvironment: "test_debug",
        generationPin: { type: "current" },
        bindingKind: "agent",
        updatedAt: "2026-08-14T10:00:00.000Z",
        updatedBy: "human:test",
      },
    ],
    ...overrides,
  };
}

async function seedSourceFamily(): Promise<void> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "family.yaml"), familyYaml(), "utf-8");
  await writeFile(path.join(sourceDir, "qualys.py"), "def run(): pass\n");
}

async function seedPromotedGeneration() {
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => "lock_1",
  });
  await lockStore.acquireLock({
    familyId: "qualys",
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const draftStore = createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    now: () => new Date(nowMs),
    createId: () => "draft_1",
  });
  const draft = await draftStore.createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: {
      "family.yaml": familyYaml(),
      "qualys.py": "def run(): pass\n",
    },
  });
  if (!draft.ok) throw new Error(draft.reason);
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore,
    now: () => new Date(nowMs),
    createId: () => `gen_${++generationCounter}`,
  }).promoteDraft({
    draftId: draft.draft.id,
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  return promoted.generation;
}

async function seedConfig(): Promise<void> {
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertEnvironmentConfig({
    familyId: "qualys",
    environment: "test_debug",
    config: { endpoint: "https://qualys.example.test" },
    secrets: { apiToken: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId: "qualys-test_debug",
    secrets: { apiToken: "token_123" },
    updatedBy: "human:operator",
  });
}

async function readExecutionLog(runId: string): Promise<string> {
  return readFile(
    path.join(dataDir, "hosted-integrations", "execution-logs", `${runId}.json`),
    "utf-8",
  );
}

function familyYaml(): string {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 1000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
runtimeConfig:
  requiredConfigKeys:
    - endpoint
  requiredSecretKeys:
    - apiToken
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets matching a safe query.
    inputSchema:
      type: object
      properties:
        query:
          type: string
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

interface FakeRuntime {
  calls: Array<{ generationId: string; toolName: string }>;
  callTool: HostedIntegrationPythonRuntime["callTool"];
}

function fakeRuntime(output: {
  result?: unknown;
  error?: {
    code: "runtime_error" | "timeout" | "tool_bug";
    message: string;
    details?: unknown;
  };
  elapsedMs?: number;
}): FakeRuntime {
  const runtime: FakeRuntime = {
    calls: [],
    callTool: async (request) => {
      runtime.calls.push({
        generationId: request.generationId,
        toolName: String(request.toolName),
      });
      nowMs += output.elapsedMs ?? 0;
      if (output.error) return { ok: false, error: output.error };
      return { ok: true, result: output.result ?? null };
    },
  };
  return runtime;
}
