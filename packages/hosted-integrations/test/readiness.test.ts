import { describe, expect, it } from "vitest";
import {
  resolveAgentHostedToolBindingReadiness,
  resolveDebugReadiness,
  resolveEnvironmentConfigReadiness,
  resolveInvocationReadiness,
  resolvePublishReadiness,
  resolveRuntimeConfigContractReadiness,
  type HostedIntegrationEnvironment,
  type HostedIntegrationHostedToolBinding,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationReadiness,
} from "../src/index.js";

const agent: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

const toolDeveloper: HostedIntegrationPolicyActor = {
  id: "agent:tool-developer",
  kind: "agent",
  roles: ["tool_developer"],
};

describe("hosted integration readiness resolvers", () => {
  it("covers every environment config readiness state without exposing values", () => {
    const cases = [
      {
        name: "missing",
        result: resolveEnvironmentConfigReadiness({
          familyId: "qualys",
          environment: "prod",
          environmentConfig: null,
          requiredConfigKeys: ["QUALYS_BASE_URL"],
          requiredSecretKeys: ["QUALYS_PASSWORD"],
        }),
        status: "blocked",
        code: "missing",
      },
      {
        name: "incomplete",
        result: resolveEnvironmentConfigReadiness({
          familyId: "qualys",
          environment: "prod",
          environmentConfig: environmentConfig("prod", {
            config: { QUALYS_BASE_URL: "https://qualys.example" },
            secrets: { QUALYS_PASSWORD: { configured: false } },
          }),
          requiredConfigKeys: ["QUALYS_BASE_URL"],
          requiredSecretKeys: ["QUALYS_PASSWORD"],
        }),
        status: "blocked",
        code: "incomplete",
      },
      {
        name: "conflicted",
        result: resolveEnvironmentConfigReadiness({
          familyId: "qualys",
          environment: "prod",
          environmentConfig: environmentConfig("prod"),
          conflicted: true,
        }),
        status: "blocked",
        code: "conflicted",
      },
      {
        name: "quarantined",
        result: resolveEnvironmentConfigReadiness({
          familyId: "qualys",
          environment: "prod",
          environmentConfig: environmentConfig("prod"),
          quarantined: true,
        }),
        status: "blocked",
        code: "quarantined",
      },
      {
        name: "ready",
        result: resolveEnvironmentConfigReadiness({
          familyId: "qualys",
          environment: "prod",
          environmentConfig: environmentConfig("prod", {
            config: { QUALYS_BASE_URL: "https://qualys.example" },
            secrets: { QUALYS_PASSWORD: { configured: true } },
          }),
          requiredConfigKeys: ["QUALYS_BASE_URL"],
          requiredSecretKeys: ["QUALYS_PASSWORD"],
        }),
        status: "ready",
        code: "ready",
      },
    ] as const;

    for (const testCase of cases) {
      expect(testCase.result, testCase.name).toMatchObject({
        kind: "environment_config",
        status: testCase.status,
        code: testCase.code,
        target: {
          familyId: "qualys",
          environment: "prod",
          environmentConfigId: "qualys-prod",
        },
      });
      expect(JSON.stringify(testCase.result), testCase.name).not.toContain(
        "qualys.example",
      );
      expect(JSON.stringify(testCase.result), testCase.name).not.toContain(
        "raw-token",
      );
    }
  });

  it("covers every hosted-tool binding readiness state", () => {
    const cases = [
      {
        name: "missing",
        result: resolveAgentHostedToolBindingReadiness({
          agentId: "agent:analyst",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          hostedToolBindings: [],
        }),
        status: "blocked",
        code: "missing",
      },
      {
        name: "invalid",
        result: resolveAgentHostedToolBindingReadiness({
          agentId: "agent:analyst",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          hostedToolBindings: [
            {
              ...binding(),
              allowedEnvironments: ["test_debug"],
              defaultEnvironment: "prod",
            },
          ],
        }),
        status: "blocked",
        code: "invalid",
      },
      {
        name: "denied",
        result: resolveAgentHostedToolBindingReadiness({
          agentId: "agent:analyst",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          hostedToolBindings: [binding()],
          policyDecision: {
            ok: false,
            reason: "policy_denied",
            message: "agent cannot call this hosted tool",
          },
        }),
        status: "blocked",
        code: "denied",
      },
      {
        name: "stale_generation",
        result: resolveAgentHostedToolBindingReadiness({
          agentId: "agent:analyst",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          hostedToolBindings: [
            binding({ generationPin: { type: "generation", generationId: "gen_old" } }),
          ],
          activeGenerationId: "gen_current",
        }),
        status: "blocked",
        code: "stale_generation",
      },
      {
        name: "ready",
        result: resolveAgentHostedToolBindingReadiness({
          agentId: "agent:analyst",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          hostedToolBindings: [binding()],
        }),
        status: "ready",
        code: "ready",
      },
    ] as const;

    for (const testCase of cases) {
      expect(testCase.result, testCase.name).toMatchObject({
        kind: "binding",
        status: testCase.status,
        code: testCase.code,
      });
    }
  });

  it("covers every publish readiness state", () => {
    const base = {
      draftId: "draft_1",
      draftExists: true,
      hasLock: true,
      validation: { ok: true },
      runtimeConfigContract: { status: "empty" as const },
      productionEnvironmentReadiness: readyEnvironment("qualys", "prod"),
    };
    const cases = [
      {
        name: "draft_missing",
        result: resolvePublishReadiness({ ...base, draftExists: false }),
        code: "draft_missing",
        status: "blocked",
      },
      {
        name: "lock_required",
        result: resolvePublishReadiness({ ...base, hasLock: false }),
        code: "lock_required",
        status: "blocked",
      },
      {
        name: "validation_required",
        result: resolvePublishReadiness({ ...base, validation: null }),
        code: "validation_required",
        status: "blocked",
      },
      {
        name: "validation_failed",
        result: resolvePublishReadiness({ ...base, validation: { ok: false } }),
        code: "validation_failed",
        status: "blocked",
      },
      {
        name: "runtime_config_contract_missing",
        result: resolvePublishReadiness({
          ...base,
          runtimeConfigContract: { status: "missing" },
        }),
        code: "runtime_config_contract_missing",
        status: "blocked",
      },
      {
        name: "production_config_missing",
        result: resolvePublishReadiness({
          ...base,
          runtimeConfigContract: { status: "requires" },
          productionEnvironmentReadiness: missingEnvironment("qualys", "prod"),
        }),
        code: "production_config_missing",
        status: "blocked",
      },
      {
        name: "production_config_incomplete",
        result: resolvePublishReadiness({
          ...base,
          runtimeConfigContract: { status: "requires" },
          productionEnvironmentReadiness: incompleteEnvironment("qualys", "prod"),
        }),
        code: "production_config_incomplete",
        status: "blocked",
      },
      {
        name: "ready",
        result: resolvePublishReadiness(base),
        code: "ready",
        status: "ready",
      },
    ] as const;

    for (const testCase of cases) {
      expect(testCase.result, testCase.name).toMatchObject({
        kind: "publish",
        status: testCase.status,
        code: testCase.code,
      });
    }
  });

  it("resolves runtime config contract state from the manifest explicitly", () => {
    expect(resolveRuntimeConfigContractReadiness({})).toEqual({
      contract: { status: "missing" },
      requiredConfigKeys: [],
      requiredSecretKeys: [],
    });
    expect(
      resolveRuntimeConfigContractReadiness({
        runtimeConfig: {
          requiredConfigKeys: [],
          requiredSecretKeys: [],
        },
      }),
    ).toEqual({
      contract: { status: "empty" },
      requiredConfigKeys: [],
      requiredSecretKeys: [],
    });
    expect(
      resolveRuntimeConfigContractReadiness({
        runtimeConfig: {
          requiredConfigKeys: ["QUALYS_BASE_URL", "QUALYS_BASE_URL"],
          requiredSecretKeys: ["QUALYS_PASSWORD"],
        },
      }),
    ).toEqual({
      contract: { status: "requires" },
      requiredConfigKeys: ["QUALYS_BASE_URL"],
      requiredSecretKeys: ["QUALYS_PASSWORD"],
    });
  });

  it("covers every debug readiness state", () => {
    const cases = [
      {
        name: "actor_denied",
        result: resolveDebugReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          operation: "read",
          environmentReadiness: readyEnvironment("qualys", "test_debug"),
        }),
        code: "actor_denied",
        status: "blocked",
      },
      {
        name: "approval_required",
        result: resolveDebugReadiness({
          actor: toolDeveloper,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          operation: "read",
          requiresApproval: true,
          approvalGranted: false,
          environmentReadiness: readyEnvironment("qualys", "test_debug"),
        }),
        code: "approval_required",
        status: "blocked",
      },
      {
        name: "environment_missing",
        result: resolveDebugReadiness({
          actor: toolDeveloper,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          operation: "read",
          environmentReadiness: missingEnvironment("qualys", "test_debug"),
        }),
        code: "environment_missing",
        status: "blocked",
      },
      {
        name: "environment_incomplete",
        result: resolveDebugReadiness({
          actor: toolDeveloper,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          operation: "read",
          environmentReadiness: incompleteEnvironment("qualys", "test_debug"),
        }),
        code: "environment_incomplete",
        status: "blocked",
      },
      {
        name: "prod_environment_requires_explicit_allow",
        result: resolveDebugReadiness({
          actor: toolDeveloper,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          environment: "prod",
          allowProdEnvironment: false,
          operation: "read",
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "prod_environment_requires_explicit_allow",
        status: "blocked",
      },
      {
        name: "tool_not_debuggable",
        result: resolveDebugReadiness({
          actor: toolDeveloper,
          familyId: "qualys",
          toolName: "qualys_purge_asset",
          operation: "destructive",
          environmentReadiness: readyEnvironment("qualys", "test_debug"),
        }),
        code: "tool_not_debuggable",
        status: "blocked",
      },
      {
        name: "ready",
        result: resolveDebugReadiness({
          actor: toolDeveloper,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          operation: "read",
          environmentReadiness: readyEnvironment("qualys", "test_debug"),
        }),
        code: "ready",
        status: "ready",
      },
    ] as const;

    for (const testCase of cases) {
      expect(testCase.result, testCase.name).toMatchObject({
        kind: "debug",
        status: testCase.status,
        code: testCase.code,
      });
    }
  });

  it("covers every invocation readiness state", () => {
    const okPolicy = {
      ok: true,
      resolvedEnvironment: "prod",
      resolvedEnvironmentConfigId: "qualys-prod",
      generationPin: { type: "current" },
    } as const;
    const cases = [
      {
        name: "tool_not_enabled",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          toolLifecycle: "hidden",
          policyDecision: okPolicy,
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "tool_not_enabled",
        status: "blocked",
      },
      {
        name: "binding_missing",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: {
            ok: false,
            reason: "policy_denied",
            message: "agent is not bound to hosted integration tool",
          },
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "binding_missing",
        status: "blocked",
      },
      {
        name: "binding_invalid",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: {
            ok: false,
            reason: "policy_denied",
            message: "requested environment is not allowed",
          },
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "binding_invalid",
        status: "blocked",
      },
      {
        name: "environment_missing",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: okPolicy,
          environmentReadiness: missingEnvironment("qualys", "prod"),
        }),
        code: "environment_missing",
        status: "blocked",
      },
      {
        name: "environment_incomplete",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: okPolicy,
          environmentReadiness: incompleteEnvironment("qualys", "prod"),
        }),
        code: "environment_incomplete",
        status: "blocked",
      },
      {
        name: "generation_stale",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: okPolicy,
          environmentReadiness: readyEnvironment("qualys", "prod"),
          capturedGenerationId: "gen_old",
          resolvedGenerationId: "gen_current",
        }),
        code: "generation_stale",
        status: "blocked",
      },
      {
        name: "tool_disabled",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          toolLifecycle: "disabled",
          policyDecision: okPolicy,
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "tool_disabled",
        status: "blocked",
      },
      {
        name: "approval_required",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: {
            ok: false,
            reason: "approval_required",
            message: "approval is required",
          },
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "approval_required",
        status: "blocked",
      },
      {
        name: "ready",
        result: resolveInvocationReadiness({
          actor: agent,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          policyDecision: okPolicy,
          environmentReadiness: readyEnvironment("qualys", "prod"),
        }),
        code: "ready",
        status: "ready",
      },
    ] as const;

    for (const testCase of cases) {
      expect(testCase.result, testCase.name).toMatchObject({
        kind: "invocation",
        status: testCase.status,
        code: testCase.code,
      });
    }
  });
});

function environmentConfig(
  environment: HostedIntegrationEnvironment,
  overrides: Partial<ReturnType<typeof environmentConfig>> = {},
) {
  return {
    id: `qualys-${environment}`,
    familyId: "qualys",
    environment,
    revision: 1,
    config: {},
    secrets: {},
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:alen",
    ...overrides,
  };
}

function binding(
  overrides: Partial<HostedIntegrationHostedToolBinding> = {},
): HostedIntegrationHostedToolBinding {
  return {
    agentId: "agent:analyst",
    familyId: "qualys",
    toolName: "qualys_count_assets",
    allowedEnvironments: ["prod", "test_debug"],
    defaultEnvironment: "prod",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:alen",
    ...overrides,
  };
}

function readyEnvironment(
  familyId: string,
  environment: HostedIntegrationEnvironment,
): HostedIntegrationReadiness {
  return resolveEnvironmentConfigReadiness({
    familyId,
    environment,
    environmentConfig: environmentConfig(environment),
  });
}

function missingEnvironment(
  familyId: string,
  environment: HostedIntegrationEnvironment,
): HostedIntegrationReadiness {
  return resolveEnvironmentConfigReadiness({
    familyId,
    environment,
    environmentConfig: null,
  });
}

function incompleteEnvironment(
  familyId: string,
  environment: HostedIntegrationEnvironment,
): HostedIntegrationReadiness {
  return resolveEnvironmentConfigReadiness({
    familyId,
    environment,
    environmentConfig: environmentConfig(environment, {
      config: { QUALYS_BASE_URL: "https://qualys.example" },
      secrets: { QUALYS_PASSWORD: { configured: false } },
    }),
    requiredConfigKeys: ["QUALYS_BASE_URL"],
    requiredSecretKeys: ["QUALYS_PASSWORD"],
  });
}
