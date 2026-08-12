import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

export const HOSTED_INTEGRATION_MANAGEMENT_TOOL_NAMES = [
  "hosted_integration_family_list",
  "hosted_integration_family_create",
  "hosted_integration_source_read",
  "hosted_integration_lock_acquire",
  "hosted_integration_lock_renew",
  "hosted_integration_lock_release",
  "hosted_integration_draft_create",
  "hosted_integration_draft_get",
  "hosted_integration_draft_patch",
  "hosted_integration_draft_delete",
  "hosted_integration_example_list",
  "hosted_integration_example_upsert",
  "hosted_integration_example_run",
  "hosted_integration_validate",
  "hosted_integration_promote",
  "hosted_integration_generation_list",
  "hosted_integration_generation_get",
  "hosted_integration_generation_rollback",
  "hosted_integration_config_scope_list",
  "hosted_integration_config_scope_get",
  "hosted_integration_debug_run",
  "hosted_integration_run_get",
  "hosted_integration_artifact_get",
  "hosted_integration_failure_bucket_list",
  "hosted_integration_failure_bucket_get",
  "hosted_integration_failure_bucket_assign",
  "hosted_integration_failure_bucket_close",
] as const;

export type HostedIntegrationManagementToolName =
  (typeof HOSTED_INTEGRATION_MANAGEMENT_TOOL_NAMES)[number];

export interface HostedIntegrationManagementRequest {
  actorId: string;
  toolName: HostedIntegrationManagementToolName;
  operation: HostedIntegrationManagementToolName;
  params: Record<string, unknown>;
}

export interface HostedIntegrationManagementBindings {
  invoke(request: HostedIntegrationManagementRequest): Promise<unknown>;
}

let bindings: HostedIntegrationManagementBindings | null = null;

export function bindHostedIntegrationManagement(
  b: HostedIntegrationManagementBindings | null,
): void {
  bindings = b;
}

const JsonObjectParam = z.record(z.string(), z.unknown());
const OptionalPositiveInteger = z.number().int().positive().optional();
const FamilyId = z.string().min(1);
const DraftId = z.string().min(1);
const LockId = z.string().min(1);
const GenerationId = z.string().min(1);
const RunId = z.string().min(1);
const BucketId = z.string().min(1);

const ExampleParam = z
  .object({
    id: z.string().min(1),
    familyId: FamilyId,
    toolName: z.string().min(1),
    category: z.enum([
      "smoke",
      "live_safe",
      "regression",
      "mock_only",
      "destructive_requires_human",
    ]),
    args: JsonObjectParam,
    expected: z.unknown().optional(),
  })
  .strict();

const definitions: Array<{
  name: HostedIntegrationManagementToolName;
  description: string;
  parameters: z.ZodObject;
}> = [
  {
    name: "hosted_integration_family_list",
    description: "List hosted integration families visible to the platform.",
    parameters: z.object({}).strict(),
  },
  {
    name: "hosted_integration_family_create",
    description:
      "Create a proposed hosted integration family and initial draft.",
    parameters: z
      .object({
        family_id: FamilyId,
        name: z.string().min(1),
        tool_name: z.string().min(1),
        ttl_ms: OptionalPositiveInteger,
      })
      .strict(),
  },
  {
    name: "hosted_integration_source_read",
    description:
      "Inspect canonical family source or a draft source file without filesystem access.",
    parameters: z
      .object({
        family_id: FamilyId.optional(),
        draft_id: DraftId.optional(),
        path: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    name: "hosted_integration_lock_acquire",
    description: "Acquire the edit lock for a hosted integration family.",
    parameters: z
      .object({ family_id: FamilyId, ttl_ms: OptionalPositiveInteger })
      .strict(),
  },
  {
    name: "hosted_integration_lock_renew",
    description: "Renew an active hosted integration family edit lock.",
    parameters: z
      .object({ lock_id: LockId, ttl_ms: OptionalPositiveInteger })
      .strict(),
  },
  {
    name: "hosted_integration_lock_release",
    description: "Release an active hosted integration family edit lock.",
    parameters: z.object({ lock_id: LockId }).strict(),
  },
  {
    name: "hosted_integration_draft_create",
    description: "Create a draft for a locked hosted integration family.",
    parameters: z
      .object({
        family_id: FamilyId,
        lock_id: LockId,
        source_revision_id: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    name: "hosted_integration_draft_get",
    description: "Inspect a hosted integration draft or one draft source file.",
    parameters: z
      .object({ draft_id: DraftId, path: z.string().min(1).optional() })
      .strict(),
  },
  {
    name: "hosted_integration_draft_patch",
    description: "Write a source file in a locked hosted integration draft.",
    parameters: z
      .object({
        draft_id: DraftId,
        lock_id: LockId,
        path: z.string().min(1),
        content: z.string(),
      })
      .strict(),
  },
  {
    name: "hosted_integration_draft_delete",
    description: "Delete a source file from a locked hosted integration draft.",
    parameters: z
      .object({ draft_id: DraftId, lock_id: LockId, path: z.string().min(1) })
      .strict(),
  },
  {
    name: "hosted_integration_example_list",
    description:
      "List registered test examples for a hosted integration draft.",
    parameters: z.object({ draft_id: DraftId }).strict(),
  },
  {
    name: "hosted_integration_example_upsert",
    description: "Create or update a test example for a locked draft.",
    parameters: z
      .object({ draft_id: DraftId, lock_id: LockId, example: ExampleParam })
      .strict(),
  },
  {
    name: "hosted_integration_example_run",
    description: "Run a registered safe draft test example.",
    parameters: z
      .object({ draft_id: DraftId, example_id: z.string().min(1) })
      .strict(),
  },
  {
    name: "hosted_integration_validate",
    description: "Validate a hosted integration draft.",
    parameters: z.object({ draft_id: DraftId }).strict(),
  },
  {
    name: "hosted_integration_promote",
    description:
      "Promote a validated draft. Destructive promotions still require separate human approval.",
    parameters: z
      .object({
        draft_id: DraftId,
        lock_id: LockId,
        approval_id: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    name: "hosted_integration_generation_list",
    description: "List hosted integration generations.",
    parameters: z.object({ family_id: FamilyId.optional() }).strict(),
  },
  {
    name: "hosted_integration_generation_get",
    description: "Inspect one hosted integration generation.",
    parameters: z.object({ generation_id: GenerationId }).strict(),
  },
  {
    name: "hosted_integration_generation_rollback",
    description:
      "Roll back a hosted integration family to an older generation.",
    parameters: z.object({ generation_id: GenerationId }).strict(),
  },
  {
    name: "hosted_integration_config_scope_list",
    description:
      "List hosted integration config scopes with sanitized secret metadata.",
    parameters: z.object({}).strict(),
  },
  {
    name: "hosted_integration_config_scope_get",
    description:
      "Inspect one hosted integration config scope with sanitized secret metadata.",
    parameters: z.object({ scope_id: z.string().min(1) }).strict(),
  },
  {
    name: "hosted_integration_debug_run",
    description:
      "Run a debug invocation as the Tool Developer Agent. Writes require explicit allow_writes.",
    parameters: z
      .object({
        family_id: FamilyId,
        tool_name: z.string().min(1),
        environment: z.string().min(1),
        config_scope_id: z.string().min(1),
        args: JsonObjectParam.default({}),
        generation_id: GenerationId.optional(),
        operation_class: z
          .enum(["read", "write", "destructive"])
          .default("read"),
        allow_writes: z.boolean().optional(),
      })
      .strict(),
  },
  {
    name: "hosted_integration_run_get",
    description: "Inspect a hosted integration execution log entry.",
    parameters: z.object({ run_id: RunId }).strict(),
  },
  {
    name: "hosted_integration_artifact_get",
    description: "Read a sanitized hosted integration run artifact.",
    parameters: z.object({ run_id: RunId, name: z.string().min(1) }).strict(),
  },
  {
    name: "hosted_integration_failure_bucket_list",
    description: "List hosted integration failure buckets assigned for repair.",
    parameters: z.object({ family_id: FamilyId.optional() }).strict(),
  },
  {
    name: "hosted_integration_failure_bucket_get",
    description: "Inspect one hosted integration failure bucket.",
    parameters: z.object({ bucket_id: BucketId }).strict(),
  },
  {
    name: "hosted_integration_failure_bucket_assign",
    description: "Assign a hosted integration failure bucket to an agent.",
    parameters: z
      .object({ bucket_id: BucketId, assigned_to: z.string().min(1) })
      .strict(),
  },
  {
    name: "hosted_integration_failure_bucket_close",
    description:
      "Close a hosted integration failure bucket after repair evidence exists.",
    parameters: z
      .object({
        bucket_id: BucketId,
        draft_id: DraftId.optional(),
        generation_id: GenerationId.optional(),
        regression_example_id: z.string().min(1).optional(),
      })
      .strict(),
  },
];

for (const definition of definitions) {
  registry.register({
    name: definition.name,
    toolset: "hosted-integration-management",
    description: definition.description,
    parameters: definition.parameters,
    parallelSafe: false,
    handler: async (args) => invokeManagementTool(definition.name, args),
  });
}

async function invokeManagementTool(
  toolName: HostedIntegrationManagementToolName,
  args: Record<string, unknown>,
): Promise<string> {
  if (!bindings) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "platform_unavailable",
        message:
          "hosted integration management tools are not initialized — ServerRuntime must bind them.",
      },
    });
  }
  const actorId = getCurrentAgentId();
  if (!actorId) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "policy_denied",
        message:
          "hosted integration management tools require an active agent context.",
      },
    });
  }

  try {
    const result = await bindings.invoke({
      actorId,
      toolName,
      operation: toolName,
      params: args,
    });
    return JSON.stringify(sanitizeManagementResult(result));
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|passwd|pwd|credential|api[_-]?key|authorization)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+|raw-token|super-secret[^\s",}]*)/gi;

function sanitizeManagementResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeManagementResult);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key)
          ? REDACTED
          : sanitizeManagementResult(child),
      ]),
    );
  }
  if (typeof value === "string") {
    return value.replace(SENSITIVE_VALUE_PATTERN, REDACTED);
  }
  return value;
}
