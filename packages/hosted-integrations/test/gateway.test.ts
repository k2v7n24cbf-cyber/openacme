import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationConfigScopeStore,
  createFileHostedIntegrationDraftStore,
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
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-gateway-"));
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

describe("hosted integration gateway", () => {
  it("denies invocation before runtime dispatch", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedPromotedGeneration();
    await seedConfig();

    await expect(
      gateway(runtime).invoke({
        actor,
        familyId: "qualys",
        toolName: "qualys_count_assets",
        environment: "test",
        args: { query: "severity:5" },
        bindings: [],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
    expect(runtime.calls).toEqual([]);
  });

  it("dispatches an allowed invocation to the selected generation", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    const generation = await seedPromotedGeneration();
    await seedConfig();

    await expect(
      gateway(runtime).invoke(allowedInvocation({ generationId: generation.id })),
    ).resolves.toMatchObject({
      ok: true,
      generationId: generation.id,
      envelope: { ok: true, result: { count: 2 } },
    });
    expect(runtime.calls[0]).toMatchObject({
      generationId: generation.id,
      toolName: "qualys_count_assets",
    });
  });

  it("records config revision on the execution log", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedPromotedGeneration();
    await seedConfig();
    const instance = gateway(runtime);

    const result = await instance.invoke(allowedInvocation());
    if (!result.ok || result.replayed) throw new Error("invoke failed");

    await expect(instance.executionLogs.getRunLog(result.runId)).resolves
      .toMatchObject({
        runId: result.runId,
        configScopeId: "qualys-test",
        configRevision: 1,
        status: "succeeded",
      });
  });

  it("normalizes runtime errors", async () => {
    const runtime = fakeRuntime({
      error: { code: "tool_bug", message: "ValueError: boom" },
    });
    await seedPromotedGeneration();
    await seedConfig();

    await expect(gateway(runtime).invoke(allowedInvocation())).resolves
      .toMatchObject({
        ok: false,
        error: {
          code: "tool_bug",
          message: expect.stringContaining("ValueError"),
        },
      });
  });

  it("returns normalized timeout errors", async () => {
    const runtime = fakeRuntime({
      error: { code: "timeout", message: "timed out after 100ms" },
    });
    await seedPromotedGeneration();
    await seedConfig();

    await expect(gateway(runtime).invoke(allowedInvocation())).resolves
      .toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
  });

  it("replays matching idempotency keys from final envelope metadata", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedPromotedGeneration();
    await seedConfig();
    const instance = gateway(runtime);

    const first = await instance.invoke(
      allowedInvocation({ idempotencyKey: "idem_1" }),
    );
    const second = await instance.invoke(
      allowedInvocation({ idempotencyKey: "idem_1" }),
    );

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({
      ok: true,
      replayed: true,
      resultEnvelopeRef: expect.stringMatching(/^call_/),
    });
    expect(runtime.calls).toHaveLength(1);
  });

  it("rejects idempotency key reuse with a different fingerprint", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedPromotedGeneration();
    await seedConfig();
    const instance = gateway(runtime);

    await instance.invoke(allowedInvocation({ idempotencyKey: "idem_1" }));
    await expect(
      instance.invoke(
        allowedInvocation({
          args: { query: "severity:4" },
          idempotencyKey: "idem_1",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(runtime.calls).toHaveLength(1);
  });
});

function gateway(runtime: FakeRuntime) {
  return createFileHostedIntegrationGateway({
    dataDir,
    runtime,
    now: () => new Date(nowMs),
  });
}

function allowedInvocation(
  overrides: Partial<
    Parameters<ReturnType<typeof createFileHostedIntegrationGateway>["invoke"]>[0]
  > = {},
) {
  return {
    actor,
    familyId: "qualys",
    toolName: "qualys_count_assets",
    environment: "test",
    args: { query: "severity:5" },
    bindings: [
      {
        agentId: "agent:analyst",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedConfigScopeIds: ["qualys-test"],
        defaultConfigScopeId: "qualys-test",
        environment: "test",
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
  await createFileHostedIntegrationConfigScopeStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertConfigScope({
    scopeId: "qualys-test",
    familyId: "qualys",
    environment: "test",
    config: { endpoint: "https://qualys.example.test" },
    secrets: { apiToken: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    scopeId: "qualys-test",
    secrets: { apiToken: "token_123" },
    updatedBy: "human:operator",
  });
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
  error?: { code: "runtime_error" | "timeout" | "tool_bug"; message: string };
}): FakeRuntime {
  const runtime: FakeRuntime = {
    calls: [],
    callTool: async (request) => {
      runtime.calls.push({
        generationId: request.generationId,
        toolName: String(request.toolName),
      });
      if (output.error) return { ok: false, error: output.error };
      return { ok: true, result: output.result ?? null };
    },
  };
  return runtime;
}
