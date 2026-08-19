import type { HostedIntegrationEnvironmentConfig } from "./hosted-integration-agent-settings";
import { parse as parseYaml } from "yaml";

export interface HostedIntegrationFamilySummary {
  id: string;
  name: string;
  version: number;
  toolNames: string[];
  status: "active" | "proposed";
}

export interface HostedIntegrationToolSpec {
  name: string;
  title: string;
  description: string;
  lifecycle: "active" | "deprecated" | "hidden" | "disabled" | "removed";
  inputSchema?: Record<string, unknown>;
  help?: {
    summary?: string;
    full?: string;
    whenToUse?: string[];
    whenNotToUse?: string[];
    parameters?: Record<string, unknown>;
    examples?: unknown[];
    noExampleJustification?: string;
  };
  classification: {
    operation: "read" | "write" | "destructive";
    freshness: "live" | "cached" | "sync";
    idempotency: "idempotent" | "non_idempotent";
    execution: "sync" | "async";
    approval: "none" | "confirm" | "human";
  };
}

export interface HostedIntegrationRuntimeConfigContract {
  requiredConfigKeys?: string[];
  requiredSecretKeys?: string[];
}

export type HostedIntegrationAgentBindingGenerationPin =
  | { type: "current" }
  | { type: "generation"; generationId: string };

export interface HostedIntegrationAgentBindingMatrixRowInput {
  agentId: string;
  agentName: string;
  hostedToolName: string;
  familyId: string;
  toolName: string;
  bindingKind: "agent" | "internal";
  allowedEnvironments: Array<"prod" | "test_debug">;
  defaultEnvironment: "prod" | "test_debug";
  generationPin: HostedIntegrationAgentBindingGenerationPin;
  purpose?: string;
  bindingNote?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface HostedIntegrationAgentBindingMatrixRow extends HostedIntegrationAgentBindingMatrixRowInput {
  generationLabel: string;
  noteLabel: string;
}

export interface HostedIntegrationAgentBindingMatrixGroup {
  kind: "agent" | "internal";
  label: "Agents" | "Internal";
  rows: HostedIntegrationAgentBindingMatrixRow[];
}

export interface HostedIntegrationAgentBindingMatrix {
  familyId: string;
  toolName: string;
  hostedToolName: string;
  totalCount: number;
  agentCount: number;
  internalCount: number;
  groups: HostedIntegrationAgentBindingMatrixGroup[];
}

export interface HostedIntegrationFamilyDetail {
  summary: HostedIntegrationFamilySummary;
  manifest: {
    id: string;
    name: string;
    version: number;
    runtime?: {
      entrypoint?: string;
    };
    runtimeConfig?: HostedIntegrationRuntimeConfigContract;
  };
  tools: HostedIntegrationToolSpec[];
}

export function buildHostedIntegrationAgentBindingMatrix(input: {
  familyId: string;
  toolName: string;
  hostedToolName: string;
  bindings: HostedIntegrationAgentBindingMatrixRowInput[];
}): HostedIntegrationAgentBindingMatrix {
  const rows = input.bindings
    .filter(
      (binding) =>
        binding.familyId === input.familyId &&
        binding.toolName === input.toolName &&
        binding.hostedToolName === input.hostedToolName,
    )
    .map((binding) => ({
      ...binding,
      generationLabel:
        binding.generationPin.type === "current"
          ? "Current generation"
          : `Pinned to ${binding.generationPin.generationId}`,
      noteLabel: binding.bindingNote ?? binding.purpose ?? "",
    }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName));
  const agentRows = rows.filter((row) => row.bindingKind === "agent");
  const internalRows = rows.filter((row) => row.bindingKind === "internal");
  return {
    familyId: input.familyId,
    toolName: input.toolName,
    hostedToolName: input.hostedToolName,
    totalCount: rows.length,
    agentCount: agentRows.length,
    internalCount: internalRows.length,
    groups: [
      { kind: "agent", label: "Agents", rows: agentRows },
      { kind: "internal", label: "Internal", rows: internalRows },
    ],
  };
}

export interface HostedIntegrationGenerationSummary {
  id: string;
  familyId: string;
  sourceRevisionId: string;
  status: "active" | "superseded" | "draining" | "retired" | "disabled";
  promotedAt: string;
  promotedBy: string;
}

export interface HostedIntegrationFailureBucket {
  id: string;
  familyId: string;
  toolName: string;
  generationId: string;
  fingerprint?: string;
  status: "open" | "closed";
  count: number;
  firstSeenAt?: string;
  latestSeenAt: string;
  assignedTo?: string;
}

export interface HostedIntegrationExecutionLogEntry {
  runId: string;
  familyId: string;
  toolName: string;
  generationId: string;
  actorId: string;
  environmentConfigId: string | null;
  configRevision: number | null;
  executionPurpose?: string;
  sanitizedArgs: Record<string, unknown>;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  resultEnvelopeRef?: string;
  resultMetadata?: {
    envelopeRef: string;
    responseMode: "inline" | "artifact";
    artifact?: {
      name: string;
      sizeBytes: number;
      estimatedTokens: number;
    };
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HostedIntegrationExecutionLogRow {
  run: HostedIntegrationExecutionLogEntry;
  versionRelation: "current version" | "previous version";
  completedAt: string;
  durationLabel: string;
  resultLabel: string;
  artifactName: string | null;
  errorCode: string | null;
}

export type HostedIntegrationExecutionLogScope = "selected_tool" | "family";

export interface HostedIntegrationExecutionLogActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"execution_logs"> | null;
  canRefreshLogs: boolean;
}

export interface HostedIntegrationArtifactActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"run_artifact"> | null;
  canLoadArtifact: boolean;
}

export function hostedIntegrationExecutionLogPrimaryHeader(
  scope: HostedIntegrationExecutionLogScope,
): "Version" | "Tool" {
  return scope === "selected_tool" ? "Version" : "Tool";
}

export function hostedIntegrationExecutionLogRowAccessibleLabel(input: {
  row: HostedIntegrationExecutionLogRow;
  primaryLabel: string;
  completedLabel: string;
}): string {
  return [
    "Execution log",
    input.primaryLabel,
    hostedIntegrationExecutionConfigLabel(input.row.run),
    input.completedLabel,
    input.row.run.status,
    input.row.errorCode ?? input.row.resultLabel,
    input.row.durationLabel,
  ].join(", ");
}

export function hostedIntegrationExecutionConfigLabel(
  run: Pick<
    HostedIntegrationExecutionLogEntry,
    "environmentConfigId" | "executionPurpose"
  >,
): string {
  return (
    run.environmentConfigId ?? `config-free ${run.executionPurpose ?? "run"}`
  );
}

export function hostedIntegrationExecutionConfigRevisionLabel(
  run: Pick<
    HostedIntegrationExecutionLogEntry,
    "configRevision" | "executionPurpose"
  >,
): string {
  return run.configRevision === null
    ? `Config-free ${run.executionPurpose ?? "run"}`
    : String(run.configRevision);
}

export function hostedIntegrationExecutionLogDetailAccessibleLabels(input: {
  runId: string | null | undefined;
  artifactName?: string | null | undefined;
}): {
  sanitizedArguments: string;
  error: string;
  artifact: string;
  loadArtifact: string;
} {
  const runTarget = input.runId?.trim() || "selected run";
  const artifactTarget = input.artifactName?.trim() || "selected artifact";
  return {
    sanitizedArguments: `Sanitized arguments for run ${runTarget}`,
    error: `Error for run ${runTarget}`,
    artifact: `Artifact ${artifactTarget} for run ${runTarget}`,
    loadArtifact: `Load artifact ${artifactTarget} for run ${runTarget}`,
  };
}

export function buildHostedIntegrationExecutionLogActionState(input: {
  scope: HostedIntegrationExecutionLogScope;
  selectedToolName: string | null | undefined;
  familyId: string | null | undefined;
  canManage: boolean;
}): HostedIntegrationExecutionLogActionState {
  const id =
    input.scope === "family"
      ? input.familyId?.trim()
      : input.selectedToolName?.trim();
  const target =
    input.canManage && id
      ? {
          kind: "execution_logs" as const,
          id: `${input.scope}:${id}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    target,
    canRefreshLogs: Boolean(target),
  };
}

export function buildHostedIntegrationArtifactActionState(input: {
  runId: string | null | undefined;
  artifactName: string | null | undefined;
  canManage: boolean;
}): HostedIntegrationArtifactActionState {
  const runId = input.runId?.trim();
  const artifactName = input.artifactName?.trim();
  const target =
    input.canManage && runId && artifactName
      ? {
          kind: "run_artifact" as const,
          id: `${runId}/${artifactName}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    target,
    canLoadArtifact: Boolean(target),
  };
}

export interface HostedIntegrationVersionRow {
  generation: HostedIntegrationGenerationSummary;
  relation: "current version" | "previous version";
  stateLabel: "active" | "retired" | "previous";
  canRollback: boolean;
}

export interface HostedIntegrationVersionActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"previous_version"> | null;
  hasSelectedTarget: boolean;
  canCompare: boolean;
  canRollback: boolean;
}

export interface HostedIntegrationLifecycleTargetDescriptor<
  Kind extends string = string,
> {
  kind: Kind;
  id: string;
  ownedByCurrentHuman: boolean;
  ready: boolean;
}

export function hostedIntegrationVersionRowAccessibleLabel(input: {
  row: HostedIntegrationVersionRow;
  promotedLabel: string;
}): string {
  return [
    input.row.relation,
    input.row.generation.promotedBy,
    input.row.stateLabel,
    input.promotedLabel,
  ].join(", ");
}

export function hostedIntegrationVersionActionAccessibleLabels(input: {
  selectedVersionRow: HostedIntegrationVersionRow | null;
  promotedLabel: string | null;
}): {
  compare: string;
  rollback: string;
  diff: string;
  rollbackResult: string;
} {
  const target = input.selectedVersionRow
    ? `${input.selectedVersionRow.relation} from ${
        input.promotedLabel ?? input.selectedVersionRow.generation.promotedAt
      }`
    : "selected previous version";
  return {
    compare: `Compare ${target}`,
    rollback: `Rollback to ${target}`,
    diff: `Version diff for ${target}`,
    rollbackResult: `Rollback result for ${target}`,
  };
}

export function hostedIntegrationVersionEmptyStateText(input: {
  state: "no_selected_previous_version" | "no_versions";
  familyName: string | null | undefined;
}): string {
  const familyTarget = input.familyName?.trim() || "selected family";
  return input.state === "no_selected_previous_version"
    ? `No previous version selected for ${familyTarget}.`
    : `No versions have been published for ${familyTarget} yet.`;
}

export function hostedIntegrationDraftFileActionAccessibleLabels(
  path: string,
): {
  save: string;
  delete: string;
} {
  const target = path.trim() || "selected file";
  return {
    save: `Save ${target}`,
    delete: `Delete ${target}`,
  };
}

export interface HostedIntegrationDraftFileActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"changed_file"> | null;
  canSaveFile: boolean;
  canDeleteFile: boolean;
}

export function buildHostedIntegrationDraftFileActionState(input: {
  canEdit: boolean;
  draftId: string | null | undefined;
  path: string | null | undefined;
}): HostedIntegrationDraftFileActionState {
  const draftId = input.draftId?.trim();
  const path = input.path?.trim();
  const target =
    input.canEdit && draftId && path
      ? {
          kind: "changed_file" as const,
          id: `${draftId}:${path}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    target,
    canSaveFile: Boolean(target),
    canDeleteFile: Boolean(target),
  };
}

export function hostedIntegrationFileModeAccessibleLabel(input: {
  mode: "current" | "changes";
  familyName: string | null | undefined;
}): string {
  const familyTarget = input.familyName?.trim() || "selected family";
  return input.mode === "current"
    ? `Show current files for ${familyTarget}`
    : `Show changed files for ${familyTarget}`;
}

export function hostedIntegrationFileEditorAccessibleLabel(input: {
  mode: "current" | "changes";
  path: string | null | undefined;
}): string {
  const pathTarget = input.path?.trim() || "selected file";
  return input.mode === "current"
    ? `Current source for ${pathTarget}`
    : `Changed source for ${pathTarget}`;
}

export function hostedIntegrationFileEmptyStateText(input: {
  state: "current_empty" | "changes_locked" | "changes_empty";
  familyName: string | null | undefined;
}): string {
  const familyTarget = input.familyName?.trim() || "selected family";
  if (input.state === "current_empty") {
    return `No current files found for ${familyTarget}.`;
  }
  if (input.state === "changes_locked") {
    return `Select Edit to update files for ${familyTarget}.`;
  }
  return `No changed files for ${familyTarget} yet.`;
}

export function hostedIntegrationExampleActionAccessibleLabels(
  exampleId: string | null | undefined,
): {
  save: string;
  run: string;
} {
  const target = exampleId?.trim() || "selected example";
  return {
    save: `Save example ${target}`,
    run: `Run test for example ${target}`,
  };
}

export function hostedIntegrationExampleSelectorAccessibleLabel(
  toolName: string | null | undefined,
): string {
  const target = toolName?.trim() || "selected tool";
  return `Select test example for ${target}`;
}

export function hostedIntegrationExamplePayloadAccessibleLabel(input: {
  exampleId: string | null | undefined;
  mode: "published" | "saved" | "new";
}): string {
  const target = input.exampleId?.trim() || "selected example";
  if (input.mode === "new") return `New example payload for ${target}`;
  if (input.mode === "published") {
    return `Published example payload for ${target}`;
  }
  return `Example payload for ${target}`;
}

export function hostedIntegrationExampleEmptyStateText(input: {
  mode: "published" | "saved";
  toolName: string | null | undefined;
}): string {
  const target = input.toolName?.trim() || "selected tool";
  return input.mode === "saved"
    ? `No saved examples for ${target}.`
    : `No published examples for ${target}.`;
}

export function hostedIntegrationExampleResultAccessibleLabel(
  exampleId: string | null | undefined,
): string {
  const target = exampleId?.trim() || "selected example";
  return `Test result for example ${target}`;
}

export function hostedIntegrationDebugActionAccessibleLabel(input: {
  toolName: string | null | undefined;
  environmentConfigId: string | null | undefined;
}): string {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const environmentConfigTarget =
    input.environmentConfigId?.trim() || "selected environment config";
  return `Run debug for ${toolTarget} using ${environmentConfigTarget}`;
}

export function hostedIntegrationDebugEnvironmentConfigAccessibleLabel(
  toolName: string | null | undefined,
): string {
  const target = toolName?.trim() || "selected tool";
  return `Select debug environment config for ${target}`;
}

export function hostedIntegrationDebugArgumentsAccessibleLabel(
  toolName: string | null | undefined,
): string {
  const target = toolName?.trim() || "selected tool";
  return `Debug arguments for ${target}`;
}

export function hostedIntegrationDebugResultAccessibleLabel(input: {
  toolName: string | null | undefined;
  environmentConfigId: string | null | undefined;
}): string {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const environmentConfigTarget =
    input.environmentConfigId?.trim() || "selected environment config";
  return `Debug result for ${toolTarget} using ${environmentConfigTarget}`;
}

export interface HostedIntegrationDebugActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"debug_run"> | null;
  canRunDebug: boolean;
  primaryDisabled: boolean;
}

export function buildHostedIntegrationDebugActionState(input: {
  canManage: boolean;
  toolName: string | null | undefined;
  environmentConfigId: string | null | undefined;
  requiresEnvironmentConfig: boolean;
  operation: HostedIntegrationToolSpec["classification"]["operation"] | null;
  hasLocalArgumentError: boolean;
  busy: boolean;
}): HostedIntegrationDebugActionState {
  const toolName = input.toolName?.trim();
  const environmentConfigId = input.environmentConfigId?.trim();
  const hasRequiredEnvironmentConfig =
    !input.requiresEnvironmentConfig || Boolean(environmentConfigId);
  const target =
    input.canManage &&
    toolName &&
    hasRequiredEnvironmentConfig &&
    input.operation === "read"
      ? {
          kind: "debug_run" as const,
          id: `${toolName}:${environmentConfigId ?? "config-free"}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    target,
    canRunDebug: Boolean(target),
    primaryDisabled: input.busy || !target || input.hasLocalArgumentError,
  };
}

export function hostedIntegrationDebugUnavailableReason(input: {
  canManage: boolean;
  toolName: string | null | undefined;
  operation: HostedIntegrationToolSpec["classification"]["operation"] | null;
  environmentConfigCount: number;
  requiresEnvironmentConfig: boolean;
  familyName: string | null | undefined;
}): string | null {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const familyTarget = input.familyName?.trim() || "selected family";
  if (!input.toolName?.trim()) {
    return "Select a tool before running debug.";
  }
  if (!input.canManage) {
    return `Hosted integration management permission is required to run debug for ${toolTarget}.`;
  }
  if (input.operation !== "read") {
    const operationTarget = input.operation ?? "unclassified";
    return `${toolTarget} is classified as ${operationTarget}. Debug runs are available for read tools only.`;
  }
  if (input.requiresEnvironmentConfig && input.environmentConfigCount === 0) {
    return `Add an environment config for ${familyTarget} before running debug for ${toolTarget}.`;
  }
  return null;
}

export function hostedIntegrationRequiresEnvironmentConfig(
  row: Pick<HostedIntegrationAdminFamilyRow, "runtimeConfig">,
): boolean {
  const runtimeConfig = row.runtimeConfig;
  if (!runtimeConfig) return true;
  return (
    (runtimeConfig.requiredConfigKeys?.length ?? 0) > 0 ||
    (runtimeConfig.requiredSecretKeys?.length ?? 0) > 0
  );
}

export function hostedIntegrationEnvironmentConfigAccessibleLabel(input: {
  environmentConfigId: string | null | undefined;
  environment: string | null | undefined;
  configKeyCount: number;
  configuredSecretCount: number;
  secretKeyCount: number;
}): string {
  const environmentConfigTarget =
    input.environmentConfigId?.trim() || "selected environment config";
  const environmentTarget = input.environment?.trim() || "environment";
  const missingSecretCount = Math.max(
    input.secretKeyCount - input.configuredSecretCount,
    0,
  );
  return [
    `Environment config ${environmentConfigTarget}`,
    environmentTarget,
    `${input.configKeyCount} config keys`,
    `${input.configuredSecretCount} configured secrets`,
    `${missingSecretCount} missing secrets`,
  ].join(", ");
}

export function hostedIntegrationSecretStatusLabel(
  configured: boolean,
): string {
  return configured ? "configured" : "missing";
}

export function hostedIntegrationSecretInputAccessibleLabel(input: {
  environmentConfigId: string | null | undefined;
  secretName: string | null | undefined;
}): string {
  const environmentConfigTarget =
    input.environmentConfigId?.trim() || "selected environment config";
  const secretTarget = input.secretName?.trim() || "selected secret";
  return `New value for secret ${secretTarget} in ${environmentConfigTarget}`;
}

export function hostedIntegrationSecretActionAccessibleLabel(input: {
  environmentConfigId: string | null | undefined;
  secretName: string | null | undefined;
}): string {
  const environmentConfigTarget =
    input.environmentConfigId?.trim() || "selected environment config";
  const secretTarget = input.secretName?.trim() || "selected secret";
  return `Set secret ${secretTarget} for ${environmentConfigTarget}`;
}

export function hostedIntegrationConfigEmptyStateText(input: {
  familyName: string | null | undefined;
}): string {
  const familyTarget = input.familyName?.trim() || "selected family";
  return `No environment configs defined for ${familyTarget}.`;
}

export function hostedIntegrationToolHelpActionAccessibleLabels(
  toolName: string | null | undefined,
): {
  save: string;
  addParameter: string;
  addExample: string;
  advancedFields: string;
  examplesDisclosure: string;
} {
  const target = toolName?.trim() || "selected tool";
  return {
    save: `Save help for ${target}`,
    addParameter: `Add help parameter for ${target}`,
    addExample: `Add help example for ${target}`,
    advancedFields: `Show advanced help fields for ${target}`,
    examplesDisclosure: `Show help examples for ${target}`,
  };
}

export interface HostedIntegrationToolHelpActionState {
  saveTarget: HostedIntegrationLifecycleTargetDescriptor<"tool_help"> | null;
  canSaveHelp: boolean;
}

export function buildHostedIntegrationToolHelpActionState(input: {
  canEdit: boolean;
  draftId: string | null | undefined;
  toolName: string | null | undefined;
}): HostedIntegrationToolHelpActionState {
  const draftId = input.draftId?.trim();
  const toolName = input.toolName?.trim();
  const saveTarget =
    input.canEdit && draftId && toolName
      ? {
          kind: "tool_help" as const,
          id: `${draftId}:${toolName}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    saveTarget,
    canSaveHelp: Boolean(saveTarget),
  };
}

export function hostedIntegrationToolHelpFieldAccessibleLabels(input: {
  toolName: string | null | undefined;
  parameterName: string | null | undefined;
}): {
  summary: string;
  full: string;
  whenToUse: string;
  whenNotToUse: string;
  noExampleJustification: string;
  parameterRules: string;
  parameterFull: string;
  parameterShape: string;
} {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const parameterTarget = input.parameterName?.trim() || "selected parameter";
  return {
    summary: `Help summary for ${toolTarget}`,
    full: `Full help detail for ${toolTarget}`,
    whenToUse: `When to use help for ${toolTarget}`,
    whenNotToUse: `When not to use help for ${toolTarget}`,
    noExampleJustification: `No example justification for ${toolTarget}`,
    parameterRules: `Rules for ${parameterTarget} in ${toolTarget}`,
    parameterFull: `Full detail for ${parameterTarget} in ${toolTarget}`,
    parameterShape: `Shape override for ${parameterTarget} in ${toolTarget}`,
  };
}

export function hostedIntegrationToolHelpEmptyStateText(input: {
  state:
    | "summary_empty"
    | "parameters_empty"
    | "parameter_summary_empty"
    | "examples_empty";
  toolName: string | null | undefined;
  parameterName?: string | null | undefined;
}): string {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const parameterTarget = input.parameterName?.trim() || "selected parameter";
  if (input.state === "summary_empty") {
    return `No help summary documented for ${toolTarget}.`;
  }
  if (input.state === "parameters_empty") {
    return `No parameter help entries documented for ${toolTarget}.`;
  }
  if (input.state === "parameter_summary_empty") {
    return `No summary documented for ${parameterTarget} in ${toolTarget}.`;
  }
  return `No help examples documented for ${toolTarget}.`;
}

export function hostedIntegrationToolHelpParameterRowAccessibleLabels(input: {
  toolName: string | null | undefined;
  parameterName: string | null | undefined;
  parameterIndex: number;
}): {
  name: string;
  summary: string;
  remove: string;
} {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const ordinal = input.parameterIndex + 1;
  const parameterTarget =
    input.parameterName?.trim() || `help parameter ${ordinal}`;
  return {
    name: `Name for ${parameterTarget} in ${toolTarget}`,
    summary: `Summary for ${parameterTarget} in ${toolTarget}`,
    remove: `Remove ${parameterTarget} from ${toolTarget}`,
  };
}

export function hostedIntegrationToolHelpExampleAccessibleLabels(input: {
  toolName: string | null | undefined;
  exampleIndex: number;
}): {
  payload: string;
  remove: string;
} {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const ordinal = input.exampleIndex + 1;
  return {
    payload: `Help example ${ordinal} payload for ${toolTarget}`,
    remove: `Remove help example ${ordinal} for ${toolTarget}`,
  };
}

export function hostedIntegrationCodeActionAccessibleLabels(input: {
  toolName: string | null | undefined;
  handlerName: string | null | undefined;
}): {
  editSource: string;
  focusedHandler: string;
  fullFamily: string;
  schemaDisclosure: string;
  handlerSource: string;
  schemaDetails: string;
} {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const handlerTarget = input.handlerName?.trim() || "selected handler";
  return {
    editSource: `Edit source file for ${handlerTarget}`,
    focusedHandler: `Show focused handler for ${toolTarget}`,
    fullFamily: `Show full family source for ${toolTarget}`,
    schemaDisclosure: `Show schema and diagnostics for ${toolTarget}`,
    handlerSource: `Handler source for ${handlerTarget}`,
    schemaDetails: `Schema details for ${toolTarget}`,
  };
}

export interface HostedIntegrationCodeActionState {
  editSourceTarget: HostedIntegrationLifecycleTargetDescriptor<"source_file"> | null;
  canEditSourceFile: boolean;
}

export interface HostedIntegrationPackageActionState {
  importCreateTarget: HostedIntegrationLifecycleTargetDescriptor<"hosted_package_import_create"> | null;
  importUpdateTarget: HostedIntegrationLifecycleTargetDescriptor<"hosted_package_import_update"> | null;
  exportActiveGenerationTarget: HostedIntegrationLifecycleTargetDescriptor<"hosted_package_export_active_generation"> | null;
  exportDraftTarget: HostedIntegrationLifecycleTargetDescriptor<"hosted_package_export_draft"> | null;
  exportCurrentSourceTarget: HostedIntegrationLifecycleTargetDescriptor<"hosted_package_export_current_source"> | null;
  canImportCreate: boolean;
  canImportUpdate: boolean;
  canExportActiveGeneration: boolean;
  canExportDraft: boolean;
  canExportCurrentSource: boolean;
  updateBlockedReason: string | null;
}

export function buildHostedIntegrationPackageActionState(input: {
  canManage: boolean;
  familyId: string | null | undefined;
  activeGenerationId: string | null | undefined;
  draftId: string | null | undefined;
  lock: HostedIntegrationFamilyLock | null;
  actorId: string;
  busy: boolean;
}): HostedIntegrationPackageActionState {
  const familyId = input.familyId?.trim();
  const activeGenerationId = input.activeGenerationId?.trim();
  const draftId = input.draftId?.trim();
  const lockOwnedByCurrentHuman = input.lock?.lockedBy === input.actorId;
  const readyForManagedAction = input.canManage && !input.busy;
  const importCreateTarget = readyForManagedAction
    ? {
        kind: "hosted_package_import_create" as const,
        id: "new-family",
        ownedByCurrentHuman: true,
        ready: true,
      }
    : null;
  const importUpdateTarget =
    readyForManagedAction && familyId && draftId && lockOwnedByCurrentHuman
      ? {
          kind: "hosted_package_import_update" as const,
          id: `${familyId}:${draftId}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  const exportActiveGenerationTarget =
    readyForManagedAction && familyId && activeGenerationId
      ? {
          kind: "hosted_package_export_active_generation" as const,
          id: activeGenerationId,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  const exportDraftTarget =
    readyForManagedAction && draftId && lockOwnedByCurrentHuman
      ? {
          kind: "hosted_package_export_draft" as const,
          id: draftId,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  const exportCurrentSourceTarget =
    readyForManagedAction && familyId
      ? {
          kind: "hosted_package_export_current_source" as const,
          id: familyId,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  let updateBlockedReason: string | null = null;
  if (!input.canManage) {
    updateBlockedReason = "Hosted tool management permission is required.";
  } else if (!lockOwnedByCurrentHuman) {
    updateBlockedReason = input.lock
      ? "Unlock is held by another editor."
      : "Lock for editing before importing over this family.";
  } else if (!draftId) {
    updateBlockedReason = "No editable draft is available for this lock.";
  }
  return {
    importCreateTarget,
    importUpdateTarget,
    exportActiveGenerationTarget,
    exportDraftTarget,
    exportCurrentSourceTarget,
    canImportCreate: Boolean(importCreateTarget),
    canImportUpdate: Boolean(importUpdateTarget),
    canExportActiveGeneration: Boolean(exportActiveGenerationTarget),
    canExportDraft: Boolean(exportDraftTarget),
    canExportCurrentSource: Boolean(exportCurrentSourceTarget),
    updateBlockedReason,
  };
}

export function hostedIntegrationPackageActionAccessibleLabels(
  familyName: string | null | undefined,
): {
  openPanel: string;
  closePanel: string;
  importCreate: string;
  importUpdate: string;
  exportActiveGeneration: string;
  exportDraft: string;
  exportCurrentSource: string;
  copyExport: string;
  importPayload: string;
  exportPayload: string;
} {
  const target = familyName?.trim() || "selected family";
  return {
    openPanel: `Show package import and export for ${target}`,
    closePanel: `Hide package import and export for ${target}`,
    importCreate: "Import package as a new hosted tool family",
    importUpdate: `Import package into ${target} pending changes`,
    exportActiveGeneration: `Export current version package for ${target}`,
    exportDraft: `Export pending changes package for ${target}`,
    exportCurrentSource: `Export source package for ${target}`,
    copyExport: `Copy exported package for ${target}`,
    importPayload: "Hosted family package JSON to import",
    exportPayload: `Exported hosted family package JSON for ${target}`,
  };
}

export interface HostedIntegrationPackagePreviewState {
  status: "empty" | "invalid" | "ready";
  error: string | null;
  modeLabel: "Create" | "Update";
  familyId: string | null;
  familyName: string | null;
  toolNames: string[];
  fileCount: number;
  addedFileCount: number;
  removedFileCount: number;
  retainedFileCount: number;
  exampleCount: number;
  providerRefCount: number;
  helpRefCount: number;
  destructiveToolNames: string[];
}

export function buildHostedIntegrationPackagePreviewState(input: {
  packageJson: string;
  mode: "create" | "update";
  currentFilePaths?: string[];
}): HostedIntegrationPackagePreviewState {
  const modeLabel = input.mode === "create" ? "Create" : "Update";
  if (input.packageJson.trim().length === 0) {
    return emptyHostedIntegrationPackagePreview(modeLabel);
  }
  try {
    const packageDocument = JSON.parse(input.packageJson) as unknown;
    if (!packageDocument || typeof packageDocument !== "object") {
      throw new Error("package must be a JSON object");
    }
    const filesValue = (packageDocument as { files?: unknown }).files;
    if (!Array.isArray(filesValue)) {
      throw new Error("package files must be an array");
    }
    const files = filesValue
      .map((file): { path: string; content: string } | null => {
        if (!file || typeof file !== "object") return null;
        const path = (file as { path?: unknown }).path;
        const content = (file as { content?: unknown }).content;
        return typeof path === "string" && typeof content === "string"
          ? { path, content }
          : null;
      })
      .filter((file): file is { path: string; content: string } =>
        Boolean(file),
      );
    if (files.length !== filesValue.length) {
      throw new Error("package files must include string path and content");
    }
    const filesByPath = new Map(files.map((file) => [file.path, file.content]));
    const familyYaml = parsePackageYaml(filesByPath.get("family.yaml"));
    const toolsYaml = parsePackageYaml(filesByPath.get("tools.yaml"));
    const examplesYaml = parsePackageYaml(filesByPath.get("examples.yaml"));
    const toolEntries = Array.isArray(objectField(toolsYaml, "tools"))
      ? (objectField(toolsYaml, "tools") as unknown[])
      : [];
    const toolNames = toolEntries
      .map((tool) => objectField(objectField(tool, "openacme"), "toolName"))
      .filter((toolName): toolName is string => typeof toolName === "string")
      .sort((left, right) => left.localeCompare(right));
    const destructiveToolNames = toolEntries
      .filter(
        (tool) =>
          objectField(
            objectField(objectField(tool, "openacme"), "classification"),
            "operation",
          ) === "destructive",
      )
      .map((tool) => objectField(objectField(tool, "openacme"), "toolName"))
      .filter((toolName): toolName is string => typeof toolName === "string")
      .sort((left, right) => left.localeCompare(right));
    const providerRefCount = toolEntries.filter((tool) =>
      Boolean(objectField(objectField(tool, "openacme"), "providerRef")),
    ).length;
    const helpRefCount = countPackageHelpRefs(toolEntries);
    const exampleEntries = Array.isArray(objectField(examplesYaml, "examples"))
      ? (objectField(examplesYaml, "examples") as unknown[])
      : [];
    const currentFilePaths = new Set(input.currentFilePaths ?? []);
    const packageFilePaths = new Set(files.map((file) => file.path));
    const retainedFileCount = [...packageFilePaths].filter((filePath) =>
      currentFilePaths.has(filePath),
    ).length;
    const addedFileCount = [...packageFilePaths].filter(
      (filePath) => !currentFilePaths.has(filePath),
    ).length;
    const removedFileCount =
      currentFilePaths.size === 0
        ? 0
        : [...currentFilePaths].filter(
            (filePath) => !packageFilePaths.has(filePath),
          ).length;
    return {
      status: "ready",
      error: null,
      modeLabel,
      familyId:
        stringFieldFromObject(familyYaml, "id") ??
        stringFieldFromObject(objectField(toolsYaml, "family"), "id"),
      familyName: stringFieldFromObject(familyYaml, "name"),
      toolNames,
      fileCount: files.length,
      addedFileCount,
      removedFileCount,
      retainedFileCount,
      exampleCount: exampleEntries.length,
      providerRefCount,
      helpRefCount,
      destructiveToolNames,
    };
  } catch (error) {
    return {
      ...emptyHostedIntegrationPackagePreview(modeLabel),
      status: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function emptyHostedIntegrationPackagePreview(
  modeLabel: "Create" | "Update",
): HostedIntegrationPackagePreviewState {
  return {
    status: "empty",
    error: null,
    modeLabel,
    familyId: null,
    familyName: null,
    toolNames: [],
    fileCount: 0,
    addedFileCount: 0,
    removedFileCount: 0,
    retainedFileCount: 0,
    exampleCount: 0,
    providerRefCount: 0,
    helpRefCount: 0,
    destructiveToolNames: [],
  };
}

function parsePackageYaml(content: string | undefined): unknown {
  if (!content) return null;
  return parseYaml(content);
}

function objectField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return (value as Record<string, unknown>)[field];
}

function stringFieldFromObject(value: unknown, field: string): string | null {
  const fieldValue = objectField(value, field);
  return typeof fieldValue === "string" ? fieldValue : null;
}

function countPackageHelpRefs(toolEntries: unknown[]): number {
  let count = 0;
  for (const tool of toolEntries) {
    const openacme = objectField(tool, "openacme");
    if (typeof objectField(openacme, "fullHelp") === "string") count += 1;
    const parameterHelp = objectField(openacme, "parameterHelp");
    if (
      parameterHelp &&
      typeof parameterHelp === "object" &&
      !Array.isArray(parameterHelp)
    ) {
      for (const help of Object.values(parameterHelp)) {
        if (typeof objectField(help, "full") === "string") count += 1;
      }
    }
  }
  return count;
}

export function buildHostedIntegrationCodeActionState(input: {
  canEdit: boolean;
  draftId: string | null | undefined;
  path: string | null | undefined;
}): HostedIntegrationCodeActionState {
  const draftId = input.draftId?.trim();
  const path = input.path?.trim();
  const editSourceTarget =
    input.canEdit && draftId && path
      ? {
          kind: "source_file" as const,
          id: `${draftId}:${path}`,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    editSourceTarget,
    canEditSourceFile: Boolean(editSourceTarget),
  };
}

export function hostedIntegrationCodeEmptyStateText(input: {
  toolName: string | null | undefined;
  handlerName: string | null | undefined;
}): string {
  const toolTarget = input.toolName?.trim() || "selected tool";
  const handlerTarget = input.handlerName?.trim() || "selected handler";
  return `No focused source loaded for ${handlerTarget} in ${toolTarget}.`;
}

export function hostedIntegrationEditLockActionAccessibleLabels(
  familyName: string | null | undefined,
): {
  edit: string;
  unlock: string;
  lockedByAnotherEditor: string;
} {
  const target = familyName?.trim() || "selected family";
  return {
    edit: `Edit ${target}`,
    unlock: `Unlock ${target} edit session`,
    lockedByAnotherEditor: `${target} is locked by another editor`,
  };
}

export function hostedIntegrationEditorModeLabel(input: {
  hasDraft: boolean;
}): "Changes" | "Inspect mode" {
  return input.hasDraft ? "Changes" : "Inspect mode";
}

export function hostedIntegrationRefreshActionAccessibleLabel(
  surfaceName: string | null | undefined,
): string {
  const target = surfaceName?.trim() || "current view";
  return `Refresh ${target}`;
}

export function hostedIntegrationFamilyNavigationAccessibleLabel(input: {
  familyName: string | null | undefined;
  familyId: string | null | undefined;
  status: "active" | "idle";
  includeFamilyId: boolean;
}): string {
  const familyName = input.familyName?.trim() || "selected family";
  const familyId = input.familyId?.trim();
  const identity =
    input.includeFamilyId && familyId
      ? `${familyName} (${familyId})`
      : familyName;
  return `Select family ${identity}, ${input.status}`;
}

export function hostedIntegrationToolNavigationAccessibleLabel(input: {
  toolName: string | null | undefined;
  familyName: string | null | undefined;
}): string {
  const toolName = input.toolName?.trim() || "selected tool";
  const familyName = input.familyName?.trim();
  return familyName
    ? `Select tool ${toolName} in ${familyName}`
    : `Select tool ${toolName}`;
}

export function hostedIntegrationEditorSectionAccessibleLabel(input: {
  sectionLabel: string | null | undefined;
  toolName: string | null | undefined;
}): string {
  const section = input.sectionLabel?.trim() || "workspace";
  const toolName = input.toolName?.trim() || "selected tool";
  return `Show ${section} for ${toolName}`;
}

export function hostedIntegrationFileNavigationAccessibleLabel(input: {
  path: string | null | undefined;
  sizeBytes: number | null | undefined;
  mode: "current" | "changes";
}): string {
  const path = input.path?.trim() || "selected file";
  const sizeLabel =
    typeof input.sizeBytes === "number"
      ? `${input.sizeBytes} bytes`
      : "size not recorded";
  return `Select ${input.mode} file ${path}, ${sizeLabel}`;
}

export function hostedIntegrationLogScopeAccessibleLabel(input: {
  scope: HostedIntegrationExecutionLogScope;
  toolName: string | null | undefined;
  familyName: string | null | undefined;
}): string {
  if (input.scope === "family") {
    const familyName = input.familyName?.trim() || "selected family";
    return `Show logs for family ${familyName}`;
  }
  const toolName = input.toolName?.trim() || "selected tool";
  return `Show logs for tool ${toolName}`;
}

export function hostedIntegrationRefreshLogsAccessibleLabel(input: {
  scope: HostedIntegrationExecutionLogScope;
  toolName: string | null | undefined;
  familyName: string | null | undefined;
}): string {
  if (input.scope === "family") {
    const familyName = input.familyName?.trim() || "selected family";
    return `Refresh logs for family ${familyName}`;
  }
  const toolName = input.toolName?.trim() || "selected tool";
  return `Refresh logs for tool ${toolName}`;
}

export interface HostedIntegrationPublishViewState {
  validationOk: boolean;
  publishReady: boolean;
  publishBlocked: boolean;
  blockerLabel: string | null;
  tabLabel: "Validate" | "Publish" | "Blocked";
  primaryLabel: "Validate" | "Validate again" | "Publish";
  primaryAccessibleLabel:
    | "Validate pending changes"
    | "Validate pending changes again"
    | "Publish validated changes";
  resultLabel: "Validation result" | "Publish result" | null;
}

export interface HostedIntegrationPublishActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"editable_change_set"> | null;
  hasEditableDraft: boolean;
  showLane: boolean;
  primaryDisabled: boolean;
}

export function hostedIntegrationPublishAccessibleLabels(input: {
  familyName: string | null | undefined;
  viewState: HostedIntegrationPublishViewState;
}): {
  primary: string;
  result: string;
  rawResult: string;
} {
  const familyTarget = input.familyName?.trim() || "selected family";
  const resultTarget = (
    input.viewState.resultLabel ?? "validation result"
  ).toLowerCase();
  return {
    primary: `${input.viewState.primaryAccessibleLabel} for ${familyTarget}`,
    result: `${
      input.viewState.resultLabel ?? "Validation result"
    } for ${familyTarget} pending changes`,
    rawResult: `Show raw ${resultTarget} for ${familyTarget} pending changes`,
  };
}

export interface HostedIntegrationFailureSummaryState {
  openCount: number;
  assignedOpenCount: number;
  guidance: string;
}

export interface HostedIntegrationFailureBucketActionState {
  target: HostedIntegrationLifecycleTargetDescriptor<"failure_bucket"> | null;
  canAssignRepair: boolean;
}

export function hostedIntegrationFailureBucketAccessibleLabel(input: {
  bucket: HostedIntegrationFailureBucket;
  versionRelation: string;
  assignedLabel: string;
  latestSeenLabel: string;
}): string {
  const statusLabel =
    input.bucket.status === "closed"
      ? "closed"
      : input.bucket.assignedTo
        ? "assigned"
        : "open";
  return [
    "Failure bucket",
    input.bucket.toolName,
    input.versionRelation,
    hostedIntegrationFailureBucketHitLabel(input.bucket.count),
    input.assignedLabel,
    input.latestSeenLabel,
    statusLabel,
  ].join(", ");
}

export function hostedIntegrationFailureBucketHitLabel(count: number): string {
  return `${count} ${count === 1 ? "hit" : "hits"}`;
}

export function hostedIntegrationFailureBucketActionAccessibleLabels(input: {
  bucket: HostedIntegrationFailureBucket | null | undefined;
  versionRelation: string | null | undefined;
}): {
  assignRepair: string;
} {
  const toolName = input.bucket?.toolName?.trim() || "selected tool";
  const relation = input.versionRelation?.trim() || "selected version";
  return {
    assignRepair: `Assign repair for ${toolName} failure bucket, ${relation}`,
  };
}

export function buildHostedIntegrationFailureBucketActionState(input: {
  bucket: HostedIntegrationFailureBucket;
  canManage: boolean;
  assignedRepairActor: string;
}): HostedIntegrationFailureBucketActionState {
  const target =
    input.canManage &&
    input.bucket.status === "open" &&
    input.bucket.assignedTo !== input.assignedRepairActor
      ? {
          kind: "failure_bucket" as const,
          id: input.bucket.id,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    target,
    canAssignRepair: Boolean(target),
  };
}

export interface HostedIntegrationExampleActionState {
  saveTarget: HostedIntegrationLifecycleTargetDescriptor<"editable_examples"> | null;
  runTarget: HostedIntegrationLifecycleTargetDescriptor<"test_example"> | null;
  canSaveExample: boolean;
  canRunExample: boolean;
}

export interface HostedIntegrationFamilyLock {
  id: string;
  familyId: string;
  lockedBy: string;
  draftId?: string;
  expiresAt: string;
}

export interface HostedIntegrationConfigKeyRow {
  name: string;
}

export interface HostedIntegrationSecretKeyRow {
  name: string;
  configured: boolean;
}

export interface HostedIntegrationAdminFamilyRow {
  id: string;
  name: string;
  version: number;
  activeGeneration: HostedIntegrationGenerationSummary | null;
  tools: HostedIntegrationToolSpec[];
  runtimeConfig?: HostedIntegrationRuntimeConfigContract;
  environmentConfigs: Array<{
    id: string;
    familyId: string;
    environment: string;
    revision: number;
    configKeyCount: number;
    configuredSecretCount: number;
    configKeys: HostedIntegrationConfigKeyRow[];
    secretKeys: HostedIntegrationSecretKeyRow[];
  }>;
  failureBuckets: HostedIntegrationFailureBucket[];
  openFailureBucketCount: number;
  lock: HostedIntegrationFamilyLock | null;
}

export interface HostedIntegrationFocusedSourceView {
  mode: "focused" | "full_family";
  manifest: {
    tool: HostedIntegrationToolSpec;
  };
  source: {
    fullSource?: string;
    selectedHandler?: {
      name: string;
      source: string;
      startLine: number;
      endLine: number;
    };
    hooks: Array<{ name: string; source: string }>;
    helpers: Array<{ name: string; source: string }>;
    collapsedToolHandlers: Array<{
      toolName: string;
      functionName: string;
      source: string;
    }>;
  };
  diagnostics: Array<{
    severity: string;
    code: string;
    message: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
  }>;
}

export interface HostedIntegrationToolMapping {
  toolName: string;
  handlerName: string;
  title: string;
  lifecycle: HostedIntegrationToolSpec["lifecycle"];
  operation: HostedIntegrationToolSpec["classification"]["operation"];
  selected: boolean;
}

export interface HostedIntegrationEditorModel {
  selectedToolName: string | null;
  selectedHandlerName: string | null;
  selectedTool: HostedIntegrationToolSpec | null;
  mappings: HostedIntegrationToolMapping[];
  focusedHandlerCode: string;
  collapsedHandlerNames: string[];
  inputSchema: Record<string, unknown> | null;
  helpSummary: string | null;
  canManage: boolean;
  canEdit: boolean;
  canRunReadSafeDebug: boolean;
}

export function buildHostedIntegrationsAdminRows(input: {
  families: HostedIntegrationFamilySummary[];
  familyDetails: HostedIntegrationFamilyDetail[];
  generations: HostedIntegrationGenerationSummary[];
  environmentConfigs: HostedIntegrationEnvironmentConfig[];
  failureBuckets: HostedIntegrationFailureBucket[];
  locks: Array<HostedIntegrationFamilyLock | null>;
}): HostedIntegrationAdminFamilyRow[] {
  const familiesById = new Map<string, HostedIntegrationFamilySummary>();
  for (const family of input.families) {
    const existing = familiesById.get(family.id);
    if (
      !existing ||
      shouldPreferHostedIntegrationFamilySummary(family, existing)
    ) {
      familiesById.set(family.id, family);
    }
  }
  const detailsByFamily = new Map(
    input.familyDetails.map((detail) => [detail.summary.id, detail]),
  );
  const locksByFamily = new Map(
    input.locks
      .filter((lock): lock is HostedIntegrationFamilyLock => lock !== null)
      .map((lock) => [lock.familyId, lock]),
  );
  return [...familiesById.values()].map((family) => {
    const detail = detailsByFamily.get(family.id);
    return {
      id: family.id,
      name: family.name,
      version: family.version,
      activeGeneration:
        input.generations.find(
          (generation) =>
            generation.familyId === family.id && generation.status === "active",
        ) ?? null,
      tools: detail?.tools ?? [],
      runtimeConfig: detail?.manifest.runtimeConfig,
      environmentConfigs: input.environmentConfigs
        .filter((scope) => scope.familyId === family.id)
        .map((scope) => ({
          id: scope.id,
          familyId: scope.familyId,
          environment: scope.environment,
          revision: scope.revision,
          configKeyCount: Object.keys(scope.config).length,
          configuredSecretCount: Object.values(scope.secrets).filter(
            (secret) => secret.configured,
          ).length,
          configKeys: Object.keys(scope.config)
            .sort((left, right) => left.localeCompare(right))
            .map((name) => ({ name })),
          secretKeys: Object.entries(scope.secrets)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, secret]) => ({
              name,
              configured: secret.configured,
            })),
        })),
      failureBuckets: input.failureBuckets
        .filter((bucket) => bucket.familyId === family.id)
        .sort((left, right) =>
          right.latestSeenAt.localeCompare(left.latestSeenAt),
        ),
      openFailureBucketCount: input.failureBuckets.filter(
        (bucket) => bucket.familyId === family.id && bucket.status === "open",
      ).length,
      lock: locksByFamily.get(family.id) ?? null,
    };
  });
}

function shouldPreferHostedIntegrationFamilySummary(
  candidate: HostedIntegrationFamilySummary,
  existing: HostedIntegrationFamilySummary,
): boolean {
  if (candidate.version !== existing.version) {
    return candidate.version > existing.version;
  }
  if (candidate.status !== existing.status) {
    return candidate.status === "active";
  }
  return false;
}

export function hostedIntegrationHandlerName(toolName: string): string {
  return `tool_${toolName}`;
}

export function buildHostedIntegrationExecutionLogRows(input: {
  row: HostedIntegrationAdminFamilyRow;
  runs: HostedIntegrationExecutionLogEntry[];
}): HostedIntegrationExecutionLogRow[] {
  return input.runs.map((run) => {
    const artifactName = run.resultMetadata?.artifact?.name ?? null;
    return {
      run,
      versionRelation:
        input.row.activeGeneration?.id === run.generationId
          ? "current version"
          : "previous version",
      completedAt: run.endedAt ?? run.startedAt,
      durationLabel:
        run.durationMs !== undefined
          ? `${run.durationMs} ms`
          : run.status === "running"
            ? "running"
            : "not recorded",
      resultLabel:
        run.status === "failed"
          ? "failed"
          : run.resultMetadata?.responseMode === "artifact"
            ? "artifact"
            : run.status === "running"
              ? "pending"
              : "inline",
      artifactName,
      errorCode: run.error?.code ?? null,
    };
  });
}

export function filterHostedIntegrationExecutionLogRows(input: {
  rows: HostedIntegrationExecutionLogRow[];
  selectedToolName: string | null;
  scope: HostedIntegrationExecutionLogScope;
}): HostedIntegrationExecutionLogRow[] {
  if (input.scope === "family" || !input.selectedToolName) {
    return input.rows;
  }
  return input.rows.filter(
    (row) => row.run.toolName === input.selectedToolName,
  );
}

export function buildHostedIntegrationVersionRows(input: {
  row: HostedIntegrationAdminFamilyRow;
  generations: HostedIntegrationGenerationSummary[];
}): HostedIntegrationVersionRow[] {
  return input.generations
    .filter((generation) => generation.familyId === input.row.id)
    .sort((left, right) => {
      const byPromotedAt = right.promotedAt.localeCompare(left.promotedAt);
      return byPromotedAt === 0
        ? right.id.localeCompare(left.id)
        : byPromotedAt;
    })
    .map((generation) => {
      const isCurrent = input.row.activeGeneration?.id === generation.id;
      return {
        generation,
        relation: isCurrent ? "current version" : "previous version",
        stateLabel: isCurrent
          ? "active"
          : generation.status === "retired"
            ? "retired"
            : "previous",
        canRollback: !isCurrent,
      };
    });
}

export function buildHostedIntegrationVersionActionState(input: {
  selectedVersionRow: HostedIntegrationVersionRow | null;
  canManage: boolean;
  activeGenerationId?: string | null | undefined;
}): HostedIntegrationVersionActionState {
  const target =
    input.selectedVersionRow?.canRollback && input.canManage
      ? {
          kind: "previous_version" as const,
          id: input.selectedVersionRow.generation.id,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  const hasSelectedTarget = Boolean(target);
  return {
    target,
    hasSelectedTarget,
    canCompare: hasSelectedTarget && Boolean(input.activeGenerationId?.trim()),
    canRollback: hasSelectedTarget,
  };
}

export function buildHostedIntegrationPublishViewState(input: {
  validation: unknown;
  publishReadiness?: unknown;
  publishResult: unknown;
}): HostedIntegrationPublishViewState {
  const validationOk = hostedIntegrationValidationOk(input.validation);
  const hasValidationResult = Boolean(input.validation);
  const readiness = hostedPublishReadinessSummary(input.publishReadiness);
  const publishBlocked = validationOk && readiness?.status === "blocked";
  const publishReady =
    validationOk &&
    !publishBlocked &&
    (readiness ? readiness.status === "ready" : true);
  return {
    validationOk,
    publishReady,
    publishBlocked,
    blockerLabel: publishBlocked
      ? (readiness?.label ?? "Publish blocked")
      : null,
    tabLabel: publishBlocked
      ? "Blocked"
      : publishReady
        ? "Publish"
        : "Validate",
    primaryLabel: publishReady
      ? "Publish"
      : hasValidationResult
        ? "Validate again"
        : "Validate",
    primaryAccessibleLabel: publishReady
      ? "Publish validated changes"
      : hasValidationResult
        ? "Validate pending changes again"
        : "Validate pending changes",
    resultLabel: input.publishResult
      ? "Publish result"
      : hasValidationResult
        ? "Validation result"
        : null,
  };
}

export function buildHostedIntegrationPublishActionState(input: {
  canEdit: boolean;
  draftId: string | null | undefined;
  validationOk: boolean;
  publishReady?: boolean;
  busy: boolean;
  promotionNeedsHumanApproval: boolean;
}): HostedIntegrationPublishActionState {
  const target =
    input.canEdit && input.draftId
      ? {
          kind: "editable_change_set" as const,
          id: input.draftId,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  const hasEditableDraft = Boolean(target);
  return {
    target,
    hasEditableDraft,
    showLane: hasEditableDraft,
    primaryDisabled:
      input.busy ||
      !hasEditableDraft ||
      (input.validationOk && input.publishReady === false) ||
      ((input.publishReady ?? input.validationOk) &&
        input.promotionNeedsHumanApproval),
  };
}

function hostedPublishReadinessSummary(
  value: unknown,
): { status: "ready" | "blocked"; label: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const readiness = value as {
    status?: unknown;
    code?: unknown;
    blockers?: unknown;
  };
  if (readiness.status !== "ready" && readiness.status !== "blocked") {
    return null;
  }
  const blocker = Array.isArray(readiness.blockers)
    ? readiness.blockers.find(
        (candidate): candidate is { message?: unknown; code?: unknown } =>
          Boolean(candidate) && typeof candidate === "object",
      )
    : null;
  const message =
    typeof blocker?.message === "string"
      ? blocker.message
      : typeof blocker?.code === "string"
        ? blocker.code
        : typeof readiness.code === "string"
          ? readiness.code
          : null;
  return { status: readiness.status, label: message };
}

export function countHostedIntegrationAssignedOpenFailureBuckets(
  buckets: HostedIntegrationFailureBucket[],
): number {
  return buckets.filter(
    (bucket) => bucket.status === "open" && Boolean(bucket.assignedTo),
  ).length;
}

export function buildHostedIntegrationFailureSummaryState(
  buckets: HostedIntegrationFailureBucket[],
): HostedIntegrationFailureSummaryState {
  const openCount = buckets.filter((bucket) => bucket.status === "open").length;
  const assignedOpenCount =
    countHostedIntegrationAssignedOpenFailureBuckets(buckets);
  return {
    openCount,
    assignedOpenCount,
    guidance:
      openCount > 0
        ? "Close requires a passing regression proof."
        : "No open repair buckets. Historical buckets are listed for audit.",
  };
}

export function selectHostedIntegrationEditableSourcePath(
  files: Array<{ path: string }>,
): string {
  const sourceFile =
    files.find((file) => file.path.toLowerCase().endsWith(".py")) ??
    files.find((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file.path)) ??
    files.find((file) => !/^(examples|family)\.ya?ml$/i.test(file.path));
  return sourceFile?.path ?? files[0]?.path ?? "";
}

export function buildHostedIntegrationExampleActionState(input: {
  canEdit: boolean;
  draftId: string | null | undefined;
  selectedExampleId: string | null | undefined;
  selectedExampleCategory?: string | null | undefined;
}): HostedIntegrationExampleActionState {
  const draftId = input.draftId?.trim();
  const selectedExampleId = input.selectedExampleId?.trim();
  const selectedExampleCategory = input.selectedExampleCategory?.trim();
  const saveTarget =
    input.canEdit && draftId
      ? {
          kind: "editable_examples" as const,
          id: draftId,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  const runTarget =
    saveTarget &&
    selectedExampleId &&
    selectedExampleCategory !== "discovery_required"
      ? {
          kind: "test_example" as const,
          id: selectedExampleId,
          ownedByCurrentHuman: true,
          ready: true,
        }
      : null;
  return {
    saveTarget,
    runTarget,
    canSaveExample: Boolean(saveTarget),
    canRunExample: Boolean(runTarget),
  };
}

export function shouldBlockHostedIntegrationFamilyNavigation(input: {
  editingFamilyId: string | null;
  targetFamilyId: string;
}): boolean {
  return Boolean(
    input.editingFamilyId && input.editingFamilyId !== input.targetFamilyId,
  );
}

export function buildHostedIntegrationToolMappings(input: {
  row: HostedIntegrationAdminFamilyRow;
  selectedToolName: string | null;
}): HostedIntegrationToolMapping[] {
  return input.row.tools
    .filter((tool) => tool.lifecycle !== "removed")
    .map((tool) => ({
      toolName: tool.name,
      handlerName: hostedIntegrationHandlerName(tool.name),
      title: tool.title,
      lifecycle: tool.lifecycle,
      operation: tool.classification.operation,
      selected: tool.name === input.selectedToolName,
    }));
}

export function buildHostedIntegrationEditorModel(input: {
  row: HostedIntegrationAdminFamilyRow;
  selectedToolName: string | null;
  sourceView: HostedIntegrationFocusedSourceView | null;
  lock: HostedIntegrationFamilyLock | null;
  actorId: string;
  actorCanManage?: boolean;
}): HostedIntegrationEditorModel {
  const canManage = input.actorCanManage ?? true;
  const selectedTool =
    input.row.tools.find((tool) => tool.name === input.selectedToolName) ??
    input.sourceView?.manifest.tool ??
    null;
  const selectedToolName = selectedTool?.name ?? null;
  return {
    selectedToolName,
    selectedHandlerName: selectedToolName
      ? hostedIntegrationHandlerName(selectedToolName)
      : null,
    selectedTool,
    mappings: buildHostedIntegrationToolMappings({
      row: input.row,
      selectedToolName,
    }),
    focusedHandlerCode:
      input.sourceView?.source.selectedHandler?.source ??
      input.sourceView?.source.fullSource ??
      "",
    collapsedHandlerNames:
      input.sourceView?.source.collapsedToolHandlers.map(
        (handler) => handler.functionName,
      ) ?? [],
    inputSchema: (input.sourceView?.manifest.tool.inputSchema ??
      selectedTool?.inputSchema ??
      null) as Record<string, unknown> | null,
    helpSummary:
      input.sourceView?.manifest.tool.help?.summary ??
      selectedTool?.help?.summary ??
      null,
    canManage,
    canEdit: canManage && input.lock?.lockedBy === input.actorId,
    canRunReadSafeDebug:
      canManage && selectedTool?.classification.operation === "read",
  };
}

function hostedIntegrationValidationOk(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === true,
  );
}
