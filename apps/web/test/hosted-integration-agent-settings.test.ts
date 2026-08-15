import { describe, expect, it } from "vitest";
import {
  agentSettingsCatalogTools,
  agentSettingsToolGroupLabel,
  buildAgentSettingsHostedIntegrationBinding,
  groupAgentSettingsTools,
  hostedIntegrationEnvironmentConfigsForTool,
  isHostedIntegrationTool,
  selectedHostedIntegrationBindings,
  type AgentHostedIntegrationBinding,
  type HostedIntegrationEnvironmentConfig,
} from "@/app/lib/hosted-integration-agent-settings";
import type { ToolInfo } from "@/app/lib/types";

const hostedTool: ToolInfo = {
  name: "managed_qualys__qualys_count_assets",
  description: "Count assets.",
  toolset: "hosted-integrations",
  source: {
    kind: "hosted_integration",
    familyId: "qualys",
    familyName: "Qualys",
    toolName: "qualys_count_assets",
    generationId: "gen_1",
  },
};

const builtinTool: ToolInfo = {
  name: "read_file",
  description: "Read a file.",
  toolset: "filesystem",
};

const mcpTool: ToolInfo = {
  name: "mcp_github__create_issue",
  description: "Create an issue.",
  toolset: "mcp-github",
};

const managedHelpTool: ToolInfo = {
  name: "managed_tool_help",
  description: "Get managed hosted integration tool help.",
  toolset: "hosted-integration-support",
};

const hostedManagementTool: ToolInfo = {
  name: "hosted_integration_promote",
  description: "Promote a validated hosted integration draft.",
  toolset: "hosted-integration-management",
};

const environmentConfigs: HostedIntegrationEnvironmentConfig[] = [
  {
    id: "qualys-prod",
    familyId: "qualys",
    revision: 1,
    environment: "prod",
    config: { QUALYS_BASE_URL: "https://qualys.example" },
    secrets: { QUALYS_TOKEN: { configured: true } },
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedBy: "human:alen",
  },
  {
    id: "qualys-test_debug",
    familyId: "qualys",
    revision: 2,
    environment: "test_debug",
    config: { QUALYS_BASE_URL: "https://qualys-debug.example" },
    secrets: {},
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedBy: "human:alen",
  },
];

describe("hosted integration agent settings helpers", () => {
  it("classifies and groups hosted tools separately from built-in and MCP tools", () => {
    expect(isHostedIntegrationTool(hostedTool)).toBe(true);
    expect(isHostedIntegrationTool(builtinTool)).toBe(false);
    expect(isHostedIntegrationTool(managedHelpTool)).toBe(false);
    expect(agentSettingsToolGroupLabel(hostedTool)).toBe(
      "Hosted Tools / Qualys",
    );
    expect(agentSettingsToolGroupLabel(managedHelpTool)).toBe(
      "hosted-integration-support",
    );
    expect(agentSettingsToolGroupLabel(mcpTool)).toBe("mcp-github");

    expect(
      groupAgentSettingsTools([
        hostedTool,
        builtinTool,
        mcpTool,
        managedHelpTool,
      ]),
    ).toEqual([
      ["filesystem", [builtinTool]],
      ["Hosted Tools / Qualys", [hostedTool]],
      ["hosted-integration-support", [managedHelpTool]],
      ["mcp-github", [mcpTool]],
    ]);
  });

  it("keeps hosted management tools out of the normal agent catalog", () => {
    expect(
      agentSettingsCatalogTools([
        hostedTool,
        managedHelpTool,
        hostedManagementTool,
        builtinTool,
      ]),
    ).toEqual([hostedTool, managedHelpTool, builtinTool]);

    expect(
      groupAgentSettingsTools(
        agentSettingsCatalogTools([
          hostedTool,
          managedHelpTool,
          hostedManagementTool,
        ]),
      ),
    ).toEqual([
      ["Hosted Tools / Qualys", [hostedTool]],
      ["hosted-integration-support", [managedHelpTool]],
    ]);
  });

  it("returns only sanitized family scopes for a hosted tool", () => {
    expect(hostedIntegrationEnvironmentConfigsForTool(hostedTool, environmentConfigs)).toEqual(
      environmentConfigs,
    );
    expect(hostedIntegrationEnvironmentConfigsForTool(builtinTool, environmentConfigs)).toEqual([]);
    expect(JSON.stringify(environmentConfigs)).not.toContain("secret-value");
  });

  it("builds one agent binding for the selected default environment", () => {
    const binding = buildAgentSettingsHostedIntegrationBinding({
      tool: hostedTool,
      environmentConfigs: environmentConfigs,
      defaultEnvironment: "test_debug",
      now: "2026-08-14T10:00:00.000Z",
      updatedBy: "human:alen",
    });

    expect(binding).toEqual({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      allowedEnvironments: ["prod", "test_debug"],
      defaultEnvironment: "test_debug",
      generationPin: { type: "current" },
      bindingKind: "agent",
      updatedAt: "2026-08-14T10:00:00.000Z",
      updatedBy: "human:alen",
    });
  });

  it("prunes stale hosted bindings when a hosted tool is no longer selected", () => {
    const bindings: AgentHostedIntegrationBinding[] = [
      {
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedEnvironments: ["prod"],
        defaultEnvironment: "prod",
        generationPin: { type: "current" },
        bindingKind: "agent",
        updatedAt: "2026-08-14T10:00:00.000Z",
        updatedBy: "human:alen",
      },
      {
        familyId: "qualys",
        toolName: "qualys_unused",
        allowedEnvironments: ["prod"],
        defaultEnvironment: "prod",
        generationPin: { type: "current" },
        bindingKind: "agent",
        updatedAt: "2026-08-14T10:00:00.000Z",
        updatedBy: "human:alen",
      },
    ];

    expect(
      selectedHostedIntegrationBindings(
        bindings,
        ["read_file", "managed_qualys__qualys_count_assets"],
        [builtinTool, hostedTool],
      ),
    ).toEqual([bindings[0]]);
  });
});
