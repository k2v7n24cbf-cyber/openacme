import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach } from "vitest";
import { describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationEnvironmentConfigStore,
  createFileHostedIntegrationExampleRegistry,
  createFileHostedIntegrationGateway,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
  FamilyManifestSchema,
  buildHostedIntegrationFocusedSourceView,
  hostedIntegrationEnvironmentConfigId,
  type HostedIntegrationPolicyActor,
} from "../src/index.js";
import {
  EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES,
  FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES,
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_TOOL_SYNC_FAMILY,
  LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_INCIDENT_SOURCE,
  LEGACY_INTEGRATION_HUB_INVENTORY,
  LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES,
  validateLegacyIntegrationHubReplacementInventory,
  type LegacyIntegrationHubInventory,
  type LegacyIntegrationHubReplacementFamilyFixture,
} from "../test-support/integration-hub/fixtures.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-import-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("legacy integration-hub replacement inventory", () => {
  it("captures every expected legacy tool name", () => {
    const result = validateLegacyIntegrationHubReplacementInventory(
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

  it("rejects missing or duplicate hosted replacement targets", () => {
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
      validateLegacyIntegrationHubReplacementInventory(inventory, [
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
      validateLegacyIntegrationHubReplacementInventory(inventory, ["tool_a"]),
    ).toEqual({
      ok: false,
      diagnostics: [
        "invalid managed hosted tool name: mcp_integration-hub__tool_a",
        "invalid mcp name: managed_qualys__tool_a",
      ],
    });
  });
});

describe("legacy integration-hub first replacement family", () => {
  it("validates and promotes the replacement read-only Splunk family", async () => {
    await seedReplacementSourceFamily();
    const { draftId, lockId } = await createReplacementDraft();
    await registerReplacementExamples(draftId, lockId);

    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    expectNoValidationErrors(validation);

    const generation = await promoteDraft(draftId, validation);

    expect(generation.familyId).toBe(
      FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY.familyId,
    );
    expect(generation.tools?.map((tool) => tool.name)).toEqual(
      FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY.replacementToolNames,
    );
    expect(
      FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY.managedToolNames,
    ).toEqual(["managed_splunk__splunk_search"]);
    expect(
      FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY.replacementMappings,
    ).toEqual([
      {
        familyId: "splunk",
        hostedToolName: "splunk_search",
        legacyMcpToolName: "mcp_integration-hub__splunk_search",
        managedHostedToolName: "managed_splunk__splunk_search",
      },
    ]);
  });

  it("runs replacement examples through the hosted integration runtime", async () => {
    await seedReplacementSourceFamily();
    const { draftId, lockId } = await createReplacementDraft();
    await registerReplacementExamples(draftId, lockId);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation);
    await seedSplunkConfig();

    const example = FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY.examples[0]!;
    const result = await createGateway().invoke({
      actor: replacementActor,
      familyId: "splunk",
      toolName: example.toolName,
      environment: "test_debug",
      args: example.args,
      hostedToolBindings: [splunkBinding()],
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
    await seedReplacementSourceFamily();
    const { draftId, lockId } = await createReplacementDraft();
    await registerReplacementExamples(draftId, lockId);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation);
    await seedSplunkConfig();
    const gateway = createGateway();

    const result = await gateway.invoke({
      actor: replacementActor,
      familyId: "splunk",
      toolName: "splunk_search",
      environment: "test_debug",
      args: { query: 'index=main "large"', limit: 150 },
      hostedToolBindings: [splunkBinding()],
      generationId: generation.id,
    });

    if (!result.ok || result.replayed)
      throw new Error("import invoke failed");
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
        FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY.legacyMcpToolNames[0],
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

describe("legacy integration-hub replacement security families", () => {
  it("syncs a five-tool read-only Qualys pilot as managed hosted tools", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_TOOL_SYNC_FAMILY;
    expect(fixture.familyId).toBe("qualys");
    expect(fixture.replacementToolNames).toEqual([
      ...LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES,
    ]);
    expect(fixture.managedToolNames).toEqual(
      fixture.replacementToolNames.map(
        (toolName) => `managed_qualys__${toolName}`,
      ),
    );
    expect(fixture.legacyMcpToolNames).toEqual(
      fixture.replacementToolNames.map(
        (toolName) => `mcp_integration-hub__${toolName}`,
      ),
    );
    expect(fixture.examples.map((example) => example.toolName)).toEqual(
      fixture.replacementToolNames,
    );

    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }).validateDraft(draftId);
    expectNoValidationErrors(validation);

    const generation = await promoteDraft(draftId, validation, fixture);
    expect(generation.tools?.map((tool) => tool.name)).toEqual(
      fixture.replacementToolNames,
    );

    await seedQualysConfig();
    const gateway = createGateway();
    for (const example of fixture.examples) {
      const result = await gateway.invoke({
        actor: replacementActor,
        familyId: "qualys",
        toolName: example.toolName,
        generationId: generation.id,
        environment: "test_debug",
        args: example.args,
        hostedToolBindings: [
          {
            agentId: replacementActor.id,
            familyId: "qualys",
            toolName: example.toolName,
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:operator",
          },
        ],
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result.envelope).toMatchObject({
        ok: true,
        result: {
          replacement: true,
          tool: example.toolName,
          uses_explicit_cache: false,
        },
      });
    }
  }, 30_000);

  it("keeps the source-backed five-tool Qualys batch ready for blocking help quality", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY;
    expect(fixture.sourceFiles["family.yaml"]).toContain(
      "asset_last_updated is a hosted tool request parameter, not a filter field token",
    );
    expect(fixture.sourceFiles["family.yaml"]).not.toContain(
      "handlerDispatch: legacy_call_tool",
    );
    for (const toolName of LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES) {
      expect(fixture.sourceFiles["qualys.py"]).toContain(
        `def tool_${toolName}(args, context):`,
      );
    }
    expect(fixture.sourceFiles["qualys.py"]).toContain("def authenticate(ctx):");
    expect(fixture.sourceFiles["qualys.py"]).toContain(
      "def before_tool_call(tool_name, args, ctx, auth):",
    );
    expect(fixture.sourceFiles["qualys.py"]).toContain(
      "def after_tool_call(tool_name, args, ctx, result, auth):",
    );
    expect(fixture.sourceFiles["qualys.py"]).not.toContain("def call_tool(");

    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);

    expectNoValidationErrors(validation);
  });

  it("returns a focused source view for the replacement Qualys Cloud Agent count handler", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY;
    const manifest = FamilyManifestSchema.parse(
      parseYaml(fixture.sourceFiles["family.yaml"]),
    );

    const view = await buildHostedIntegrationFocusedSourceView({
      familyId: "qualys",
      generationId: "gen_qualys_format_test",
      manifest,
      entrypointPath: "qualys.py",
      source: fixture.sourceFiles["qualys.py"]!,
      toolName: "qualys_cloud_agent_hostasset_count",
      options: {
        includeHooks: true,
        includeSharedHelpers: true,
      },
    });

    expect(view).toMatchObject({
      mode: "focused",
      manifest: {
        tool: {
          name: "qualys_cloud_agent_hostasset_count",
          inputSchema: {
            properties: {
              filter_body: {
                description: expect.stringContaining("QAGENT"),
              },
            },
          },
        },
      },
      source: {
        selectedHandler: {
          source: expect.stringContaining(
            "def tool_qualys_cloud_agent_hostasset_count(args, context):",
          ),
        },
        hooks: [
          { name: "authenticate" },
          { name: "before_tool_call" },
          { name: "after_tool_call" },
        ],
      },
    });
    expect(view.source.selectedHandler?.source).toContain("_qagent_filter_body");
    expect(view.source.selectedHandler?.source).not.toContain("unknown tool");
    expect(
      view.source.collapsedToolHandlers.map((handler) => handler.toolName),
    ).toEqual([
      "qualys_gav_asset_count",
      "qualys_gav_asset_search",
      "qualys_cloud_agent_hostasset_search",
      "qualys_vmdr_host_list",
    ]);
    expect(view.source.helpers.some((helper) => helper.name === "QualysClient")).toBe(
      false,
    );
  });

  it("rejects hosted request parameters when agents put them inside GAV filter fields", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY;

    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation, fixture);
    await seedQualysConfig();

    const result = await createGateway().invoke({
      actor: replacementActor,
      familyId: "qualys",
      toolName: "qualys_cloud_agent_hostasset_count",
      generationId: generation.id,
      environment: "test_debug",
      args: {
        filter_body: {
          filters: [
            {
              field: "asset_last_updated",
              operator: "GREATER",
              value: "2026-07-14T00:00:00Z",
            },
          ],
          operation: "AND",
        },
      },
      hostedToolBindings: [
        {
          agentId: replacementActor.id,
          familyId: "qualys",
          toolName: "qualys_cloud_agent_hostasset_count",
          allowedEnvironments: ["test_debug"],
          defaultEnvironment: "test_debug",
          generationPin: { type: "current" },
          bindingKind: "agent",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:operator",
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "bad_arguments",
        message: expect.stringContaining("top-level argument"),
      },
    });
  });

  const liveQualysTest =
    process.env.OPENACME_LIVE_QUALYS === "1" ? it : it.skip;

  liveQualysTest(
    "ports the five-tool Qualys pilot through live Qualys APIs",
    async () => {
      const liveConfig = readLiveQualysConfig();
      const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_SOURCE_BACKED_FAMILY;
      expect(fixture.replacementToolNames).toEqual([
        ...LEGACY_INTEGRATION_HUB_FIVE_READONLY_SYNC_TOOL_NAMES,
      ]);
      expect(fixture.sourceFiles["qualys.py"]).toContain("class QualysClient");
      expect(fixture.sourceFiles["qualys.py"]).toContain(
        "asset.trackingMethod",
      );
      expect(fixture.sourceFiles["qualys.py"]).not.toContain("os.environ");

      await seedReplacementSourceFamily(fixture);
      const { draftId, lockId } = await createReplacementDraft(fixture);
      await registerReplacementExamples(draftId, lockId, fixture);
      const validation = await createFileHostedIntegrationDraftValidator({
        draftStore: createDraftStore(fixture),
        catalog: createFileHostedIntegrationCatalog({ dataDir }),
      }).validateDraft(draftId);
      expectNoValidationErrors(validation);
      const generation = await promoteDraft(draftId, validation, fixture);
      await seedLiveQualysConfig(liveConfig);

      const gateway = createGateway();
      const results = new Map<
        string,
        Awaited<ReturnType<typeof gateway.invoke>>
      >();
      for (const example of fixture.examples) {
        const result = await gateway.invoke({
          actor: replacementActor,
          familyId: "qualys",
          toolName: example.toolName,
          generationId: generation.id,
          environment: "test_debug",
          args: example.args,
          hostedToolBindings: [liveQualysBinding(example.toolName)],
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

  it("validates and promotes every replacement security family fixture", async () => {
    expect(
      LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES.map(
        (fixture) => fixture.familyId,
      ),
    ).toEqual(["qualys", "splunk", "msgraph", "mde", "defender-alert"]);

    for (const fixture of LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES) {
      await seedReplacementSourceFamily(fixture);
      const { draftId, lockId } = await createReplacementDraft(fixture);
      await registerReplacementExamples(draftId, lockId, fixture);
      const validation = await createFileHostedIntegrationDraftValidator({
        draftStore: createDraftStore(fixture),
        catalog: createFileHostedIntegrationCatalog({ dataDir }),
      }).validateDraft(draftId);

      expectNoValidationErrors(validation);
      const generation = await promoteDraft(draftId, validation, fixture);
      expect(generation.tools?.map((tool) => tool.name)).toEqual(
        fixture.replacementToolNames,
      );
      expect(fixture.managedToolNames).toEqual(
        fixture.replacementMappings.map(
          (mapping) => mapping.managedHostedToolName,
        ),
      );
      expect(
        fixture.replacementMappings.map((mapping) => mapping.hostedToolName),
      ).toEqual(fixture.replacementToolNames);
      expect(
        fixture.replacementMappings.map((mapping) => mapping.legacyMcpToolName),
      ).toEqual(fixture.legacyMcpToolNames);
    }
  });

  it("maps env requirements to environment configs and never reads process env", () => {
    for (const fixture of LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES) {
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
    for (const fixture of LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES) {
      await seedReplacementSourceFamily(fixture);
    }
    const catalog = createFileHostedIntegrationCatalog({ dataDir });

    for (const fixture of LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES) {
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
      LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES.flatMap(
        (fixture) => fixture.regressionExamples,
      ),
    ).toEqual([]);
  });

  it("ports Microsoft Graph GET as a source-backed deterministic hosted tool", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY;
    expect(fixture.familyId).toBe("msgraph");
    expect(fixture.replacementToolNames).toEqual(["msgraph_get"]);
    expect(fixture.sourceFiles["family.yaml"]).not.toContain(
      "handlerDispatch: legacy_call_tool",
    );
    expect(fixture.sourceFiles["msgraph.py"]).toContain(
      "def tool_msgraph_get(args, context):",
    );
    expect(fixture.sourceFiles["msgraph.py"]).toContain(
      "graph.microsoft.com",
    );
    expect(fixture.sourceFiles["msgraph.py"]).toContain("MSGRAPH_TENANT_ID");
    expect(fixture.sourceFiles["msgraph.py"]).toContain("MSGRAPH_CLIENT_ID");
    expect(fixture.sourceFiles["msgraph.py"]).toContain(
      "MSGRAPH_CLIENT_SECRET",
    );
    expect(fixture.sourceFiles["msgraph.py"]).not.toContain(
      '"replacement": True',
    );
    expect(fixture.sourceFiles["msgraph.py"]).not.toContain(
      "def call_tool(name, args, context):",
    );

    const manifest = FamilyManifestSchema.parse(
      parseYaml(fixture.sourceFiles["family.yaml"]),
    );
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toMatchObject({
      name: "msgraph_get",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: expect.objectContaining({ type: "string" }),
          params: expect.objectContaining({ type: "object" }),
          api_version: expect.objectContaining({ type: "string" }),
        },
        additionalProperties: false,
      },
    });

    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);

    expectNoValidationErrors(validation);
  });

  it("rejects absolute non-Graph URLs before Microsoft Graph token exchange", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY;
    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation, fixture);
    await seedMsGraphConfig();

    const result = await createGateway().invoke({
      actor: replacementActor,
      familyId: "msgraph",
      toolName: "msgraph_get",
      generationId: generation.id,
      environment: "test_debug",
      args: { path: "https://evil.example.test/users" },
      hostedToolBindings: [msgraphBinding()],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "bad_arguments",
        message: expect.stringContaining("graph.microsoft.com"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("login.microsoftonline.com");
  });

  it("ports MDE GET as a source-backed deterministic hosted tool", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY;
    expect(fixture.familyId).toBe("mde");
    expect(fixture.replacementToolNames).toEqual(["mde_get"]);
    expect(fixture.sourceFiles["family.yaml"]).not.toContain(
      "handlerDispatch: legacy_call_tool",
    );
    expect(fixture.sourceFiles["mde.py"]).toContain(
      "def tool_mde_get(args, context):",
    );
    expect(fixture.sourceFiles["mde.py"]).toContain(
      "api.securitycenter.microsoft.com",
    );
    expect(fixture.sourceFiles["mde.py"]).toContain("MDE_TENANT_ID");
    expect(fixture.sourceFiles["mde.py"]).toContain("MDE_CLIENT_ID");
    expect(fixture.sourceFiles["mde.py"]).toContain("MDE_CLIENT_SECRET");
    expect(fixture.sourceFiles["mde.py"]).not.toContain("MSGRAPH_");
    expect(fixture.sourceFiles["mde.py"]).not.toContain('"replacement": True');
    expect(fixture.sourceFiles["mde.py"]).not.toContain(
      "def call_tool(name, args, context):",
    );

    const manifest = FamilyManifestSchema.parse(
      parseYaml(fixture.sourceFiles["family.yaml"]),
    );
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toMatchObject({
      name: "mde_get",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: expect.objectContaining({ type: "string" }),
          params: expect.objectContaining({ type: "object" }),
        },
        additionalProperties: false,
      },
    });

    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);

    expectNoValidationErrors(validation);
  });

  it("rejects absolute non-MDE URLs before MDE token exchange", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY;
    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation, fixture);
    await seedMdeConfig();

    const result = await createGateway().invoke({
      actor: replacementActor,
      familyId: "mde",
      toolName: "mde_get",
      generationId: generation.id,
      environment: "test_debug",
      args: { path: "https://evil.example.test/api/machines" },
      hostedToolBindings: [mdeBinding()],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "bad_arguments",
        message: expect.stringContaining("api.securitycenter.microsoft.com"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("login.microsoftonline.com");
  });

  it("ports Defender Alert GET as a source-backed deterministic hosted tool", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY;
    expect(fixture.familyId).toBe("defender-alert");
    expect(fixture.replacementToolNames).toEqual(["defender_alert_get"]);
    expect(fixture.replacementToolNames).not.toContain("defender_alert_search");
    expect(fixture.sourceFiles["family.yaml"]).not.toContain(
      "handlerDispatch: legacy_call_tool",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).toContain(
      "def tool_defender_alert_get(args, context):",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).toContain(
      "/security/alerts_v2/",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).toContain(
      "/alerts/{graph_alert_id}",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).toContain(
      "DEFENDER_TENANT_ID",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).toContain(
      "DEFENDER_CLIENT_ID",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).toContain(
      "DEFENDER_CLIENT_SECRET",
    );
    expect(fixture.sourceFiles["defender_alert.py"]).not.toContain("MSGRAPH_");
    expect(fixture.sourceFiles["defender_alert.py"]).not.toContain("MDE_");
    expect(fixture.sourceFiles["defender_alert.py"]).not.toContain(
      '"replacement": True',
    );
    expect(fixture.sourceFiles["defender_alert.py"]).not.toContain(
      "def call_tool(name, args, context):",
    );

    const manifest = FamilyManifestSchema.parse(
      parseYaml(fixture.sourceFiles["family.yaml"]),
    );
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toMatchObject({
      name: "defender_alert_get",
      inputSchema: {
        type: "object",
        required: ["graph_alert_id"],
        properties: {
          graph_alert_id: expect.objectContaining({ type: "string" }),
        },
        additionalProperties: false,
      },
    });

    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);

    expectNoValidationErrors(validation);
  });

  it("rejects missing Defender Alert graph alert id before network calls", async () => {
    const fixture = LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY;
    await seedReplacementSourceFamily(fixture);
    const { draftId, lockId } = await createReplacementDraft(fixture);
    await registerReplacementExamples(draftId, lockId, fixture);
    const validation = await createFileHostedIntegrationDraftValidator({
      draftStore: createDraftStore(fixture),
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
      helpQualityMode: "error",
    }).validateDraft(draftId);
    const generation = await promoteDraft(draftId, validation, fixture);
    await seedDefenderAlertConfig();

    const result = await createGateway().invoke({
      actor: replacementActor,
      familyId: "defender-alert",
      toolName: "defender_alert_get",
      generationId: generation.id,
      environment: "test_debug",
      args: {},
      hostedToolBindings: [defenderAlertBinding()],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "bad_arguments",
        message: expect.stringContaining("graph_alert_id"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("login.microsoftonline.com");
  });
});

const replacementActor: HostedIntegrationPolicyActor = {
  id: "agent:import-test",
  kind: "agent",
  roles: ["agent"],
};

async function seedReplacementSourceFamily(
  fixture = FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
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

async function createReplacementDraft(
  fixture = FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
): Promise<{
  draftId: string;
  lockId: string;
}> {
  const lockId = `lock_import_${safeFixtureId(fixture)}`;
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
    sourceRevisionId: "source_rev_import_1",
    files: fixture.sourceFiles,
  });
  if (!created.ok) throw new Error(created.reason);
  return { draftId: created.draft.id, lockId };
}

async function registerReplacementExamples(
  draftId: string,
  lockId: string,
  fixture = FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
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
  fixture = FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
) {
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore: createDraftStore(fixture),
    now: () => new Date(nowMs),
    createId: () => `gen_import_${safeFixtureId(fixture)}`,
  }).promoteDraft({
    draftId,
    promotedBy: "agent:tool-developer",
    validation,
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  return promoted.generation;
}

async function seedSplunkConfig(): Promise<void> {
  const environmentConfigId = hostedIntegrationEnvironmentConfigId(
    "splunk",
    "test_debug",
  );
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertEnvironmentConfig({
    familyId: "splunk",
    environment: "test_debug",
    config: { SPLUNK_BASE_URL: "https://splunk.example.test" },
    secrets: { SPLUNK_TOKEN: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId: environmentConfigId,
    secrets: { SPLUNK_TOKEN: "raw-token-secret" },
    updatedBy: "human:operator",
  });
}

async function seedMsGraphConfig(): Promise<void> {
  const environmentConfigId = hostedIntegrationEnvironmentConfigId(
    "msgraph",
    "test_debug",
  );
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertEnvironmentConfig({
    familyId: "msgraph",
    environment: "test_debug",
    config: {
      MSGRAPH_TENANT_ID: "tenant-id",
      MSGRAPH_CLIENT_ID: "client-id",
      MSGRAPH_TIMEOUT_SECONDS: "1",
      MSGRAPH_MAX_PAGES: "1",
      MSGRAPH_API_VERSION: "v1.0",
    },
    secrets: { MSGRAPH_CLIENT_SECRET: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId,
    secrets: { MSGRAPH_CLIENT_SECRET: "client-secret" },
    updatedBy: "human:operator",
  });
}

async function seedMdeConfig(): Promise<void> {
  const environmentConfigId = hostedIntegrationEnvironmentConfigId(
    "mde",
    "test_debug",
  );
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertEnvironmentConfig({
    familyId: "mde",
    environment: "test_debug",
    config: {
      MDE_TENANT_ID: "tenant-id",
      MDE_CLIENT_ID: "client-id",
      MDE_TIMEOUT_SECONDS: "1",
      MDE_MAX_PAGES: "1",
    },
    secrets: { MDE_CLIENT_SECRET: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId,
    secrets: { MDE_CLIENT_SECRET: "client-secret" },
    updatedBy: "human:operator",
  });
}

async function seedDefenderAlertConfig(): Promise<void> {
  const environmentConfigId = hostedIntegrationEnvironmentConfigId(
    "defender-alert",
    "test_debug",
  );
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertEnvironmentConfig({
    familyId: "defender-alert",
    environment: "test_debug",
    config: {
      DEFENDER_TENANT_ID: "tenant-id",
      DEFENDER_CLIENT_ID: "client-id",
      DEFENDER_TIMEOUT_SECONDS: "1",
    },
    secrets: { DEFENDER_CLIENT_SECRET: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId,
    secrets: { DEFENDER_CLIENT_SECRET: "client-secret" },
    updatedBy: "human:operator",
  });
}

async function seedQualysConfig(): Promise<void> {
  const environmentConfigId = hostedIntegrationEnvironmentConfigId(
    "qualys",
    "test_debug",
  );
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertEnvironmentConfig({
    familyId: "qualys",
    environment: "test_debug",
    config: {
      endpoint: "https://qualys.example.test",
      QUALYS_VM_URL: "https://qualys-vm.example.test",
      QUALYS_GATEWAY_URL: "https://qualys-gateway.example.test",
    },
    secrets: {
      apiToken: { configured: true },
      QUALYS_USERNAME: { configured: true },
      QUALYS_PASSWORD: { configured: true },
    },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId: environmentConfigId,
    secrets: {
      apiToken: "raw-token-secret",
      QUALYS_USERNAME: "qualys-user",
      QUALYS_PASSWORD: "qualys-password",
    },
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
  const environmentConfigId = hostedIntegrationEnvironmentConfigId(
    "qualys",
    "test_debug",
  );
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    now: () => new Date(nowMs),
    familyId: "qualys",
    environment: "test_debug",
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
    environmentConfigId: environmentConfigId,
    secrets: liveConfig.secrets,
    updatedBy: "human:operator",
  });
}

function createDraftStore(
  fixture = FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
) {
  return createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore: createFileHostedIntegrationLockStore({
      dataDir,
      now: () => new Date(nowMs),
    }),
    now: () => new Date(nowMs),
    createId: () => `draft_import_${safeFixtureId(fixture)}`,
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
    agentId: replacementActor.id,
    familyId: "splunk",
    toolName: "splunk_search",
    allowedEnvironments: ["test_debug"],
    defaultEnvironment: "test_debug",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:operator",
  };
}

function msgraphBinding() {
  return {
    agentId: replacementActor.id,
    familyId: "msgraph",
    toolName: "msgraph_get",
    allowedEnvironments: ["test_debug"],
    defaultEnvironment: "test_debug",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:operator",
  };
}

function mdeBinding() {
  return {
    agentId: replacementActor.id,
    familyId: "mde",
    toolName: "mde_get",
    allowedEnvironments: ["test_debug"],
    defaultEnvironment: "test_debug",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:operator",
  };
}

function defenderAlertBinding() {
  return {
    agentId: replacementActor.id,
    familyId: "defender-alert",
    toolName: "defender_alert_get",
    allowedEnvironments: ["test_debug"],
    defaultEnvironment: "test_debug",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:operator",
  };
}

function liveQualysBinding(toolName: string) {
  return {
    agentId: replacementActor.id,
    familyId: "qualys",
    toolName,
    allowedEnvironments: ["test_debug"],
    defaultEnvironment: "test_debug",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:operator",
  };
}

function safeFixtureId(
  fixture: LegacyIntegrationHubReplacementFamilyFixture,
): string {
  return fixture.familyId.replaceAll("-", "_");
}

function expectNoValidationErrors(validation: {
  ok: boolean;
  diagnostics: Array<{ severity: string }>;
}): void {
  expect(validation.ok).toBe(true);
  expect(validation.diagnostics.filter((item) => item.severity === "error")).toEqual(
    [],
  );
}
