import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationConfigScopeStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationGateway,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationPythonRuntime,
  type HostedIntegrationToolLifecycle,
} from "../src/index.js";

let dataDir: string;

const actor: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-deprecation-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration tool deprecation policy", () => {
  it("fails direct removal of an active source tool during validation", async () => {
    await writeSourceFamily(familyYaml("active", true));
    const draftStore = await createDraftFromSource(familyYaml("active", false));
    const validator = createFileHostedIntegrationDraftValidator({
      draftStore,
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    });

    await expect(validator.validateDraft("draft_1")).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "breaking_tool_removal" })],
    });
  });

  it("keeps deprecated tools invocable for existing allowed agents", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedRunnableFamily("deprecated");

    await expect(
      gateway(runtime).invoke(allowedInvocation()),
    ).resolves.toMatchObject({
      ok: true,
      envelope: { ok: true, result: { count: 2 } },
    });
    expect(runtime.calls).toEqual([
      { generationId: "gen_1", toolName: "qualys_count_assets" },
    ]);
  });

  it("omits hidden tools from new selection surfaces while keeping deprecated tools visible", async () => {
    await writeSourceFamily(familyYaml("hidden", true, "deprecated"));
    const catalog = createFileHostedIntegrationCatalog({ dataDir });

    await expect(catalog.listFamilies()).resolves.toMatchObject([
      {
        id: "qualys",
        toolNames: ["qualys_list_assets"],
      },
    ]);
  });

  it("fails disabled tools before runtime dispatch", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedRunnableFamily("disabled");

    await expect(
      gateway(runtime).invoke(allowedInvocation()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "tool_disabled" },
    });
    expect(runtime.calls).toEqual([]);
  });

  it("treats removed tools as unavailable for new invocation selection", async () => {
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedRunnableFamily("removed");

    await expect(
      gateway(runtime).invoke(allowedInvocation()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "tool_not_found" },
    });
    expect(runtime.calls).toEqual([]);
  });
});

async function seedRunnableFamily(
  lifecycle: HostedIntegrationToolLifecycle,
): Promise<void> {
  await writeSourceFamily(familyYaml(lifecycle));
  const draftStore = await createDraftFromSource(familyYaml(lifecycle));
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore,
    createId: () => "gen_1",
  }).promoteDraft({
    draftId: "draft_1",
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  await seedConfig();
}

async function writeSourceFamily(yaml: string): Promise<void> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "family.yaml"), yaml, "utf-8");
  await writeFile(path.join(sourceDir, "qualys.py"), "def run(): pass\n");
}

async function createDraftFromSource(yaml: string) {
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
  await draftStore.writeDraftFile({
    draftId: "draft_1",
    lockId: "lock_1",
    path: "family.yaml",
    content: yaml,
  });
  return draftStore;
}

async function seedConfig(): Promise<void> {
  await createFileHostedIntegrationConfigScopeStore({
    dataDir,
  }).upsertConfigScope({
    scopeId: "qualys-test",
    familyId: "qualys",
    environment: "test",
    config: {},
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

function gateway(runtime: FakeRuntime) {
  return createFileHostedIntegrationGateway({ dataDir, runtime });
}

function allowedInvocation() {
  return {
    actor,
    familyId: "qualys",
    toolName: "qualys_count_assets",
    environment: "test",
    args: {},
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
  };
}

function familyYaml(
  lifecycle: HostedIntegrationToolLifecycle,
  includeSecondTool = false,
  secondLifecycle: HostedIntegrationToolLifecycle = "active",
): string {
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
    lifecycle: ${lifecycle}
    inputSchema:
      type: object
      properties: {}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
${includeSecondTool ? secondToolYaml(secondLifecycle) : ""}`;
}

function secondToolYaml(lifecycle: HostedIntegrationToolLifecycle): string {
  return `  - name: qualys_list_assets
    title: List assets
    description: List assets matching a safe query.
    lifecycle: ${lifecycle}
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
  const runtime: FakeRuntime = {
    calls: [],
    callTool: async (request) => {
      runtime.calls.push({
        generationId: request.generationId,
        toolName: String(request.toolName),
      });
      return { ok: true, result: output.result ?? null };
    },
  };
  return runtime;
}
