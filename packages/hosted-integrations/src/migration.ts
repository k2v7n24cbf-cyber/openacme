import { HostedIntegrationToolNameSchema } from "./schemas.js";

export interface LegacyIntegrationHubToolInventoryEntry {
  familyId: string;
  legacyServerName: string;
  legacyToolName: string;
  legacyMcpToolName: string;
  hostedToolName: string;
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
