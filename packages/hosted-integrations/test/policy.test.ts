import { describe, expect, it } from "vitest";
import {
  createAgentSettingsHostedIntegrationBinding,
  evaluateHostedIntegrationPolicy,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationPolicyInput,
} from "../src/index.js";

const normalAgent: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

const toolDeveloper: HostedIntegrationPolicyActor = {
  id: "agent:tool-developer",
  kind: "agent",
  roles: ["tool_developer"],
};

const readTool = {
  operation: "read",
  freshness: "live",
  idempotency: "idempotent",
  execution: "sync",
  approval: "none",
} as const;

const destructiveTool = {
  operation: "destructive",
  freshness: "live",
  idempotency: "non_idempotent",
  execution: "sync",
  approval: "human",
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
    bindings: [
      {
        agentId: "agent:analyst",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedConfigScopeIds: ["qualys-prod-readonly"],
        defaultConfigScopeId: "qualys-prod-readonly",
        environment: "prod",
      },
    ],
    ...overrides,
  };
}

describe("hosted integration access policy", () => {
  it("denies unknown actors by default", () => {
    expect(
      evaluateHostedIntegrationPolicy(invocation({ actor: null })),
    ).toEqual({
      ok: false,
      reason: "policy_denied",
      message: "actor is required",
    });
  });

  it("allows Tool Developer Agent draft edits but denies secret reads", () => {
    expect(
      evaluateHostedIntegrationPolicy({
        actor: toolDeveloper,
        action: "edit_draft",
        familyId: "qualys",
        operationClass: "management",
        environment: "prod",
        mode: "debug",
      }),
    ).toEqual({ ok: true });

    expect(
      evaluateHostedIntegrationPolicy({
        actor: toolDeveloper,
        action: "read_secret",
        familyId: "qualys",
        operationClass: "secret",
        environment: "prod",
        mode: "debug",
      }),
    ).toEqual({
      ok: false,
      reason: "policy_denied",
      message: "secret values are human/runtime only",
    });
  });

  it("allows normal agents to invoke explicitly bound hosted integration tools", () => {
    expect(evaluateHostedIntegrationPolicy(invocation())).toEqual({
      ok: true,
      resolvedConfigScopeId: "qualys-prod-readonly",
    });
  });

  it("denies normal agents calling hosted integration management tools", () => {
    expect(
      evaluateHostedIntegrationPolicy(
        invocation({
          action: "management_tool",
          operationClass: "management",
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "policy_denied",
      message: "management action requires tool_developer role",
    });
  });

  it("resolves the default config scope from the agent tool binding", () => {
    expect(
      evaluateHostedIntegrationPolicy(
        invocation({ requestedConfigScopeId: undefined }),
      ),
    ).toEqual({
      ok: true,
      resolvedConfigScopeId: "qualys-prod-readonly",
    });
  });

  it("fails before runtime when multiple scopes are allowed without a default", () => {
    expect(
      evaluateHostedIntegrationPolicy(
        invocation({
          bindings: [
            {
              agentId: "agent:analyst",
              familyId: "qualys",
              toolName: "qualys_count_assets",
              allowedConfigScopeIds: ["qualys-prod", "qualys-stage"],
              environment: "prod",
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "config_missing",
      message: "multiple config scopes require a default",
    });
  });

  it("does not let Agent Settings bindings grant management-tool access", () => {
    const binding = createAgentSettingsHostedIntegrationBinding({
      agentId: "agent:analyst",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      allowedConfigScopeIds: ["qualys-prod-readonly"],
      defaultConfigScopeId: "qualys-prod-readonly",
      environment: "prod",
    });
    expect(binding).toMatchObject({ ok: true });

    expect(
      evaluateHostedIntegrationPolicy(
        invocation({
          action: "management_tool",
          operationClass: "management",
          bindings: binding.ok ? [binding.binding] : [],
        }),
      ),
    ).toMatchObject({ ok: false, reason: "policy_denied" });
  });

  it("does not let Agent Settings bindings bypass destructive approval policy", () => {
    expect(
      evaluateHostedIntegrationPolicy(
        invocation({
          toolName: "qualys_delete_asset",
          operationClass: "destructive",
          toolClassification: destructiveTool,
          bindings: [
            {
              agentId: "agent:analyst",
              familyId: "qualys",
              toolName: "qualys_delete_asset",
              allowedConfigScopeIds: ["qualys-prod-readonly"],
              defaultConfigScopeId: "qualys-prod-readonly",
              environment: "prod",
            },
          ],
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "approval_required",
      message: "destructive tool requires human approval",
    });
  });
});
