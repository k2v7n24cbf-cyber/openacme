import type { ToolInfo } from "./types";

export interface AgentHostedIntegrationBinding {
  familyId: string;
  toolName: string;
  allowedConfigScopeIds: string[];
  defaultConfigScopeId?: string;
  environment: string;
}

export interface HostedIntegrationConfigScope {
  id: string;
  familyId: string;
  revision: number;
  environment: string;
  config: Record<string, unknown>;
  secrets: Record<string, { configured: boolean }>;
  updatedAt: string;
  updatedBy: string;
}

export function isHostedIntegrationTool(tool: ToolInfo): boolean {
  return tool.source?.kind === "hosted_integration";
}

export function agentSettingsToolGroupLabel(tool: ToolInfo): string {
  if (isHostedIntegrationTool(tool)) {
    return `Hosted Integrations / ${tool.source?.familyName ?? tool.toolset}`;
  }
  return tool.toolset;
}

export function groupAgentSettingsTools(
  tools: ToolInfo[],
): [string, ToolInfo[]][] {
  const map = new Map<string, ToolInfo[]>();
  for (const tool of tools) {
    if (tool.system) continue;
    const label = agentSettingsToolGroupLabel(tool);
    const list = map.get(label) ?? [];
    list.push(tool);
    map.set(label, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function hostedIntegrationScopesForTool(
  tool: ToolInfo,
  configScopes: HostedIntegrationConfigScope[],
): HostedIntegrationConfigScope[] {
  const familyId = tool.source?.familyId;
  if (!familyId) return [];
  return configScopes
    .filter((scope) => scope.familyId === familyId)
    .sort((a, b) =>
      a.environment === b.environment
        ? a.id.localeCompare(b.id)
        : a.environment.localeCompare(b.environment),
    );
}

export function buildAgentSettingsHostedIntegrationBinding(input: {
  tool: ToolInfo;
  configScopes: HostedIntegrationConfigScope[];
  defaultConfigScopeId?: string;
}): AgentHostedIntegrationBinding | null {
  const familyId = input.tool.source?.familyId;
  if (!familyId) return null;
  const scopes = hostedIntegrationScopesForTool(input.tool, input.configScopes);
  const defaultScope =
    scopes.find((scope) => scope.id === input.defaultConfigScopeId) ??
    scopes[0];
  if (!defaultScope) return null;
  const allowedConfigScopeIds = scopes
    .filter((scope) => scope.environment === defaultScope.environment)
    .map((scope) => scope.id);
  return {
    familyId,
    toolName: input.tool.name,
    allowedConfigScopeIds,
    defaultConfigScopeId: defaultScope.id,
    environment: defaultScope.environment,
  };
}

export function upsertHostedIntegrationBinding(
  bindings: AgentHostedIntegrationBinding[],
  next: AgentHostedIntegrationBinding,
): AgentHostedIntegrationBinding[] {
  return [
    ...bindings.filter(
      (binding) =>
        binding.familyId !== next.familyId || binding.toolName !== next.toolName,
    ),
    next,
  ].sort((a, b) =>
    a.familyId === b.familyId
      ? a.toolName.localeCompare(b.toolName)
      : a.familyId.localeCompare(b.familyId),
  );
}

export function removeHostedIntegrationBinding(
  bindings: AgentHostedIntegrationBinding[],
  tool: ToolInfo,
): AgentHostedIntegrationBinding[] {
  const familyId = tool.source?.familyId;
  if (!familyId) return bindings;
  return bindings.filter(
    (binding) =>
      binding.familyId !== familyId || binding.toolName !== tool.name,
  );
}

export function selectedHostedIntegrationBindings(
  bindings: AgentHostedIntegrationBinding[],
  selectedTools: string[],
  tools: ToolInfo[],
): AgentHostedIntegrationBinding[] {
  const selected = new Set(selectedTools);
  const hostedToolKeys = new Set(
    tools
      .filter((tool) => selected.has(tool.name) && isHostedIntegrationTool(tool))
      .map((tool) => `${tool.source?.familyId}:${tool.name}`),
  );
  return bindings.filter((binding) =>
    hostedToolKeys.has(`${binding.familyId}:${binding.toolName}`),
  );
}

export function sameHostedIntegrationBindings(
  a: AgentHostedIntegrationBinding[] = [],
  b: AgentHostedIntegrationBinding[] = [],
): boolean {
  return JSON.stringify(normalizeBindings(a)) === JSON.stringify(normalizeBindings(b));
}

function normalizeBindings(
  bindings: AgentHostedIntegrationBinding[],
): AgentHostedIntegrationBinding[] {
  return bindings
    .map((binding) => ({
      ...binding,
      allowedConfigScopeIds: [...binding.allowedConfigScopeIds].sort(),
    }))
    .sort((a, b) =>
      a.familyId === b.familyId
        ? a.toolName.localeCompare(b.toolName)
        : a.familyId.localeCompare(b.familyId),
    );
}
