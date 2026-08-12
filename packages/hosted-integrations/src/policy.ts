import {
  HostedIntegrationPolicyBindingSchema,
  type HostedIntegrationPolicyBinding,
  type HostedIntegrationToolClassification,
} from "./schemas.js";

export type HostedIntegrationPolicyActorKind = "agent" | "human" | "system";

export interface HostedIntegrationPolicyActor {
  id: string;
  kind: HostedIntegrationPolicyActorKind;
  roles: string[];
}

export type HostedIntegrationPolicyAction =
  | "invoke"
  | "debug_run"
  | "edit_draft"
  | "management_tool"
  | "read_secret";

export type HostedIntegrationPolicyMode = "run" | "debug";

export type HostedIntegrationPolicyOperationClass =
  | "read"
  | "write"
  | "destructive"
  | "management"
  | "secret";

export interface HostedIntegrationPolicyInput {
  actor: HostedIntegrationPolicyActor | null;
  action: HostedIntegrationPolicyAction;
  familyId: string;
  toolName?: string;
  operationClass: HostedIntegrationPolicyOperationClass;
  environment: string;
  mode: HostedIntegrationPolicyMode;
  requestedConfigScopeId?: string;
  toolClassification?: HostedIntegrationToolClassification;
  bindings?: HostedIntegrationPolicyBinding[];
  approvalGranted?: boolean;
}

export type HostedIntegrationPolicyDecision =
  | { ok: true; resolvedConfigScopeId?: string }
  | {
      ok: false;
      reason: "policy_denied" | "config_missing" | "approval_required";
      message: string;
    };

type ResolvedConfigScopeDecision =
  | { ok: true; scopeId: string }
  | Extract<HostedIntegrationPolicyDecision, { ok: false }>;

export type CreateAgentSettingsHostedIntegrationBindingResult =
  | { ok: true; binding: HostedIntegrationPolicyBinding }
  | { ok: false; error: string };

export function createAgentSettingsHostedIntegrationBinding(
  input: unknown,
): CreateAgentSettingsHostedIntegrationBindingResult {
  const parsed = HostedIntegrationPolicyBindingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_binding" };
  }
  return { ok: true, binding: parsed.data };
}

export function evaluateHostedIntegrationPolicy(
  input: HostedIntegrationPolicyInput,
): HostedIntegrationPolicyDecision {
  if (!input.actor) {
    return denied("actor is required");
  }

  switch (input.action) {
    case "edit_draft":
      return hasRole(input.actor, "tool_developer")
        ? { ok: true }
        : denied("draft editing requires tool_developer role");
    case "read_secret":
      return hasRole(input.actor, "runtime_secret_resolver")
        ? { ok: true }
        : denied("secret values are human/runtime only");
    case "management_tool":
      return hasRole(input.actor, "tool_developer")
        ? { ok: true }
        : denied("management action requires tool_developer role");
    case "debug_run":
      return hasRole(input.actor, "tool_developer")
        ? { ok: true }
        : denied("debug run requires tool_developer role");
    case "invoke":
      return evaluateInvocation(input);
  }
}

function evaluateInvocation(
  input: HostedIntegrationPolicyInput,
): HostedIntegrationPolicyDecision {
  if (!input.toolName) return denied("tool is required");

  if (
    input.toolClassification?.operation === "destructive" &&
    input.toolClassification.approval !== "none" &&
    input.approvalGranted !== true
  ) {
    return {
      ok: false,
      reason: "approval_required",
      message: "destructive tool requires human approval",
    };
  }

  const binding = (input.bindings ?? []).find(
    (candidate) =>
      candidate.agentId === input.actor?.id &&
      candidate.familyId === input.familyId &&
      candidate.toolName === input.toolName &&
      candidate.environment === input.environment,
  );
  if (!binding) return denied("agent is not bound to hosted integration tool");

  const resolvedConfigScopeId = resolveConfigScope(input, binding);
  if (!resolvedConfigScopeId.ok) return resolvedConfigScopeId;
  return { ok: true, resolvedConfigScopeId: resolvedConfigScopeId.scopeId };
}

function resolveConfigScope(
  input: HostedIntegrationPolicyInput,
  binding: HostedIntegrationPolicyBinding,
): ResolvedConfigScopeDecision {
  if (input.requestedConfigScopeId) {
    if (binding.allowedConfigScopeIds.includes(input.requestedConfigScopeId)) {
      return { ok: true, scopeId: input.requestedConfigScopeId };
    }
    return {
      ok: false,
      reason: "policy_denied",
      message: "requested config scope is not allowed",
    };
  }

  if (binding.defaultConfigScopeId) {
    if (binding.allowedConfigScopeIds.includes(binding.defaultConfigScopeId)) {
      return { ok: true, scopeId: binding.defaultConfigScopeId };
    }
    return {
      ok: false,
      reason: "policy_denied",
      message: "default config scope is not allowed",
    };
  }

  const onlyConfigScopeId = binding.allowedConfigScopeIds[0];
  if (binding.allowedConfigScopeIds.length === 1 && onlyConfigScopeId) {
    return { ok: true, scopeId: onlyConfigScopeId };
  }

  return {
    ok: false,
    reason: "config_missing",
    message: "multiple config scopes require a default",
  };
}

function denied(message: string): HostedIntegrationPolicyDecision {
  return { ok: false, reason: "policy_denied", message };
}

function hasRole(actor: HostedIntegrationPolicyActor, role: string): boolean {
  return actor.roles.includes(role);
}
