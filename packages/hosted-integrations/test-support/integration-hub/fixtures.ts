import {
  buildHostedToolName,
  HostedToolNameSchema,
  parseHostedToolName,
} from "../../src/naming.js";
import {
  LEGACY_INTEGRATION_HUB_QUALYS_SOURCE_PATH,
  qualysCurrentPromotedReadOnlySourceBackedFamilyYaml,
  qualysCurrentPromotedReadOnlySourceBackedPythonSource,
  qualysGavFilterFieldsVocabularyJson,
} from "./qualys-source.js";
import { HostedIntegrationToolNameSchema } from "../../src/schemas.js";
import type { HostedIntegrationExample } from "../../src/schemas.js";
import { withSplitToolContractFiles } from "../split-contract.js";

export interface LegacyIntegrationHubToolInventoryEntry {
  familyId: string;
  legacyServerName: string;
  legacyToolName: string;
  legacyMcpToolName: string;
  hostedToolName: string;
  hostedRegistryToolName: string;
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

export interface ValidateReplacementInventoryResult {
  ok: boolean;
  diagnostics: string[];
}

export interface LegacyIntegrationHubReplacementMapping {
  familyId: string;
  hostedToolName: string;
  legacyMcpToolName: string;
  hostedRegistryToolName: string;
}

export interface LegacyIntegrationHubReplacementFamilyFixture {
  familyId: string;
  familyName: string;
  replacementToolNames: string[];
  hostedToolNames: string[];
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

export const QUALYS_TOOL_NAMES = [
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

export const LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES = [
  "qualys_gav_asset_count",
  "qualys_gav_asset_get",
  "qualys_gav_asset_search",
  "qualys_cloud_agent_hostasset_count",
  "qualys_cloud_agent_hostasset_search",
  "qualys_vmdr_host_list",
  "qualys_vmdr_host_detection_list",
  "qualys_vmdr_asset_group_list",
  "qualys_vmdr_ip_list",
  "qualys_vmdr_excluded_ip_list",
  "qualys_vmdr_restricted_ip_list",
  "qualys_vmdr_virtual_host_list",
  "qualys_vmdr_scan_list",
  "qualys_vmdr_scan_fetch",
  "qualys_vmdr_kb_vuln_list",
  "qualys_vmdr_kb_qvs_list",
  "qualys_asset_management_tag_list",
  "qualys_asset_management_tag_search",
] as const;

export const EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES = [
  ...QUALYS_TOOL_NAMES,
  "splunk_search",
  "msgraph_get",
  "mde_get",
  "defender_alert_get",
] as const;

export const LEGACY_INTEGRATION_HUB_INVENTORY: LegacyIntegrationHubInventory = {
  source: {
    serverName: LEGACY_SERVER_NAME,
    sourceAvailableInRepo: false,
    notes:
      "The current worktree does not contain workspace/src/integration_hub; seed inventory is based on hosted integration architecture docs and installed Qualys toolkit references.",
  },
  families: [
    family(
      "qualys",
      ["QUALYS_VM_URL", "QUALYS_GATEWAY_URL"],
      ["QUALYS_USERNAME", "QUALYS_PASSWORD"],
      {
        sourceStatus: "documented",
        sourcePaths: [LEGACY_INTEGRATION_HUB_QUALYS_SOURCE_PATH],
      },
    ),
    family("splunk", ["SPLUNK_BASE_URL"], ["SPLUNK_TOKEN"]),
    family(
      "msgraph",
      [
        "MSGRAPH_TENANT_ID",
        "MSGRAPH_CLIENT_ID",
        "MSGRAPH_TIMEOUT_SECONDS",
        "MSGRAPH_MAX_PAGES",
        "MSGRAPH_API_VERSION",
      ],
      ["MSGRAPH_CLIENT_SECRET"],
    ),
    family(
      "mde",
      [
        "MDE_TENANT_ID",
        "MDE_CLIENT_ID",
        "MDE_TIMEOUT_SECONDS",
        "MDE_MAX_PAGES",
      ],
      ["MDE_CLIENT_SECRET"],
    ),
    family(
      "defender-alert",
      ["DEFENDER_TENANT_ID", "DEFENDER_CLIENT_ID", "DEFENDER_TIMEOUT_SECONDS"],
      ["DEFENDER_CLIENT_SECRET"],
    ),
  ],
  tools: [
    ...QUALYS_TOOL_NAMES.map((toolName) =>
      tool("qualys", toolName, {
        freshness: toolName.startsWith("qualys_cache_") ? "cached" : "live",
        resultBehavior:
          toolName.includes("download") || toolName.includes("fetch")
            ? "result_file"
            : toolName.startsWith("qualys_cache_")
              ? "cache_workspace"
              : "inline",
        configKeys: ["QUALYS_VM_URL", "QUALYS_GATEWAY_URL"],
        secretRefs: ["QUALYS_USERNAME", "QUALYS_PASSWORD"],
      }),
    ),
    tool("splunk", "splunk_search", {
      configKeys: ["SPLUNK_BASE_URL"],
      secretRefs: ["SPLUNK_TOKEN"],
      resultBehavior: "result_file",
    }),
    tool("msgraph", "msgraph_get", {
      configKeys: [
        "MSGRAPH_TENANT_ID",
        "MSGRAPH_CLIENT_ID",
        "MSGRAPH_TIMEOUT_SECONDS",
        "MSGRAPH_MAX_PAGES",
        "MSGRAPH_API_VERSION",
      ],
      secretRefs: ["MSGRAPH_CLIENT_SECRET"],
    }),
    tool("mde", "mde_get", {
      configKeys: [
        "MDE_TENANT_ID",
        "MDE_CLIENT_ID",
        "MDE_TIMEOUT_SECONDS",
        "MDE_MAX_PAGES",
      ],
      secretRefs: ["MDE_CLIENT_SECRET"],
    }),
    tool("defender-alert", "defender_alert_get", {
      configKeys: [
        "DEFENDER_TENANT_ID",
        "DEFENDER_CLIENT_ID",
        "DEFENDER_TIMEOUT_SECONDS",
      ],
      secretRefs: ["DEFENDER_CLIENT_SECRET"],
    }),
  ],
};

export const FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY: LegacyIntegrationHubReplacementFamilyFixture =
  {
    familyId: "splunk",
    familyName: "Splunk",
    replacementToolNames: ["splunk_search"],
    hostedToolNames: [
      buildHostedToolName({
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
    sourceFiles: withSplitToolContractFiles({
      "family.yaml": splunkFamilyYaml(),
      "splunk.py": splunkPythonSource(),
    }),
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

export const LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY: LegacyIntegrationHubReplacementFamilyFixture =
  {
    familyId: "msgraph",
    familyName: "Microsoft Graph",
    replacementToolNames: ["msgraph_get"],
    hostedToolNames: [
      buildHostedToolName({
        familyId: "msgraph",
        toolName: "msgraph_get",
      }),
    ],
    legacyMcpToolNames: ["mcp_integration-hub__msgraph_get"],
    replacementMappings: [
      replacementMapping(
        "msgraph",
        "msgraph_get",
        "mcp_integration-hub__msgraph_get",
      ),
    ],
    configKeys: [
      "MSGRAPH_TENANT_ID",
      "MSGRAPH_CLIENT_ID",
      "MSGRAPH_TIMEOUT_SECONDS",
      "MSGRAPH_MAX_PAGES",
      "MSGRAPH_API_VERSION",
    ],
    secretRefs: ["MSGRAPH_CLIENT_SECRET"],
    sourceFiles: {
      "family.yaml": msgraphFamilyYaml(),
      "msgraph.py": msgraphPythonSource(),
    },
    examples: [
      {
        id: "msgraph_get_service_root_source_backed",
        familyId: "msgraph",
        toolName: "msgraph_get",
        category: "live_safe",
        args: { path: "/" },
        expected: { pages_fetched: 1 },
      },
    ],
    regressionExamples: [],
  };

export const LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY: LegacyIntegrationHubReplacementFamilyFixture =
  {
    familyId: "mde",
    familyName: "Microsoft Defender for Endpoint",
    replacementToolNames: ["mde_get"],
    hostedToolNames: [
      buildHostedToolName({
        familyId: "mde",
        toolName: "mde_get",
      }),
    ],
    legacyMcpToolNames: ["mcp_integration-hub__mde_get"],
    replacementMappings: [
      replacementMapping("mde", "mde_get", "mcp_integration-hub__mde_get"),
    ],
    configKeys: [
      "MDE_TENANT_ID",
      "MDE_CLIENT_ID",
      "MDE_TIMEOUT_SECONDS",
      "MDE_MAX_PAGES",
    ],
    secretRefs: ["MDE_CLIENT_SECRET"],
    sourceFiles: {
      "family.yaml": mdeFamilyYaml(),
      "mde.py": mdePythonSource(),
    },
    examples: [
      {
        id: "mde_get_machines_source_backed",
        familyId: "mde",
        toolName: "mde_get",
        category: "live_safe",
        args: { path: "/machines", params: { $top: "1" } },
        expected: { pages_fetched: 1 },
      },
    ],
    regressionExamples: [],
  };

export const LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY: LegacyIntegrationHubReplacementFamilyFixture =
  {
    familyId: "defender-alert",
    familyName: "Defender Alert",
    replacementToolNames: ["defender_alert_get"],
    hostedToolNames: [
      buildHostedToolName({
        familyId: "defender-alert",
        toolName: "defender_alert_get",
      }),
    ],
    legacyMcpToolNames: ["mcp_integration-hub__defender_alert_get"],
    replacementMappings: [
      replacementMapping(
        "defender-alert",
        "defender_alert_get",
        "mcp_integration-hub__defender_alert_get",
      ),
    ],
    configKeys: [
      "DEFENDER_TENANT_ID",
      "DEFENDER_CLIENT_ID",
      "DEFENDER_TIMEOUT_SECONDS",
    ],
    secretRefs: ["DEFENDER_CLIENT_SECRET"],
    sourceFiles: {
      "family.yaml": defenderAlertFamilyYaml(),
      "defender_alert.py": defenderAlertPythonSource(),
    },
    examples: [
      {
        id: "defender_alert_get_source_backed",
        familyId: "defender-alert",
        toolName: "defender_alert_get",
        category: "live_safe",
        args: { graph_alert_id: "sample-alert-id" },
        expected: { pages_fetched: 1 },
      },
    ],
    regressionExamples: [],
  };

export const LEGACY_INTEGRATION_HUB_INCIDENT_SOURCE: LegacyIntegrationHubIncidentSourceInventory =
  {
    available: false,
    path: "ops/incidents.jsonl",
    notes:
      "No ops/incidents.jsonl file is present in the current worktree; no synthetic regression examples are created during import.",
  };

export const LEGACY_INTEGRATION_HUB_REPLACEMENT_SECURITY_FAMILIES: LegacyIntegrationHubReplacementFamilyFixture[] =
  [
    buildReplacementFamilyFixture("qualys", "Qualys", "qualys.py"),
    FIRST_LEGACY_INTEGRATION_HUB_REPLACEMENT_FAMILY,
    LEGACY_INTEGRATION_HUB_MSGRAPH_SOURCE_BACKED_FAMILY,
    LEGACY_INTEGRATION_HUB_MDE_SOURCE_BACKED_FAMILY,
    LEGACY_INTEGRATION_HUB_DEFENDER_ALERT_SOURCE_BACKED_FAMILY,
  ];

export const LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_SYNC_FAMILY: LegacyIntegrationHubReplacementFamilyFixture =
  buildReplacementFamilyFixture("qualys", "Qualys", "qualys.py", {
    toolNames: LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES,
    examplesForEveryTool: true,
  });

export const LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY: LegacyIntegrationHubReplacementFamilyFixture =
  {
    ...buildReplacementFamilyFixture("qualys", "Qualys", "qualys.py", {
      toolNames: LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES,
      examplesForEveryTool: true,
    }),
    sourceFiles: withSplitToolContractFiles({
      "family.yaml": qualysCurrentPromotedReadOnlySourceBackedFamilyYaml(),
      "qualys.py": qualysCurrentPromotedReadOnlySourceBackedPythonSource(),
      "references/gav-filter-fields.json":
        qualysGavFilterFieldsVocabularyJson(),
    }),
    examples: [
      {
        id: "qualys_gav_asset_count_source_backed",
        familyId: "qualys",
        toolName: "qualys_gav_asset_count",
        category: "live_safe",
        args: {
          asset_last_updated: "2026-08-01T00:00Z",
          filter_body: {
            filters: [
              {
                field: "operatingSystem.category1",
                operator: "EQUALS",
                value: "Server",
              },
            ],
          },
        },
        expected: { used_filter_body: true },
      },
      {
        id: "qualys_gav_asset_get_source_backed",
        familyId: "qualys",
        toolName: "qualys_gav_asset_get",
        category: "live_safe",
        args: {
          asset_id: 1,
          include_fields: ["assetId", "assetName", "operatingSystem"],
        },
        expected: { direct_asset_get: true },
      },
      {
        id: "qualys_gav_asset_search_source_backed",
        familyId: "qualys",
        toolName: "qualys_gav_asset_search",
        category: "live_safe",
        args: {
          page_size: 2,
          max_pages: 1,
          include_fields: ["assetId", "assetName", "agentId"],
          filter_body: {
            filters: [
              {
                field: "operatingSystem.category1",
                operator: "EQUALS",
                value: "Linux",
              },
            ],
          },
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_cloud_agent_hostasset_count_source_backed",
        familyId: "qualys",
        toolName: "qualys_cloud_agent_hostasset_count",
        category: "live_safe",
        args: {
          filter_body: {
            filters: [
              {
                field: "qualys.agent.lastCheckedInDate",
                operator: "LESS_THAN_EQUAL",
                value: "2026-07-01T00:00Z",
              },
            ],
          },
        },
        expected: { used_filter_body: true },
      },
      {
        id: "qualys_cloud_agent_hostasset_search_source_backed",
        familyId: "qualys",
        toolName: "qualys_cloud_agent_hostasset_search",
        category: "live_safe",
        args: {
          page_size: 2,
          max_pages: 1,
          include_fields: ["assetId", "assetName", "agentId"],
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_host_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_host_list",
        category: "live_safe",
        args: {
          truncation_limit: 2,
          max_pages: 1,
          params: { host_metadata: "all" },
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_host_detection_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_host_detection_list",
        category: "live_safe",
        args: {
          status: "New,Active,Re-Opened",
          truncation_limit: 1,
          max_pages: 1,
          params: { show_asset_id: 1 },
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_scan_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_scan_list",
        category: "live_safe",
        args: {
          params: {},
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_scan_fetch_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_scan_fetch",
        category: "discovery_required",
        args: {},
        expected: {
          requires_discovered_scan_ref: true,
          discovery_tool: "qualys_vmdr_scan_list",
          not_live_safe_until_scan_ref_discovered: true,
          fetch_args_after_discovery: {
            params: { mode: "brief", output_format: "json" },
          },
        },
      },
      {
        id: "qualys_vmdr_virtual_host_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_virtual_host_list",
        category: "live_safe",
        args: {
          params: {},
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_restricted_ip_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_restricted_ip_list",
        category: "live_safe",
        args: {
          params: {},
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_excluded_ip_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_excluded_ip_list",
        category: "live_safe",
        args: {
          params: {},
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_ip_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_ip_list",
        category: "live_safe",
        args: {
          params: {},
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_asset_group_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_asset_group_list",
        category: "live_safe",
        args: {
          params: {},
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_kb_vuln_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_kb_vuln_list",
        category: "live_safe",
        args: {
          params: { ids: "90043", details: "All" },
          max_pages: 1,
        },
        expected: { pages_fetched: 1 },
      },
      {
        id: "qualys_vmdr_kb_qvs_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_vmdr_kb_qvs_list",
        category: "live_safe",
        args: {
          params: { qvs_min: 80, details: "Basic" },
        },
        expected: { qvs_metadata: true },
      },
      {
        id: "qualys_asset_management_tag_list_source_backed",
        familyId: "qualys",
        toolName: "qualys_asset_management_tag_list",
        category: "live_safe",
        args: {
          limit: 1,
        },
        expected: { qps_tag_list: true },
      },
      {
        id: "qualys_asset_management_tag_search_source_backed",
        familyId: "qualys",
        toolName: "qualys_asset_management_tag_search",
        category: "live_safe",
        args: {
          criteria: [{ field: "name", operator: "CONTAINS", value: "Cloud" }],
          limit: 1,
        },
        expected: { qps_tag_search: true },
      },
    ],
  };

export function validateLegacyIntegrationHubReplacementInventory(
  inventory: LegacyIntegrationHubInventory,
  expectedToolNames: readonly string[] = EXPECTED_LEGACY_INTEGRATION_HUB_TOOL_NAMES,
): ValidateReplacementInventoryResult {
  const diagnostics: string[] = [];
  const legacyNames = new Set(
    inventory.tools.map((entry) => entry.legacyToolName),
  );
  for (const expected of expectedToolNames) {
    if (!legacyNames.has(expected))
      diagnostics.push(`missing legacy tool: ${expected}`);
  }
  for (const entry of inventory.tools) {
    if (
      !HostedIntegrationToolNameSchema.safeParse(entry.hostedToolName).success
    ) {
      diagnostics.push(`invalid hosted tool name: ${entry.hostedToolName}`);
    }
    const parsedHosted = parseHostedToolName(entry.hostedRegistryToolName);
    if (
      !HostedToolNameSchema.safeParse(entry.hostedRegistryToolName).success ||
      !parsedHosted
    ) {
      diagnostics.push(
        `invalid hosted registry tool name: ${entry.hostedRegistryToolName}`,
      );
    } else if (
      parsedHosted.familyId !== entry.familyId ||
      parsedHosted.toolName !== entry.hostedToolName
    ) {
      diagnostics.push(
        `hosted registry tool name mismatch: ${entry.hostedRegistryToolName}`,
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
    inventory.tools.map((entry) => entry.hostedRegistryToolName),
  )) {
    diagnostics.push(`duplicate hosted registry tool: ${duplicate}`);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

function family(
  familyId: string,
  configKeys: string[],
  secretRefs: string[],
  options: {
    sourceStatus?: LegacyIntegrationHubFamilyInventoryEntry["sourceStatus"];
    sourcePaths?: string[];
  } = {},
): LegacyIntegrationHubFamilyInventoryEntry {
  return {
    familyId,
    sourceStatus: options.sourceStatus ?? "external_source_unavailable",
    sourcePaths: options.sourcePaths ?? [
      `workspace/src/integration_hub/integrations/${familyId}/`,
    ],
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
    hostedRegistryToolName: buildHostedToolName({
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
    hostedRegistryToolName: buildHostedToolName({
      familyId,
      toolName: hostedToolName,
    }),
  };
}

function buildReplacementFamilyFixture(
  familyId: string,
  familyName: string,
  entrypoint: string,
  options: {
    toolNames?: readonly string[];
    examplesForEveryTool?: boolean;
  } = {},
): LegacyIntegrationHubReplacementFamilyFixture {
  const familyEntry = LEGACY_INTEGRATION_HUB_INVENTORY.families.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!familyEntry) throw new Error(`missing import family: ${familyId}`);
  const selectedToolNames = options.toolNames
    ? new Set(options.toolNames)
    : null;
  const tools = LEGACY_INTEGRATION_HUB_INVENTORY.tools.filter(
    (entry) =>
      entry.familyId === familyId &&
      (!selectedToolNames || selectedToolNames.has(entry.hostedToolName)),
  );
  if (tools.length === 0) {
    throw new Error(`missing import tools for family: ${familyId}`);
  }
  if (selectedToolNames && tools.length !== selectedToolNames.size) {
    const found = new Set(tools.map((entry) => entry.hostedToolName));
    const missing = [...selectedToolNames].filter(
      (toolName) => !found.has(toolName),
    );
    throw new Error(
      `missing import tools for family ${familyId}: ${missing.join(", ")}`,
    );
  }
  if (options.toolNames) {
    const order = new Map(
      options.toolNames.map((toolName, index) => [toolName, index]),
    );
    tools.sort(
      (left, right) =>
        (order.get(left.hostedToolName) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.hostedToolName) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  const exampleTools = options.examplesForEveryTool ? tools : [tools[0]!];
  return {
    familyId,
    familyName,
    replacementToolNames: tools.map((entry) => entry.hostedToolName),
    hostedToolNames: tools.map((entry) => entry.hostedRegistryToolName),
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
      "family.yaml": generatedFamilyYaml(
        familyId,
        familyName,
        entrypoint,
        familyEntry.configKeys,
        familyEntry.secretRefs,
        tools,
      ),
      [entrypoint]: generatedPythonSource(tools),
    },
    examples: exampleTools.map((entry) => ({
      id: `${entry.hostedToolName}_import_smoke`,
      familyId,
      toolName: entry.hostedToolName,
      category: "mock_only",
      args: {},
      expected: {
        replacement: true,
        tool: entry.hostedToolName,
      },
    })),
    regressionExamples: [],
  };
}

function generatedFamilyYaml(
  familyId: string,
  familyName: string,
  entrypoint: string,
  configKeys: string[],
  secretRefs: string[],
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
runtimeConfig:
  requiredConfigKeys:${yamlArray(configKeys)}
  requiredSecretKeys:${yamlArray(secretRefs)}
tools:
${tools.map(toolYaml).join("")}`;
}

function yamlArray(values: string[]): string {
  return values.length === 0
    ? " []"
    : `\n${values.map((value) => `    - ${value}`).join("\n")}`;
}

function toolYaml(entry: LegacyIntegrationHubToolInventoryEntry): string {
  const cacheYaml =
    entry.freshness === "cached" || entry.freshness === "sync"
      ? `    cache:
      scope: family_home
      path: ${entry.hostedToolName}.json
      description: Explicit import cache for ${entry.hostedToolName}.
`
      : "";
  return `  - name: ${entry.hostedToolName}
    title: ${titleizeToolName(entry.hostedToolName)}
    description: Replacement legacy integration-hub tool ${entry.legacyMcpToolName}.
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
  return `TOOL_NAMES = ${JSON.stringify(
    tools.map((entry) => entry.hostedToolName),
    null,
    4,
  )}
CACHE_TOOLS = ${JSON.stringify(
    tools
      .filter(
        (entry) => entry.freshness === "cached" || entry.freshness === "sync",
      )
      .map((entry) => entry.hostedToolName),
    null,
    4,
  )}

def list_tools():
    return []

def authenticate(ctx):
    return {}

def before_tool_call(tool_name, args, ctx, auth):
    return args

def after_tool_call(tool_name, args, ctx, result, auth):
    return result

def _run_tool(name, args, context):
    if name not in TOOL_NAMES:
        raise ValueError(f"unknown tool: {name}")
    return {
        "replacement": True,
        "tool": name,
        "args": args,
        "family_id": context["family_id"],
        "generation_id": context["generation_id"],
        "uses_explicit_cache": name in CACHE_TOOLS,
        "auth_configured": bool(context.get("secrets")),
    }

${tools
  .map(
    (entry) => `def tool_${entry.hostedToolName}(args, context):
    return _run_tool(${JSON.stringify(entry.hostedToolName)}, args, context)
`,
  )
  .join("\n")}
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
runtimeConfig:
  requiredConfigKeys:
    - SPLUNK_BASE_URL
  requiredSecretKeys:
    - SPLUNK_TOKEN
tools:
  - name: splunk_search
    title: Search Splunk
    description: Runs a read-only Splunk search through the replacement hosted integration surface.
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
            "description": "Runs a read-only Splunk search through the replacement hosted integration surface.",
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

def authenticate(ctx):
    return {}

def before_tool_call(tool_name, args, ctx, auth):
    return args

def after_tool_call(tool_name, args, ctx, result, auth):
    return result

def tool_splunk_search(args, context):
    query = args["query"]
    limit = int(args.get("limit", 2))
    base_url = context["config"].get("SPLUNK_BASE_URL", "https://splunk.example.test")
    has_token = bool(context["secrets"].get("SPLUNK_TOKEN"))
    rows = [
        {
            "offset": index,
            "source": "import_fixture",
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

function msgraphFamilyYaml(): string {
  return `
id: msgraph
name: Microsoft Graph
version: 1
runtime:
  language: python
  entrypoint: msgraph.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
    declaredEgress:
      - https://login.microsoftonline.com
      - https://graph.microsoft.com
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
runtimeConfig:
  requiredConfigKeys:
    - MSGRAPH_TENANT_ID
    - MSGRAPH_CLIENT_ID
  requiredSecretKeys:
    - MSGRAPH_CLIENT_SECRET
tools:
  - name: msgraph_get
    title: Microsoft Graph GET
    description: Performs a read-only GET request against graph.microsoft.com using client-credentials auth.
    inputSchema:
      type: object
      required:
        - path
      properties:
        path:
          type: string
          minLength: 1
          description: Relative Microsoft Graph path, or an absolute https://graph.microsoft.com/v1.0|beta/... URL.
        params:
          type: object
          additionalProperties:
            anyOf:
              - type: string
              - type: number
              - type: boolean
              - type: array
                items:
                  anyOf:
                    - type: string
                    - type: number
                    - type: boolean
        api_version:
          type: string
          enum:
            - v1.0
            - beta
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means the path, params, or api_version are unsupported; fix the request before retrying.
      - auth_failed or permission_denied means the Microsoft Graph app credentials, tenant, or Graph application permissions need correction.
      - upstream_error or rate_limited means Microsoft Graph rejected or throttled the request; retry only when the error indicates it is transient.
    help:
      summary: Read a Microsoft Graph resource with a safe GET request.
      full: |
        Calls Microsoft Graph using application credentials configured on the
        hosted integration environment. Use relative paths such as
        /, /users, or /groups, or an absolute
        https://graph.microsoft.com/v1.0/... or beta URL. Absolute URLs for
        any other host are rejected before token exchange or Graph network
        calls.
      whenToUse:
        - Read Microsoft Graph directory, user, group, device, or policy resources.
        - Fetch a bounded collection where Graph permissions already allow access.
      whenNotToUse:
        - Do not use for POST, PATCH, DELETE, or any mutation.
        - Do not use non-Graph absolute URLs or Microsoft Defender hunting queries.
      parameters:
        path:
          summary: Microsoft Graph resource path.
          full: |
            Prefer a relative path starting with /, for example /
            or /users. Absolute URLs are accepted only when the host is exactly
            graph.microsoft.com and the path starts with /v1.0/ or /beta/.
          rules:
            - Non-Graph absolute URLs are rejected with bad_arguments.
            - Relative paths are resolved under the selected api_version.
            - Do not include a query string in path when params is supplied.
          examples:
            - /
            - /users
            - https://graph.microsoft.com/v1.0/groups
        params:
          summary: Query string parameters passed to Microsoft Graph.
          full: |
            Use Graph query parameters such as $top, $select, $filter, or
            $orderby. Values may be scalars or arrays of scalars. Pagination
            follows @odata.nextLink up to MSGRAPH_MAX_PAGES.
          rules:
            - Use $top to keep result sets bounded.
            - Do not place credentials or bearer tokens in params.
            - Params are ignored for @odata.nextLink continuation requests.
          examples:
            - $top: "1"
              $select: id,displayName
        api_version:
          summary: Microsoft Graph API version for relative paths.
          full: Use v1.0 unless the requested resource is only available in beta.
          rules:
            - Must be v1.0 or beta.
          examples:
            - v1.0
            - beta
      examples:
        - path: /
`;
}

function msgraphPythonSource(): string {
  return String.raw`
"""Microsoft Graph read-only hosted integration.

The hosted runtime supplies config and secrets through context only. Token
exchange is intentionally delayed until after the requested Graph URL is
validated, so unsafe absolute URLs fail without external network calls.
"""

import json
import urllib.error
import urllib.parse
import urllib.request


GRAPH_HOST = "graph.microsoft.com"
LOGIN_HOST = "login.microsoftonline.com"
DEFAULT_API_VERSION = "v1.0"
SUPPORTED_API_VERSIONS = {"v1.0", "beta"}


class MsGraphToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def list_tools():
    return []


def authenticate(ctx):
    config = ctx.get("config") or {}
    secrets = ctx.get("secrets") or {}
    tenant_id = _required(config, "MSGRAPH_TENANT_ID")
    client_id = _required(config, "MSGRAPH_CLIENT_ID")
    client_secret = _required(secrets, "MSGRAPH_CLIENT_SECRET")
    timeout_seconds = _positive_float(
        config.get("MSGRAPH_TIMEOUT_SECONDS") or "30",
        "MSGRAPH_TIMEOUT_SECONDS",
    )
    max_pages = _positive_int(
        config.get("MSGRAPH_MAX_PAGES") or "3",
        "MSGRAPH_MAX_PAGES",
    )
    api_version = config.get("MSGRAPH_API_VERSION") or DEFAULT_API_VERSION
    _validate_api_version(api_version)
    return {
        "tenant_id": tenant_id,
        "client_id": client_id,
        "client_secret": client_secret,
        "timeout_seconds": timeout_seconds,
        "max_pages": max_pages,
        "api_version": api_version,
    }


def before_tool_call(tool_name, args, ctx, auth):
    return args or {}


def after_tool_call(tool_name, args, ctx, result, auth):
    return result


def tool_msgraph_get(args, context):
    auth = context.get("auth") or {}
    api_version = args.get("api_version") or auth.get("api_version") or DEFAULT_API_VERSION
    _validate_api_version(api_version)
    path = _required(args, "path")
    if not isinstance(path, str):
        raise MsGraphToolError("bad_arguments", "path must be a string")
    params = _params_arg(args.get("params"))
    url = _normalize_graph_url(path, api_version, params)
    token = _fetch_token(auth)
    return _get_graph(url, token, auth)


def _required(source, key):
    value = source.get(key)
    if value is None or str(value).strip() == "":
        raise MsGraphToolError("missing_config", f"{key} is not configured")
    return str(value).strip()


def _validate_api_version(value):
    if value not in SUPPORTED_API_VERSIONS:
        raise MsGraphToolError("bad_arguments", "api_version must be v1.0 or beta")


def _positive_int(value, key):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise MsGraphToolError("bad_arguments", f"{key} must be a positive integer")
    if parsed <= 0:
        raise MsGraphToolError("bad_arguments", f"{key} must be a positive integer")
    return parsed


def _positive_float(value, key):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise MsGraphToolError("bad_arguments", f"{key} must be a positive number")
    if parsed <= 0:
        raise MsGraphToolError("bad_arguments", f"{key} must be a positive number")
    return parsed


def _params_arg(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise MsGraphToolError("bad_arguments", "params must be an object")
    return value


def _normalize_graph_url(path, api_version, params):
    parsed = urllib.parse.urlparse(path)
    if parsed.scheme or parsed.netloc:
        if parsed.scheme != "https" or parsed.netloc.lower() != GRAPH_HOST:
            raise MsGraphToolError(
                "bad_arguments",
                "absolute Microsoft Graph URLs must use https://graph.microsoft.com",
            )
        parts = [part for part in parsed.path.split("/") if part]
        if not parts or parts[0] not in SUPPORTED_API_VERSIONS:
            raise MsGraphToolError(
                "bad_arguments",
                "absolute Microsoft Graph URLs must include /v1.0/ or /beta/",
            )
        if params:
            query = urllib.parse.urlencode(params, doseq=True)
            return urllib.parse.urlunparse(parsed._replace(query=query))
        return urllib.parse.urlunparse(parsed)
    relative = path if path.startswith("/") else f"/{path}"
    query = urllib.parse.urlencode(params, doseq=True)
    return urllib.parse.urlunparse(
        ("https", GRAPH_HOST, f"/{api_version}{relative}", "", query, "")
    )


def _fetch_token(auth):
    tenant_id = auth.get("tenant_id")
    url = f"https://{LOGIN_HOST}/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode(
        {
            "client_id": auth.get("client_id"),
            "client_secret": auth.get("client_secret"),
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    payload = _open_json(request, auth.get("timeout_seconds"))
    token = payload.get("access_token")
    if not token:
        raise MsGraphToolError("auth_failed", "Microsoft Graph token response did not include access_token")
    return token


def _get_graph(first_url, token, auth):
    results = []
    pages_fetched = 0
    next_url = first_url
    last_payload = None
    while next_url and pages_fetched < auth.get("max_pages", 3):
        request = urllib.request.Request(
            next_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            method="GET",
        )
        payload = _open_json(request, auth.get("timeout_seconds"))
        last_payload = payload
        pages_fetched += 1
        if isinstance(payload.get("value"), list):
            results.extend(payload["value"])
            next_url = payload.get("@odata.nextLink")
        else:
            return {
                "response": payload,
                "pages_fetched": pages_fetched,
                "truncated": False,
            }
    return {
        "results": results,
        "result_count": len(results),
        "pages_fetched": pages_fetched,
        "truncated": bool(last_payload and last_payload.get("@odata.nextLink")),
    }


def _open_json(request, timeout):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise MsGraphToolError("upstream_error", f"Microsoft Graph HTTP {exc.code}: {_short(body)}")
    except urllib.error.URLError as exc:
        raise MsGraphToolError("connection_error", str(exc.reason))
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise MsGraphToolError("upstream_error", "Microsoft Graph response was not valid JSON")


def _short(value):
    return value.replace("\n", " ")[:300]
`;
}

function mdeFamilyYaml(): string {
  return `
id: mde
name: Microsoft Defender for Endpoint
version: 1
runtime:
  language: python
  entrypoint: mde.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
    declaredEgress:
      - https://login.microsoftonline.com
      - https://api.securitycenter.microsoft.com
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
runtimeConfig:
  requiredConfigKeys:
    - MDE_TENANT_ID
    - MDE_CLIENT_ID
  requiredSecretKeys:
    - MDE_CLIENT_SECRET
tools:
  - name: mde_get
    title: Microsoft Defender for Endpoint GET
    description: Performs a read-only GET request against api.securitycenter.microsoft.com/api using client-credentials auth.
    inputSchema:
      type: object
      required:
        - path
      properties:
        path:
          type: string
          minLength: 1
          description: Relative MDE API path, or an absolute https://api.securitycenter.microsoft.com/api/... URL.
        params:
          type: object
          additionalProperties:
            anyOf:
              - type: string
              - type: number
              - type: boolean
              - type: array
                items:
                  anyOf:
                    - type: string
                    - type: number
                    - type: boolean
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means the path or params are unsupported; fix the request before retrying.
      - auth_failed or permission_denied means the Defender for Endpoint app credentials, tenant, or WindowsDefenderATP permissions need correction.
      - upstream_error or rate_limited means the MDE API rejected or throttled the request; retry only when the error indicates it is transient.
    help:
      summary: Read a Microsoft Defender for Endpoint API resource with a safe GET request.
      full: |
        Calls the classic Microsoft Defender for Endpoint API using
        application credentials configured on the MDE hosted integration
        environment. Use relative paths such as /machines, /alerts,
        /vulnerabilities, or /recommendations. Absolute URLs are accepted only
        under https://api.securitycenter.microsoft.com/api.
      whenToUse:
        - Read Defender for Endpoint machine, alert, vulnerability, score, or recommendation resources.
        - Fetch a bounded collection where WindowsDefenderATP permissions already allow access.
      whenNotToUse:
        - Do not use for POST, PATCH, DELETE, or any mutation.
        - Do not use Microsoft Graph paths or non-MDE absolute URLs.
      parameters:
        path:
          summary: Defender for Endpoint API path.
          full: |
            Prefer a relative path starting with /, for example /machines or
            /vulnerabilities. Absolute URLs are accepted only when they start
            with https://api.securitycenter.microsoft.com/api.
          rules:
            - Non-MDE absolute URLs are rejected with bad_arguments.
            - Do not include a query string in path when params is supplied.
            - Endpoint availability depends on WindowsDefenderATP app permissions.
          examples:
            - /machines
            - /alerts
            - https://api.securitycenter.microsoft.com/api/vulnerabilities
        params:
          summary: Query string parameters passed to the MDE API.
          full: |
            Use OData query parameters such as $top, $filter, $select, or
            $orderby. Values may be scalars or arrays of scalars. Pagination
            follows @odata.nextLink up to MDE_MAX_PAGES.
          rules:
            - Use $top to keep result sets bounded.
            - Do not place credentials or bearer tokens in params.
            - Params are ignored for @odata.nextLink continuation requests.
          examples:
            - $top: "1"
      examples:
        - path: /machines
          params:
            $top: "1"
`;
}

function mdePythonSource(): string {
  return String.raw`
"""Microsoft Defender for Endpoint read-only hosted integration.

The hosted runtime supplies MDE config and secrets through context only. Token
exchange is delayed until after URL validation, so unsafe absolute URLs fail
without external network calls.
"""

import json
import urllib.error
import urllib.parse
import urllib.request


MDE_BASE_URL = "https://api.securitycenter.microsoft.com/api"
MDE_RESOURCE = "https://api.securitycenter.microsoft.com"
LOGIN_HOST = "login.microsoftonline.com"


class MdeToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def list_tools():
    return []


def authenticate(ctx):
    config = ctx.get("config") or {}
    secrets = ctx.get("secrets") or {}
    tenant_id = _required(config, "MDE_TENANT_ID")
    client_id = _required(config, "MDE_CLIENT_ID")
    client_secret = _required(secrets, "MDE_CLIENT_SECRET")
    timeout_seconds = _positive_float(
        config.get("MDE_TIMEOUT_SECONDS") or "60",
        "MDE_TIMEOUT_SECONDS",
    )
    max_pages = _positive_int(
        config.get("MDE_MAX_PAGES") or "10",
        "MDE_MAX_PAGES",
    )
    return {
        "tenant_id": tenant_id,
        "client_id": client_id,
        "client_secret": client_secret,
        "timeout_seconds": timeout_seconds,
        "max_pages": max_pages,
    }


def before_tool_call(tool_name, args, ctx, auth):
    return args or {}


def after_tool_call(tool_name, args, ctx, result, auth):
    return result


def tool_mde_get(args, context):
    auth = context.get("auth") or {}
    path = _required(args, "path")
    if not isinstance(path, str):
        raise MdeToolError("bad_arguments", "path must be a string")
    params = _params_arg(args.get("params"))
    url = _normalize_mde_url(path, params)
    token = _fetch_token(auth)
    return _get_mde(url, token, auth)


def _required(source, key):
    value = source.get(key)
    if value is None or str(value).strip() == "":
        raise MdeToolError("missing_config", f"{key} is not configured")
    return str(value).strip()


def _positive_int(value, key):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise MdeToolError("bad_arguments", f"{key} must be a positive integer")
    if parsed <= 0:
        raise MdeToolError("bad_arguments", f"{key} must be a positive integer")
    return parsed


def _positive_float(value, key):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise MdeToolError("bad_arguments", f"{key} must be a positive number")
    if parsed <= 0:
        raise MdeToolError("bad_arguments", f"{key} must be a positive number")
    return parsed


def _params_arg(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise MdeToolError("bad_arguments", "params must be an object")
    return value


def _normalize_mde_url(path, params):
    cleaned = path.strip()
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme or parsed.netloc:
        base = MDE_BASE_URL.lower()
        absolute = urllib.parse.urlunparse(parsed._replace(query=""))
        if parsed.scheme != "https" or not absolute.lower().startswith(base):
            raise MdeToolError(
                "bad_arguments",
                "absolute MDE URLs must start with https://api.securitycenter.microsoft.com/api",
            )
        if params:
            query = urllib.parse.urlencode(params, doseq=True)
            return urllib.parse.urlunparse(parsed._replace(query=query))
        return urllib.parse.urlunparse(parsed)
    relative = cleaned if cleaned.startswith("/") else f"/{cleaned}"
    query = urllib.parse.urlencode(params, doseq=True)
    return f"{MDE_BASE_URL}{relative}" + (f"?{query}" if query else "")


def _fetch_token(auth):
    tenant_id = auth.get("tenant_id")
    url = f"https://{LOGIN_HOST}/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode(
        {
            "client_id": auth.get("client_id"),
            "client_secret": auth.get("client_secret"),
            "scope": f"{MDE_RESOURCE}/.default",
            "grant_type": "client_credentials",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    payload = _open_json(request, auth.get("timeout_seconds"), "token")
    token = payload.get("access_token")
    if not token:
        raise MdeToolError("auth_failed", "MDE token response did not include access_token")
    return token


def _get_mde(first_url, token, auth):
    results = []
    pages_fetched = 0
    next_url = first_url
    last_payload = None
    while next_url and pages_fetched < auth.get("max_pages", 10):
        request = urllib.request.Request(
            next_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            method="GET",
        )
        payload = _open_json(request, auth.get("timeout_seconds"), "api")
        last_payload = payload
        values = payload.get("value")
        if not isinstance(values, list):
            return {
                "results": [payload],
                "result_count": 1,
                "pages_fetched": 1,
                "truncated": False,
            }
        pages_fetched += 1
        results.extend(values)
        next_url = payload.get("@odata.nextLink")
    return {
        "results": results,
        "result_count": len(results),
        "pages_fetched": pages_fetched,
        "truncated": bool(last_payload and last_payload.get("@odata.nextLink")),
    }


def _open_json(request, timeout, surface):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if surface == "token":
            raise MdeToolError("auth_failed", f"MDE token HTTP {exc.code}: {_short(body)}")
        if exc.code in (401, 403):
            raise MdeToolError("auth_failed", f"MDE HTTP {exc.code}: {_short(body)}")
        if exc.code == 429:
            raise MdeToolError("rate_limited", "MDE HTTP 429")
        raise MdeToolError("upstream_error", f"MDE HTTP {exc.code}: {_short(body)}")
    except urllib.error.URLError as exc:
        raise MdeToolError("connection_error", str(exc.reason))
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise MdeToolError("upstream_error", "MDE response was not valid JSON")


def _short(value):
    return value.replace("\n", " ")[:300]
`;
}

function defenderAlertFamilyYaml(): string {
  return `
id: defender-alert
name: Defender Alert
version: 1
runtime:
  language: python
  entrypoint: defender_alert.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
    declaredEgress:
      - https://login.microsoftonline.com
      - https://graph.microsoft.com
      - https://api.securitycenter.microsoft.com
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
runtimeConfig:
  requiredConfigKeys:
    - DEFENDER_TENANT_ID
    - DEFENDER_CLIENT_ID
  requiredSecretKeys:
    - DEFENDER_CLIENT_SECRET
tools:
  - name: defender_alert_get
    title: Defender Alert GET
    description: Fetches the same alert from Microsoft Graph alerts_v2 and best-effort MDE native alerts.
    inputSchema:
      type: object
      required:
        - graph_alert_id
      properties:
        graph_alert_id:
          type: string
          minLength: 1
          description: Alert ID from Microsoft Graph /security/alerts_v2 id field.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means graph_alert_id is missing or is not the Graph /security/alerts_v2 id; correct the identifier before retrying.
      - auth_failed or permission_denied means Graph or MDE credentials, tenant, or application permissions need correction.
      - upstream_error or rate_limited means Graph or MDE rejected or throttled the request; retry only when the error indicates it is transient.
    help:
      summary: Fetch one alert from Graph alerts_v2 and best-effort MDE native alerts.
      full: |
        Uses the Graph alert id directly as the MDE native alert lookup key.
        Returns raw Graph and MDE payloads side by side and does not merge,
        deduplicate, correlate, or interpret them. The Graph side is required.
        The MDE side is best-effort; if MDE lookup fails, the response includes
        a clear mde_status instead of failing the whole call.
      whenToUse:
        - Compare one Graph security alert with the matching Defender for Endpoint native alert.
        - Preserve raw source-specific alert payloads for follow-up investigation.
      whenNotToUse:
        - Do not use for alert search or list workflows.
        - Do not use providerAlertId as the lookup input.
        - Do not use for mutation, remediation, or alert status updates.
      parameters:
        graph_alert_id:
          summary: The Graph /security/alerts_v2 id field.
          full: |
            Pass Graph's raw id field. Do not pass providerAlertId; legacy live
            testing showed providerAlertId did not resolve reliably in MDE's
            native alert API.
          rules:
            - Required and must be non-empty.
            - Must come from Graph alerts_v2 id, not providerAlertId.
          examples:
            - sample-alert-id
      examples:
        - graph_alert_id: sample-alert-id
`;
}

function defenderAlertPythonSource(): string {
  return String.raw`
"""Defender alert cross-API read-only hosted integration.

The hosted runtime supplies defender-alert config and secrets through context
only. The Graph side is required; the native endpoint side is best-effort and
reported through mde_status.
"""

import json
import urllib.error
import urllib.parse
import urllib.request


GRAPH_RESOURCE = "https://graph.microsoft.com"
GRAPH_ALERT_BASE = "https://graph.microsoft.com/v1.0/security/alerts_v2/"
ENDPOINT_RESOURCE = "https://api.securitycenter.microsoft.com"
ENDPOINT_ALERT_BASE = "https://api.securitycenter.microsoft.com/api/alerts"
LOGIN_HOST = "login.microsoftonline.com"


class DefenderAlertToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def list_tools():
    return []


def authenticate(ctx):
    config = ctx.get("config") or {}
    secrets = ctx.get("secrets") or {}
    tenant_id = _required(config, "DEFENDER_TENANT_ID")
    client_id = _required(config, "DEFENDER_CLIENT_ID")
    client_secret = _required(secrets, "DEFENDER_CLIENT_SECRET")
    timeout_seconds = _positive_float(
        config.get("DEFENDER_TIMEOUT_SECONDS") or "60",
        "DEFENDER_TIMEOUT_SECONDS",
    )
    return {
        "tenant_id": tenant_id,
        "client_id": client_id,
        "client_secret": client_secret,
        "timeout_seconds": timeout_seconds,
    }


def before_tool_call(tool_name, args, ctx, auth):
    return args or {}


def after_tool_call(tool_name, args, ctx, result, auth):
    return result


def tool_defender_alert_get(args, context):
    graph_alert_id = _required(args, "graph_alert_id")
    if not isinstance(graph_alert_id, str):
        raise DefenderAlertToolError("bad_arguments", "graph_alert_id must be a string")
    auth = context.get("auth") or {}
    graph_token = _fetch_token(auth, GRAPH_RESOURCE)
    graph_alert = _get_json(
        f"{GRAPH_ALERT_BASE}{urllib.parse.quote(graph_alert_id, safe='')}",
        graph_token,
        auth,
        "graph",
    )
    endpoint_alert = None
    endpoint_status = "not_found"
    try:
        endpoint_token = _fetch_token(auth, ENDPOINT_RESOURCE)
        # Native endpoint lookup uses /alerts/{graph_alert_id}; do not use providerAlertId.
        endpoint_alert = _get_json(
            f"{ENDPOINT_ALERT_BASE}/{urllib.parse.quote(graph_alert_id, safe='')}",
            endpoint_token,
            auth,
            "endpoint",
        )
        endpoint_status = "ok" if endpoint_alert else "not_found"
    except DefenderAlertToolError as exc:
        endpoint_status = f"{exc.code}: {exc}"
    return {
        "results": [
            {
                "graph": graph_alert,
                "mde": endpoint_alert,
                "mde_status": endpoint_status,
            }
        ],
        "result_count": 1,
        "truncated": False,
        "pages_fetched": 1,
    }


def _required(source, key):
    value = source.get(key)
    if value is None or str(value).strip() == "":
        code = "bad_arguments" if key == "graph_alert_id" else "missing_config"
        raise DefenderAlertToolError(code, f"{key} is not configured")
    return str(value).strip()


def _positive_float(value, key):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise DefenderAlertToolError("bad_arguments", f"{key} must be a positive number")
    if parsed <= 0:
        raise DefenderAlertToolError("bad_arguments", f"{key} must be a positive number")
    return parsed


def _fetch_token(auth, resource):
    url = f"https://{LOGIN_HOST}/{auth.get('tenant_id')}/oauth2/v2.0/token"
    body = urllib.parse.urlencode(
        {
            "client_id": auth.get("client_id"),
            "client_secret": auth.get("client_secret"),
            "scope": f"{resource}/.default",
            "grant_type": "client_credentials",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    payload = _open_json(request, auth.get("timeout_seconds"), "token")
    token = payload.get("access_token")
    if not token:
        raise DefenderAlertToolError("auth_failed", "token response did not include access_token")
    return token


def _get_json(url, token, auth, surface):
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    return _open_json(request, auth.get("timeout_seconds"), surface)


def _open_json(request, timeout, surface):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if surface == "endpoint" and exc.code == 404:
            raise DefenderAlertToolError("not_found", "endpoint alert not found")
        if surface == "graph" and exc.code == 404:
            raise DefenderAlertToolError("not_found", "Graph alert not found")
        if surface == "token":
            raise DefenderAlertToolError("auth_failed", f"token HTTP {exc.code}: {_short(body)}")
        if exc.code in (401, 403):
            raise DefenderAlertToolError("auth_failed", f"{surface} HTTP {exc.code}: {_short(body)}")
        if exc.code == 429:
            raise DefenderAlertToolError("rate_limited", f"{surface} HTTP 429")
        raise DefenderAlertToolError("upstream_error", f"{surface} HTTP {exc.code}: {_short(body)}")
    except urllib.error.URLError as exc:
        raise DefenderAlertToolError("connection_error", str(exc.reason))
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise DefenderAlertToolError("upstream_error", f"{surface} response was not valid JSON")


def _short(value):
    return value.replace("\n", " ")[:300]
`;
}
