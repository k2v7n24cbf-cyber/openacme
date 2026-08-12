import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationConfigScopeStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationExampleRegistry,
  createFileHostedIntegrationGateway,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
  EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES,
  FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
  LEGACY_INTEGRATION_HUB_INVENTORY,
  validateLegacyIntegrationHubMigrationInventory,
  type HostedIntegrationPolicyActor,
  type LegacyIntegrationHubInventory,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-migration-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("legacy integration-hub migration inventory", () => {
  it("captures every expected legacy tool name", () => {
    const result = validateLegacyIntegrationHubMigrationInventory(
      LEGACY_INTEGRATION_HUB_INVENTORY,
    );

    expect(result).toEqual({ ok: true, diagnostics: [] });
    expect(
      LEGACY_INTEGRATION_HUB_INVENTORY.tools.map(
        (entry) => entry.legacyToolName,
      ),
    ).toEqual(expect.arrayContaining([...EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES]));
  });

  it("maps env requirements to config keys and secret refs", () => {
    for (const family of LEGACY_INTEGRATION_HUB_INVENTORY.families) {
      expect([...family.configKeys, ...family.secretRefs].length).toBeGreaterThan(0);
    }
    for (const entry of LEGACY_INTEGRATION_HUB_INVENTORY.tools) {
      expect([...entry.configKeys, ...entry.secretRefs].length).toBeGreaterThan(0);
    }
  });

  it("rejects missing or duplicate hosted migration targets", () => {
    const inventory: LegacyIntegrationHubInventory = {
      ...LEGACY_INTEGRATION_HUB_INVENTORY,
      tools: [
        {
          ...LEGACY_INTEGRATION_HUB_INVENTORY.tools[0]!,
          legacyToolName: "tool_a",
          legacyMcpToolName: "mcp_integration-hub__tool_a",
          hostedToolName: "duplicate_target",
        },
        {
          ...LEGACY_INTEGRATION_HUB_INVENTORY.tools[1]!,
          legacyToolName: "tool_b",
          legacyMcpToolName: "mcp_integration-hub__tool_b",
          hostedToolName: "duplicate_target",
        },
      ],
    };

    expect(
      validateLegacyIntegrationHubMigrationInventory(inventory, [
        "tool_a",
        "tool_b",
        "missing_tool",
      ]),
    ).toEqual({
      ok: false,
      diagnostics: [
        "missing legacy tool: missing_tool",
        "duplicate hosted tool: duplicate_target",
      ],
    });
  });
});

describe("legacy integration-hub first migrated family", () => {
  it("validates and promotes the migrated read-only Splunk family", async () => {
    await seedMigratedSourceFamily();
    const { draftId, lockId } = await createMigratedDraft();
    await registerMigratedExamples(draftId, lockId);

    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    expect(validation).toEqual({ ok: true, diagnostics: [] });

    const generation = await promoteDraft(draftId, validation);

    expect(generation.familyId).toBe(
      FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.familyId,
    );
    expect(generation.tools?.map((tool) => tool.name)).toEqual(
      FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.migratedToolNames,
    );
  });

  it("runs migrated examples through the hosted integration runtime", async () => {
    await seedMigratedSourceFamily();
    const { draftId, lockId } = await createMigratedDraft();
    await registerMigratedExamples(draftId, lockId);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation);
    await seedSplunkConfig();

    const example = FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.examples[0]!;
    const result = await createGateway().invoke({
      actor: migrationActor,
      familyId: "splunk",
      toolName: example.toolName,
      environment: "test",
      args: example.args,
      bindings: [splunkBinding()],
      generationId: generation.id,
    });

    expect(result).toMatchObject({
      ok: true,
      envelope: {
        ok: true,
        result: {
          query: 'index=main "login"',
          auth_configured: true,
          result_count: 2,
        },
      },
    });
  });

  it("maps legacy result-file behavior to hosted run artifacts", async () => {
    await seedMigratedSourceFamily();
    const { draftId, lockId } = await createMigratedDraft();
    await registerMigratedExamples(draftId, lockId);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation);
    await seedSplunkConfig();
    const gateway = createGateway();

    const result = await gateway.invoke({
      actor: migrationActor,
      familyId: "splunk",
      toolName: "splunk_search",
      environment: "test",
      args: { query: 'index=main "large"', limit: 150 },
      bindings: [splunkBinding()],
      generationId: generation.id,
    });

    if (!result.ok || result.replayed) throw new Error("migration invoke failed");
    expect(result.envelope).toMatchObject({
      ok: true,
      result_ref: {
        type: "artifact",
        name: "output.json",
      },
    });
    expect(
      LEGACY_INTEGRATION_HUB_INVENTORY.tools.find(
        (entry) => entry.legacyToolName === "splunk_search",
      ),
    ).toMatchObject({
      legacyMcpToolName:
        FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.legacyMcpToolNames[0],
      resultBehavior: "result_file",
    });
    const artifact = await gateway.artifacts.readArtifact({
      familyId: "splunk",
      runId: result.runId,
      name: "output.json",
    });
    expect(artifact).toContain('"result_count": 150');
    expect(artifact).not.toContain("raw-token-secret");
  });
});

const migrationActor: HostedIntegrationPolicyActor = {
  id: "agent:migration-test",
  kind: "agent",
  roles: ["agent"],
};

async function seedMigratedSourceFamily(): Promise<void> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.familyId,
  );
  await mkdir(sourceDir, { recursive: true });
  await Promise.all(
    Object.entries(
      FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.sourceFiles,
    ).map(([filePath, content]) =>
      writeFile(path.join(sourceDir, filePath), content, "utf-8"),
    ),
  );
}

async function createMigratedDraft(): Promise<{
  draftId: string;
  lockId: string;
}> {
  const lockId = "lock_migration_1";
  await createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => lockId,
  }).acquireLock({
    familyId: FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.familyId,
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const created = await createDraftStore().createDraftFromFiles({
    familyId: FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.familyId,
    lockId,
    sourceRevisionId: "source_rev_migration_1",
    files: FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.sourceFiles,
  });
  if (!created.ok) throw new Error(created.reason);
  return { draftId: created.draft.id, lockId };
}

async function registerMigratedExamples(
  draftId: string,
  lockId: string,
): Promise<void> {
  const registry = createFileHostedIntegrationExampleRegistry({
    draftStore: createDraftStore(),
  });
  for (const example of FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.examples) {
    await expect(
      registry.upsertExample({ draftId, lockId, example }),
    ).resolves.toEqual({ ok: true });
  }
}

async function promoteDraft(
  draftId: string,
  validation: { ok: boolean; diagnostics: Array<Record<string, unknown>> },
) {
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore: createDraftStore(),
    now: () => new Date(nowMs),
    createId: () => "gen_migration_1",
  }).promoteDraft({
    draftId,
    promotedBy: "agent:tool-developer",
    validation,
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  return promoted.generation;
}

async function seedSplunkConfig(): Promise<void> {
  await createFileHostedIntegrationConfigScopeStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertConfigScope({
    scopeId: "splunk-test",
    familyId: "splunk",
    environment: "test",
    config: { baseUrl: "https://splunk.example.test" },
    secrets: { token: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    scopeId: "splunk-test",
    secrets: { token: "raw-token-secret" },
    updatedBy: "human:operator",
  });
}

function createDraftStore() {
  return createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore: createFileHostedIntegrationLockStore({
      dataDir,
      now: () => new Date(nowMs),
    }),
    now: () => new Date(nowMs),
    createId: () => "draft_migration_1",
  });
}

function createGateway() {
  return createFileHostedIntegrationGateway({
    dataDir,
    now: () => new Date(nowMs),
  });
}

function splunkBinding() {
  return {
    agentId: migrationActor.id,
    familyId: "splunk",
    toolName: "splunk_search",
    allowedConfigScopeIds: ["splunk-test"],
    defaultConfigScopeId: "splunk-test",
    environment: "test",
  };
}
