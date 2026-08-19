import type { ToolInfo } from "./types";

const HOSTED_INTEGRATION_MANAGEMENT_TOOLSET = "hosted-integration-management";

export interface AgentHostedIntegrationBinding {
  familyId: string;
  toolName: string;
  allowedEnvironments: Array<"prod" | "test_debug">;
  defaultEnvironment: "prod" | "test_debug";
  generationPin:
    | { type: "current" }
    | { type: "generation"; generationId: string };
  bindingKind: "agent" | "internal";
  purpose?: string;
  bindingNote?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface HostedIntegrationEnvironmentConfig {
  id: string;
  familyId: string;
  revision: number;
  environment: "prod" | "test_debug";
  config: Record<string, unknown>;
  secrets: Record<string, { configured: boolean }>;
  updatedAt: string;
  updatedBy: string;
}

export interface HostedIntegrationFamilyAccessRow {
  familyId: string;
  familyName: string;
  tools: ToolInfo[];
  toolNames: string[];
  requiresEnvironmentConfig: boolean;
  environmentConfigs: HostedIntegrationEnvironmentConfig[];
  allowedEnvironments: Array<"prod" | "test_debug">;
  defaultEnvironment: "prod" | "test_debug" | null;
  mixedDefaultEnvironments: boolean;
}

export function isHostedIntegrationTool(tool: ToolInfo): boolean {
  return tool.source?.kind === "hosted_integration";
}

export function isHostedIntegrationManagementTool(tool: ToolInfo): boolean {
  return tool.toolset === HOSTED_INTEGRATION_MANAGEMENT_TOOLSET;
}

export function agentSettingsCatalogTools(tools: ToolInfo[]): ToolInfo[] {
  return tools.filter((tool) => !isHostedIntegrationManagementTool(tool));
}

export function hostedIntegrationNativeToolName(tool: ToolInfo): string | null {
  return tool.source?.kind === "hosted_integration"
    ? tool.source.toolName
    : null;
}

export function agentSettingsToolGroupLabel(tool: ToolInfo): string {
  if (isHostedIntegrationTool(tool)) {
    return `Hosted Tools / ${tool.source?.familyName ?? tool.toolset}`;
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

export function hostedIntegrationEnvironmentConfigsForTool(
  tool: ToolInfo,
  environmentConfigs: HostedIntegrationEnvironmentConfig[],
): HostedIntegrationEnvironmentConfig[] {
  const familyId = tool.source?.familyId;
  if (!familyId) return [];
  return environmentConfigs
    .filter((scope) => scope.familyId === familyId)
    .sort((a, b) =>
      a.environment === b.environment
        ? a.id.localeCompare(b.id)
        : a.environment.localeCompare(b.environment),
    );
}

export function buildAgentSettingsHostedIntegrationBinding(input: {
  tool: ToolInfo;
  environmentConfigs: HostedIntegrationEnvironmentConfig[];
  defaultEnvironment?: "prod" | "test_debug";
  now?: string;
  updatedBy?: string;
}): AgentHostedIntegrationBinding | null {
  const familyId = input.tool.source?.familyId;
  const toolName = hostedIntegrationNativeToolName(input.tool);
  if (!familyId || !toolName) return null;
  const scopes = hostedIntegrationEnvironmentConfigsForTool(
    input.tool,
    input.environmentConfigs,
  );
  const configRequired = hostedIntegrationToolRequiresEnvironmentConfig(
    input.tool,
  );
  const allowedEnvironments: Array<"prod" | "test_debug"> = (
    configRequired
      ? [...new Set(scopes.map((scope) => scope.environment))]
      : (["prod", "test_debug"] as Array<"prod" | "test_debug">)
  ).sort();
  const defaultEnvironment =
    input.defaultEnvironment &&
    allowedEnvironments.includes(input.defaultEnvironment)
      ? input.defaultEnvironment
      : allowedEnvironments[0];
  if (!defaultEnvironment) return null;
  return {
    familyId,
    toolName,
    allowedEnvironments,
    defaultEnvironment,
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: input.now ?? new Date().toISOString(),
    updatedBy: input.updatedBy ?? "human:web",
  };
}

export function selectedHostedIntegrationFamilyAccessRows(input: {
  tools: ToolInfo[];
  selectedTools: string[];
  bindings: AgentHostedIntegrationBinding[];
  environmentConfigs: HostedIntegrationEnvironmentConfig[];
}): HostedIntegrationFamilyAccessRow[] {
  const selected = new Set(input.selectedTools);
  const groups = new Map<string, ToolInfo[]>();
  for (const tool of input.tools) {
    const familyId = tool.source?.familyId;
    if (
      !familyId ||
      !selected.has(tool.name) ||
      !isHostedIntegrationTool(tool)
    ) {
      continue;
    }
    const list = groups.get(familyId) ?? [];
    list.push(tool);
    groups.set(familyId, list);
  }

  return [...groups.entries()]
    .map(([familyId, tools]) => {
      const requiresEnvironmentConfig = tools.some((tool) =>
        hostedIntegrationToolRequiresEnvironmentConfig(tool),
      );
      const scopes = input.environmentConfigs
        .filter((scope) => scope.familyId === familyId)
        .sort((a, b) =>
          a.environment === b.environment
            ? a.id.localeCompare(b.id)
            : a.environment.localeCompare(b.environment),
        );
      const allowedEnvironments = (
        requiresEnvironmentConfig
          ? [...new Set(scopes.map((scope) => scope.environment))]
          : (["prod", "test_debug"] as Array<"prod" | "test_debug">)
      ).sort();
      const selectedNativeToolNames = new Set(
        tools
          .map((tool) => hostedIntegrationNativeToolName(tool))
          .filter((toolName): toolName is string => Boolean(toolName)),
      );
      const defaults = [
        ...new Set(
          input.bindings
            .filter(
              (binding) =>
                binding.familyId === familyId &&
                selectedNativeToolNames.has(binding.toolName),
            )
            .map((binding) => binding.defaultEnvironment)
            .filter((environment) => allowedEnvironments.includes(environment)),
        ),
      ].sort();
      return {
        familyId,
        familyName: tools[0]?.source?.familyName ?? familyId,
        tools,
        toolNames: tools.map((tool) => tool.name).sort(),
        requiresEnvironmentConfig,
        environmentConfigs: scopes,
        allowedEnvironments,
        defaultEnvironment: defaults[0] ?? allowedEnvironments[0] ?? null,
        mixedDefaultEnvironments: defaults.length > 1,
      };
    })
    .sort((a, b) => a.familyName.localeCompare(b.familyName));
}

export function preferredHostedIntegrationFamilyEnvironment(input: {
  bindings: AgentHostedIntegrationBinding[];
  familyId: string;
  allowedEnvironments: Array<"prod" | "test_debug">;
}): "prod" | "test_debug" | undefined {
  const existing = input.bindings.find(
    (binding) =>
      binding.familyId === input.familyId &&
      input.allowedEnvironments.includes(binding.defaultEnvironment),
  )?.defaultEnvironment;
  return existing ?? input.allowedEnvironments[0];
}

export function updateHostedIntegrationFamilyDefaultEnvironment(input: {
  bindings: AgentHostedIntegrationBinding[];
  tools: ToolInfo[];
  selectedTools: string[];
  familyId: string;
  environment: "prod" | "test_debug";
  environmentConfigs: HostedIntegrationEnvironmentConfig[];
}): AgentHostedIntegrationBinding[] {
  const selected = new Set(input.selectedTools);
  return input.tools
    .filter(
      (tool) =>
        selected.has(tool.name) &&
        isHostedIntegrationTool(tool) &&
        tool.source?.familyId === input.familyId,
    )
    .reduce((bindings, tool) => {
      const binding = buildAgentSettingsHostedIntegrationBinding({
        tool,
        environmentConfigs: input.environmentConfigs,
        defaultEnvironment: input.environment,
      });
      return binding
        ? upsertHostedIntegrationBinding(bindings, binding)
        : bindings;
    }, input.bindings);
}

export function hostedIntegrationToolRequiresEnvironmentConfig(
  tool: ToolInfo,
): boolean {
  if (!isHostedIntegrationTool(tool)) return false;
  const runtimeConfig = tool.source?.runtimeConfig;
  if (!runtimeConfig) return true;
  return (
    (runtimeConfig.requiredConfigKeys?.length ?? 0) > 0 ||
    (runtimeConfig.requiredSecretKeys?.length ?? 0) > 0
  );
}

export function upsertHostedIntegrationBinding(
  bindings: AgentHostedIntegrationBinding[],
  next: AgentHostedIntegrationBinding,
): AgentHostedIntegrationBinding[] {
  return [
    ...bindings.filter(
      (binding) =>
        binding.familyId !== next.familyId ||
        binding.toolName !== next.toolName,
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
  const toolName = hostedIntegrationNativeToolName(tool);
  if (!familyId || !toolName) return bindings;
  return bindings.filter(
    (binding) => binding.familyId !== familyId || binding.toolName !== toolName,
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
      .filter(
        (tool) => selected.has(tool.name) && isHostedIntegrationTool(tool),
      )
      .map(
        (tool) =>
          `${tool.source?.familyId}:${hostedIntegrationNativeToolName(tool)}`,
      ),
  );
  return bindings.filter((binding) =>
    hostedToolKeys.has(`${binding.familyId}:${binding.toolName}`),
  );
}

export function sameHostedIntegrationBindings(
  a: AgentHostedIntegrationBinding[] = [],
  b: AgentHostedIntegrationBinding[] = [],
): boolean {
  return (
    JSON.stringify(normalizeBindings(a)) ===
    JSON.stringify(normalizeBindings(b))
  );
}

function normalizeBindings(
  bindings: AgentHostedIntegrationBinding[],
): AgentHostedIntegrationBinding[] {
  return bindings
    .map((binding) => ({
      ...binding,
      allowedEnvironments: [...binding.allowedEnvironments].sort(),
    }))
    .sort((a, b) =>
      a.familyId === b.familyId
        ? a.toolName.localeCompare(b.toolName)
        : a.familyId.localeCompare(b.familyId),
    );
}
