import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";
import { describe, expect, it } from "vitest";
import {
  LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES,
  QUALYS_TOOL_NAMES,
} from "../test-support/integration-hub/fixtures.js";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  HostedToolContractDocumentSchema,
  validateHostedFamilyPackage,
  resolveHostedIntegrationToolHelp,
} from "../src/index.js";

type InventoryTool = {
  toolName: string;
  status: string;
  hostedMcpName: string;
  handlerName: string;
  operationCategory: string;
  sourceReferences: string[];
  endpointEvidence: string[];
  resultMode: string;
  paginationModel: string;
  idDiscoveryRequired: boolean;
  safety: string;
};

type QualysLiveInventory = {
  version: number;
  familyId: string;
  hostedNamespace: string;
  statusVocabulary: string[];
  canonicalSources: Array<{ sourceId: string; path: string; role: string }>;
  globalRules: string[];
  currentPromotedBatch: { description: string; tools: string[] };
  tools: InventoryTool[];
  excludedOperations: Array<{ name: string; status: string; reason: string }>;
  scopedOutModules: Array<{ name: string; status: string }>;
};

type QualysHelpCoverageRequirement = {
  path: string;
  contains?: string[];
  equals?: string;
};

type QualysHelpCoverageTool = {
  toolName: string;
  status: string;
  requiredCoverage: QualysHelpCoverageRequirement[];
};

type QualysHelpCoverageMatrix = {
  version: number;
  familyId: string;
  scope: string;
  contractSource: string;
  batchSource: string;
  globalRules: Array<{ ruleId: string; representedBy: string[] }>;
  tools: QualysHelpCoverageTool[];
};

type QualysPerToolAuditRow = {
  toolName: string;
  status: "audited" | "fixed" | "evidence_required";
  sourcesCompared: string[];
  inputsVerified: string[];
  helpVerified: string[];
  runtimeValidationVerified: string[];
  examplesVerified: string[];
  knownOmissions: string[];
  evidenceRequired: string[];
};

type QualysPerToolAudit = {
  version: number;
  familyId: string;
  scope: string;
  contractSource: string;
  requiredSources: string[];
  sourceCatalog: Record<string, { path: string; role: string }>;
  tools: QualysPerToolAuditRow[];
};

type QualysCoverageTrackerRow = {
  toolName: string;
  auditStatus: string;
  comparedWithIntegrationHub: string;
  comparedWithUserSkill: string;
  comparedWithDevSkill: string;
  packageHelpStatus: string;
  runtimeValidationStatus: string;
  examplesStatus: string;
  liveSmokeStatus: string;
};

type QualysCoverageTracker = {
  version: number;
  familyId: string;
  status: "in_progress" | "complete";
  currentRound: string;
  rounds: Array<{ id: string; status: string; summary: string }>;
  toolStatuses: QualysCoverageTrackerRow[];
};

type LiveEvaluationScenario = {
  id: string;
  execution: "active" | "planned";
  coverage: string[];
  expectedOutcome: "hosted_call" | "evidence_required" | "refusal" | "recovery";
  familyId: string;
  preferredToolName: string;
  availableToolNames?: string[];
  acceptedArtifacts?: Array<{
    runId: string;
    path: string;
    status: "pass";
    secretScan: "pass";
    evidence: string;
  }>;
  guidance: string;
  prompt: string;
  analyzer: {
    requireUnguided?: boolean;
    requireDetailedHelpOrVocabularyLookup?: boolean;
    forbiddenToolNames?: string[];
    forbiddenHostedArgumentFragments?: string[];
    requiredHostedArgumentFragments?: string[];
    requiredHelpParameterNames?: string[];
    requiredHostedResultFragments?: string[];
    requiredHostedResultSummaryKeys?: string[];
    forbiddenOutcomeFragments?: string[];
    requiredOutcomeFragments?: string[];
    requiredDisabledMcpServers?: string[];
  };
};

type LiveEvaluationScenarioManifest = {
  schemaVersion: string;
  scenarios: LiveEvaluationScenario[];
};

type VocabularyAcceptanceArea = {
  id: string;
  when_changed: string[];
  must_prove: string[];
  commands: string[];
  live_commands_when_claiming_model_usability?: string[];
};

type VocabularyAcceptanceMatrix = {
  version: number;
  kind: string;
  rules: Array<{ id: string; requirement: string }>;
  areas: VocabularyAcceptanceArea[];
  complete_bundle: {
    deterministic_commands: string[];
    live_optional_until_claimed: { requirement: string };
  };
};

const inventoryPath = path.resolve(
  process.cwd(),
  "../../docs/hosted-integrations-qualys-live-migration-inventory.yaml",
);
const helpCoveragePath = path.resolve(
  process.cwd(),
  "../../docs/hosted-integrations-qualys-help-coverage.yaml",
);
const implementationPlanPath = path.resolve(
  process.cwd(),
  "../../docs/hosted-integrations-implementation-plan.md",
);
const liveEvaluationScenariosPath = path.resolve(
  process.cwd(),
  "../../docs/hosted-tools-live-evaluation-scenarios.yaml",
);
const vocabularyAcceptanceMatrixPath = path.resolve(
  process.cwd(),
  "../../docs/hosted-tools-vocabulary-acceptance-matrix.yaml",
);
const acceptedLiveArtifactPathPrefix =
  "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance/";
const externalQualysPackageRoot =
  process.env.OPENACME_QUALYS_HOSTED_PACKAGE_ROOT ??
  "/Users/alenbohcelyan/Documents/AIProjects/openacme-hosted-tools-qualys";
const currentPilotNamingGuardPaths = [
  path.resolve(
    process.cwd(),
    "test-support/integration-hub/fixtures.ts",
  ),
  path.resolve(
    process.cwd(),
    "test-support/integration-hub/qualys-source.ts",
  ),
  path.resolve(process.cwd(), "test/integration-hub-replacement.test.ts"),
  path.resolve(process.cwd(), "test/packages.test.ts"),
  path.resolve(
    process.cwd(),
    "../server/test-support/integration-hub/live-parity.ts",
  ),
  path.resolve(process.cwd(), "../server/test/tools-hosted-integrations.test.ts"),
];

function readInventory(): QualysLiveInventory {
  return readStrictYaml<QualysLiveInventory>(inventoryPath);
}

function readHelpCoverage(): QualysHelpCoverageMatrix {
  return readStrictYaml<QualysHelpCoverageMatrix>(helpCoveragePath);
}

function readPerToolAuditFromFiles(
  files: Record<string, string>,
): QualysPerToolAudit {
  const content = files["references/per-tool-audit.yaml"];
  expect(
    content,
    "external package must include references/per-tool-audit.yaml",
  ).toBeDefined();
  const document = parseDocument(content!, { uniqueKeys: true });
  expect(
    document.errors.map((error) => error.message),
    "per-tool-audit.yaml YAML parse errors",
  ).toEqual([]);
  return document.toJSON() as QualysPerToolAudit;
}

function readCoverageTrackerFromFiles(
  files: Record<string, string>,
): QualysCoverageTracker {
  const content = files["references/coverage-tracker.yaml"];
  expect(
    content,
    "external package must include references/coverage-tracker.yaml",
  ).toBeDefined();
  const document = parseDocument(content!, { uniqueKeys: true });
  expect(
    document.errors.map((error) => error.message),
    "coverage-tracker.yaml YAML parse errors",
  ).toEqual([]);
  return document.toJSON() as QualysCoverageTracker;
}

function readLiveEvaluationScenarios(): LiveEvaluationScenarioManifest {
  return readStrictYaml<LiveEvaluationScenarioManifest>(
    liveEvaluationScenariosPath,
  );
}

function readVocabularyAcceptanceMatrix(): VocabularyAcceptanceMatrix {
  return readStrictYaml<VocabularyAcceptanceMatrix>(
    vocabularyAcceptanceMatrixPath,
  );
}

function readStrictYaml<T>(filePath: string): T {
  const content = readFileSync(filePath, "utf-8");
  const document = parseDocument(content, { uniqueKeys: true });
  expect(
    document.errors.map((error) => error.message),
    `${path.basename(filePath)} YAML parse errors`,
  ).toEqual([]);
  return document.toJSON() as T;
}

function readExternalHostedPackageSource(
  root: string,
): Record<string, string> | null {
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  const files: Record<string, string> = {};
  const ignoredDirs = new Set([".git", "dist", "node_modules"]);
  const allowedExtensions = new Set([".yaml", ".yml", ".py", ".json", ".md"]);
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name.startsWith(".") || ignoredDirs.has(name)) continue;
      const fullPath = path.join(directory, name);
      const stat = statSync(fullPath);
      const relativePath = path
        .relative(root, fullPath)
        .split(path.sep)
        .join("/");
      if (stat.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (relativePath.startsWith("scripts/")) continue;
      if (!allowedExtensions.has(path.extname(name))) continue;
      files[relativePath] = readFileSync(fullPath, "utf-8");
    }
  };
  visit(root);
  return files;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

const packageJsonByName = new Map([
  [
    "@openacme/hosted-integrations",
    path.resolve(process.cwd(), "package.json"),
  ],
  ["@openacme/tools", path.resolve(process.cwd(), "../tools/package.json")],
  ["@openacme/server", path.resolve(process.cwd(), "../server/package.json")],
]);

const packageJsonByDir = new Map([
  ["apps/web", path.resolve(process.cwd(), "../../apps/web/package.json")],
]);
const rootPackageJsonPath = path.resolve(process.cwd(), "../../package.json");

function readPackageScripts(packageName: string): Record<string, string> {
  const packageJsonPath = packageJsonByName.get(packageName);
  expect(packageJsonPath, `unknown package ${packageName}`).toBeDefined();
  const packageJson = JSON.parse(readFileSync(packageJsonPath!, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function readPackageScriptsByDir(packageDir: string): Record<string, string> {
  const packageJsonPath = packageJsonByDir.get(packageDir);
  expect(packageJsonPath, `unknown package dir ${packageDir}`).toBeDefined();
  const packageJson = JSON.parse(readFileSync(packageJsonPath!, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function readRootPackageScripts(): Record<string, string> {
  const packageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

function matrixCommands(matrix: VocabularyAcceptanceMatrix): string[] {
  return [
    ...matrix.areas.flatMap((area) => [
      ...area.commands,
      ...(area.live_commands_when_claiming_model_usability ?? []),
    ]),
    ...matrix.complete_bundle.deterministic_commands,
  ];
}

describe("Qualys live hosted migration inventory", () => {
  it("stores the current Qualys source fixture as split family.yaml plus tools.yaml", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const manifest = parseYaml(sourceFiles["family.yaml"]) as Record<
      string,
      unknown
    >;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );

    expect(sourceFiles).toHaveProperty("tools.yaml");
    expect(manifest).toMatchObject({ id: "qualys", name: "Qualys" });
    expect(manifest).not.toHaveProperty("tools");
    expect(contract.tools.map((tool) => tool.openacme.toolName).sort()).toEqual(
      [...LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES].sort(),
    );
    expect(
      contract.tools.map((tool) => tool.mcp.name).sort(),
    ).toEqual(
      [...LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES]
        .map((toolName) => `hosted_qualys__${toolName}`)
        .sort(),
    );
  });

  it("classifies every current Qualys tool exactly once", () => {
    const inventory = readInventory();
    const toolNames = inventory.tools.map((tool) => tool.toolName);

    expect(inventory).toMatchObject({
      version: 1,
      familyId: "qualys",
      hostedNamespace: "hosted_qualys",
    });
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames.sort()).toEqual([...QUALYS_TOOL_NAMES].sort());
  });

  it("keeps included_live rows aligned with the current promoted batch", () => {
    const inventory = readInventory();
    const inventoryRows = new Map(
      inventory.tools.map((tool) => [tool.toolName, tool]),
    );

    expect(inventory.globalRules.join("\n")).toContain(
      "included_live means the tool is in the current promoted/source-backed hosted contract",
    );
    expect(inventory.globalRules.join("\n")).toContain(
      "currentPromotedBatch is the authoritative current hosted Qualys contract scope",
    );
    expect(inventory.currentPromotedBatch.description).toContain(
      "Current promoted/source-backed hosted Qualys contract scope",
    );
    expect(sorted(inventory.currentPromotedBatch.tools)).toEqual(
      sorted(LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES),
    );
    expect(
      sorted(
        inventory.tools
          .filter((tool) => tool.status === "included_live")
          .map((tool) => tool.toolName),
      ),
    ).toEqual(
      sorted(LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES),
    );
    for (const toolName of inventory.currentPromotedBatch.tools) {
      expect(inventoryRows.get(toolName)?.status, toolName).toBe(
        "included_live",
      );
    }
  });

  it("keeps blocked broader Qualys migration rows out of the current promoted contract", () => {
    const inventory = readInventory();
    const matrix = readHelpCoverage();
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const currentPromotedTools = new Set(inventory.currentPromotedBatch.tools);
    const blockedBroaderTools = inventory.tools
      .filter((tool) => tool.status === "blocked_evidence_required")
      .map((tool) => tool.toolName)
      .filter((toolName) => !currentPromotedTools.has(toolName));
    const contractToolNames = new Set(
      contract.tools.map((tool) => tool.openacme.toolName),
    );
    const coverageToolNames = new Set(matrix.tools.map((tool) => tool.toolName));
    const exampleToolNames = new Set(
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples.map(
        (example) => example.toolName,
      ),
    );

    expect(blockedBroaderTools.length).toBeGreaterThan(0);
    for (const toolName of blockedBroaderTools) {
      expect(contractToolNames, `${toolName} must not be in tools.yaml`).not.toContain(
        toolName,
      );
      expect(
        coverageToolNames,
        `${toolName} must not be in current help coverage`,
      ).not.toContain(toolName);
      expect(exampleToolNames, `${toolName} must not have current examples`).not.toContain(
        toolName,
      );
    }
  });

  it("records required migration metadata for each inventory row", () => {
    const inventory = readInventory();
    const allowedStatuses = new Set(inventory.statusVocabulary);
    const sourceIds = new Set(
      inventory.canonicalSources.map((source) => source.sourceId),
    );

    for (const tool of inventory.tools) {
      expect(allowedStatuses.has(tool.status), tool.toolName).toBe(true);
      expect(tool.hostedMcpName).toBe(`hosted_qualys__${tool.toolName}`);
      expect(tool.handlerName).toBe(`tool_${tool.toolName}`);
      expect(tool.operationCategory, tool.toolName).not.toHaveLength(0);
      expect(tool.sourceReferences.length, tool.toolName).toBeGreaterThan(0);
      expect(tool.endpointEvidence.length, tool.toolName).toBeGreaterThan(0);
      expect(tool.resultMode, tool.toolName).not.toHaveLength(0);
      expect(tool.paginationModel, tool.toolName).not.toHaveLength(0);
      expect(typeof tool.idDiscoveryRequired, tool.toolName).toBe("boolean");
      expect(tool.safety, tool.toolName).not.toHaveLength(0);
      expect(
        tool.sourceReferences.every((sourceRef) => sourceIds.has(sourceRef)),
        tool.toolName,
      ).toBe(true);
      if (tool.status === "included_live") {
        expect(tool.endpointEvidence.join("\n"), tool.toolName).not.toMatch(
          /local reference|local snapshot|local cache/i,
        );
        if (tool.operationCategory === "vmdr_search_lists") {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).not.toMatch(
            /\bFO\b .* with native params/i,
          );
        }
        if (
          tool.toolName === "qualys_vmdr_scan_summary" ||
          tool.toolName === "qualys_vmdr_scan_vm_summary"
        ) {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).toMatch(
            /\/api\/|\/rest\//,
          );
          expect(tool.endpointEvidence.join("\n"), tool.toolName).not.toMatch(
            /\bFO\b .* with native params/i,
          );
        }
        if (tool.operationCategory === "vmdr_report_read_view") {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).toMatch(
            /\/api\/|\/rest\//,
          );
          expect(tool.endpointEvidence.join("\n"), tool.toolName).not.toMatch(
            /\bFO\b .* with native params/i,
          );
        }
        if (tool.operationCategory === "policy_compliance_read_view") {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).toMatch(
            /\/api\/|\/rest\//,
          );
          expect(tool.endpointEvidence.join("\n"), tool.toolName).not.toMatch(
            /Policy Compliance .* with native params/i,
          );
        }
        if (tool.operationCategory === "continuous_monitoring") {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).toMatch(
            /\/qps\/rest\/|\/api\/|\/rest\//,
          );
          expect(tool.endpointEvidence.join("\n"), tool.toolName).not.toMatch(
            /Continuous Monitoring .* (search|get|download)/i,
          );
        }
        if (tool.operationCategory === "activity_audit") {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).toMatch(
            /\/api\/|\/rest\//,
          );
        }
        if (tool.operationCategory === "asset_management_tags") {
          expect(tool.endpointEvidence.join("\n"), tool.toolName).toContain(
            "/qps/rest/2.0/",
          );
        }
      } else if (tool.status === "blocked_evidence_required") {
        expect(
          inventory.currentPromotedBatch.tools,
          `${tool.toolName} must not be promoted while blocked`,
        ).not.toContain(tool.toolName);
        expect(tool.endpointEvidence.join("\n"), tool.toolName).toContain(
          "EVIDENCE_REQUIRED",
        );
      }
    }
  });

  it("keeps inline endpoint evidence YAML as quoted string scalars", () => {
    const inventoryText = readFileSync(inventoryPath, "utf-8");
    const unquotedInlineEvidenceLines = inventoryText
      .split(/\r?\n/)
      .filter((line) => /^\s+endpointEvidence:\s+\[[^"]/.test(line));

    expect(unquotedInlineEvidenceLines).toEqual([]);
    for (const tool of readInventory().tools) {
      expect(
        tool.endpointEvidence.every((evidence) => typeof evidence === "string"),
        tool.toolName,
      ).toBe(true);
    }
  });

  it("keeps cache-local and reference-only tools out of the live API-backed set", () => {
    const inventory = readInventory();

    for (const tool of inventory.tools) {
      if (tool.toolName.startsWith("qualys_cache_")) {
        expect(tool.status).toBe("excluded_cache_local");
        expect(tool.safety).toBe("excluded_from_live_migration");
      } else if (tool.toolName.startsWith("qualys_quickref_")) {
        expect(tool.status).toBe("included_reference");
        expect(tool.safety).toBe("reference_only_no_tenant_evidence");
      } else {
        expect(["included_live", "blocked_evidence_required"]).toContain(
          tool.status,
        );
        expect(tool.safety).toBe("read_only_live");
      }
    }
  });

  it("keeps mutating operations and scoped-out product modules explicitly excluded", () => {
    const inventory = readInventory();

    expect(inventory.globalRules.join("\n")).toContain("EVIDENCE_REQUIRED");
    expect(inventory.excludedOperations.length).toBeGreaterThan(0);
    expect(inventory.excludedOperations.map((entry) => entry.status)).toEqual(
      inventory.excludedOperations.map(() => "excluded_mutating"),
    );
    expect(inventory.scopedOutModules.map((entry) => entry.status)).toEqual(
      inventory.scopedOutModules.map(() => "excluded_scoped_out"),
    );
  });

  it("does not depend on integration-hub runtime imports for the Qualys inventory", () => {
    const inventoryText = readFileSync(inventoryPath, "utf-8");

    expect(inventoryText).not.toContain("workspace/src/integration_hub");
    expect(inventoryText).not.toContain("legacy_call_tool");
    expect(inventoryText).not.toContain("handlerDispatch");
  });

  it("keeps the current Qualys help coverage matrix tied to tools.yaml", () => {
    const inventory = readInventory();
    const matrix = readHelpCoverage();
    const splitFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(splitFiles["tools.yaml"]),
    );
    const contractTools = new Map(
      contract.tools.map((tool) => [tool.openacme.toolName, tool]),
    );

    expect(matrix).toMatchObject({
      version: 1,
      familyId: "qualys",
      scope: "current_readonly_surface",
      contractSource: "tools.yaml",
      batchSource:
        "docs/hosted-integrations-qualys-live-migration-inventory.yaml#currentPromotedBatch",
    });
    expect(matrix.tools.map((tool) => tool.toolName).sort()).toEqual(
      sorted(inventory.currentPromotedBatch.tools),
    );
    expect(sorted(inventory.currentPromotedBatch.tools)).toEqual(
      sorted(LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES),
    );
    expect(sorted(contractTools.keys())).toEqual(
      sorted(inventory.currentPromotedBatch.tools),
    );

    const globalRepresentedBy = new Set(
      matrix.globalRules.flatMap((rule) => rule.representedBy),
    );
    expect(globalRepresentedBy).toContain("openacme.errors");
    expect(globalRepresentedBy).toContain("openacme.pagination");

    for (const row of matrix.tools) {
      const inventoryRow = inventory.tools.find(
        (tool) => tool.toolName === row.toolName,
      );
      const contractTool = contractTools.get(row.toolName);
      expect(inventoryRow?.status, row.toolName).toBe("included_live");
      expect(row.status, row.toolName).toBe("covered_current_batch");
      expect(contractTool, row.toolName).toBeDefined();
      const coveragePaths = row.requiredCoverage.map(
        (requirement) => requirement.path,
      );
      expect(coveragePaths, row.toolName).toContain("openacme.errors");
      if (inventoryRow && requiresPaginationContract(inventoryRow)) {
        expect(
          coveragePaths.some((coveragePath) =>
            coveragePath.startsWith("openacme.pagination"),
          ),
          row.toolName,
        ).toBe(true);
      }
      for (const requirement of row.requiredCoverage) {
        const actual = coveragePathValue(contractTool!, requirement.path);
        if (requirement.equals !== undefined) {
          expect(actual, `${row.toolName} ${requirement.path}`).toBe(
            requirement.equals,
          );
        }
        for (const expected of requirement.contains ?? []) {
          expect(
            coverageString(actual),
            `${row.toolName} ${requirement.path}`,
          ).toContain(expected);
        }
      }
    }
  });

  it("keeps the current Qualys promotion-readiness bundle complete", () => {
    const inventory = readInventory();
    const matrix = readHelpCoverage();
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";
    const examplesByTool = new Map(
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples.map(
        (example) => [example.toolName, example],
      ),
    );
    const coveredTools = new Set(matrix.tools.map((tool) => tool.toolName));
    const inventoryRows = new Map(
      inventory.tools.map((tool) => [tool.toolName, tool]),
    );
    const currentPromotedTools = new Set(inventory.currentPromotedBatch.tools);
    const registeredExampleToolNames =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples.map(
        (example) => example.toolName,
      );

    expect(sorted(contract.tools.map((tool) => tool.openacme.toolName))).toEqual(
      sorted(currentPromotedTools),
    );
    expect(sorted(coveredTools)).toEqual(sorted(currentPromotedTools));
    expect(sorted(registeredExampleToolNames)).toEqual(
      sorted(currentPromotedTools),
    );

    for (const tool of contract.tools) {
      const toolName = tool.openacme.toolName;
      const inventoryRow = inventoryRows.get(toolName);
      const registeredExample = examplesByTool.get(toolName);
      expect(currentPromotedTools.has(toolName), toolName).toBe(true);
      expect(inventoryRow?.status, toolName).toBe("included_live");
      expect(coveredTools.has(toolName), toolName).toBe(true);
      expect(tool.mcp.title, toolName).not.toHaveLength(0);
      expect(tool.mcp.description, toolName).not.toHaveLength(0);
      expect(tool.mcp.outputSchema, toolName).toBeDefined();
      expect(tool.openacme.function, toolName).toBe(`tool_${toolName}`);
      expect(pythonSource, toolName).toContain(
        `def tool_${toolName}(args, context):`,
      );
      expect(tool.openacme.fullHelp, toolName).toBeDefined();
      expect(tool.openacme.selectWhen.length, toolName).toBeGreaterThan(0);
      expect(tool.openacme.doNotSelectWhen.length, toolName).toBeGreaterThan(0);
      expect(
        Object.keys(tool.openacme.parameterHelp).length,
        toolName,
      ).toBeGreaterThan(0);
      expect(tool.openacme.errors.length, toolName).toBeGreaterThan(0);
      expect(tool.openacme.classification?.operation, toolName).toBe("read");
      expect(tool.openacme.classification?.freshness, toolName).toBe("live");
      expect(tool.mcp.annotations?.readOnlyHint, toolName).toBe(true);
      expect(tool.mcp.annotations?.destructiveHint, toolName).toBe(false);
      expect(tool.openacme.examples.length, toolName).toBeGreaterThan(0);
      expect(examplesByTool.has(toolName), toolName).toBe(true);
      expect(
        ["live_safe", "discovery_required"],
        `${toolName} registered example category`,
      ).toContain(registeredExample?.category);
      if (registeredExample?.category === "discovery_required") {
        expect(
          JSON.stringify(registeredExample.expected),
          `${toolName} discovery metadata`,
        ).toContain("requires_discovered_");
        expect(registeredExample.expected?.discovery_tool, toolName).toBeDefined();
      } else {
        expect(registeredExample?.args, toolName).not.toEqual({});
      }
      expect(JSON.stringify(tool.openacme), toolName).not.toContain(
        "EVIDENCE_REQUIRED",
      );
      if (tool.openacme.providerRef) {
        expect(
          sourceFiles[tool.openacme.providerRef.path],
          `${toolName} providerRef ${tool.openacme.providerRef.path}`,
        ).toBeDefined();
      }
      if (inventoryRow && requiresPaginationContract(inventoryRow)) {
        expect(tool.openacme.pagination, toolName).toBeDefined();
      }
    }
  });

  it("accepts the external Qualys hosted package as the deployable source of truth when available", async () => {
    const externalFiles = readExternalHostedPackageSource(
      externalQualysPackageRoot,
    );
    if (!externalFiles) {
      expect(
        process.env.OPENACME_QUALYS_HOSTED_PACKAGE_ROOT,
        "set OPENACME_QUALYS_HOSTED_PACKAGE_ROOT to validate an external deployable Qualys package",
      ).toBeUndefined();
      return;
    }

    expect(Object.keys(externalFiles).sort()).toEqual(
      expect.arrayContaining([
        "README.md",
        "examples.yaml",
        "family.yaml",
        "qualys.py",
        "references/coverage-tracker.yaml",
        "references/current-scope.md",
        "references/gav-filter-fields.json",
        "references/per-tool-audit.yaml",
        "references/source-boundary.md",
        "tools.yaml",
      ]),
    );
    expect(externalFiles["README.md"]).toContain(
      "separate from the OpenAcme platform runtime",
    );
    expect(externalFiles["references/source-boundary.md"]).toContain(
      "Do not import integration-hub code at runtime",
    );

    const externalPackage = {
      kind: "openacme.hostedFamilyPackage",
      version: 1,
      metadata: {
        familyId: "qualys",
        sourceRevisionId: "external_qualys_package_test",
      },
      files: Object.entries(externalFiles).map(([filePath, content]) => ({
        path: filePath,
        content,
      })),
    };
    const validation = await validateHostedFamilyPackage(externalPackage, {
      targetFamilyId: "qualys",
      helpQualityMode: "error",
    });
    expect(validation).toEqual({ ok: true, diagnostics: [], package: validation.package });

    const externalContract = HostedToolContractDocumentSchema.parse(
      parseYaml(externalFiles["tools.yaml"]),
    );
    const externalAudit = readPerToolAuditFromFiles(externalFiles);
    const coverageTracker = readCoverageTrackerFromFiles(externalFiles);
    const fixtureContract = HostedToolContractDocumentSchema.parse(
      parseYaml(
        LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY
          .sourceFiles["tools.yaml"],
      ),
    );
    const inventory = readInventory();

    expect(
      sorted(externalContract.tools.map((tool) => tool.openacme.toolName)),
    ).toEqual(sorted(inventory.currentPromotedBatch.tools));
    expect(
      sorted(externalContract.tools.map((tool) => tool.mcp.name)),
    ).toEqual(
      sorted(
        inventory.currentPromotedBatch.tools.map(
          (toolName) => `hosted_qualys__${toolName}`,
        ),
      ),
    );
    expect(
      sorted(externalContract.tools.map((tool) => tool.openacme.toolName)),
    ).toEqual(
      sorted(fixtureContract.tools.map((tool) => tool.openacme.toolName)),
    );
    expect(externalAudit).toMatchObject({
      version: 1,
      familyId: "qualys",
      scope: "current_readonly_surface",
      contractSource: "tools.yaml",
    });
    expect(sorted(externalAudit.tools.map((row) => row.toolName))).toEqual(
      sorted(inventory.currentPromotedBatch.tools),
    );
    expect(coverageTracker).toMatchObject({
      version: 1,
      familyId: "qualys",
    });
    expect(["in_progress", "complete"]).toContain(coverageTracker.status);
    expect(coverageTracker.currentRound.length).toBeGreaterThan(0);
    expect(coverageTracker.rounds.length).toBeGreaterThan(0);
    expect(
      sorted(coverageTracker.toolStatuses.map((row) => row.toolName)),
    ).toEqual(sorted(inventory.currentPromotedBatch.tools));
    for (const requiredSource of [
      "operational-skill",
      "development-skill",
      "tool-map",
      "migration-inventory",
      "historical-integration-hub",
    ]) {
      expect(externalAudit.requiredSources, requiredSource).toContain(
        requiredSource,
      );
      expect(
        externalAudit.sourceCatalog[requiredSource],
        requiredSource,
      ).toBeDefined();
    }
    const auditRows = new Map(
      externalAudit.tools.map((row) => [row.toolName, row]),
    );
    for (const tool of externalContract.tools) {
      const row = auditRows.get(tool.openacme.toolName);
      expect(row, tool.openacme.toolName).toBeDefined();
      expect(["audited", "fixed"], tool.openacme.toolName).toContain(
        row?.status,
      );
      expect(row?.evidenceRequired ?? [], tool.openacme.toolName).toEqual([]);
      for (const requiredSource of externalAudit.requiredSources) {
        expect(
          row?.sourcesCompared,
          `${tool.openacme.toolName} ${requiredSource}`,
        ).toContain(requiredSource);
      }
      for (const inputName of Object.keys(tool.mcp.inputSchema.properties ?? {})) {
        expect(
          row?.inputsVerified,
          `${tool.openacme.toolName} ${inputName}`,
        ).toContain(inputName);
      }
      expect(row?.helpVerified.length, tool.openacme.toolName).toBeGreaterThan(
        0,
      );
      expect(
        row?.runtimeValidationVerified.length,
        tool.openacme.toolName,
      ).toBeGreaterThan(0);
      expect(
        row?.examplesVerified.length,
        tool.openacme.toolName,
      ).toBeGreaterThan(0);
      const trackerRow = coverageTracker.toolStatuses.find(
        (candidate) => candidate.toolName === tool.openacme.toolName,
      );
      expect(trackerRow, tool.openacme.toolName).toBeDefined();
      expect(trackerRow?.comparedWithIntegrationHub, tool.openacme.toolName).toBe(
        "yes",
      );
      expect(trackerRow?.comparedWithUserSkill, tool.openacme.toolName).toBe(
        "yes",
      );
      expect(trackerRow?.comparedWithDevSkill, tool.openacme.toolName).toBe(
        "yes",
      );
      expect(
        trackerRow?.packageHelpStatus.length,
        tool.openacme.toolName,
      ).toBeGreaterThan(0);
      expect(
        trackerRow?.runtimeValidationStatus.length,
        tool.openacme.toolName,
      ).toBeGreaterThan(0);
      expect(
        trackerRow?.examplesStatus.length,
        tool.openacme.toolName,
      ).toBeGreaterThan(0);
      expect(
        trackerRow?.liveSmokeStatus.length,
        tool.openacme.toolName,
      ).toBeGreaterThan(0);
    }
    expect(externalFiles["qualys.py"]).not.toContain("integration_hub");
    expect(externalFiles["qualys.py"]).not.toContain("legacy_call_tool");
  });

  it("keeps the current Qualys source-backed package passing draft validation before promotion", async () => {
    const dataDir = mkdtempSync(
      path.join(tmpdir(), "openacme-qualys-current-validation-"),
    );
    try {
      const lockStore = createFileHostedIntegrationLockStore({
        dataDir,
        createId: () => "lock_current_validation",
      });
      const lock = await lockStore.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(lock.ok).toBe(true);

      const draftStore = createFileHostedIntegrationDraftStore({
        dataDir,
        lockStore,
        createId: () => "draft_current_validation",
      });
      const draft = await draftStore.createDraftFromFiles({
        familyId: "qualys",
        lockId: "lock_current_validation",
        sourceRevisionId: "source_current_validation",
        files:
          LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles,
      });
      expect(draft.ok).toBe(true);
      await draftStore.writeDraftFile({
        draftId: "draft_current_validation",
        lockId: "lock_current_validation",
        path: "examples.yaml",
        content: stringifyYaml({
          examples:
            LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples,
        }),
      });

      const validator = createFileHostedIntegrationDraftValidator({
        draftStore,
        catalog: createFileHostedIntegrationCatalog({ dataDir }),
        helpQualityMode: "error",
      });
      const result = await validator.validateDraft("draft_current_validation");

      expect(result).toEqual({ ok: true, diagnostics: [] });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps live evaluation scenarios aligned with inventory scope and active promotion state", () => {
    const inventory = readInventory();
    const manifest = readLiveEvaluationScenarios();
    const inventoryToolNames = new Set(
      inventory.tools.map((tool) => tool.toolName),
    );
    const excludedOperationNames = new Set(
      inventory.excludedOperations.map((operation) => operation.name),
    );
    const scopedOutModuleNames = new Set(
      inventory.scopedOutModules.map((module) => module.name),
    );
    const currentPromotedTools = new Set(inventory.currentPromotedBatch.tools);

    expect(manifest.schemaVersion).toBe(
      "2026-08-18.hosted-tool-live-evaluation-scenarios.v1",
    );
    expect(manifest.scenarios.length).toBeGreaterThan(0);

    const currentBatchActiveHostedCalls = manifest.scenarios
      .filter((scenario) => scenario.execution === "active")
      .filter((scenario) => scenario.expectedOutcome === "hosted_call")
      .filter((scenario) =>
        currentPromotedTools.has(scenario.preferredToolName),
      )
      .filter((scenario) =>
        (scenario.availableToolNames ?? []).every((toolName) =>
          currentPromotedTools.has(toolName),
        ),
      )
      .map((scenario) => scenario.id);
    expect(sorted(currentBatchActiveHostedCalls)).toEqual([
      "qualys-unguided-known-id-direct-get",
      "qualys-unguided-overlapping-tool-selection",
      "qualys-unguided-pagination-continuation",
      "qualys-unguided-qps-count-download-rules",
      "qualys-unguided-vmdr-known-qid-detections",
      "qualys-unguided-vocabulary-discovery",
    ]);

    for (const scenario of manifest.scenarios) {
      expect(scenario.familyId, scenario.id).toBe(inventory.familyId);
      expect(scenario.guidance, scenario.id).toBe("unguided");
      expect(scenario.analyzer.requireUnguided, scenario.id).toBe(true);
      expect(
        unguidedPromptHintFindings(scenario.prompt),
        scenario.id,
      ).toEqual([]);
      expect(scenario.coverage.length, scenario.id).toBeGreaterThan(0);
      expect(
        new Set(scenario.availableToolNames ?? []).size,
        `${scenario.id} duplicate availableToolNames`,
      ).toBe((scenario.availableToolNames ?? []).length);
      expect(
        ["hosted_call", "evidence_required", "refusal", "recovery"],
        scenario.id,
      ).toContain(scenario.expectedOutcome);
      expect(
        inventoryToolNames.has(scenario.preferredToolName) ||
          excludedOperationNames.has(scenario.preferredToolName) ||
          scopedOutModuleNames.has(scenario.preferredToolName),
        `${scenario.id} preferredToolName ${scenario.preferredToolName}`,
      ).toBe(true);
      for (const availableToolName of scenario.availableToolNames ?? []) {
        expect(
          inventoryToolNames.has(availableToolName),
          `${scenario.id} availableToolName ${availableToolName}`,
        ).toBe(true);
      }
      for (const forbiddenToolName of scenario.analyzer.forbiddenToolNames ?? []) {
        expect(
          forbiddenToolName.startsWith("hosted_"),
          `${scenario.id} forbiddenToolName ${forbiddenToolName}`,
        ).toBe(false);
        expect(
          inventoryToolNames.has(forbiddenToolName),
          `${scenario.id} forbiddenToolName ${forbiddenToolName}`,
        ).toBe(true);
      }
      for (const [field, values] of Object.entries(scenario.analyzer)) {
        if (!Array.isArray(values)) continue;
        expect(new Set(values).size, `${scenario.id} analyzer.${field}`).toBe(
          values.length,
        );
      }

      if (scenario.execution === "active") {
        expect(
          scenario.acceptedArtifacts?.length ?? 0,
          `${scenario.id} acceptedArtifacts`,
        ).toBeGreaterThan(0);
        for (const artifact of scenario.acceptedArtifacts ?? []) {
          expect(
            artifact.runId.trim().length,
            `${scenario.id} accepted artifact runId`,
          ).toBeGreaterThan(0);
          expect(artifact.status, `${scenario.id} accepted artifact status`).toBe(
            "pass",
          );
          expect(
            artifact.secretScan,
            `${scenario.id} accepted artifact secret scan`,
          ).toBe("pass");
          expect(
            artifact.path,
            `${scenario.id} accepted artifact runId/path`,
          ).toBe(`${acceptedLiveArtifactPathPrefix}${artifact.runId}.json`);
          expect(
            artifact.evidence.trim().length,
            `${scenario.id} accepted artifact evidence`,
          ).toBeGreaterThan(20);
          expect(
            artifact.evidence.length,
            `${scenario.id} accepted artifact evidence`,
          ).toBeLessThanOrEqual(240);
          expect(
            artifact.evidence,
            `${scenario.id} accepted artifact evidence`,
          ).not.toMatch(/[\r\n]/);
        }
        if (scenario.expectedOutcome !== "hosted_call") {
          expect(
            ["evidence_required", "refusal", "recovery"],
            `${scenario.id} active non-call expectedOutcome`,
          ).toContain(scenario.expectedOutcome);
        }
      } else {
        expect(
          scenario.acceptedArtifacts?.length ?? 0,
          `${scenario.id} planned acceptedArtifacts`,
        ).toBe(0);
      }
      if (scenario.expectedOutcome !== "hosted_call") {
        expect(
          scenario.analyzer.requiredOutcomeFragments?.length ?? 0,
          `${scenario.id} requiredOutcomeFragments`,
        ).toBeGreaterThan(0);
      }
      if (
        scenario.execution === "active" &&
        scenario.expectedOutcome === "hosted_call"
      ) {
        expect(
          currentPromotedTools.has(scenario.preferredToolName),
          `${scenario.id} active preferredToolName ${scenario.preferredToolName}`,
        ).toBe(true);
        for (const availableToolName of scenario.availableToolNames ?? []) {
          expect(
            currentPromotedTools.has(availableToolName),
            `${scenario.id} active availableToolName ${availableToolName}`,
          ).toBe(true);
        }
      }
      if (scenario.coverage.includes("provider_evidence_boundary")) {
        expect(scenario.expectedOutcome, scenario.id).toBe("evidence_required");
      }
      if (scenario.coverage.includes("mutating_scoped_out_refusal")) {
        expect(scenario.expectedOutcome, scenario.id).toBe("refusal");
        expect(
          excludedOperationNames.has(scenario.preferredToolName) ||
            scopedOutModuleNames.has(scenario.preferredToolName),
          scenario.id,
        ).toBe(true);
      }
      if (scenario.coverage.includes("auth_rate_limit_recovery")) {
        expect(scenario.expectedOutcome, scenario.id).toBe("recovery");
      }
    }
  });

  it("keeps current Qualys examples aligned with shared GAV vocabulary tokens", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const vocabulary = JSON.parse(
      sourceFiles["references/gav-filter-fields.json"] ?? "{}",
    ) as {
      entries?: Array<{ value?: string }>;
      invalidAliases?: Array<{ value?: string; use?: string }>;
    };
    const validFields = new Set(
      (vocabulary.entries ?? []).map((entry) => entry.value).filter(Boolean),
    );
    const invalidAliases = new Map(
      (vocabulary.invalidAliases ?? [])
        .map((entry) => [entry.value, entry.use] as const)
        .filter(([value]) => Boolean(value)),
    );

    expect(validFields).toContain("qualys.agent.lastCheckedInDate");
    expect(invalidAliases.get("agent.lastCheckedIn")).toBe(
      "qualys.agent.lastCheckedInDate",
    );

    for (const example of LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples) {
      for (const field of gavFilterFieldsFromArgs(example.args)) {
        expect(
          invalidAliases.has(field),
          `${example.id} uses invalid GAV filter field ${field}; use ${invalidAliases.get(field)}`,
        ).toBe(false);
        expect(
          validFields.has(field),
          `${example.id} uses undocumented GAV filter field ${field}`,
        ).toBe(true);
      }
    }
  });

  it("keeps current Qualys source-backed examples bounded and read-only", () => {
    const inventory = readInventory();
    const examplesByTool = new Map(
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples.map(
        (example) => [example.toolName, example],
      ),
    );
    const rowByTool = new Map(
      inventory.tools.map((tool) => [tool.toolName, tool]),
    );

    for (const toolName of inventory.currentPromotedBatch.tools) {
      const example = examplesByTool.get(toolName);
      const row = rowByTool.get(toolName);
      const args = asRecord(example?.args);

      expect(example, toolName).toBeDefined();
      expect(row?.safety, toolName).toBe("read_only_live");
      expect(JSON.stringify(args), toolName).not.toMatch(
        /\b(create|update|delete|remove|purge|launch|cancel|pause|resume)\b/i,
      );

      if (toolName === "qualys_vmdr_scan_fetch") {
        expect(example?.category, toolName).toBe("discovery_required");
        expect(args, toolName).toEqual({});
        expect(example?.expected, toolName).toMatchObject({
          requires_discovered_scan_ref: true,
          discovery_tool: "qualys_vmdr_scan_list",
          not_live_safe_until_scan_ref_discovered: true,
          fetch_args_after_discovery: {
            params: { mode: "brief", output_format: "json" },
          },
        });
        expect(JSON.stringify(example), toolName).not.toContain(
          "scan/123456.789",
        );
        expect(JSON.stringify(example), toolName).not.toContain(
          "<real-scan-ref>",
        );
      } else {
        expect(example?.category, toolName).toBe("live_safe");
      }

      if (toolName === "qualys_asset_management_tag_list") {
        expect(numberArg(args, "limit"), toolName).toBeLessThanOrEqual(1);
        expect(Object.keys(args).sort(), toolName).toEqual(["limit"]);
      } else if (toolName === "qualys_asset_management_tag_search") {
        expect(numberArg(args, "limit"), toolName).toBeLessThanOrEqual(1);
        expect(JSON.stringify(args), toolName).not.toContain('"*"');
      } else if (toolName.endsWith("_search")) {
        expect(numberArg(args, "page_size"), toolName).toBeLessThanOrEqual(2);
        expect(numberArg(args, "max_pages"), toolName).toBeLessThanOrEqual(1);
      }

      if (toolName === "qualys_vmdr_host_list") {
        expect(numberArg(args, "truncation_limit"), toolName).toBeLessThanOrEqual(2);
        expect(numberArg(args, "max_pages"), toolName).toBeLessThanOrEqual(1);
      }

      const filterBody = asRecord(args.filter_body);
      if (filterBody.operation !== undefined) {
        expect(filterBody.operation, toolName).toBe("AND");
      }
      if (toolName.includes("cloud_agent")) {
        expect(gavFilterFieldsFromArgs(args), toolName).not.toContain(
          "agent.lastCheckedIn",
        );
      }
    }
  });

  it("keeps VMDR Host Detection status and QID parameter semantics deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const hostDetection = contract.tools.find(
      (tool) =>
        tool.openacme.toolName === "qualys_vmdr_host_detection_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(hostDetection, "qualys_vmdr_host_detection_list").toBeDefined();
    expect(hostDetection?.mcp.inputSchema.properties).toHaveProperty("status");
    expect(hostDetection?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(
      JSON.stringify(hostDetection?.openacme.parameterHelp),
      "host detection help must teach top-level status",
    ).toContain("Keep detection status at top level");
    expect(
      JSON.stringify(hostDetection?.openacme.parameterHelp),
      "host detection help must teach plural qids",
    ).toContain("Use plural qids.");
    expect(pythonSource).toContain("params.status");
    expect(pythonSource).toContain("params.detection_status");
    expect(pythonSource).toContain("params.state");
    expect(pythonSource).toContain("Use plural params.qids");
  });

  it("keeps VMDR KnowledgeBase vuln list params and metadata boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const kbVulnList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_kb_vuln_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(kbVulnList, "qualys_vmdr_kb_vuln_list").toBeDefined();
    expect(kbVulnList?.mcp.inputSchema.required).toContain("params");
    expect(kbVulnList?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(kbVulnList?.mcp.inputSchema.properties).toHaveProperty("max_pages");
    expect(kbVulnList?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(kbVulnList?.mcp.inputSchema.properties).not.toHaveProperty(
      "truncation_limit",
    );
    expect(
      JSON.stringify(kbVulnList?.openacme.parameterHelp),
      "KB help must teach native params.cve",
    ).toContain("Use params.cve");
    expect(
      JSON.stringify(kbVulnList?.openacme.parameterHelp),
      "KB help must reject title/RTI invention",
    ).toContain("Do not pass title-like strings, RTI names");
    expect(
      JSON.stringify(kbVulnList?.openacme),
      "KB help must identify metadata-only evidence",
    ).toContain("metadata only");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_kb_vuln_list(args, context):",
    );
    expect(pythonSource).toContain(
      "_native_params_arg(args, required=True)",
    );
  });

  it("keeps VMDR KnowledgeBase QVS list params and score boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const qvsList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_kb_qvs_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(qvsList, "qualys_vmdr_kb_qvs_list").toBeDefined();
    expect(qvsList?.mcp.inputSchema.required).toContain("params");
    expect(qvsList?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(qvsList?.mcp.inputSchema.properties).not.toHaveProperty("page_size");
    expect(qvsList?.mcp.inputSchema.properties).not.toHaveProperty(
      "truncation_limit",
    );
    expect(
      JSON.stringify(qvsList?.openacme.parameterHelp),
      "QVS help must teach native qvs params",
    ).toContain("qvs_min");
    expect(
      JSON.stringify(qvsList?.openacme.parameterHelp),
      "QVS help must distinguish QVS from QDS",
    ).toContain("QVS is CVE/vulnerability-level");
    expect(
      JSON.stringify(qvsList?.openacme),
      "QVS help must identify non-tenant evidence",
    ).toContain("does not prove tenant exposure");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_kb_qvs_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_kb_qvs");
  });

  it("keeps Asset Management tag search Criteria and QPS boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const tagSearch = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_asset_management_tag_search",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(tagSearch, "qualys_asset_management_tag_search").toBeDefined();
    expect(tagSearch?.mcp.inputSchema.required).toContain("criteria");
    expect(tagSearch?.mcp.inputSchema.properties).toHaveProperty("criteria");
    expect(tagSearch?.mcp.inputSchema.properties).toHaveProperty("limit");
    expect(tagSearch?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(tagSearch?.mcp.inputSchema.properties).not.toHaveProperty(
      "max_pages",
    );
    expect(
      JSON.stringify(tagSearch?.openacme.parameterHelp),
      "tag search help must teach QPS Criteria structure",
    ).toContain("Criteria");
    expect(
      JSON.stringify(tagSearch?.openacme.parameterHelp),
      "tag search help must teach limitResults",
    ).toContain("limitResults");
    expect(
      tagSearch?.openacme.doNotSelectWhen.join("\n"),
      "tag search help must reject wildcard discovery",
    ).toContain('Do not use "*"');
    expect(
      JSON.stringify(tagSearch?.openacme),
      "tag search help must identify Tag record output",
    ).toContain("ServiceResponse.data.Tag");
    expect(pythonSource).toContain(
      "def tool_qualys_asset_management_tag_search(args, context):",
    );
    expect(pythonSource).toContain("_qps_criteria_list_arg(args");
    expect(pythonSource).toContain("client.search_asset_tags");
  });

  it("keeps Asset Management tag list limit-only QPS boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const tagList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_asset_management_tag_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(tagList, "qualys_asset_management_tag_list").toBeDefined();
    expect(tagList?.mcp.inputSchema.required ?? []).toEqual([]);
    expect(tagList?.mcp.inputSchema.properties).toHaveProperty("limit");
    expect(tagList?.mcp.inputSchema.properties).not.toHaveProperty("criteria");
    expect(tagList?.mcp.inputSchema.properties).not.toHaveProperty("page_size");
    expect(tagList?.mcp.inputSchema.properties).not.toHaveProperty("max_pages");
    expect(
      JSON.stringify(tagList?.openacme.parameterHelp),
      "tag list help must teach QPS limitResults",
    ).toContain("limitResults");
    expect(
      tagList?.openacme.doNotSelectWhen.join("\n"),
      "tag list help must reject wildcard and filter args",
    ).toContain('Do not use "*"');
    expect(
      tagList?.openacme.doNotSelectWhen.join("\n"),
      "tag list help must route filtered lookup to tag search",
    ).toContain("qualys_asset_management_tag_search");
    expect(
      JSON.stringify(tagList?.openacme),
      "tag list help must identify Tag record output",
    ).toContain("ServiceResponse.data.Tag");
    expect(pythonSource).toContain(
      "def tool_qualys_asset_management_tag_list(args, context):",
    );
    expect(pythonSource).toContain("_validate_tag_list_args(args)");
    expect(pythonSource).toContain("client.list_asset_tags");
  });

  it("keeps VMDR asset group list native params and FO XML boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const assetGroupList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_asset_group_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(assetGroupList, "qualys_vmdr_asset_group_list").toBeDefined();
    expect(assetGroupList?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(assetGroupList?.mcp.inputSchema.properties).toHaveProperty(
      "max_pages",
    );
    expect(assetGroupList?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(
      JSON.stringify(assetGroupList?.openacme),
      "asset group list help must identify endpoint and record tag",
    ).toContain("/api/2.0/fo/asset/group/");
    expect(
      JSON.stringify(assetGroupList?.openacme),
      "asset group list help must identify ASSET_GROUP records",
    ).toContain("ASSET_GROUP");
    expect(
      JSON.stringify(assetGroupList?.openacme.parameterHelp),
      "asset group list help must teach native params",
    ).toContain("ids");
    expect(
      JSON.stringify(assetGroupList?.openacme.parameterHelp),
      "asset group list help must avoid invented text search",
    ).toContain("Do not invent");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_asset_group_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_asset_groups");
    expect(pythonSource).toContain('".//ASSET_GROUP"');
  });

  it("keeps VMDR IP list native params and FO XML boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const ipList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_ip_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(ipList, "qualys_vmdr_ip_list").toBeDefined();
    expect(ipList?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(ipList?.mcp.inputSchema.properties).toHaveProperty("max_pages");
    expect(ipList?.mcp.inputSchema.properties).not.toHaveProperty("page_size");
    expect(ipList?.mcp.inputSchema.properties).not.toHaveProperty(
      "filter_body",
    );
    expect(
      JSON.stringify(ipList?.openacme),
      "IP list help must identify endpoint and IP/RANGE records",
    ).toContain("/api/2.0/fo/asset/ip/");
    expect(JSON.stringify(ipList?.openacme)).toContain("IP/RANGE");
    expect(
      JSON.stringify(ipList?.openacme.parameterHelp),
      "IP list help must teach native params",
    ).toContain("ips");
    expect(
      JSON.stringify(ipList?.openacme.parameterHelp),
      "IP list help must avoid GAV filters",
    ).toContain("Do not invent");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_ip_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_ips");
    expect(pythonSource).toContain("/api/2.0/fo/asset/ip/");
  });

  it("keeps VMDR excluded IP list native params and FO XML boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const excludedIpList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_excluded_ip_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(excludedIpList, "qualys_vmdr_excluded_ip_list").toBeDefined();
    expect(excludedIpList?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(excludedIpList?.mcp.inputSchema.properties).toHaveProperty(
      "max_pages",
    );
    expect(excludedIpList?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(excludedIpList?.mcp.inputSchema.properties).not.toHaveProperty(
      "filter_body",
    );
    expect(
      JSON.stringify(excludedIpList?.openacme),
      "excluded IP list help must identify endpoint and excluded IP/range records",
    ).toContain("/api/2.0/fo/asset/excluded_ip/");
    expect(JSON.stringify(excludedIpList?.openacme)).toContain(
      "excluded IP/range",
    );
    expect(
      JSON.stringify(excludedIpList?.openacme.parameterHelp),
      "excluded IP list help must teach native params",
    ).toContain("ips");
    expect(
      JSON.stringify(excludedIpList?.openacme.parameterHelp),
      "excluded IP list help must avoid GAV filters",
    ).toContain("Do not invent");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_excluded_ip_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_excluded_ips");
    expect(pythonSource).toContain("/api/2.0/fo/asset/excluded_ip/");
  });

  it("keeps VMDR restricted IP list native params and FO XML boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const restrictedIpList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_restricted_ip_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(restrictedIpList, "qualys_vmdr_restricted_ip_list").toBeDefined();
    expect(restrictedIpList?.mcp.inputSchema.properties).toHaveProperty(
      "params",
    );
    expect(restrictedIpList?.mcp.inputSchema.properties).toHaveProperty(
      "max_pages",
    );
    expect(restrictedIpList?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(restrictedIpList?.mcp.inputSchema.properties).not.toHaveProperty(
      "filter_body",
    );
    expect(
      JSON.stringify(restrictedIpList?.openacme),
      "restricted IP list help must identify endpoint and restricted IP/range records",
    ).toContain("/api/2.0/fo/setup/restricted_ips/");
    expect(JSON.stringify(restrictedIpList?.openacme)).toContain(
      "restricted IP/range",
    );
    expect(
      JSON.stringify(restrictedIpList?.openacme.parameterHelp),
      "restricted IP list help must teach output_format=xml",
    ).toContain("output_format=xml");
    expect(
      JSON.stringify(restrictedIpList?.openacme.parameterHelp),
      "restricted IP list help must avoid GAV filters",
    ).toContain("Do not invent");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_restricted_ip_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_restricted_ips");
    expect(pythonSource).toContain("/api/2.0/fo/setup/restricted_ips/");
    expect(pythonSource).toContain('"output_format": "xml"');
  });

  it("keeps VMDR virtual host list native params and FO XML boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const virtualHostList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_virtual_host_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(virtualHostList, "qualys_vmdr_virtual_host_list").toBeDefined();
    expect(virtualHostList?.mcp.inputSchema.properties).toHaveProperty(
      "params",
    );
    expect(virtualHostList?.mcp.inputSchema.properties).toHaveProperty(
      "max_pages",
    );
    expect(virtualHostList?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(virtualHostList?.mcp.inputSchema.properties).not.toHaveProperty(
      "filter_body",
    );
    expect(
      JSON.stringify(virtualHostList?.openacme),
      "virtual host list help must identify endpoint and VIRTUAL_HOST records",
    ).toContain("/api/2.0/fo/asset/vhost/");
    expect(JSON.stringify(virtualHostList?.openacme)).toContain("VIRTUAL_HOST");
    expect(
      JSON.stringify(virtualHostList?.openacme.parameterHelp),
      "virtual host list help must teach native params",
    ).toContain("params");
    expect(
      JSON.stringify(virtualHostList?.openacme.parameterHelp),
      "virtual host list help must avoid GAV filters",
    ).toContain("Do not invent");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_virtual_host_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_virtual_hosts");
    expect(pythonSource).toContain("/api/2.0/fo/asset/vhost/");
    expect(pythonSource).toContain('".//VIRTUAL_HOST"');
  });

  it("keeps VMDR scan list native params and FO XML boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const scanList = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_scan_list",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(scanList, "qualys_vmdr_scan_list").toBeDefined();
    expect(scanList?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(scanList?.mcp.inputSchema.properties).toHaveProperty("max_pages");
    expect(scanList?.mcp.inputSchema.properties).not.toHaveProperty(
      "scan_ref",
    );
    expect(scanList?.mcp.inputSchema.properties).not.toHaveProperty(
      "page_size",
    );
    expect(
      JSON.stringify(scanList?.openacme),
      "scan list help must identify endpoint and SCAN records",
    ).toContain("/api/2.0/fo/scan/");
    expect(JSON.stringify(scanList?.openacme)).toContain("SCAN records");
    expect(
      JSON.stringify(scanList?.openacme.parameterHelp),
      "scan list help must teach native params",
    ).toContain("launched_after_datetime");
    expect(
      JSON.stringify(scanList?.openacme.doNotSelectWhen),
      "scan list help must route scan_ref reads to fetch",
    ).toContain("qualys_vmdr_scan_fetch");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_scan_list(args, context):",
    );
    expect(pythonSource).toContain("client.list_vm_scans");
    expect(pythonSource).toContain("/api/2.0/fo/scan/");
    expect(pythonSource).toContain('".//SCAN"');
  });

  it("keeps VMDR scan fetch scan_ref and artifact boundary deterministic", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(sourceFiles["tools.yaml"]),
    );
    const scanFetch = contract.tools.find(
      (tool) => tool.openacme.toolName === "qualys_vmdr_scan_fetch",
    );
    const pythonSource = sourceFiles["qualys.py"] ?? "";

    expect(scanFetch, "qualys_vmdr_scan_fetch").toBeDefined();
    expect(scanFetch?.mcp.inputSchema.properties).toHaveProperty("scan_ref");
    expect(scanFetch?.mcp.inputSchema.required).toContain("scan_ref");
    expect(scanFetch?.mcp.inputSchema.properties).toHaveProperty("params");
    expect(scanFetch?.mcp.inputSchema.properties).not.toHaveProperty(
      "max_pages",
    );
    expect(scanFetch?.openacme.pagination?.model).toBe("none");
    expect(
      JSON.stringify(scanFetch?.openacme),
      "scan fetch help must identify action=fetch and artifact semantics",
    ).toContain("action=fetch");
    expect(JSON.stringify(scanFetch?.openacme)).toContain("scan result payload");
    expect(JSON.stringify(scanFetch?.openacme)).toContain("artifact");
    expect(
      JSON.stringify(scanFetch?.openacme.parameterHelp),
      "scan fetch help must teach scan_ref and native output params",
    ).toContain("output_format");
    expect(
      JSON.stringify(scanFetch?.openacme.parameterHelp),
      "scan fetch help must reject placeholder refs",
    ).toContain("Do not pass placeholder");
    expect(JSON.stringify(scanFetch?.openacme.examples)).toContain(
      "not_ready_to_send",
    );
    expect(JSON.stringify(scanFetch?.openacme.examples)).not.toContain(
      "scan/123456.789",
    );
    expect(
      JSON.stringify(scanFetch?.openacme.doNotSelectWhen),
      "scan fetch help must route discovery to scan list",
    ).toContain("qualys_vmdr_scan_list");
    expect(pythonSource).toContain(
      "def tool_qualys_vmdr_scan_fetch(args, context):",
    );
    expect(pythonSource).toContain("client.fetch_vm_scan");
    expect(pythonSource).toContain("/api/2.0/fo/scan/");
    expect(pythonSource).toContain('"action": "fetch"');
  });

  it("keeps current Qualys source, help coverage, live evaluation, and examples free of raw secret material", () => {
    const sourceFiles =
      LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
    const scannedText = [
      ...Object.entries(sourceFiles).map(
        ([filePath, content]) => `--- ${filePath} ---\n${content}`,
      ),
      `--- examples ---\n${JSON.stringify(
        LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples,
      )}`,
      `--- help-coverage ---\n${readFileSync(helpCoveragePath, "utf-8")}`,
      `--- inventory ---\n${readFileSync(inventoryPath, "utf-8")}`,
      `--- live-evaluation-scenarios ---\n${readFileSync(
        liveEvaluationScenariosPath,
        "utf-8",
      )}`,
    ].join("\n");

    const findings = qualysSecretDenylistFindings(scannedText);

    expect(findings).toEqual([]);
  });

  it("keeps current Qualys hosted help projection free of raw secret material", async () => {
    const dataDir = mkdtempSync(
      path.join(tmpdir(), "openacme-qualys-help-secrets-"),
    );
    try {
      const sourceFiles =
        LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
      const lockStore = createFileHostedIntegrationLockStore({
        dataDir,
        createId: () => "lock_help_projection",
      });
      const lock = await lockStore.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(lock.ok).toBe(true);
      const draftStore = createFileHostedIntegrationDraftStore({
        dataDir,
        lockStore,
        createId: () => "draft_help_projection",
      });
      const draft = await draftStore.createDraftFromFiles({
        familyId: "qualys",
        lockId: "lock_help_projection",
        sourceRevisionId: "source_help_projection",
        files: sourceFiles,
      });
      expect(draft.ok).toBe(true);
      const generations = createFileHostedIntegrationGenerationStore({
        dataDir,
        draftStore,
        createId: () => "gen_help_projection",
      });
      const promoted = await generations.promoteDraft({
        draftId: "draft_help_projection",
        promotedBy: "agent:tool-developer",
        validation: { ok: true, diagnostics: [] },
      });
      expect(promoted.ok).toBe(true);

      const inventory = readInventory();
      const helpOutputs: string[] = [];
      for (const toolName of inventory.currentPromotedBatch.tools) {
        const result = await resolveHostedIntegrationToolHelp({
          dataDir,
          generations,
          hostedToolName: `hosted_qualys__${toolName}`,
          familyId: "qualys",
          toolName,
          request: {
            tool_detail: "full",
            include_examples: true,
            parameters: null,
          },
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        helpOutputs.push(JSON.stringify(result));
      }

      expect(qualysSecretDenylistFindings(helpOutputs.join("\n"))).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps current Qualys hosted help projection exposing shared GAV vocabulary metadata", async () => {
    const dataDir = mkdtempSync(
      path.join(tmpdir(), "openacme-qualys-help-vocabulary-"),
    );
    try {
      const sourceFiles =
        LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.sourceFiles;
      const contract = HostedToolContractDocumentSchema.parse(
        parseYaml(sourceFiles["tools.yaml"]),
      );
      const expectedVocabularyTools = new Set(
        contract.tools
          .filter(
            (tool) =>
              tool.openacme.parameterHelp["filter_body.filters.field"]
                ?.vocabularyRef === "references/gav-filter-fields.json",
          )
          .map((tool) => tool.openacme.toolName),
      );
      expect(sorted(expectedVocabularyTools)).toEqual([
        "qualys_cloud_agent_hostasset_count",
        "qualys_cloud_agent_hostasset_search",
        "qualys_gav_asset_count",
        "qualys_gav_asset_search",
      ]);

      const lockStore = createFileHostedIntegrationLockStore({
        dataDir,
        createId: () => "lock_help_vocabulary",
      });
      const lock = await lockStore.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(lock.ok).toBe(true);
      const draftStore = createFileHostedIntegrationDraftStore({
        dataDir,
        lockStore,
        createId: () => "draft_help_vocabulary",
      });
      const draft = await draftStore.createDraftFromFiles({
        familyId: "qualys",
        lockId: "lock_help_vocabulary",
        sourceRevisionId: "source_help_vocabulary",
        files: sourceFiles,
      });
      expect(draft.ok).toBe(true);
      const generations = createFileHostedIntegrationGenerationStore({
        dataDir,
        draftStore,
        createId: () => "gen_help_vocabulary",
      });
      const promoted = await generations.promoteDraft({
        draftId: "draft_help_vocabulary",
        promotedBy: "agent:tool-developer",
        validation: { ok: true, diagnostics: [] },
      });
      expect(promoted.ok).toBe(true);

      for (const toolName of expectedVocabularyTools) {
        const result = await resolveHostedIntegrationToolHelp({
          dataDir,
          generations,
          hostedToolName: `hosted_qualys__${toolName}`,
          familyId: "qualys",
          toolName,
          request: {
            tool_detail: "full",
            include_examples: false,
            parameters: null,
          },
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) continue;
        expect(result.help.parameters["filter_body.filters.field"]).toMatchObject({
          vocabulary: {
            id: "qualys-gav-filter-fields",
            parameter_path: "filter_body.filters.field",
            status: "ok",
          },
        });
        expect(
          result.help.parameters["filter_body.filters.field"]?.vocabulary
            ?.entry_count,
          toolName,
        ).toBeGreaterThanOrEqual(5);
        expect(
          result.help.parameters["filter_body.filters.field"]?.vocabulary
            ?.invalid_alias_count,
          toolName,
        ).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(result.help), toolName).toContain(
          "small live-verified API filter_body subset",
        );
        expect(JSON.stringify(result.help), toolName).toContain(
          "Do not use QQL/UI search tokens here",
        );
        expect(JSON.stringify(result.help), toolName).not.toContain(
          "gav-ui-qql-token-catalog",
        );
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps Qualys closeout documentation boundaries explicit", () => {
    const inventoryText = readFileSync(inventoryPath, "utf-8");
    const liveEvaluationText = readFileSync(
      liveEvaluationScenariosPath,
      "utf-8",
    );
    const planText = readFileSync(implementationPlanPath, "utf-8");
    const acceptanceMatrixText = JSON.stringify(
      readStrictYaml<unknown>(vocabularyAcceptanceMatrixPath),
    );
    const closeoutText = [
      inventoryText,
      readFileSync(helpCoveragePath, "utf-8"),
      liveEvaluationText,
      planText,
      acceptanceMatrixText,
    ].join("\n");

    expect(inventoryText).toContain("included_live");
    expect(inventoryText).toContain("currentPromotedBatch");
    expect(inventoryText).toContain(
      "Broader planned migration rows stay blocked_evidence_required",
    );
    expect(inventoryText).toContain("excluded_mutating");
    expect(inventoryText).toContain("excluded_cache_local");
    expect(inventoryText).toContain("excluded_scoped_out");
    expect(inventoryText).toContain("included_reference");
    expect(inventoryText).toContain("reference_only_no_tenant_evidence");
    expect(inventoryText).toContain("qualys_quickref_search");
    expect(liveEvaluationText).toContain("expectedOutcome");
    expect(liveEvaluationText).toContain("requiredOutcomeFragments");
    expect(liveEvaluationText).toContain("evidence_required");
    expect(liveEvaluationText).toContain("refusal");
    expect(liveEvaluationText).toContain("recovery");
    expect(planText).toContain("outcomeText");
    expect(planText).toContain("Help-effectiveness acceptance was tightened");
    expect(planText).toContain("learned vocabulary or parameter evidence");
    expect(planText).toContain(
      "dogfood:hosted-tools:accepted-artifacts:audit",
    );
    expect(planText).toContain("`9` active scenarios");
    expect(planText).toContain("root `pnpm check-types`");
    expect(planText).toContain("`21` package");
    expect(planText).toContain(
      "Current complete deterministic matrix bundle was rerun",
    );
    expect(planText).toContain("`133` passed, `1` skipped");
    expect(planText).toContain("server analyzer/guidance bundle (`73` passed)");
    expect(planText).toContain("`21` successful package tasks");
    expect(planText).toContain(
      "packages/skills/builtin/openacme-platform/SKILL.md",
    );
    expect(planText).toContain(
      "route hosted tool work to\n  `$hosted-integrations-development`",
    );
    expect(planText).toContain(
      "Focused platform routing guard passed",
    );
    expect(planText).toContain("`8` passed");
    expect(planText).toContain("Managed-agent installation now also preserves");
    expect(planText).toContain("agent-catalog.test.ts");
    expect(planText).toContain("`19` passed");
    expect(planText).toContain("analyzer/guidance bundle includes");
    expect(planText).toContain("`85` passed");
    expect(planText).toContain(
      "Milestones 27-36\nhave since accepted the current Hosted Tools concept gate",
    );
    expect(planText).toContain(
      "Do not reopen those milestones as the next implementation\norder",
    );
    expect(planText).not.toContain(
      "1. Milestone 27: live hosted-tool concept acceptance.",
    );
    expect(planText).not.toContain(
      "2. Milestone 28: unguided hosted-tool management-surface evaluation.",
    );
    expect(closeoutText).toContain("positive outcome text evidence");
    expect(closeoutText).toContain("EVIDENCE_REQUIRED");
    expect(planText).not.toMatch(/^Status:\s*$/m);
    expect(planText).toContain(
      "Status: implemented for the original Qualys vocabulary-discovery dogfood",
    );
    expect(sectionText(planText, "Milestone 31")).not.toContain(
      "Status: in progress.",
    );
    expect(planText).toContain(
      "Status: accepted for the current 18-tool read-only pilot. Broader Qualys",
    );
    expect(planText).toContain(
      "## Milestone 37: Hosted Tools Production Hardening",
    );
    expect(sectionText(planText, "Milestone 37")).toContain(
      "Status: accepted for the currently identified bounded production-hardening",
    );
    expect(planText).toContain("broader Qualys");
    expect(planText).toContain("Status: accepted for the current 18-tool read-only pilot");
    expect(planText).toContain("Broader Qualys\nbatches are deferred");
    expect(planText).toContain("Broader Qualys\nruntime coverage is deferred");
    expect(planText).toContain("Broader batch live\nsmoke/parity is deferred");
    expect(planText).toContain("Broader\nunguided scenario coverage is deferred");
    expect(planText).toContain("Final broader Qualys\ncloseout is deferred");
    expect(planText).toContain("blocked_evidence_required");
    expect(planText).toContain("current-batch-ready broader hosted-call");
    expect(planText).toContain("VMDR Host Detection");
    expect(planText).toContain("CVE-to-QID");
    expect(planText).toContain("evidence-required scenario");
    expect(planText).toContain("qualys-unguided-vmdr-known-qid-detections");
    expect(planText).toContain(
      "active current-batch hosted-call set is exactly\n  vocabulary discovery, overlapping tool selection, known-id direct get, QPS\n  count/download rules, VMDR known-QID Host Detection, and pagination\n  continuation",
    );
    expect(planText).not.toContain(
      "active current-batch hosted-call set is exactly\n  vocabulary discovery, overlapping tool selection, and pagination\n  continuation",
    );
    expect(planText).not.toContain(
      "active current-batch hosted-call set is exactly\n  vocabulary discovery, overlapping tool selection, VMDR known-QID Host\n  Detection, and pagination continuation",
    );
    expect(planText).toContain(
      "unguided_consumer_m36_combined_clean_diag_20260818071044.json",
    );
    expect(planText).toContain("empty scenario diagnostics");
    expect(planText).toContain("Unguided hosted scenarios");
    expect(closeoutText).toContain("nested filter values");
    expect(closeoutText).toContain("unguided-only");
    expect(closeoutText).toContain("run-id lookup diagnostics");
    expect(planText).toContain("Final broader Qualys\ncloseout is deferred");
    expect(planText).toContain("no-mock live gate");
    expect(planText).toContain("mock Qualys endpoint");
    expect(planText).toContain("promotion-readiness bundle");
  });

  it("keeps the vocabulary acceptance matrix as the executable TDD source", () => {
    const matrix = readVocabularyAcceptanceMatrix();
    const areas = new Map(matrix.areas.map((area) => [area.id, area]));
    const completeCommands = matrix.complete_bundle.deterministic_commands;

    expect(matrix).toMatchObject({
      version: 1,
      kind: "hosted_tools_vocabulary_acceptance_matrix",
    });
    expect(matrix.purpose).toContain("example readiness");
    expect(matrix.purpose).toContain("example-readiness slice");
    expect(matrix.rules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        "no_mock_for_live_claims",
        "vocabulary_source_of_truth",
        "aliases_are_not_exact_values",
        "unguided_claims_need_live_artifacts",
        "provider_faults_need_fault_injection",
        "live_artifacts_are_evidence_records",
      ]),
    );
    expect([...areas.keys()].sort()).toEqual([
      "contract_shape",
      "current_qualys_vocabulary",
      "example_readiness",
      "help_projection",
      "tool_developer_guidance",
      "unguided_agent_evaluation",
    ]);

    expect(areas.get("contract_shape")?.commands).toEqual(
      expect.arrayContaining([
        "pnpm --filter @openacme/hosted-integrations test -- schemas.test.ts validation.test.ts packages.test.ts",
        "pnpm --filter @openacme/hosted-integrations check-types",
        "pnpm --filter @openacme/hosted-integrations build",
      ]),
    );
    expect(areas.get("contract_shape")?.must_prove.join("\n")).toContain(
      "duplicate YAML keys",
    );
    expect(areas.get("contract_shape")?.must_prove.join("\n")).toContain(
      "family.yaml, tools.yaml, examples.yaml",
    );
    expect(areas.get("help_projection")?.commands).toEqual(
      expect.arrayContaining([
        "pnpm --filter @openacme/hosted-integrations test -- help.test.ts integration-hub-replacement.test.ts",
        "pnpm --filter @openacme/tools test -- hosted-integration-help.test.ts",
        "pnpm --filter @openacme/tools check-types",
      ]),
    );
    expect(areas.get("current_qualys_vocabulary")?.must_prove.join("\n")).toContain(
      "references/gav-filter-fields.json",
    );
    expect(areas.get("current_qualys_vocabulary")?.commands).toEqual(
      expect.arrayContaining([
        "pnpm --filter @openacme/hosted-integrations test -- qualys-live-inventory.test.ts integration-hub-replacement.test.ts",
      ]),
    );
    expect(areas.get("example_readiness")?.must_prove.join("\n")).toContain(
      "example_not_runnable",
    );
    expect(areas.get("example_readiness")?.must_prove.join("\n")).toContain(
      "expected.discovery_tool",
    );
    expect(areas.get("example_readiness")?.must_prove.join("\n")).toContain(
      "requires_discovered_*",
    );
    expect(areas.get("example_readiness")?.must_prove.join("\n")).toContain(
      "placeholder ids",
    );
    expect(areas.get("example_readiness")?.commands).toEqual(
      expect.arrayContaining([
        "pnpm --filter @openacme/hosted-integrations test -- examples.test.ts qualys-live-inventory.test.ts",
        "pnpm --dir apps/web test hosted-integrations-admin.test.ts",
        "pnpm --filter @openacme/server test -- hosted-integrations-legacy-surface.test.ts",
        "pnpm --filter @openacme/hosted-integrations build",
        "pnpm --filter @openacme/tools build",
        "pnpm --filter @openacme/server test -- hosted-integrations-routes.test.ts tools-hosted-integrations.test.ts",
        "pnpm --filter @openacme/tools test -- hosted-integration-management.test.ts",
      ]),
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "live artifacts",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "hosted-tool-not-enabled recovery is classified separately",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "provider auth/rate-limit/upstream recovery scenarios stay planned",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "carrying vocabulary-derived or",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "subsequent hosted business-call arguments",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "messageHistory",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "parsed live artifact",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "expectedOutcome evidence",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "~/.openamce-hosted-integrations-test-env/hosted-integrations/live-acceptance",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "direct <runId>.json",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "nested paths",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "planned scenarios do not carry acceptedArtifacts",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "active scenarios without acceptedArtifacts",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "evidence summaries stay concise",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "multi-line notes",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "non-call",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "forbidden outcome",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "consumer analyzer semantics",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "without starting the live",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "model/provider calls",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "active-scenario scoped",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "planned scenario ids fail",
    );
    expect(areas.get("unguided_agent_evaluation")?.must_prove.join("\n")).toContain(
      "JSON result envelope",
    );
    expect(
      areas.get("unguided_agent_evaluation")
        ?.live_commands_when_claiming_model_usability,
    ).toEqual(
      expect.arrayContaining([
        'OPENACME_DATA_DIR="$HOME/.openamce-hosted-integrations-test-env" OPENACME_E2E_PORT=3467 OPENACME_LIVE_HOSTED_TOOLS_SCENARIO_IDS=<scenario_ids> pnpm --filter @openacme/server dogfood:hosted-tools:live:unguided-consumer',
        "OPENACME_LIVE_HOSTED_TOOLS_SCENARIO_IDS=<scenario_ids> pnpm --filter @openacme/server dogfood:hosted-tools:accepted-artifacts:audit",
      ]),
    );
    expect(areas.get("tool_developer_guidance")?.commands).toEqual(
      expect.arrayContaining([
        "pnpm --filter @openacme/server test -- agent-catalog.test.ts hosted-integrations-legacy-surface.test.ts hosted-tools-unguided-management.test.ts",
      ]),
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "vocabulary/help/example-readiness changes",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "acceptedArtifacts",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "matching runId/path",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "secretScan: pass",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "platform-admin/Acme seeded skills",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "Hosted Tools product wording",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "external package",
    );
    expect(areas.get("tool_developer_guidance")?.must_prove.join("\n")).toContain(
      "test-support fixtures",
    );
    expect(completeCommands).toEqual(
      expect.arrayContaining([
        "pnpm --filter @openacme/hosted-integrations test -- schemas.test.ts validation.test.ts help.test.ts packages.test.ts integration-hub-replacement.test.ts qualys-live-inventory.test.ts",
        "pnpm --filter @openacme/hosted-integrations test -- examples.test.ts qualys-live-inventory.test.ts",
        "pnpm --filter @openacme/tools test -- hosted-integration-help.test.ts hosted-integrations.test.ts hosted-integration-management.test.ts",
        "pnpm --dir apps/web test hosted-integrations-admin.test.ts",
        "pnpm --filter @openacme/server test -- hosted-tools-live-acceptance.test.ts hosted-tools-unguided-management.test.ts hosted-integrations-legacy-surface.test.ts agent-catalog.test.ts",
        "pnpm --filter @openacme/hosted-integrations build",
        "pnpm --filter @openacme/tools build",
        "pnpm --filter @openacme/server test -- hosted-integrations-routes.test.ts tools-hosted-integrations.test.ts",
        "pnpm check-types",
        "git diff --check",
      ]),
    );
    const hostedBuildIndex = completeCommands.indexOf(
      "pnpm --filter @openacme/hosted-integrations build",
    );
    const toolsCheckTypesIndex = completeCommands.indexOf(
      "pnpm --filter @openacme/tools check-types",
    );
    const toolsBuildIndex = completeCommands.indexOf(
      "pnpm --filter @openacme/tools build",
    );
    const serverRouteExampleIndex = completeCommands.indexOf(
      "pnpm --filter @openacme/server test -- hosted-integrations-routes.test.ts tools-hosted-integrations.test.ts",
    );
    const serverCheckTypesIndex = completeCommands.indexOf(
      "pnpm --filter @openacme/server check-types",
    );
    const rootCheckTypesIndex = completeCommands.indexOf("pnpm check-types");
    expect(hostedBuildIndex).toBeGreaterThanOrEqual(0);
    expect(toolsBuildIndex).toBeGreaterThan(hostedBuildIndex);
    expect(serverRouteExampleIndex).toBeGreaterThan(toolsBuildIndex);
    expect(toolsCheckTypesIndex).toBeGreaterThan(hostedBuildIndex);
    expect(serverCheckTypesIndex).toBeGreaterThan(hostedBuildIndex);
    expect(rootCheckTypesIndex).toBeGreaterThan(serverCheckTypesIndex);
    expect(
      matrix.complete_bundle.live_optional_until_claimed.requirement,
    ).toContain("real provider behavior or unguided model usability");
    expect(
      matrix.complete_bundle.live_optional_until_claimed.requirement,
    ).toContain("acceptedArtifacts");
    expect(
      matrix.complete_bundle.live_optional_until_claimed.requirement,
    ).toContain("matching runId/path");
    expect(
      matrix.complete_bundle.live_optional_until_claimed.requirement,
    ).toContain("secretScan: pass");
    expect(
      matrix.complete_bundle.live_optional_until_claimed.requirement,
    ).toContain("dogfood:hosted-tools:accepted-artifacts:audit");
    expect(
      matrix.complete_bundle.live_optional_until_claimed.requirement,
    ).toContain("without starting a live server");

    for (const command of matrixCommands(matrix)) {
      if (command === "git diff --check") continue;
      const rootScriptMatch = command.match(/^pnpm ([\w:-]+)$/);
      if (rootScriptMatch) {
        const [, scriptName] = rootScriptMatch;
        expect(
          readRootPackageScripts(),
          `${command} references a missing root package script`,
        ).toHaveProperty(scriptName);
        continue;
      }
      const filterMatch = command.match(/pnpm --filter (\S+) ([\w:-]+)/);
      if (filterMatch) {
        const [, packageName, scriptName] = filterMatch;
        expect(
          readPackageScripts(packageName),
          `${command} references a missing package script`,
        ).toHaveProperty(scriptName);
        continue;
      }
      const dirMatch = command.match(/pnpm --dir (\S+) ([\w:-]+)/);
      if (dirMatch) {
        const [, packageDir, scriptName] = dirMatch;
        expect(
          readPackageScriptsByDir(packageDir),
          `${command} references a missing package script`,
        ).toHaveProperty(scriptName);
        continue;
      }
      throw new Error(`matrix command is not recognized: ${command}`);
    }
  });

  it("keeps current promoted Qualys pilot naming aligned with its actual tool count", () => {
    const stalePatterns = [
      ["FIVE", "READONLY"].join("_"),
      ["Five", "ReadOnly"].join(""),
      ["five", "ReadOnly"].join(""),
      ["five", "tool"].join("-"),
      ["five", "tool"].join(" "),
      ["five", "read-only"].join(" "),
    ];

    for (const filePath of currentPilotNamingGuardPaths) {
      const source = readFileSync(filePath, "utf-8");
      for (const stalePattern of stalePatterns) {
        expect(source, `${filePath} contains stale ${stalePattern}`).not.toContain(
          stalePattern,
        );
      }
    }
  });
});

function coveragePathValue(root: unknown, dottedPath: string): unknown {
  if (dottedPath.startsWith("openacme.parameterHelp.")) {
    return parameterHelpPathValue(
      root as {
        openacme?: { parameterHelp?: Record<string, unknown> };
      },
      dottedPath.slice("openacme.parameterHelp.".length),
    );
  }
  return dottedPath.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

function parameterHelpPathValue(
  root: { openacme?: { parameterHelp?: Record<string, unknown> } },
  pathTail: string,
): unknown {
  const parameterHelp = root.openacme?.parameterHelp ?? {};
  const knownSuffixes = [
    ".vocabularyRef",
    ".summary",
    ".full",
    ".rules",
    ".examples",
  ];
  for (const suffix of knownSuffixes) {
    if (!pathTail.endsWith(suffix)) continue;
    const parameterName = pathTail.slice(0, -suffix.length);
    const field = suffix.slice(1);
    const entry = parameterHelp[parameterName];
    return entry && typeof entry === "object"
      ? (entry as Record<string, unknown>)[field]
      : undefined;
  }
  return parameterHelp[pathTail];
}

function coverageString(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sectionText(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return "";
  const next = markdown.indexOf("\n## ", start + marker.length);
  return next < 0 ? markdown.slice(start) : markdown.slice(start, next);
}

function gavFilterFieldsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const filterBody = (args as { filter_body?: unknown }).filter_body;
  if (!filterBody || typeof filterBody !== "object") return [];
  const filters = (filterBody as { filters?: unknown }).filters;
  if (!Array.isArray(filters)) return [];
  return filters
    .map((filter) =>
      filter && typeof filter === "object"
        ? (filter as { field?: unknown }).field
        : undefined,
    )
    .filter((field): field is string => typeof field === "string");
}

function requiresPaginationContract(tool: InventoryTool): boolean {
  return !["none", "count"].includes(tool.paginationModel);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

function qualysSecretDenylistFindings(text: string): string[] {
  const checks: Array<{ name: string; pattern: RegExp }> = [
    { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
    {
      name: "access-token-assignment",
      pattern: /\baccess_token\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    },
    {
      name: "client-secret-assignment",
      pattern: /\bclient_secret\b\s*[:=]\s*["']?[^"',\s]{8,}/i,
    },
    {
      name: "raw-token-marker",
      pattern: /\braw-(?:token|secret|password)\b/i,
    },
    {
      name: "password-value-assignment",
      pattern:
        /\bpassword\b\s*[:=]\s*["'](?!configured\b|redacted\b|missing\b)[^"',\s]{8,}/i,
    },
    {
      name: "jwt",
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    },
  ];
  return checks
    .filter((check) => check.pattern.test(text))
    .map((check) => check.name);
}

function unguidedPromptHintFindings(prompt: string): string[] {
  const checks: Array<{ name: string; pattern: RegExp }> = [
    { name: "hosted-tool-name", pattern: /\bhosted_[a-z0-9-]+__/i },
    { name: "help-tool-name", pattern: /\bhosted_tool_help\b/i },
    { name: "managed-tool-name", pattern: /\bmanaged_[a-z0-9-]+__/i },
    { name: "remote-mcp-tool-name", pattern: /\bmcp_[a-z0-9_-]+__/i },
    {
      name: "exact-argument-json",
      pattern: /"filter_body"\s*:|"filters"\s*:|"field"\s*:/i,
    },
  ];
  return checks
    .filter((check) => check.pattern.test(prompt))
    .map((check) => check.name);
}
