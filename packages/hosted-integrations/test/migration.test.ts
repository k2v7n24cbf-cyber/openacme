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
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES,
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_TOOL_SYNC_FAMILY,
  LEGACY_INTEGRATION_HUB_INCIDENT_SOURCE,
  LEGACY_INTEGRATION_HUB_INVENTORY,
  LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES,
  validateLegacyIntegrationHubMigrationInventory,
  type HostedIntegrationPolicyActor,
  type LegacyIntegrationHubInventory,
  type LegacyIntegrationHubMigratedFamilyFixture,
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
    ).toEqual(
      expect.arrayContaining([...EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES]),
    );
  });

  it("records explicit legacy MCP to managed hosted replacement metadata", () => {
    for (const entry of LEGACY_INTEGRATION_HUB_INVENTORY.tools) {
      expect(entry.legacyMcpToolName).toBe(
        `mcp_integration-hub__${entry.legacyToolName}`,
      );
      expect(entry.managedHostedToolName).toBe(
        `managed_${entry.familyId}__${entry.hostedToolName}`,
      );
      expect(entry.managedHostedToolName).not.toBe(entry.legacyMcpToolName);
    }
  });

  it("maps env requirements to config keys and secret refs", () => {
    for (const family of LEGACY_INTEGRATION_HUB_INVENTORY.families) {
      expect(
        [...family.configKeys, ...family.secretRefs].length,
      ).toBeGreaterThan(0);
    }
    for (const entry of LEGACY_INTEGRATION_HUB_INVENTORY.tools) {
      expect([...entry.configKeys, ...entry.secretRefs].length).toBeGreaterThan(
        0,
      );
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
          managedHostedToolName: "managed_qualys__duplicate_target",
        },
        {
          ...LEGACY_INTEGRATION_HUB_INVENTORY.tools[1]!,
          legacyToolName: "tool_b",
          legacyMcpToolName: "mcp_integration-hub__tool_b",
          hostedToolName: "duplicate_target",
          managedHostedToolName: "managed_qualys__duplicate_target",
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
        "duplicate managed hosted tool: managed_qualys__duplicate_target",
      ],
    });
  });

  it("rejects malformed legacy MCP and managed hosted names", () => {
    const inventory: LegacyIntegrationHubInventory = {
      ...LEGACY_INTEGRATION_HUB_INVENTORY,
      tools: [
        {
          ...LEGACY_INTEGRATION_HUB_INVENTORY.tools[0]!,
          legacyToolName: "tool_a",
          legacyMcpToolName: "managed_qualys__tool_a",
          hostedToolName: "tool_a",
          managedHostedToolName: "mcp_integration-hub__tool_a",
        },
      ],
    };

    expect(
      validateLegacyIntegrationHubMigrationInventory(inventory, ["tool_a"]),
    ).toEqual({
      ok: false,
      diagnostics: [
        "invalid managed hosted tool name: mcp_integration-hub__tool_a",
        "invalid mcp name: managed_qualys__tool_a",
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
    expect(
      FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.managedToolNames,
    ).toEqual(["managed_splunk__splunk_search"]);
    expect(
      FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY.replacementMappings,
    ).toEqual([
      {
        familyId: "splunk",
        hostedToolName: "splunk_search",
        legacyMcpToolName: "mcp_integration-hub__splunk_search",
        managedHostedToolName: "managed_splunk__splunk_search",
      },
    ]);
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

    if (!result.ok || result.replayed)
      throw new Error("migration invoke failed");
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

describe("legacy integration-hub migrated security families", () => {
  it("syncs a five-tool read-only Qualys pilot as managed hosted tools", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_TOOL_SYNC_FAMILY;
    expect(fixture.familyId).toBe("qualys");
    expect(fixture.migratedToolNames).toEqual([
      ...LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES,
    ]);
    expect(fixture.managedToolNames).toEqual(
      fixture.migratedToolNames.map(
        (toolName) => `managed_qualys__${toolName}`,
      ),
    );
    expect(fixture.legacyMcpToolNames).toEqual(
      fixture.migratedToolNames.map(
        (toolName) => `mcp_integration-hub__${toolName}`,
      ),
    );
    expect(fixture.examples.map((example) => example.toolName)).toEqual(
      fixture.migratedToolNames,
    );

    await seedMigratedSourceFamily(fixture);
    const { draftId, lockId } = await createMigratedDraft(fixture);
    await registerMigratedExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    expect(validation).toEqual({ ok: true, diagnostics: [] });

    const generation = await promoteDraft(draftId, validation, fixture);
    expect(generation.tools?.map((tool) => tool.name)).toEqual(
      fixture.migratedToolNames,
    );

    await seedQualysConfig();
    const gateway = createGateway();
    for (const example of fixture.examples) {
      const result = await gateway.invoke({
        actor: migrationActor,
        familyId: "qualys",
        toolName: example.toolName,
        generationId: generation.id,
        environment: "test",
        args: example.args,
        bindings: [
          {
            agentId: migrationActor.id,
            familyId: "qualys",
            toolName: example.toolName,
            allowedConfigScopeIds: ["qualys-test"],
            defaultConfigScopeId: "qualys-test",
            environment: "test",
          },
        ],
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result.envelope).toMatchObject({
        ok: true,
        result: {
          migrated: true,
          tool: example.toolName,
          uses_explicit_cache: false,
        },
      });
    }
  }, 30_000);

  const liveQualysTest =
    process.env.OPENACME_LIVE_QUALYS === "1" ? it : it.skip;

  liveQualysTest(
    "ports the five-tool Qualys pilot through live Qualys APIs",
    async () => {
      const liveConfig = readLiveQualysConfig();
      const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY;
      expect(fixture.migratedToolNames).toEqual([
        ...LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES,
      ]);
      expect(fixture.sourceFiles["qualys.py"]).toContain("class QualysClient");
      expect(fixture.sourceFiles["qualys.py"]).toContain(
        "asset.trackingMethod",
      );
      expect(fixture.sourceFiles["qualys.py"]).not.toContain("os.environ");

      await seedMigratedSourceFamily(fixture);
      const { draftId, lockId } = await createMigratedDraft(fixture);
      await registerMigratedExamples(draftId, lockId, fixture);
      const validation = await createFileHostedIntegrationDraftValidator({
        draftStore: createDraftStore(fixture),
        catalog: createFileHostedIntegrationCatalog({ dataDir }),
      }).validateDraft(draftId);
      expect(validation).toEqual({ ok: true, diagnostics: [] });
      const generation = await promoteDraft(draftId, validation, fixture);
      await seedLiveQualysConfig(liveConfig);

      const gateway = createGateway();
      const results = new Map<
        string,
        Awaited<ReturnType<typeof gateway.invoke>>
      >();
      for (const example of fixture.examples) {
        const result = await gateway.invoke({
          actor: migrationActor,
          familyId: "qualys",
          toolName: example.toolName,
          generationId: generation.id,
          environment: "test",
          args: example.args,
          bindings: [liveQualysBinding(example.toolName)],
        });
        if (!result.ok) throw new Error(JSON.stringify(result));
        results.set(example.toolName, result);
      }

      expect(
        results.get("qualys_gav_asset_count")?.envelope.result,
      ).toMatchObject({
        used_filter_body: true,
        asset_last_updated: "2026-08-01T00:00Z",
      });
      expect(
        typeof (
          results.get("qualys_gav_asset_count")?.envelope.result as {
            count?: unknown;
          }
        ).count,
      ).toBe("number");
      expect(
        results.get("qualys_gav_asset_search")?.envelope.result,
      ).toMatchObject({
        pages_fetched: 1,
        upstream_include_fields: ["assetName", "agentId"],
      });
      expect(
        Array.isArray(
          (
            results.get("qualys_gav_asset_search")?.envelope.result as {
              results?: unknown;
            }
          ).results,
        ),
      ).toBe(true);
      expect(
        results.get("qualys_cloud_agent_hostasset_count")?.envelope.result,
      ).toMatchObject({ used_filter_body: true });
      expect(
        typeof (
          results.get("qualys_cloud_agent_hostasset_count")?.envelope
            .result as {
            count?: unknown;
          }
        ).count,
      ).toBe("number");
      expect(
        results.get("qualys_cloud_agent_hostasset_search")?.envelope.result,
      ).toMatchObject({
        pages_fetched: 1,
      });
      expect(
        Array.isArray(
          (
            results.get("qualys_cloud_agent_hostasset_search")?.envelope
              .result as {
              results?: unknown;
            }
          ).results,
        ),
      ).toBe(true);
      expect(
        results.get("qualys_vmdr_host_list")?.envelope.result,
      ).toMatchObject({ pages_fetched: 1 });
      expect(
        Array.isArray(
          (
            results.get("qualys_vmdr_host_list")?.envelope.result as {
              results?: unknown;
            }
          ).results,
        ),
      ).toBe(true);
    },
    180_000,
  );

  it("validates and promotes every migrated security family fixture", async () => {
    expect(
      LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES.map(
        (fixture) => fixture.familyId,
      ),
    ).toEqual(["qualys", "splunk", "msgraph", "mde", "defender-alert"]);

    for (const fixture of LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES) {
      await seedMigratedSourceFamily(fixture);
      const { draftId, lockId } = await createMigratedDraft(fixture);
      await registerMigratedExamples(draftId, lockId, fixture);
      const validation = await createFileHostedIntegrationDraftValidator({
        draftStore: createDraftStore(fixture),
        catalog: createFileHostedIntegrationCatalog({ dataDir }),
      }).validateDraft(draftId);

      expect(validation).toEqual({ ok: true, diagnostics: [] });
      const generation = await promoteDraft(draftId, validation, fixture);
      expect(generation.tools?.map((tool) => tool.name)).toEqual(
        fixture.migratedToolNames,
      );
      expect(fixture.managedToolNames).toEqual(
        fixture.replacementMappings.map(
          (mapping) => mapping.managedHostedToolName,
        ),
      );
      expect(
        fixture.replacementMappings.map((mapping) => mapping.hostedToolName),
      ).toEqual(fixture.migratedToolNames);
      expect(
        fixture.replacementMappings.map((mapping) => mapping.legacyMcpToolName),
      ).toEqual(fixture.legacyMcpToolNames);
    }
  });

  it("maps env requirements to config scopes and never reads process env", () => {
    for (const fixture of LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES) {
      const inventoryFamily = LEGACY_INTEGRATION_HUB_INVENTORY.families.find(
        (entry) => entry.familyId === fixture.familyId,
      );
      expect(inventoryFamily).toMatchObject({
        configKeys: fixture.configKeys,
        secretRefs: fixture.secretRefs,
      });
      for (const [filePath, content] of Object.entries(fixture.sourceFiles)) {
        if (!filePath.endsWith(".py")) continue;
        expect(content).not.toContain("os.environ");
        expect(content).not.toContain("process.env");
      }
    }
  });

  it("declares hosted cache only for explicitly cached or sync tools", async () => {
    for (const fixture of LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES) {
      await seedMigratedSourceFamily(fixture);
    }
    const catalog = createFileHostedIntegrationCatalog({ dataDir });

    for (const fixture of LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES) {
      const family = await catalog.getFamily(fixture.familyId);
      expect(family).not.toBeNull();
      for (const tool of family!.manifest.tools) {
        const inventoryTool = LEGACY_INTEGRATION_HUB_INVENTORY.tools.find(
          (entry) =>
            entry.familyId === fixture.familyId &&
            entry.hostedToolName === tool.name,
        );
        const expectsCache =
          inventoryTool?.freshness === "cached" ||
          inventoryTool?.freshness === "sync";
        expect(Boolean(tool.cache)).toBe(expectsCache);
      }
    }
  });

  it("does not invent regression examples when legacy incidents are unavailable", () => {
    expect(LEGACY_INTEGRATION_HUB_INCIDENT_SOURCE).toMatchObject({
      available: false,
      path: "ops/incidents.jsonl",
    });
    expect(
      LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES.flatMap(
        (fixture) => fixture.regressionExamples,
      ),
    ).toEqual([]);
  });
});

const migrationActor: HostedIntegrationPolicyActor = {
  id: "agent:migration-test",
  kind: "agent",
  roles: ["agent"],
};

async function seedMigratedSourceFamily(
  fixture = FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
): Promise<void> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    fixture.familyId,
  );
  await mkdir(sourceDir, { recursive: true });
  await Promise.all(
    Object.entries(fixture.sourceFiles).map(([filePath, content]) =>
      writeFile(path.join(sourceDir, filePath), content, "utf-8"),
    ),
  );
}

async function createMigratedDraft(
  fixture = FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
): Promise<{
  draftId: string;
  lockId: string;
}> {
  const lockId = `lock_migration_${safeFixtureId(fixture)}`;
  await createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => lockId,
  }).acquireLock({
    familyId: fixture.familyId,
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const created = await createDraftStore(fixture).createDraftFromFiles({
    familyId: fixture.familyId,
    lockId,
    sourceRevisionId: "source_rev_migration_1",
    files: fixture.sourceFiles,
  });
  if (!created.ok) throw new Error(created.reason);
  return { draftId: created.draft.id, lockId };
}

async function registerMigratedExamples(
  draftId: string,
  lockId: string,
  fixture = FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
): Promise<void> {
  const registry = createFileHostedIntegrationExampleRegistry({
    draftStore: createDraftStore(fixture),
  });
  for (const example of fixture.examples) {
    await expect(
      registry.upsertExample({ draftId, lockId, example }),
    ).resolves.toEqual({ ok: true });
  }
}

async function promoteDraft(
  draftId: string,
  validation: { ok: boolean; diagnostics: Array<Record<string, unknown>> },
  fixture = FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
) {
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore: createDraftStore(fixture),
    now: () => new Date(nowMs),
    createId: () => `gen_migration_${safeFixtureId(fixture)}`,
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

async function seedQualysConfig(): Promise<void> {
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
    secrets: { apiToken: "raw-token-secret" },
    updatedBy: "human:operator",
  });
}

interface LiveQualysConfig {
  config: Record<string, string>;
  secrets: Record<string, string>;
}

function readLiveQualysConfig(): LiveQualysConfig {
  const vmUrl = process.env.QUALYS_VM_URL?.trim();
  const gatewayUrl = process.env.QUALYS_GATEWAY_URL?.trim();
  const username = process.env.QUALYS_USERNAME?.trim();
  const password = process.env.QUALYS_PASSWORD?.trim();
  if (!vmUrl || !username || !password) {
    throw new Error(
      "OPENACME_LIVE_QUALYS=1 requires QUALYS_VM_URL, QUALYS_USERNAME, and QUALYS_PASSWORD; QUALYS_GATEWAY_URL is optional.",
    );
  }
  return {
    config: {
      QUALYS_VM_URL: vmUrl,
      ...(gatewayUrl ? { QUALYS_GATEWAY_URL: gatewayUrl } : {}),
      QUALYS_VERIFY_TLS: process.env.QUALYS_VERIFY_TLS ?? "1",
      QUALYS_TIMEOUT_SECONDS: process.env.QUALYS_TIMEOUT_SECONDS ?? "120",
      QUALYS_ASSET_MAX_PAGES: "1",
      QUALYS_MAX_PAGES: "1",
    },
    secrets: {
      QUALYS_USERNAME: username,
      QUALYS_PASSWORD: password,
    },
  };
}

async function seedLiveQualysConfig(
  liveConfig: LiveQualysConfig,
): Promise<void> {
  await createFileHostedIntegrationConfigScopeStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertConfigScope({
    scopeId: "qualys-source-test",
    familyId: "qualys",
    environment: "test",
    config: liveConfig.config,
    secrets: {
      QUALYS_USERNAME: { configured: true },
      QUALYS_PASSWORD: { configured: true },
    },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    scopeId: "qualys-source-test",
    secrets: liveConfig.secrets,
    updatedBy: "human:operator",
  });
}

function createDraftStore(
  fixture = FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
) {
  return createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore: createFileHostedIntegrationLockStore({
      dataDir,
      now: () => new Date(nowMs),
    }),
    now: () => new Date(nowMs),
    createId: () => `draft_migration_${safeFixtureId(fixture)}`,
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

function liveQualysBinding(toolName: string) {
  return {
    agentId: migrationActor.id,
    familyId: "qualys",
    toolName,
    allowedConfigScopeIds: ["qualys-source-test"],
    defaultConfigScopeId: "qualys-source-test",
    environment: "test",
  };
}

function safeFixtureId(
  fixture: LegacyIntegrationHubMigratedFamilyFixture,
): string {
  return fixture.familyId.replaceAll("-", "_");
}
