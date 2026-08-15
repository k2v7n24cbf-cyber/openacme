import {
  HostedIntegrationEnvironmentSchema,
  HostedIntegrationHostedToolBindingSchema,
  type HostedIntegrationEnvironment,
  type HostedIntegrationGenerationPin,
  type HostedIntegrationHostedToolBinding,
  type HostedIntegrationToolClassification,
} from "./schemas.js";
import { hostedIntegrationEnvironmentConfigId } from "./environment-configs.js";

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
  requestedEnvironment?: string;
  toolClassification?: HostedIntegrationToolClassification;
  hostedToolBindings?: HostedIntegrationHostedToolBinding[];
  approvalGranted?: boolean;
}

export type HostedIntegrationPolicyDecision =
  | {
      ok: true;
      resolvedEnvironment?: HostedIntegrationEnvironment;
      resolvedEnvironmentConfigId?: string;
      generationPin?: HostedIntegrationGenerationPin;
    }
  | {
      ok: false;
      reason: "policy_denied" | "config_missing" | "approval_required";
      message: string;
    };

export type CreateAgentSettingsHostedToolBindingResult =
  | { ok: true; binding: HostedIntegrationHostedToolBinding }
  | { ok: false; error: string };

export function createAgentSettingsHostedToolBinding(
  input: unknown,
): CreateAgentSettingsHostedToolBindingResult {
  const parsed = HostedIntegrationHostedToolBindingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_binding" };
  }
  return { ok: true, binding: parsed.data };
}

export type ResolveHostedIntegrationBindingEnvironmentResult =
  | {
      ok: true;
      environment: HostedIntegrationEnvironment;
      environmentConfigId: string;
    }
  | {
      ok: false;
      reason: "policy_denied" | "config_missing";
      message: string;
    };

export function resolveHostedIntegrationBindingEnvironment(
  binding: HostedIntegrationHostedToolBinding,
  requestedEnvironment?: string,
): ResolveHostedIntegrationBindingEnvironmentResult {
  const environment = requestedEnvironment ?? binding.defaultEnvironment;
  const parsedEnvironment = HostedIntegrationEnvironmentSchema.safeParse(
    environment,
  );
  if (!parsedEnvironment.success) {
    return {
      ok: false,
      reason: "policy_denied",
      message: "requested environment is not allowed",
    };
  }
  if (!binding.allowedEnvironments.includes(parsedEnvironment.data)) {
    return {
      ok: false,
      reason: "policy_denied",
      message: "requested environment is not allowed",
    };
  }
  return {
    ok: true,
    environment: parsedEnvironment.data,
    environmentConfigId: hostedIntegrationEnvironmentConfigId(
      binding.familyId,
      parsedEnvironment.data,
    ),
  };
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

  const hostedToolBinding = (input.hostedToolBindings ?? []).find(
    (candidate) =>
      candidate.agentId === input.actor?.id &&
      candidate.familyId === input.familyId &&
      candidate.toolName === input.toolName,
  );
  if (hostedToolBinding) {
    const resolved = resolveHostedIntegrationBindingEnvironment(
      hostedToolBinding,
      input.requestedEnvironment,
    );
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      resolvedEnvironment: resolved.environment,
      resolvedEnvironmentConfigId: resolved.environmentConfigId,
      generationPin: hostedToolBinding.generationPin,
    };
  }

  return denied("agent is not bound to hosted integration tool");
}

function denied(message: string): HostedIntegrationPolicyDecision {
  return { ok: false, reason: "policy_denied", message };
}

function hasRole(actor: HostedIntegrationPolicyActor, role: string): boolean {
  return actor.roles.includes(role);
}
