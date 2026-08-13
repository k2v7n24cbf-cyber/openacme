import {
  buildHostedIntegrationManagedToolName,
  HostedIntegrationManagedToolNameSchema,
  parseHostedIntegrationManagedToolName,
} from "./naming.js";
import { HostedIntegrationToolNameSchema } from "./schemas.js";
import type { HostedIntegrationExample } from "./schemas.js";

export interface LegacyIntegrationHubToolInventoryEntry {
  familyId: string;
  legacyServerName: string;
  legacyToolName: string;
  legacyMcpToolName: string;
  hostedToolName: string;
  managedHostedToolName: string;
  operation: "read" | "write" | "destructive";
  freshness: "live" | "cached" | "sync";
  resultBehavior: "inline" | "result_file" | "cache_workspace";
  configKeys: string[];
  secretRefs: string[];
  notes?: string;
}

export interface LegacyIntegrationHubFamilyInventoryEntry {
  familyId: string;
  sourceStatus: "documented" | "external_source_unavailable";
  sourcePaths: string[];
  configKeys: string[];
  secretRefs: string[];
}

export interface LegacyIntegrationHubInventory {
  source: {
    serverName: string;
    sourceAvailableInRepo: boolean;
    notes: string;
  };
  families: LegacyIntegrationHubFamilyInventoryEntry[];
  tools: LegacyIntegrationHubToolInventoryEntry[];
}

export interface ValidateMigrationInventoryResult {
  ok: boolean;
  diagnostics: string[];
}

export interface LegacyIntegrationHubReplacementMapping {
  familyId: string;
  hostedToolName: string;
  legacyMcpToolName: string;
  managedHostedToolName: string;
}

export interface LegacyIntegrationHubMigratedFamilyFixture {
  familyId: string;
  familyName: string;
  migratedToolNames: string[];
  managedToolNames: string[];
  legacyMcpToolNames: string[];
  replacementMappings: LegacyIntegrationHubReplacementMapping[];
  configKeys: string[];
  secretRefs: string[];
  sourceFiles: Record<string, string>;
  examples: HostedIntegrationExample[];
  regressionExamples: HostedIntegrationExample[];
}

export interface LegacyIntegrationHubIncidentSourceInventory {
  available: boolean;
  path: string;
  notes: string;
}

const LEGACY_SERVER_NAME = "integration-hub";

const QUALYS_TOOL_NAMES = [
  "qualys_activity_audit_log_list",
  "qualys_asset_management_tag_count",
  "qualys_asset_management_tag_get",
  "qualys_asset_management_tag_list",
  "qualys_asset_management_tag_search",
  "qualys_cache_export_plan",
  "qualys_cache_export_start",
  "qualys_cache_gav_asset_count",
  "qualys_cache_gav_asset_search",
  "qualys_cache_gav_filter_tokens",
  "qualys_cache_get_raw_record",
  "qualys_cache_metric",
  "qualys_cache_qql_fields",
  "qualys_cache_status",
  "qualys_cache_vmdr_library_search",
  "qualys_cache_vmdr_vulnerability_search",
  "qualys_cloud_agent_hostasset_count",
  "qualys_cloud_agent_hostasset_get",
  "qualys_cloud_agent_hostasset_search",
  "qualys_continuous_monitoring_download_alerts",
  "qualys_continuous_monitoring_get_alert",
  "qualys_continuous_monitoring_get_profile",
  "qualys_continuous_monitoring_get_rule",
  "qualys_continuous_monitoring_get_ruleset",
  "qualys_continuous_monitoring_search_alerts",
  "qualys_continuous_monitoring_search_profiles",
  "qualys_continuous_monitoring_search_rules",
  "qualys_continuous_monitoring_search_rulesets",
  "qualys_gav_asset_count",
  "qualys_gav_asset_get",
  "qualys_gav_asset_search",
  "qualys_policy_compliance_control_list",
  "qualys_policy_compliance_exception_list",
  "qualys_policy_compliance_policy_export",
  "qualys_policy_compliance_policy_list",
  "qualys_policy_compliance_posture_list",
  "qualys_policy_compliance_scan_fetch",
  "qualys_policy_compliance_scan_list",
  "qualys_policy_compliance_scap_scan_list",
  "qualys_quickref_build_request",
  "qualys_quickref_explain",
  "qualys_quickref_gav_reference",
  "qualys_quickref_get_endpoint",
  "qualys_quickref_list_parameters",
  "qualys_quickref_list_response_fields",
  "qualys_quickref_search",
  "qualys_quickref_validate_request",
  "qualys_vmdr_asset_group_list",
  "qualys_vmdr_dynamic_search_list",
  "qualys_vmdr_excluded_ip_list",
  "qualys_vmdr_host_detection_list",
  "qualys_vmdr_host_list",
  "qualys_vmdr_ip_list",
  "qualys_vmdr_kb_qvs_list",
  "qualys_vmdr_kb_vuln_list",
  "qualys_vmdr_report_fetch",
  "qualys_vmdr_report_list",
  "qualys_vmdr_report_schedule_list",
  "qualys_vmdr_report_template_list",
  "qualys_vmdr_restricted_ip_list",
  "qualys_vmdr_scan_fetch",
  "qualys_vmdr_scan_list",
  "qualys_vmdr_scan_schedule_list",
  "qualys_vmdr_scan_summary",
  "qualys_vmdr_scan_vm_summary",
  "qualys_vmdr_static_search_list",
  "qualys_vmdr_virtual_host_list",
] as const;

export const EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES = [
  ...QUALYS_TOOL_NAMES,
  "splunk_search",
  "msgraph_get",
  "mde_get",
  "defender_alert_search",
] as const;

export const LEGACY_INTEGRATION_HUB_INVENTORY: LegacyIntegrationHubInventory = {
  source: {
    serverName: LEGACY_SERVER_NAME,
    sourceAvailableInRepo: false,
    notes:
      "The current worktree does not contain workspace/src/integration_hub; seed inventory is based on hosted integration architecture docs and installed Qualys toolkit references.",
  },
  families: [
    family("qualys", ["QUALYS_BASE_URL"], ["QUALYS_USERNAME", "QUALYS_PASSWORD"]),
    family("splunk", ["SPLUNK_BASE_URL"], ["SPLUNK_TOKEN"]),
    family(
      "msgraph",
      ["MSGRAPH_TENANT_ID", "MSGRAPH_CLIENT_ID"],
      ["MSGRAPH_CLIENT_SECRET"],
    ),
    family("mde", ["MDE_TENANT_ID", "MDE_CLIENT_ID"], ["MDE_CLIENT_SECRET"]),
    family(
      "defender-alert",
      ["DEFENDER_TENANT_ID", "DEFENDER_CLIENT_ID"],
      ["DEFENDER_CLIENT_SECRET"],
    ),
  ],
  tools: [
    ...QUALYS_TOOL_NAMES.map((toolName) =>
      tool("qualys", toolName, {
        freshness: toolName.startsWith("qualys_cache_") ? "cached" : "live",
        resultBehavior: toolName.includes("download") || toolName.includes("fetch")
          ? "result_file"
          : toolName.startsWith("qualys_cache_")
            ? "cache_workspace"
            : "inline",
        configKeys: ["QUALYS_BASE_URL"],
        secretRefs: ["QUALYS_USERNAME", "QUALYS_PASSWORD"],
      }),
    ),
    tool("splunk", "splunk_search", {
      configKeys: ["SPLUNK_BASE_URL"],
      secretRefs: ["SPLUNK_TOKEN"],
      resultBehavior: "result_file",
    }),
    tool("msgraph", "msgraph_get", {
      configKeys: ["MSGRAPH_TENANT_ID", "MSGRAPH_CLIENT_ID"],
      secretRefs: ["MSGRAPH_CLIENT_SECRET"],
    }),
    tool("mde", "mde_get", {
      configKeys: ["MDE_TENANT_ID", "MDE_CLIENT_ID"],
      secretRefs: ["MDE_CLIENT_SECRET"],
    }),
    tool("defender-alert", "defender_alert_search", {
      configKeys: ["DEFENDER_TENANT_ID", "DEFENDER_CLIENT_ID"],
      secretRefs: ["DEFENDER_CLIENT_SECRET"],
    }),
  ],
};

export const FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY: LegacyIntegrationHubMigratedFamilyFixture =
  {
    familyId: "splunk",
    familyName: "Splunk",
    migratedToolNames: ["splunk_search"],
    managedToolNames: [
      buildHostedIntegrationManagedToolName({
        familyId: "splunk",
        toolName: "splunk_search",
      }),
    ],
    legacyMcpToolNames: ["mcp_integration-hub__splunk_search"],
    replacementMappings: [
      replacementMapping(
        "splunk",
        "splunk_search",
        "mcp_integration-hub__splunk_search",
      ),
    ],
    configKeys: ["SPLUNK_BASE_URL"],
    secretRefs: ["SPLUNK_TOKEN"],
    sourceFiles: {
      "family.yaml": splunkFamilyYaml(),
      "splunk.py": splunkPythonSource(),
    },
    examples: [
      {
        id: "splunk_search_smoke",
        familyId: "splunk",
        toolName: "splunk_search",
        category: "mock_only",
        args: { query: 'index=main "login"', limit: 2 },
        expected: {
          query: 'index=main "login"',
          result_count: 2,
        },
      },
    ],
    regressionExamples: [],
  };

export const LEGACY_INTEGRATION_HUB_INCIDENT_SOURCE: LegacyIntegrationHubIncidentSourceInventory =
  {
    available: false,
    path: "ops/incidents.jsonl",
    notes:
      "No ops/incidents.jsonl file is present in the current worktree; no synthetic regression examples are created during migration.",
  };

export const LEGACY_INTEGRATION_HUB_MIGRATED_SECURITY_FAMILIES: LegacyIntegrationHubMigratedFamilyFixture[] =
  [
    buildMigratedFamilyFixture("qualys", "Qualys", "qualys.py"),
    FIRST_LEGACY_INTEGRATION_HUB_MIGRATED_FAMILY,
    buildMigratedFamilyFixture("msgraph", "Microsoft Graph", "msgraph.py"),
    buildMigratedFamilyFixture("mde", "Microsoft Defender for Endpoint", "mde.py"),
    buildMigratedFamilyFixture(
      "defender-alert",
      "Defender Alert",
      "defender_alert.py",
    ),
  ];

export function validateLegacyIntegrationHubMigrationInventory(
  inventory: LegacyIntegrationHubInventory,
  expectedToolNames: readonly string[] =
    EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES,
): ValidateMigrationInventoryResult {
  const diagnostics: string[] = [];
  const legacyNames = new Set(inventory.tools.map((entry) => entry.legacyToolName));
  for (const expected of expectedToolNames) {
    if (!legacyNames.has(expected)) diagnostics.push(`missing legacy tool: ${expected}`);
  }
  for (const entry of inventory.tools) {
    if (!HostedIntegrationToolNameSchema.safeParse(entry.hostedToolName).success) {
      diagnostics.push(`invalid hosted tool name: ${entry.hostedToolName}`);
    }
    const parsedManaged = parseHostedIntegrationManagedToolName(
      entry.managedHostedToolName,
    );
    if (
      !HostedIntegrationManagedToolNameSchema.safeParse(
        entry.managedHostedToolName,
      ).success ||
      !parsedManaged
    ) {
      diagnostics.push(
        `invalid managed hosted tool name: ${entry.managedHostedToolName}`,
      );
    } else if (
      parsedManaged.familyId !== entry.familyId ||
      parsedManaged.toolName !== entry.hostedToolName
    ) {
      diagnostics.push(
        `managed hosted tool name mismatch: ${entry.managedHostedToolName}`,
      );
    }
    if (
      entry.legacyMcpToolName !==
      `mcp_${entry.legacyServerName}__${entry.legacyToolName}`
    ) {
      diagnostics.push(`invalid mcp name: ${entry.legacyMcpToolName}`);
    }
    if (entry.configKeys.length === 0 && entry.secretRefs.length === 0) {
      diagnostics.push(`missing config mapping: ${entry.legacyToolName}`);
    }
  }
  for (const duplicate of duplicates(
    inventory.tools.map((entry) => entry.hostedToolName),
  )) {
    diagnostics.push(`duplicate hosted tool: ${duplicate}`);
  }
  for (const duplicate of duplicates(
    inventory.tools.map((entry) => entry.managedHostedToolName),
  )) {
    diagnostics.push(`duplicate managed hosted tool: ${duplicate}`);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

function family(
  familyId: string,
  configKeys: string[],
  secretRefs: string[],
): LegacyIntegrationHubFamilyInventoryEntry {
  return {
    familyId,
    sourceStatus: "external_source_unavailable",
    sourcePaths: [`workspace/src/integration_hub/integrations/${familyId}/`],
    configKeys,
    secretRefs,
  };
}

function tool(
  familyId: string,
  legacyToolName: string,
  opts: {
    operation?: "read" | "write" | "destructive";
    freshness?: "live" | "cached" | "sync";
    resultBehavior?: "inline" | "result_file" | "cache_workspace";
    configKeys: string[];
    secretRefs: string[];
  },
): LegacyIntegrationHubToolInventoryEntry {
  return {
    familyId,
    legacyServerName: LEGACY_SERVER_NAME,
    legacyToolName,
    legacyMcpToolName: `mcp_${LEGACY_SERVER_NAME}__${legacyToolName}`,
    hostedToolName: legacyToolName,
    managedHostedToolName: buildHostedIntegrationManagedToolName({
      familyId,
      toolName: legacyToolName,
    }),
    operation: opts.operation ?? "read",
    freshness: opts.freshness ?? "live",
    resultBehavior: opts.resultBehavior ?? "inline",
    configKeys: opts.configKeys,
    secretRefs: opts.secretRefs,
  };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function replacementMapping(
  familyId: string,
  hostedToolName: string,
  legacyMcpToolName: string,
): LegacyIntegrationHubReplacementMapping {
  return {
    familyId,
    hostedToolName,
    legacyMcpToolName,
    managedHostedToolName: buildHostedIntegrationManagedToolName({
      familyId,
      toolName: hostedToolName,
    }),
  };
}

function buildMigratedFamilyFixture(
  familyId: string,
  familyName: string,
  entrypoint: string,
): LegacyIntegrationHubMigratedFamilyFixture {
  const familyEntry = LEGACY_INTEGRATION_HUB_INVENTORY.families.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!familyEntry) throw new Error(`missing migration family: ${familyId}`);
  const tools = LEGACY_INTEGRATION_HUB_INVENTORY.tools.filter(
    (entry) => entry.familyId === familyId,
  );
  if (tools.length === 0) {
    throw new Error(`missing migration tools for family: ${familyId}`);
  }
  return {
    familyId,
    familyName,
    migratedToolNames: tools.map((entry) => entry.hostedToolName),
    managedToolNames: tools.map((entry) => entry.managedHostedToolName),
    legacyMcpToolNames: tools.map((entry) => entry.legacyMcpToolName),
    replacementMappings: tools.map((entry) =>
      replacementMapping(
        entry.familyId,
        entry.hostedToolName,
        entry.legacyMcpToolName,
      ),
    ),
    configKeys: familyEntry.configKeys,
    secretRefs: familyEntry.secretRefs,
    sourceFiles: {
      "family.yaml": generatedFamilyYaml(familyId, familyName, entrypoint, tools),
      [entrypoint]: generatedPythonSource(tools),
    },
    examples: [
      {
        id: `${familyId.replaceAll("-", "_")}_migration_smoke`,
        familyId,
        toolName: tools[0]!.hostedToolName,
        category: "mock_only",
        args: {},
        expected: {
          migrated: true,
          tool: tools[0]!.hostedToolName,
        },
      },
    ],
    regressionExamples: [],
  };
}

function generatedFamilyYaml(
  familyId: string,
  familyName: string,
  entrypoint: string,
  tools: LegacyIntegrationHubToolInventoryEntry[],
): string {
  return `
id: ${familyId}
name: ${familyName}
version: 1
runtime:
  language: python
  entrypoint: ${entrypoint}
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
    declaredEgress: []
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
${tools.map(toolYaml).join("")}`;
}

function toolYaml(entry: LegacyIntegrationHubToolInventoryEntry): string {
  const cacheYaml =
    entry.freshness === "cached" || entry.freshness === "sync"
      ? `    cache:
      scope: family_home
      path: ${entry.hostedToolName}.json
      description: Explicit migration cache for ${entry.hostedToolName}.
`
      : "";
  return `  - name: ${entry.hostedToolName}
    title: ${titleizeToolName(entry.hostedToolName)}
    description: Migrated legacy integration-hub tool ${entry.legacyMcpToolName}.
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: ${entry.operation}
      freshness: ${entry.freshness}
      idempotency: idempotent
      execution: sync
      approval: none
${cacheYaml}`;
}

function generatedPythonSource(
  tools: LegacyIntegrationHubToolInventoryEntry[],
): string {
  return `TOOL_NAMES = ${JSON.stringify(tools.map((entry) => entry.hostedToolName), null, 4)}
CACHE_TOOLS = ${JSON.stringify(
    tools
      .filter((entry) => entry.freshness === "cached" || entry.freshness === "sync")
      .map((entry) => entry.hostedToolName),
    null,
    4,
  )}

def list_tools():
    return []

def call_tool(name, args, context):
    if name not in TOOL_NAMES:
        raise ValueError(f"unknown tool: {name}")
    return {
        "migrated": True,
        "tool": name,
        "args": args,
        "family_id": context["familyId"],
        "generation_id": context["generationId"],
        "uses_explicit_cache": name in CACHE_TOOLS,
        "auth_configured": bool(context.get("secrets")),
    }
`;
}

function titleizeToolName(toolName: string): string {
  return toolName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function splunkFamilyYaml(): string {
  return `
id: splunk
name: Splunk
version: 1
runtime:
  language: python
  entrypoint: splunk.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 200
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
    declaredEgress:
      - SPLUNK_BASE_URL
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: splunk_search
    title: Search Splunk
    description: Runs a read-only Splunk search through the migrated hosted integration surface.
    inputSchema:
      type: object
      required:
        - query
      properties:
        query:
          type: string
          minLength: 1
        limit:
          type: integer
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

function splunkPythonSource(): string {
  return String.raw`
def list_tools():
    return [
        {
            "name": "splunk_search",
            "title": "Search Splunk",
            "description": "Runs a read-only Splunk search through the migrated hosted integration surface.",
            "inputSchema": {
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "limit": {"type": "integer"},
                },
                "additionalProperties": False,
            },
            "classification": {
                "operation": "read",
                "freshness": "live",
                "idempotency": "idempotent",
                "execution": "sync",
                "approval": "none",
            },
        }
    ]

def call_tool(name, args, context):
    if name != "splunk_search":
        raise ValueError(f"unknown tool: {name}")
    query = args["query"]
    limit = int(args.get("limit", 2))
    base_url = context["config"].get("baseUrl", "https://splunk.example.test")
    has_token = bool(context["secrets"].get("token"))
    rows = [
        {
            "offset": index,
            "source": "migration_fixture",
            "message": f"{query} event {index}",
        }
        for index in range(limit)
    ]
    return {
        "query": query,
        "base_url": base_url,
        "auth_configured": has_token,
        "result_count": len(rows),
        "results": rows,
    }
`;
}
