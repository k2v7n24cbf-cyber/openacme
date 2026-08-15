import {
  HostedIntegrationEnvironmentSchema,
  HostedIntegrationHostedToolBindingSchema,
  type HostedIntegrationEnvironment,
  type HostedIntegrationEnvironmentConfig,
  type FamilyManifest,
} from "./schemas.js";
import { hostedIntegrationEnvironmentConfigId } from "./environment-configs.js";
import type {
  HostedIntegrationPolicyActor,
  HostedIntegrationPolicyDecision,
} from "./policy.js";

export type HostedIntegrationReadinessKind =
  | "environment_config"
  | "binding"
  | "publish"
  | "debug"
  | "invocation";

export type HostedIntegrationReadinessStatus = "ready" | "blocked";

export interface HostedIntegrationReadinessBlocker {
  code: string;
  message: string;
  path?: string;
}

export interface HostedIntegrationReadiness {
  kind: HostedIntegrationReadinessKind;
  status: HostedIntegrationReadinessStatus;
  code: string;
  target: Record<string, string | boolean | null>;
  blockers: HostedIntegrationReadinessBlocker[];
  sanitizedDetails?: Record<string, unknown>;
}

export interface ResolveEnvironmentConfigReadinessInput {
  familyId: string;
  environment: HostedIntegrationEnvironment | string;
  environmentConfig: HostedIntegrationEnvironmentConfig | null;
  requiredConfigKeys?: string[];
  requiredSecretKeys?: string[];
  conflicted?: boolean;
  quarantined?: boolean;
}

export function resolveEnvironmentConfigReadiness(
  input: ResolveEnvironmentConfigReadinessInput,
): HostedIntegrationReadiness {
  const environment = HostedIntegrationEnvironmentSchema.parse(input.environment);
  const target = {
    familyId: input.familyId,
    environment,
    environmentConfigId: hostedIntegrationEnvironmentConfigId(
      input.familyId,
      environment,
    ),
  };
  if (input.conflicted) {
    return blocked("environment_config", "conflicted", target, [
      {
        code: "environment_config_conflicted",
        message: "environment config has unresolved import conflicts",
      },
    ]);
  }
  if (input.quarantined) {
    return blocked("environment_config", "quarantined", target, [
      {
        code: "environment_config_quarantined",
        message: "environment config is quarantined",
      },
    ]);
  }
  if (!input.environmentConfig) {
    return blocked("environment_config", "missing", target, [
      {
        code: "missing_environment_config",
        message: "environment config is missing",
      },
    ]);
  }

  const configuredConfigKeys = Object.keys(input.environmentConfig.config).sort();
  const secretKeys = Object.keys(input.environmentConfig.secrets).sort();
  const missingConfigKeys = (input.requiredConfigKeys ?? []).filter(
    (key) => !(key in input.environmentConfig!.config),
  );
  const missingSecretKeys = (input.requiredSecretKeys ?? []).filter(
    (key) => input.environmentConfig!.secrets[key]?.configured !== true,
  );
  const blockers = [
    ...missingConfigKeys.map((key) => ({
      code: "missing_config",
      message: `required config key ${key} is missing`,
      path: `config.${key}`,
    })),
    ...missingSecretKeys.map((key) => ({
      code: "missing_secret",
      message: `required secret key ${key} is missing`,
      path: `secrets.${key}`,
    })),
  ];
  const sanitizedDetails = {
    revision: input.environmentConfig.revision,
    configuredConfigKeys,
    secretKeys,
  };
  if (blockers.length > 0) {
    return blocked("environment_config", "incomplete", target, blockers, {
      ...sanitizedDetails,
      missingConfigKeys,
      missingSecretKeys,
    });
  }
  return ready("environment_config", "ready", target, sanitizedDetails);
}

export interface ResolveAgentHostedToolBindingReadinessInput {
  agentId: string;
  familyId: string;
  toolName: string;
  hostedToolBindings: unknown[];
  activeGenerationId?: string | null;
  policyDecision?: HostedIntegrationPolicyDecision;
}

export function resolveAgentHostedToolBindingReadiness(
  input: ResolveAgentHostedToolBindingReadinessInput,
): HostedIntegrationReadiness {
  const target = {
    agentId: input.agentId,
    familyId: input.familyId,
    toolName: input.toolName,
  };
  const matches = input.hostedToolBindings.filter(
    (candidate) =>
      isRecord(candidate) &&
      candidate["agentId"] === input.agentId &&
      candidate["familyId"] === input.familyId &&
      candidate["toolName"] === input.toolName,
  );
  if (matches.length === 0) {
    return blocked("binding", "missing", target, [
      {
        code: "binding_missing",
        message: "agent is not bound to hosted integration tool",
      },
    ]);
  }
  const parsed = HostedIntegrationHostedToolBindingSchema.safeParse(matches[0]);
  if (!parsed.success) {
    return blocked("binding", "invalid", target, [
      {
        code: "binding_invalid",
        message: "hosted-tool binding is invalid",
      },
    ]);
  }
  const binding = parsed.data;
  if (input.policyDecision && !input.policyDecision.ok) {
    return blocked("binding", "denied", target, [
      {
        code: "binding_denied",
        message: input.policyDecision.message,
      },
    ]);
  }
  if (
    binding.generationPin.type === "generation" &&
    input.activeGenerationId &&
    binding.generationPin.generationId !== input.activeGenerationId
  ) {
    return blocked("binding", "stale_generation", target, [
      {
        code: "generation_stale",
        message: "hosted-tool binding pins a non-active generation",
      },
    ]);
  }
  return ready("binding", "ready", target, {
    allowedEnvironments: binding.allowedEnvironments,
    defaultEnvironment: binding.defaultEnvironment,
    generationPin: binding.generationPin,
    bindingKind: binding.bindingKind,
    purpose: binding.purpose,
  });
}

export interface ResolveDebugReadinessInput {
  actor: HostedIntegrationPolicyActor | null;
  familyId: string;
  toolName: string;
  environment?: HostedIntegrationEnvironment | string;
  allowProdEnvironment?: boolean;
  requiresApproval?: boolean;
  approvalGranted?: boolean;
  operation: "read" | "write" | "destructive";
  environmentReadiness: HostedIntegrationReadiness;
}

export function resolveDebugReadiness(
  input: ResolveDebugReadinessInput,
): HostedIntegrationReadiness {
  const environment = HostedIntegrationEnvironmentSchema.parse(
    input.environment ?? "test_debug",
  );
  const target = {
    actorId: input.actor?.id ?? null,
    familyId: input.familyId,
    toolName: input.toolName,
    environment,
  };
  if (!input.actor?.roles.includes("tool_developer")) {
    return blocked("debug", "actor_denied", target, [
      { code: "actor_denied", message: "debug requires tool_developer role" },
    ]);
  }
  if (input.operation !== "read") {
    return blocked("debug", "tool_not_debuggable", target, [
      {
        code: "tool_not_debuggable",
        message: "debug run is limited to read tools in this readiness slice",
      },
    ]);
  }
  if (environment === "prod" && input.allowProdEnvironment !== true) {
    return blocked("debug", "prod_environment_requires_explicit_allow", target, [
      {
        code: "prod_environment_requires_explicit_allow",
        message: "prod debug requires explicit allowProdEnvironment",
      },
    ]);
  }
  if (input.requiresApproval && input.approvalGranted !== true) {
    return blocked("debug", "approval_required", target, [
      { code: "approval_required", message: "debug requires approval" },
    ]);
  }
  if (input.environmentReadiness.status !== "ready") {
    return blocked(
      "debug",
      input.environmentReadiness.code === "missing"
        ? "environment_missing"
        : "environment_incomplete",
      target,
      input.environmentReadiness.blockers,
    );
  }
  return ready("debug", "ready", target);
}

export interface ResolveInvocationReadinessInput {
  actor: HostedIntegrationPolicyActor | null;
  familyId: string;
  toolName: string;
  toolLifecycle?: "active" | "deprecated" | "hidden" | "disabled" | "removed";
  policyDecision: HostedIntegrationPolicyDecision;
  environmentReadiness: HostedIntegrationReadiness;
  operationallyDisabled?: boolean;
  capturedGenerationId?: string | null;
  resolvedGenerationId?: string | null;
}

export function resolveInvocationReadiness(
  input: ResolveInvocationReadinessInput,
): HostedIntegrationReadiness {
  const target = {
    actorId: input.actor?.id ?? null,
    familyId: input.familyId,
    toolName: input.toolName,
  };
  if (input.toolLifecycle === "hidden" || input.toolLifecycle === "removed") {
    return blocked("invocation", "tool_not_enabled", target, [
      { code: "tool_not_enabled", message: "tool is not enabled" },
    ]);
  }
  if (input.toolLifecycle === "disabled" || input.operationallyDisabled) {
    return blocked("invocation", "tool_disabled", target, [
      { code: "tool_disabled", message: "tool is disabled" },
    ]);
  }
  if (!input.policyDecision.ok) {
    const code =
      input.policyDecision.reason === "approval_required"
        ? "approval_required"
        : input.policyDecision.message.includes("not bound")
          ? "binding_missing"
          : "binding_invalid";
    return blocked("invocation", code, target, [
      { code, message: input.policyDecision.message },
    ]);
  }
  if (input.environmentReadiness.status !== "ready") {
    return blocked(
      "invocation",
      input.environmentReadiness.code === "missing"
        ? "environment_missing"
        : "environment_incomplete",
      target,
      input.environmentReadiness.blockers,
    );
  }
  if (
    input.capturedGenerationId &&
    input.resolvedGenerationId &&
    input.capturedGenerationId !== input.resolvedGenerationId
  ) {
    return blocked("invocation", "generation_stale", target, [
      { code: "generation_stale", message: "captured generation is stale" },
    ]);
  }
  return ready("invocation", "ready", target);
}

export interface ResolvePublishReadinessInput {
  draftId: string;
  draftExists: boolean;
  hasLock?: boolean;
  validation?: { ok: boolean } | null;
  runtimeConfigContract:
    | { status: "missing" }
    | { status: "empty" }
    | { status: "requires" };
  productionEnvironmentReadiness?: HostedIntegrationReadiness | null;
}

export interface HostedIntegrationRuntimeConfigContractReadiness {
  contract:
    | { status: "missing" }
    | { status: "empty" }
    | { status: "requires" };
  requiredConfigKeys: string[];
  requiredSecretKeys: string[];
}

export function resolveRuntimeConfigContractReadiness(
  manifest: Pick<FamilyManifest, "runtimeConfig">,
): HostedIntegrationRuntimeConfigContractReadiness {
  if (!manifest.runtimeConfig) {
    return {
      contract: { status: "missing" },
      requiredConfigKeys: [],
      requiredSecretKeys: [],
    };
  }
  const requiredConfigKeys = sortedUnique(
    manifest.runtimeConfig.requiredConfigKeys,
  );
  const requiredSecretKeys = sortedUnique(
    manifest.runtimeConfig.requiredSecretKeys,
  );
  return {
    contract:
      requiredConfigKeys.length === 0 && requiredSecretKeys.length === 0
        ? { status: "empty" }
        : { status: "requires" },
    requiredConfigKeys,
    requiredSecretKeys,
  };
}

export function resolvePublishReadiness(
  input: ResolvePublishReadinessInput,
): HostedIntegrationReadiness {
  const target = { draftId: input.draftId };
  if (!input.draftExists) {
    return blocked("publish", "draft_missing", target, [
      { code: "draft_missing", message: "draft is missing" },
    ]);
  }
  if (input.hasLock === false) {
    return blocked("publish", "lock_required", target, [
      { code: "lock_required", message: "active edit lock is required" },
    ]);
  }
  if (!input.validation) {
    return blocked("publish", "validation_required", target, [
      { code: "validation_required", message: "validation must run first" },
    ]);
  }
  if (!input.validation.ok) {
    return blocked("publish", "validation_failed", target, [
      { code: "validation_failed", message: "draft validation failed" },
    ]);
  }
  if (input.runtimeConfigContract.status === "missing") {
    return blocked("publish", "runtime_config_contract_missing", target, [
      {
        code: "runtime_config_contract_missing",
        message: "runtime config contract is missing",
      },
    ]);
  }
  if (input.runtimeConfigContract.status === "empty") {
    return ready("publish", "ready", target);
  }
  if (!input.productionEnvironmentReadiness) {
    return blocked("publish", "production_config_missing", target, [
      { code: "production_config_missing", message: "prod config is missing" },
    ]);
  }
  if (input.productionEnvironmentReadiness.status !== "ready") {
    return blocked(
      "publish",
      input.productionEnvironmentReadiness.code === "missing"
        ? "production_config_missing"
        : "production_config_incomplete",
      target,
      input.productionEnvironmentReadiness.blockers,
      input.productionEnvironmentReadiness.sanitizedDetails,
    );
  }
  return ready("publish", "ready", target);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function ready(
  kind: HostedIntegrationReadinessKind,
  code: string,
  target: Record<string, string | boolean | null>,
  sanitizedDetails?: Record<string, unknown>,
): HostedIntegrationReadiness {
  return {
    kind,
    status: "ready",
    code,
    target,
    blockers: [],
    ...(sanitizedDetails ? { sanitizedDetails } : {}),
  };
}

function blocked(
  kind: HostedIntegrationReadinessKind,
  code: string,
  target: Record<string, string | boolean | null>,
  blockers: HostedIntegrationReadinessBlocker[],
  sanitizedDetails?: Record<string, unknown>,
): HostedIntegrationReadiness {
  return {
    kind,
    status: "blocked",
    code,
    target,
    blockers,
    ...(sanitizedDetails ? { sanitizedDetails } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
