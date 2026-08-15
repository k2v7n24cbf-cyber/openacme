import {
  resolveEnvironmentConfigReadiness,
  resolveRuntimeConfigContractReadiness,
  type HostedIntegrationReadiness,
} from "./readiness.js";
import type {
  HostedIntegrationEnvironment,
  HostedIntegrationEnvironmentConfig,
  HostedIntegrationGeneration,
  HostedIntegrationRuntimeConfigContract,
  JsonObject,
} from "./schemas.js";
import type { HostedIntegrationPolicyDecision } from "./policy.js";

export type HostedIntegrationExecutionPurpose =
  | "consumer"
  | "debug"
  | "example"
  | "regression"
  | "validation"
  | "parity"
  | "dogfood";

export type HostedIntegrationResolvedExecutionConfig =
  | {
      ok: true;
      mode: "config_backed";
      executionPurpose: HostedIntegrationExecutionPurpose;
      environment: HostedIntegrationEnvironment;
      environmentConfigId: string;
      configRevision: number;
      config: JsonObject;
      secretsEnvironmentConfigId: string;
      readiness: HostedIntegrationReadiness;
    }
  | {
      ok: true;
      mode: "config_free";
      executionPurpose: HostedIntegrationExecutionPurpose;
      environment: HostedIntegrationEnvironment | null;
      environmentConfigId: null;
      configRevision: null;
      config: JsonObject;
      secretsEnvironmentConfigId: null;
      readiness: HostedIntegrationReadiness;
    }
  | {
      ok: false;
      error: HostedIntegrationReadiness;
    };

export interface ResolveHostedIntegrationExecutionConfigInput {
  familyId: string;
  environment: HostedIntegrationEnvironment;
  generation: Pick<HostedIntegrationGeneration, "runtimeConfig">;
  policyDecision: HostedIntegrationPolicyDecision;
  environmentConfig: HostedIntegrationEnvironmentConfig | null;
  executionPurpose: HostedIntegrationExecutionPurpose;
}

export function resolveHostedIntegrationExecutionConfig(
  input: ResolveHostedIntegrationExecutionConfigInput,
): HostedIntegrationResolvedExecutionConfig {
  if (!input.policyDecision.ok) {
    return {
      ok: false,
      error: blocked("invocation", "binding_invalid", {
        familyId: input.familyId,
        environment: input.environment,
      }),
    };
  }

  const runtimeConfig = resolveRuntimeConfigContractReadiness({
    runtimeConfig: input.generation.runtimeConfig,
  });
  if (runtimeConfig.contract.status === "missing") {
    return {
      ok: false,
      error: blocked("invocation", "runtime_config_contract_missing", {
        familyId: input.familyId,
        environment: input.environment,
      }),
    };
  }

  if (runtimeConfig.contract.status === "empty") {
    return {
      ok: true,
      mode: "config_free",
      executionPurpose: input.executionPurpose,
      environment: input.policyDecision.resolvedEnvironment ?? input.environment,
      environmentConfigId: null,
      configRevision: null,
      config: {},
      secretsEnvironmentConfigId: null,
      readiness: readyEnvironmentReadiness(
        input.familyId,
        input.policyDecision.resolvedEnvironment ?? input.environment,
        null,
        "config_free",
        input.executionPurpose,
      ),
    };
  }

  const environment = input.policyDecision.resolvedEnvironment ?? input.environment;
  const readiness = resolveEnvironmentConfigReadiness({
    familyId: input.familyId,
    environment,
    environmentConfig: input.environmentConfig,
    requiredConfigKeys: runtimeConfig.requiredConfigKeys,
    requiredSecretKeys: runtimeConfig.requiredSecretKeys,
  });
  if (readiness.status !== "ready") return { ok: false, error: readiness };
  if (!input.environmentConfig) return { ok: false, error: readiness };

  return {
    ok: true,
    mode: "config_backed",
    executionPurpose: input.executionPurpose,
    environment,
    environmentConfigId: input.environmentConfig.id,
    configRevision: input.environmentConfig.revision,
    config: input.environmentConfig.config,
    secretsEnvironmentConfigId: input.environmentConfig.id,
    readiness: {
      ...readiness,
      sanitizedDetails: {
        ...(readiness.sanitizedDetails ?? {}),
        mode: "config_backed",
        executionPurpose: input.executionPurpose,
      },
    },
  };
}

function readyEnvironmentReadiness(
  familyId: string,
  environment: HostedIntegrationEnvironment,
  environmentConfigId: string | null,
  mode: "config_free",
  executionPurpose: HostedIntegrationExecutionPurpose,
): HostedIntegrationReadiness {
  return {
    kind: "environment_config",
    status: "ready",
    code: "ready",
    target: { familyId, environment, environmentConfigId },
    blockers: [],
    sanitizedDetails: { mode, executionPurpose },
  };
}

function blocked(
  kind: HostedIntegrationReadiness["kind"],
  code: string,
  target: Record<string, string | boolean | null>,
): HostedIntegrationReadiness {
  return {
    kind,
    status: "blocked",
    code,
    target,
    blockers: [{ code, message: code }],
  };
}
