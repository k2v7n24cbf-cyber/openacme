import { describe, expect, it } from "vitest";
import {
  agentSettingsCatalogTools,
  agentSettingsToolGroupLabel,
  buildAgentSettingsHostedIntegrationBinding,
  groupAgentSettingsTools,
  hostedIntegrationEnvironmentConfigsForTool,
  hostedIntegrationToolRequiresEnvironmentConfig,
  isHostedIntegrationTool,
  preferredHostedIntegrationFamilyEnvironment,
  selectedHostedIntegrationFamilyAccessRows,
  selectedHostedIntegrationBindings,
  updateHostedIntegrationFamilyDefaultEnvironment,
  type AgentHostedIntegrationBinding,
  type HostedIntegrationEnvironmentConfig,
} from "@/app/lib/hosted-integration-agent-settings";
import type { ToolInfo } from "@/app/lib/types";

const hostedTool: ToolInfo = {
  name: "hosted_qualys__qualys_count_assets",
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

const hostedSearchTool: ToolInfo = {
  name: "hosted_qualys__qualys_search_assets",
  description: "Search assets.",
  toolset: "hosted-integrations",
  source: {
    kind: "hosted_integration",
    familyId: "qualys",
    familyName: "Qualys",
    toolName: "qualys_search_assets",
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

const hostedHelpTool: ToolInfo = {
  name: "hosted_tool_help",
  description: "Get hosted tool help.",
  toolset: "hosted-integration-support",
};

const hostedManagementTool: ToolInfo = {
  name: "hosted_tool_promote",
  description: "Promote a validated hosted integration draft.",
  toolset: "hosted-integration-management",
};

const configlessHostedTool: ToolInfo = {
  name: "hosted_math-magic__get_random_number",
  description: "Return a random number.",
  toolset: "hosted-integrations",
  source: {
    kind: "hosted_integration",
    familyId: "math-magic",
    familyName: "math_magic",
    toolName: "get_random_number",
    generationId: "gen_math",
    runtimeConfig: {
      requiredConfigKeys: [],
      requiredSecretKeys: [],
    },
  },
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
    expect(isHostedIntegrationTool(hostedHelpTool)).toBe(false);
    expect(agentSettingsToolGroupLabel(hostedTool)).toBe(
      "Hosted Tools / Qualys",
    );
    expect(agentSettingsToolGroupLabel(hostedHelpTool)).toBe(
      "hosted-integration-support",
    );
    expect(agentSettingsToolGroupLabel(mcpTool)).toBe("mcp-github");

    expect(
      groupAgentSettingsTools([
        hostedTool,
        builtinTool,
        mcpTool,
        hostedHelpTool,
      ]),
    ).toEqual([
      ["filesystem", [builtinTool]],
      ["Hosted Tools / Qualys", [hostedTool]],
      ["hosted-integration-support", [hostedHelpTool]],
      ["mcp-github", [mcpTool]],
    ]);
  });

  it("keeps hosted management tools out of the normal agent catalog", () => {
    expect(
      agentSettingsCatalogTools([
        hostedTool,
        hostedHelpTool,
        hostedManagementTool,
        builtinTool,
      ]),
    ).toEqual([hostedTool, hostedHelpTool, builtinTool]);

    expect(
      groupAgentSettingsTools(
        agentSettingsCatalogTools([
          hostedTool,
          hostedHelpTool,
          hostedManagementTool,
        ]),
      ),
    ).toEqual([
      ["Hosted Tools / Qualys", [hostedTool]],
      ["hosted-integration-support", [hostedHelpTool]],
    ]);
  });

  it("returns only sanitized family scopes for a hosted tool", () => {
    expect(
      hostedIntegrationEnvironmentConfigsForTool(
        hostedTool,
        environmentConfigs,
      ),
    ).toEqual(environmentConfigs);
    expect(
      hostedIntegrationEnvironmentConfigsForTool(
        builtinTool,
        environmentConfigs,
      ),
    ).toEqual([]);
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

  it("builds agent bindings for configless hosted tools without environment configs", () => {
    expect(
      hostedIntegrationToolRequiresEnvironmentConfig(configlessHostedTool),
    ).toBe(false);
    expect(
      hostedIntegrationEnvironmentConfigsForTool(configlessHostedTool, []),
    ).toEqual([]);

    const binding = buildAgentSettingsHostedIntegrationBinding({
      tool: configlessHostedTool,
      environmentConfigs: [],
      defaultEnvironment: "test_debug",
      now: "2026-08-14T10:00:00.000Z",
      updatedBy: "human:alen",
    });

    expect(binding).toEqual({
      familyId: "math-magic",
      toolName: "get_random_number",
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
        ["read_file", "hosted_qualys__qualys_count_assets"],
        [builtinTool, hostedTool],
      ),
    ).toEqual([bindings[0]]);
  });

  it("groups selected hosted tools by family for environment selection", () => {
    const rows = selectedHostedIntegrationFamilyAccessRows({
      tools: [hostedTool, hostedSearchTool, configlessHostedTool],
      selectedTools: [
        "hosted_qualys__qualys_count_assets",
        "hosted_qualys__qualys_search_assets",
        "hosted_math-magic__get_random_number",
      ],
      bindings: [
        {
          familyId: "qualys",
          toolName: "qualys_count_assets",
          allowedEnvironments: ["prod", "test_debug"],
          defaultEnvironment: "prod",
          generationPin: { type: "current" },
          bindingKind: "agent",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:alen",
        },
        {
          familyId: "qualys",
          toolName: "qualys_search_assets",
          allowedEnvironments: ["prod", "test_debug"],
          defaultEnvironment: "test_debug",
          generationPin: { type: "current" },
          bindingKind: "agent",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:alen",
        },
      ],
      environmentConfigs,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        familyId: "math-magic",
        requiresEnvironmentConfig: false,
        toolNames: ["hosted_math-magic__get_random_number"],
        mixedDefaultEnvironments: false,
      }),
      expect.objectContaining({
        familyId: "qualys",
        requiresEnvironmentConfig: true,
        toolNames: [
          "hosted_qualys__qualys_count_assets",
          "hosted_qualys__qualys_search_assets",
        ],
        allowedEnvironments: ["prod", "test_debug"],
        defaultEnvironment: "prod",
        mixedDefaultEnvironments: true,
      }),
    ]);
  });

  it("updates every selected hosted tool binding when a family environment changes", () => {
    const bindings: AgentHostedIntegrationBinding[] = [
      {
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedEnvironments: ["prod", "test_debug"],
        defaultEnvironment: "prod",
        generationPin: { type: "current" },
        bindingKind: "agent",
        updatedAt: "2026-08-14T10:00:00.000Z",
        updatedBy: "human:alen",
      },
    ];

    expect(
      updateHostedIntegrationFamilyDefaultEnvironment({
        bindings,
        tools: [hostedTool, hostedSearchTool],
        selectedTools: [
          "hosted_qualys__qualys_count_assets",
          "hosted_qualys__qualys_search_assets",
        ],
        familyId: "qualys",
        environment: "test_debug",
        environmentConfigs,
      }),
    ).toEqual([
      expect.objectContaining({
        familyId: "qualys",
        toolName: "qualys_count_assets",
        defaultEnvironment: "test_debug",
      }),
      expect.objectContaining({
        familyId: "qualys",
        toolName: "qualys_search_assets",
        defaultEnvironment: "test_debug",
      }),
    ]);
  });

  it("prefers the existing family environment when another tool is added", () => {
    expect(
      preferredHostedIntegrationFamilyEnvironment({
        familyId: "qualys",
        allowedEnvironments: ["prod", "test_debug"],
        bindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["prod", "test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:alen",
          },
        ],
      }),
    ).toBe("test_debug");
  });
});
