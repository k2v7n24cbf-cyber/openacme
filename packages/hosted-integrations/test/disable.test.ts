import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDisablementStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationEnvironmentConfigStore,
  createFileHostedIntegrationGateway,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationDisableTarget,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationPythonRuntime,
} from "../src/index.js";

let dataDir: string;
let runtime: FakeRuntime;
let generationId: string;

const actor: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-disable-"));
  runtime = fakeRuntime({ result: { count: 2 } });
  await seedSourceFamily();
  generationId = await seedPromotedGeneration();
  await seedConfig();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration operational disable policy", () => {
  it("blocks all new family invocations when a family is disabled", async () => {
    await disable({ level: "family", familyId: "qualys" });

    await expect(gateway().invoke(allowedInvocation())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operationally_disabled",
        details: { target: { level: "family", familyId: "qualys" } },
      },
    });
    expect(runtime.calls).toEqual([]);
  });

  it("blocks only the selected tool when a tool is disabled", async () => {
    await disable({
      level: "tool",
      familyId: "qualys",
      toolName: "qualys_count_assets",
    });

    await expect(gateway().invoke(allowedInvocation())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operationally_disabled",
        details: {
          target: {
            level: "tool",
            familyId: "qualys",
            toolName: "qualys_count_assets",
          },
        },
      },
    });
    expect(runtime.calls).toEqual([]);
  });

  it("blocks disabled environment configs before runtime dispatch", async () => {
    await disable({
      level: "environment_config",
      environmentConfigId: "qualys-test_debug",
    });

    const result = await gateway().invoke(allowedInvocation());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "operationally_disabled",
        details: {
          target: {
            level: "environment_config",
            environmentConfigId: "qualys-test_debug",
          },
        },
      },
    });
    expect(result).not.toHaveProperty("runId");
    expect(runtime.calls).toEqual([]);
  });

  it("does not dispatch disabled generations", async () => {
    await disable({ level: "generation", generationId });

    await expect(gateway().invoke(allowedInvocation())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operationally_disabled",
        details: { target: { level: "generation", generationId } },
      },
    });
    expect(runtime.calls).toEqual([]);
  });

  it("re-enables targets without creating repair-bucket style failures", async () => {
    await disable({ level: "family", familyId: "qualys" });
    await createFileHostedIntegrationDisablementStore({
      dataDir,
    }).setDisabled({
      target: { level: "family", familyId: "qualys" },
      disabled: false,
      updatedBy: "agent:tool-developer",
    });

    await expect(gateway().invoke(allowedInvocation())).resolves.toMatchObject({
      ok: true,
      envelope: { ok: true, result: { count: 2 } },
    });
    expect(runtime.calls).toHaveLength(1);
  });
});

async function disable(target: HostedIntegrationDisableTarget): Promise<void> {
  await createFileHostedIntegrationDisablementStore({
    dataDir,
  }).setDisabled({
    target,
    disabled: true,
    reason: "maintenance",
    updatedBy: "agent:tool-developer",
  });
}

function gateway() {
  return createFileHostedIntegrationGateway({ dataDir, runtime });
}

function allowedInvocation() {
  return {
    actor,
    familyId: "qualys",
    toolName: "qualys_count_assets",
    environment: "test_debug",
    args: {},
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

async function seedPromotedGeneration(): Promise<string> {
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
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
    createId: () => "draft_1",
  });
  const draft = await draftStore.createDraft({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
  });
  if (!draft.ok) throw new Error(draft.reason);
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore,
    createId: () => "gen_1",
  }).promoteDraft({
    draftId: draft.draft.id,
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  return promoted.generation.id;
}

async function seedConfig(): Promise<void> {
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
  }).upsertEnvironmentConfig({
    familyId: "qualys",
    environment: "test_debug",
    config: {},
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
  requiredConfigKeys: []
  requiredSecretKeys:
    - apiToken
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets matching a safe query.
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

interface FakeRuntime {
  calls: Array<{ generationId: string; toolName: string }>;
  callTool: HostedIntegrationPythonRuntime["callTool"];
}

function fakeRuntime(output: { result?: unknown }): FakeRuntime {
  const created: FakeRuntime = {
    calls: [],
    callTool: async (request) => {
      created.calls.push({
        generationId: request.generationId,
        toolName: String(request.toolName),
      });
      return { ok: true, result: output.result ?? null };
    },
  };
  return created;
}
