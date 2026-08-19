import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationService,
  validateHostedFamilyPackage,
} from "../src/index.js";

type RemainingPackageStatus =
  | "source_backed_ready"
  | "draft_only"
  | "evidence_required"
  | "no_hosted_equivalent";

type RemainingPackageFamily = {
  familyId: string;
  packageStatus: RemainingPackageStatus;
  packageRoot: string;
  targetHostedNamespace: string;
  configKeys: string[];
  secretRefs: string[];
};

type RemainingPackageTool = {
  legacyMcpToolName: string;
  legacyToolName: string;
  historicalFamilyId: string;
  targetFamilyId: string;
  hostedToolName: string | null;
  hostedMcpName: string | null;
  status: RemainingPackageStatus;
  packageRoot: string;
  sourceReferences: string[];
  evidenceRequired: string[];
  kqlPolicy: string;
  safety: string;
  notes: string[];
};

type RemainingPackageInventory = {
  version: number;
  kind: string;
  statusVocabulary: RemainingPackageStatus[];
  globalRules: string[];
  canonicalSources: Array<{ sourceId: string; path: string; role: string }>;
  families: RemainingPackageFamily[];
  tools: RemainingPackageTool[];
  excludedOperations: Array<{
    name: string;
    status: RemainingPackageStatus;
    reason: string;
  }>;
};

const inventoryPath = path.resolve(
  process.cwd(),
  "../../docs/hosted-integrations-remaining-integration-hub-packages.yaml",
);
const implementationPlanPath = path.resolve(
  process.cwd(),
  "../../docs/hosted-integrations-implementation-plan.md",
);
const architecturePath = path.resolve(
  process.cwd(),
  "../../docs/hosted-integrations-architecture.md",
);
const repoRoot = path.resolve(new URL("../../../", import.meta.url).pathname);
function defaultExternalPackageRoot(packageName: string): string {
  const fallback = path.resolve(repoRoot, `../${packageName}`);
  const candidates = [
    fallback,
    path.resolve(repoRoot, `../../../${packageName}`),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}
const externalPackageRoots: Record<string, string> = {
  msgraph:
    process.env.OPENACME_MSGRAPH_HOSTED_PACKAGE_ROOT ??
    defaultExternalPackageRoot("openacme-hosted-tools-msgraph"),
  microsoft_defender:
    process.env.OPENACME_MICROSOFT_DEFENDER_HOSTED_PACKAGE_ROOT ??
    defaultExternalPackageRoot("openacme-hosted-tools-microsoft-defender"),
  splunk:
    process.env.OPENACME_SPLUNK_HOSTED_PACKAGE_ROOT ??
    defaultExternalPackageRoot("openacme-hosted-tools-splunk"),
};

function loadInventory(): RemainingPackageInventory {
  return parseYaml(readFileSync(inventoryPath, "utf8")) as RemainingPackageInventory;
}

describe("M44 remaining integration-hub package inventory", () => {
  it("declares explicit target package families and package status", () => {
    const inventory = loadInventory();

    expect(inventory.kind).toBe(
      "hosted-integration-remaining-integration-hub-package-inventory",
    );
    expect(inventory.statusVocabulary).toEqual([
      "source_backed_ready",
      "draft_only",
      "evidence_required",
      "no_hosted_equivalent",
    ]);
    expect(inventory.families.map((family) => family.familyId)).toEqual([
      "msgraph",
      "microsoft_defender",
      "splunk",
    ]);

    for (const family of inventory.families) {
      expect(inventory.statusVocabulary).toContain(family.packageStatus);
      expect(family.packageRoot).toMatch(/^\.\.\/openacme-hosted-tools-/);
      expect(family.targetHostedNamespace).toBe(`hosted_${family.familyId}`);
      expect([...family.configKeys, ...family.secretRefs].length).toBeGreaterThan(
        0,
      );
    }
  });

  it("keeps historical mde and defender-alert under the merged microsoft_defender target family", () => {
    const inventory = loadInventory();
    const defenderRows = inventory.tools.filter(
      (tool) =>
        tool.historicalFamilyId === "mde" ||
        tool.historicalFamilyId === "defender-alert",
    );

    expect(defenderRows.length).toBeGreaterThan(0);
    expect(
      new Set(defenderRows.map((tool) => tool.targetFamilyId)),
    ).toEqual(new Set(["microsoft_defender"]));
    expect(
      new Set(defenderRows.map((tool) => tool.packageRoot)),
    ).toEqual(new Set(["../openacme-hosted-tools-microsoft-defender"]));
    expect(inventory.families.map((family) => family.familyId)).not.toContain(
      "mde",
    );
    expect(inventory.families.map((family) => family.familyId)).not.toContain(
      "defender-alert",
    );
  });

  it("maps every active hosted row to exactly one canonical hosted tool name", () => {
    const inventory = loadInventory();
    const activeRows = inventory.tools.filter(
      (tool) => tool.status !== "no_hosted_equivalent",
    );

    expect(activeRows.length).toBeGreaterThan(0);
    for (const row of activeRows) {
      expect(row.hostedToolName).toBeTruthy();
      expect(row.hostedMcpName).toBe(
        `hosted_${row.targetFamilyId}__${row.hostedToolName}`,
      );
    }
    expect(new Set(activeRows.map((tool) => tool.hostedMcpName)).size).toBe(
      activeRows.length,
    );
  });

  it("requires an explicit no-hosted-equivalent row for generic mde_get", () => {
    const inventory = loadInventory();
    const noEquivalentRows = inventory.tools.filter(
      (tool) => tool.status === "no_hosted_equivalent",
    );

    expect(noEquivalentRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacyMcpToolName: "mcp_integration-hub__mde_get",
          legacyToolName: "mde_get",
          targetFamilyId: "microsoft_defender",
          hostedToolName: null,
          hostedMcpName: null,
          kqlPolicy: "generic_mde_get_rejected",
        }),
      ]),
    );
  });

  it("rejects generic Microsoft Defender path wrappers and KQL-duplicate REST list tools from the target surface", () => {
    const inventory = loadInventory();
    const hostedNames = inventory.tools
      .map((tool) => tool.hostedMcpName)
      .filter(Boolean);
    const excludedNames = inventory.excludedOperations.map((entry) => entry.name);

    expect(hostedNames).not.toContain("hosted_microsoft_defender__mde_get");
    expect(hostedNames).not.toContain("hosted_microsoft_defender__mde_request");
    expect(hostedNames).not.toContain("hosted_microsoft_defender__mde_api_get");
    expect(excludedNames).toEqual(
      expect.arrayContaining([
        "hosted_microsoft_defender__mde_get",
        "hosted_microsoft_defender__mde_list_alerts",
        "hosted_microsoft_defender__mde_list_machines",
        "hosted_microsoft_defender__mde_list_machine_logon_users",
      ]),
    );
    expect(
      inventory.excludedOperations.find(
        (entry) =>
          entry.name === "hosted_microsoft_defender__mde_list_machine_logon_users",
      )?.reason,
    ).toContain("DeviceLogonEvents");
  });

  it("requires EVIDENCE_REQUIRED for unknown provider behavior before promotion", () => {
    const inventory = loadInventory();
    const evidenceRequiredRows = inventory.tools.filter(
      (tool) => tool.status === "evidence_required",
    );

    expect(evidenceRequiredRows.length).toBeGreaterThan(0);
    for (const row of evidenceRequiredRows) {
      expect(row.evidenceRequired.length).toBeGreaterThan(0);
      expect(row.evidenceRequired.join("\n")).toMatch(
        /Official|imported|Live|Real|endpoint|permissions|response|auth/i,
      );
    }
    expect(
      inventory.globalRules.join("\n"),
    ).toContain("EVIDENCE_REQUIRED");
  });

  it("keeps deployable provider sources outside platform runtime and integration-hub paths", () => {
    const inventory = loadInventory();
    const forbiddenPathFragments = [
      "packages/hosted-integrations/src",
      "packages/tools",
      "packages/server/src",
      "packages/hosted-integrations/test-support/integration-hub",
      "integration-hub",
    ];

    for (const family of inventory.families) {
      expect(family.packageRoot).toMatch(/^\.\.\//);
      for (const fragment of forbiddenPathFragments) {
        expect(family.packageRoot).not.toContain(fragment);
      }
    }
    for (const tool of inventory.tools) {
      for (const fragment of forbiddenPathFragments) {
        expect(tool.packageRoot).not.toContain(fragment);
      }
    }
  });

  it("persists milestone boundaries in docs instead of relying on chat memory", () => {
    const plan = readFileSync(implementationPlanPath, "utf8");
    const architecture = readFileSync(architecturePath, "utf8");

    expect(plan).toContain("Do not delete, rename, or modify integration-hub");
    expect(plan).toContain("Do not modify provider/operator skills");
    expect(plan).toContain("local production OpenAcme data directory");
    expect(plan).toContain("hosted_microsoft_defender__mde_get");
    expect(plan).toContain("DeviceLogonEvents");
    expect(architecture).toContain("Advanced Hunting/KQL");
    expect(architecture).toContain("DeviceLogonEvents");
  });

  it("validates documented sibling external package roots when present", async () => {
    const inventory = loadInventory();

    for (const family of inventory.families) {
      const packageRoot = externalPackageRoots[family.familyId];
      if (!packageRoot || !existsSync(packageRoot)) continue;

      const validationScript = path.join(packageRoot, "scripts", "validate-package.mjs");
      expect(existsSync(validationScript)).toBe(true);
      const localValidation = spawnSync(process.execPath, [validationScript], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      expect(localValidation.status).toBe(0);

      const packagePath = path.join(
        packageRoot,
        "dist",
        `${family.familyId}.hosted-family-package.json`,
      );
      expect(existsSync(packagePath)).toBe(true);
      const packageDocument = JSON.parse(readFileSync(packagePath, "utf8"));
      const platformValidation = await validateHostedFamilyPackage(
        packageDocument,
        { targetFamilyId: family.familyId },
      );
      expect(platformValidation.diagnostics).toEqual([]);
      expect(platformValidation.ok).toBe(true);
    }
  });

  it("keeps the Microsoft Defender external package KQL-first and specific-tool-only", () => {
    const packageRoot = externalPackageRoots.microsoft_defender;
    if (!existsSync(packageRoot)) return;

    const packagePath = path.join(
      packageRoot,
      "dist",
      "microsoft_defender.hosted-family-package.json",
    );
    expect(existsSync(packagePath)).toBe(true);
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8")) as {
      files: Array<{ path: string; content: string }>;
    };
    const fileMap = new Map(
      packageDocument.files.map((file) => [file.path, file.content]),
    );
    const tools = parseYaml(fileMap.get("tools.yaml") ?? "") as {
      tools: Array<{
        mcp: { name: string; inputSchema: { properties?: Record<string, unknown> } };
        openacme: { toolName: string; lifecycle: string; fullHelp?: string };
      }>;
    };
    const toolNames = tools.tools.map((tool) => tool.openacme.toolName).sort();

    expect(toolNames).toEqual([
      "defender_alert_get",
      "mde_get_alert",
      "mde_get_machine",
      "mde_run_advanced_hunting_query",
    ]);
    expect(
      tools.tools.map((tool) => tool.mcp.name).sort(),
    ).toEqual([
      "hosted_microsoft_defender__defender_alert_get",
      "hosted_microsoft_defender__mde_get_alert",
      "hosted_microsoft_defender__mde_get_machine",
      "hosted_microsoft_defender__mde_run_advanced_hunting_query",
    ]);

    for (const tool of tools.tools) {
      const publicInputNames = Object.keys(tool.mcp.inputSchema.properties ?? {});
      expect(publicInputNames).not.toContain("path");
      expect(publicInputNames).not.toContain("url");
      expect(publicInputNames).not.toContain("endpoint");
      expect(tool.openacme.fullHelp ?? "").not.toMatch(/search\/list alternative/i);
    }

    const source = fileMap.get("microsoft_defender.py") ?? "";
    expect(source).toContain('DEFENDER_API_BASE = "https://api.security.microsoft.com/api"');
    expect(source).toContain("/alerts/");
    expect(source).toContain("/machines/");
    expect(source).toContain("/v1.0/security/runHuntingQuery");
    expect(source).not.toContain("/advancedqueries/run");
    expect(source).not.toContain("def tool_mde_get(");
    expect(source).not.toContain("def tool_mde_request(");
    expect(source).not.toContain("def tool_mde_api_get(");

    const officialSources = fileMap.get("references/official-sources.md") ?? "";
    expect(officialSources).toContain("get-alert-info-by-id");
    expect(officialSources).toContain("get-machine-by-id");
    expect(officialSources).toContain("security-security-runhuntingquery");
    expect(officialSources).toContain("run-advanced-query-api");
    expect(officialSources).toContain("advanced-hunting-alertevidence-table");
    expect(officialSources).toContain("DeviceLogonEvents");
  });

  it("imports, promotes, and exports source-backed external packages in an isolated data dir", async () => {
    const inventory = loadInventory();
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "openacme-m44-external-packages-"),
    );
    try {
      const service = createFileHostedIntegrationService({
        dataDir,
        now: () => new Date("2026-08-19T12:00:00.000Z"),
      });
      const sourceBackedFamilies = inventory.families.filter(
        (family) => family.packageStatus === "source_backed_ready",
      );
      expect(sourceBackedFamilies.map((family) => family.familyId).sort()).toEqual([
        "microsoft_defender",
        "msgraph",
      ]);

      for (const family of sourceBackedFamilies) {
        const packageRoot = externalPackageRoots[family.familyId];
        if (!packageRoot || !existsSync(packageRoot)) continue;
        const packageDocument = JSON.parse(
          readFileSync(
            path.join(
              packageRoot,
              "dist",
              `${family.familyId}.hosted-family-package.json`,
            ),
            "utf8",
          ),
        );
        const imported = await service.packages.importPackage({
          mode: "create",
          packageDocument,
          importedBy: "agent:tool-developer",
          targetFamilyId: family.familyId,
          ttlMs: 60_000,
        });
        expect(imported).toMatchObject({
          ok: true,
          validation: { ok: true, diagnostics: [] },
        });
        if (!imported.ok) throw new Error(`expected import for ${family.familyId}`);

        const promoted = await service.generations.promoteDraft({
          draftId: imported.draft.id,
          promotedBy: "agent:tool-developer",
          validation: imported.validation,
        });
        expect(promoted.ok).toBe(true);

        const exported = await service.packages.exportPackage({
          source: { type: "active_generation", familyId: family.familyId },
          exportedBy: "agent:tool-developer",
        });
        expect(exported.ok).toBe(true);
        if (!exported.ok) throw new Error(`expected export for ${family.familyId}`);
        expect(exported.exportedFiles.sort()).toEqual(
          packageDocument.files.map((file: { path: string }) => file.path).sort(),
        );
      }

      const splunk = inventory.families.find(
        (family) => family.familyId === "splunk",
      );
      expect(splunk?.packageStatus).toBe("evidence_required");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
