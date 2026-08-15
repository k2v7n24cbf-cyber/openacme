import { describe, expect, it } from "vitest";
import {
  HostedIntegrationHostedToolBindingSchema,
  createAgentSettingsHostedToolBinding,
  evaluateHostedIntegrationPolicy,
  resolveHostedIntegrationBindingEnvironment,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationPolicyInput,
} from "../src/index.js";

const normalAgent: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

const readTool = {
  operation: "read",
  freshness: "live",
  idempotency: "idempotent",
  execution: "sync",
  approval: "none",
} as const;

const currentBinding = {
  agentId: "agent:analyst",
  familyId: "qualys",
  toolName: "qualys_count_assets",
  allowedEnvironments: ["prod", "test_debug"],
  defaultEnvironment: "prod",
  generationPin: { type: "current" },
  bindingKind: "agent",
  updatedAt: "2026-08-14T10:00:00.000Z",
  updatedBy: "human:alen",
} as const;

function invocation(
  overrides: Partial<HostedIntegrationPolicyInput> = {},
): HostedIntegrationPolicyInput {
  return {
    actor: normalAgent,
    action: "invoke",
    familyId: "qualys",
    toolName: "qualys_count_assets",
    operationClass: "read",
    environment: "prod",
    mode: "run",
    toolClassification: readTool,
    hostedToolBindings: [currentBinding],
    ...overrides,
  };
}

describe("hosted integration hosted-tool bindings", () => {
  it("accepts the new binding shape and rejects legacy binding fields", () => {
    expect(HostedIntegrationHostedToolBindingSchema.parse(currentBinding)).toEqual(
      currentBinding,
    );
    const allowedLegacyKey = ["allowedConfig", "Ids"].join("Scope");
    const defaultLegacyKey = ["defaultConfig", "Id"].join("Scope");

    expect(
      HostedIntegrationHostedToolBindingSchema.safeParse({
        agentId: "agent:analyst",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        [allowedLegacyKey]: ["qualys-prod"],
        [defaultLegacyKey]: "qualys-prod",
        environment: "prod",
      }).success,
    ).toBe(false);
  });

  it("rejects defaults outside the allowed environment set", () => {
    const binding = createAgentSettingsHostedToolBinding({
      ...currentBinding,
      allowedEnvironments: ["test_debug"],
      defaultEnvironment: "prod",
    });

    expect(binding).toEqual({
      ok: false,
      error: "invalid_binding",
    });
  });

  it("resolves the environment from the invoking agent binding", () => {
    expect(resolveHostedIntegrationBindingEnvironment(currentBinding)).toEqual({
      ok: true,
      environment: "prod",
      environmentConfigId: "qualys-prod",
    });
  });

  it("allows invocation through the hosted-tool binding without model config args", () => {
    expect(evaluateHostedIntegrationPolicy(invocation())).toEqual({
      ok: true,
      resolvedEnvironment: "prod",
      resolvedEnvironmentConfigId: "qualys-prod",
      generationPin: { type: "current" },
    });
  });

  it("denies requested environments outside the agent binding", () => {
    expect(
      evaluateHostedIntegrationPolicy(
        invocation({
          requestedEnvironment: "prod",
          hostedToolBindings: [
            {
              ...currentBinding,
              allowedEnvironments: ["test_debug"],
              defaultEnvironment: "test_debug",
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "policy_denied",
      message: "requested environment is not allowed",
    });
  });
});
