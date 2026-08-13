import { describe, expect, it } from "vitest";
import {
  agentSettingsToolGroupLabel,
  buildAgentSettingsHostedIntegrationBinding,
  groupAgentSettingsTools,
  hostedIntegrationScopesForTool,
  isHostedIntegrationTool,
  selectedHostedIntegrationBindings,
  type AgentHostedIntegrationBinding,
  type HostedIntegrationConfigScope,
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

const scopes: HostedIntegrationConfigScope[] = [
  {
    id: "qualys-prod-readonly",
    familyId: "qualys",
    revision: 1,
    environment: "prod",
    config: { QUALYS_BASE_URL: "https://qualys.example" },
    secrets: { QUALYS_TOKEN: { configured: true } },
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedBy: "human:alen",
  },
  {
    id: "qualys-prod-secondary",
    familyId: "qualys",
    revision: 2,
    environment: "prod",
    config: { QUALYS_BASE_URL: "https://qualys-secondary.example" },
    secrets: {},
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedBy: "human:alen",
  },
  {
    id: "qualys-stage",
    familyId: "qualys",
    revision: 1,
    environment: "stage",
    config: { QUALYS_BASE_URL: "https://qualys-stage.example" },
    secrets: {},
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedBy: "human:alen",
  },
];

describe("hosted integration agent settings helpers", () => {
  it("classifies and groups hosted tools separately from built-in and MCP tools", () => {
    expect(isHostedIntegrationTool(hostedTool)).toBe(true);
    expect(isHostedIntegrationTool(builtinTool)).toBe(false);
    expect(agentSettingsToolGroupLabel(hostedTool)).toBe(
      "Hosted Integrations / Qualys",
    );
    expect(agentSettingsToolGroupLabel(mcpTool)).toBe("mcp-github");

    expect(groupAgentSettingsTools([hostedTool, builtinTool, mcpTool])).toEqual([
      ["filesystem", [builtinTool]],
      ["Hosted Integrations / Qualys", [hostedTool]],
      ["mcp-github", [mcpTool]],
    ]);
  });

  it("returns only sanitized family scopes for a hosted tool", () => {
    expect(hostedIntegrationScopesForTool(hostedTool, scopes)).toEqual(scopes);
    expect(hostedIntegrationScopesForTool(builtinTool, scopes)).toEqual([]);
    expect(JSON.stringify(scopes)).not.toContain("secret-value");
  });

  it("builds one agent binding for the selected environment and default scope", () => {
    const binding = buildAgentSettingsHostedIntegrationBinding({
      tool: hostedTool,
      configScopes: scopes,
      defaultConfigScopeId: "qualys-prod-secondary",
    });

    expect(binding).toEqual({
      familyId: "qualys",
      toolName: "qualys_count_assets",
      environment: "prod",
      defaultConfigScopeId: "qualys-prod-secondary",
      allowedConfigScopeIds: ["qualys-prod-readonly", "qualys-prod-secondary"],
    });
  });

  it("prunes stale hosted bindings when a hosted tool is no longer selected", () => {
    const bindings: AgentHostedIntegrationBinding[] = [
      {
        familyId: "qualys",
        toolName: "qualys_count_assets",
        environment: "prod",
        defaultConfigScopeId: "qualys-prod-readonly",
        allowedConfigScopeIds: ["qualys-prod-readonly"],
      },
      {
        familyId: "qualys",
        toolName: "qualys_unused",
        environment: "prod",
        defaultConfigScopeId: "qualys-prod-readonly",
        allowedConfigScopeIds: ["qualys-prod-readonly"],
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
