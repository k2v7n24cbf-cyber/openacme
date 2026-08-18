import { z } from "zod";
import {
  HostedFamilyPackageDocumentSchema,
  parseHostedToolName,
} from "@openacme/hosted-integrations";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";
import { sanitizeHostedToolControlPlaneResult } from "./hosted-integration-redaction.js";

export const HOSTED_TOOL_MANAGEMENT_TOOL_NAMES = [
  "hosted_tool_family_list",
  "hosted_tool_family_create",
  "hosted_tool_family_import",
  "hosted_tool_family_export",
  "hosted_tool_source_read",
  "hosted_tool_source_view",
  "hosted_tool_lock_acquire",
  "hosted_tool_lock_renew",
  "hosted_tool_lock_release",
  "hosted_tool_draft_create",
  "hosted_tool_draft_get",
  "hosted_tool_draft_patch",
  "hosted_tool_draft_delete",
  "hosted_tool_example_list",
  "hosted_tool_example_upsert",
  "hosted_tool_example_run",
  "hosted_tool_validate",
  "hosted_tool_promote",
  "hosted_tool_generation_list",
  "hosted_tool_generation_get",
  "hosted_tool_generation_diff",
  "hosted_tool_generation_rollback",
  "hosted_tool_environment_config_list",
  "hosted_tool_environment_config_get",
  "hosted_tool_readiness_get",
  "hosted_tool_debug_run",
  "hosted_tool_run_get",
  "hosted_tool_artifact_get",
  "hosted_tool_failure_bucket_list",
  "hosted_tool_failure_bucket_get",
  "hosted_tool_failure_bucket_assign",
  "hosted_tool_failure_bucket_close",
] as const;

export type HostedToolManagementToolName =
  (typeof HOSTED_TOOL_MANAGEMENT_TOOL_NAMES)[number];

export interface HostedToolManagementRequest {
  actorId: string;
  toolName: HostedToolManagementToolName;
  operation: HostedToolManagementToolName;
  params: Record<string, unknown>;
}

export interface HostedToolManagementBindings {
  invoke(request: HostedToolManagementRequest): Promise<unknown>;
}

let bindings: HostedToolManagementBindings | null = null;

export function bindHostedToolManagement(
  b: HostedToolManagementBindings | null,
): void {
  bindings = b;
}

const JsonObjectParam = z.record(z.string(), z.unknown());
const OptionalPositiveInteger = z
  .number()
  .int()
  .positive()
  .nullable()
  .optional();
const OptionalStringParam = z.string().min(1).nullable().optional();
const FamilyId = z.string().min(1);
const NativeToolName = z
  .string()
  .min(1)
  .refine(
    (value) => parseHostedToolName(value) === null,
    "must be a family-native hosted tool name, not a canonical hosted registry name",
  );
const DraftId = z.string().min(1);
const LockId = z.string().min(1);
const GenerationId = z.string().min(1);
const RunId = z.string().min(1);
const BucketId = z.string().min(1);
const ReadinessTargetParams = z.discriminatedUnion("target_type", [
  z
    .object({
      target_type: z.literal("environment_config"),
      family_id: FamilyId,
      environment: z.enum(["prod", "test_debug"]),
    })
    .strict(),
  z
    .object({
      target_type: z.literal("binding"),
      agent_id: z.string().min(1),
      family_id: FamilyId,
      tool_name: NativeToolName,
    })
    .strict(),
  z
    .object({
      target_type: z.literal("publish"),
      draft_id: DraftId,
    })
    .strict(),
  z
    .object({
      target_type: z.literal("debug"),
      family_id: FamilyId,
      tool_name: NativeToolName,
      environment: z.enum(["prod", "test_debug"]).default("test_debug"),
      allow_prod_environment: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      target_type: z.literal("invocation"),
      agent_id: z.string().min(1),
      family_id: FamilyId,
      tool_name: NativeToolName,
      captured_generation_id: GenerationId.nullable().optional(),
    })
    .strict(),
]);
const SourceReadStartLine = z.number().int().positive().nullable().optional();
const SourceReadMaxLines = z
  .number()
  .int()
  .positive()
  .max(1_000)
  .nullable()
  .optional();
const PackageExportSourceParams = z.discriminatedUnion("source_type", [
  z.object({ source_type: z.literal("active_generation"), family_id: FamilyId }).strict(),
  z.object({ source_type: z.literal("generation"), generation_id: GenerationId }).strict(),
  z.object({ source_type: z.literal("draft"), draft_id: DraftId }).strict(),
  z.object({ source_type: z.literal("current_source"), family_id: FamilyId }).strict(),
]);

const ExampleParam = z
  .object({
    id: z.string().min(1),
    familyId: FamilyId,
    toolName: NativeToolName,
    category: z.enum([
      "smoke",
      "live_safe",
      "regression",
      "mock_only",
      "discovery_required",
      "destructive_requires_human",
    ]),
    args: JsonObjectParam,
    expected: z.unknown().optional(),
  })
  .strict();

const definitions: Array<{
  name: HostedToolManagementToolName;
  description: string;
  parameters: z.ZodType;
}> = [
  {
    name: "hosted_tool_family_list",
    description: "List hosted integration families visible to the platform.",
    parameters: z.object({}).strict(),
  },
  {
    name: "hosted_tool_family_create",
    description:
      "Create a proposed hosted integration family and initial draft.",
    parameters: z
      .object({
        family_id: FamilyId,
        name: z.string().min(1),
        tool_name: NativeToolName,
        ttl_ms: OptionalPositiveInteger,
      })
      .strict(),
  },
  {
    name: "hosted_tool_family_import",
    description:
      "Import a complete hosted family package into a proposed family or locked draft. Import validates but never promotes.",
    parameters: z
      .object({
        mode: z.enum(["create", "update"]),
        package_document: HostedFamilyPackageDocumentSchema,
        target_family_id: FamilyId.nullable().optional(),
        lock_id: LockId.nullable().optional(),
        ttl_ms: OptionalPositiveInteger,
        source_revision_id: OptionalStringParam,
      })
      .strict(),
  },
  {
    name: "hosted_tool_family_export",
    description:
      "Export a sanitized hosted family package from source, draft, active generation, or a specific generation. Secret values are never included.",
    parameters: z
      .object({
        source: PackageExportSourceParams,
        include_examples: z.boolean().optional(),
      })
      .strict(),
  },
  {
    name: "hosted_tool_source_read",
    description:
      "Inspect canonical family source or a draft source file without filesystem access.",
    parameters: z
      .object({
        family_id: FamilyId.nullable().optional(),
        draft_id: DraftId.nullable().optional(),
        path: OptionalStringParam,
        start_line: SourceReadStartLine,
        max_lines: SourceReadMaxLines,
      })
      .strict(),
  },
  {
    name: "hosted_tool_source_view",
    description:
      "Inspect source focused on one hosted integration tool handler, with optional hooks and deterministic shared helpers.",
    parameters: z
      .object({
        family_id: FamilyId,
        tool_name: NativeToolName,
        draft_id: DraftId.nullable().optional(),
        generation_id: GenerationId.nullable().optional(),
        include_shared_helpers: z.boolean().optional(),
        include_hooks: z.boolean().optional(),
        include_all_tools: z.boolean().optional(),
        helper_depth_limit: OptionalPositiveInteger,
        max_helper_snippets: OptionalPositiveInteger,
        max_source_chars: OptionalPositiveInteger,
      })
      .strict(),
  },
  {
    name: "hosted_tool_lock_acquire",
    description: "Acquire the edit lock for a hosted integration family.",
    parameters: z
      .object({ family_id: FamilyId, ttl_ms: OptionalPositiveInteger })
      .strict(),
  },
  {
    name: "hosted_tool_lock_renew",
    description: "Renew an active hosted integration family edit lock.",
    parameters: z
      .object({ lock_id: LockId, ttl_ms: OptionalPositiveInteger })
      .strict(),
  },
  {
    name: "hosted_tool_lock_release",
    description: "Release an active hosted integration family edit lock.",
    parameters: z.object({ lock_id: LockId }).strict(),
  },
  {
    name: "hosted_tool_draft_create",
    description: "Create a draft for a locked hosted integration family.",
    parameters: z
      .object({
        family_id: FamilyId,
        lock_id: LockId,
        source_revision_id: OptionalStringParam,
      })
      .strict(),
  },
  {
    name: "hosted_tool_draft_get",
    description: "Inspect a hosted integration draft or one draft source file.",
    parameters: z
      .object({
        draft_id: DraftId,
        path: OptionalStringParam,
        start_line: SourceReadStartLine,
        max_lines: SourceReadMaxLines,
      })
      .strict(),
  },
  {
    name: "hosted_tool_draft_patch",
    description:
      "Patch a source file in a locked hosted integration draft. Defaults to full-file replace; use replace_text or insert_after for large files.",
    parameters: z
      .object({
        draft_id: DraftId,
        lock_id: LockId,
        path: z.string().min(1),
        mode: z
          .enum(["replace_file", "replace_text", "insert_after"])
          .nullable()
          .optional(),
        content: z.string().nullable().optional(),
        old_text: z.string().nullable().optional(),
        new_text: z.string().nullable().optional(),
        anchor_text: z.string().nullable().optional(),
        insert_text: z.string().nullable().optional(),
      })
      .strict(),
  },
  {
    name: "hosted_tool_draft_delete",
    description: "Delete a source file from a locked hosted integration draft.",
    parameters: z
      .object({ draft_id: DraftId, lock_id: LockId, path: z.string().min(1) })
      .strict(),
  },
  {
    name: "hosted_tool_example_list",
    description:
      "List registered test examples for a hosted integration draft.",
    parameters: z.object({ draft_id: DraftId }).strict(),
  },
  {
    name: "hosted_tool_example_upsert",
    description: "Create or update a test example for a locked draft.",
    parameters: z
      .object({ draft_id: DraftId, lock_id: LockId, example: ExampleParam })
      .strict(),
  },
  {
    name: "hosted_tool_example_run",
    description: "Run a registered safe draft test example.",
    parameters: z
      .object({ draft_id: DraftId, example_id: z.string().min(1) })
      .strict(),
  },
  {
    name: "hosted_tool_validate",
    description: "Validate a hosted integration draft.",
    parameters: z.object({ draft_id: DraftId }).strict(),
  },
  {
    name: "hosted_tool_promote",
    description:
      "Promote a validated draft. Destructive promotions still require separate human approval.",
    parameters: z
      .object({
        draft_id: DraftId,
        lock_id: LockId,
        approval_id: OptionalStringParam,
      })
      .strict(),
  },
  {
    name: "hosted_tool_generation_list",
    description: "List hosted integration generations.",
    parameters: z
      .object({ family_id: FamilyId.nullable().optional() })
      .strict(),
  },
  {
    name: "hosted_tool_generation_get",
    description: "Inspect one hosted integration generation.",
    parameters: z.object({ generation_id: GenerationId }).strict(),
  },
  {
    name: "hosted_tool_generation_diff",
    description:
      "Compare two promoted hosted integration generations with summary, unified, manifest-only, or tool-focused output.",
    parameters: z
      .object({
        base_generation_id: GenerationId,
        compare_generation_id: GenerationId,
        mode: z
          .enum(["summary", "unified", "manifest", "tool_focused"])
          .default("summary"),
        path: OptionalStringParam,
        tool_name: NativeToolName.nullable().optional(),
        include_shared_helpers: z.boolean().optional(),
        include_hooks: z.boolean().optional(),
      })
      .strict(),
  },
  {
    name: "hosted_tool_generation_rollback",
    description:
      "Roll back a hosted integration family to an older generation.",
    parameters: z.object({ generation_id: GenerationId }).strict(),
  },
  {
    name: "hosted_tool_environment_config_list",
    description:
      "List hosted integration environment configs with sanitized secret metadata.",
    parameters: z.object({}).strict(),
  },
  {
    name: "hosted_tool_environment_config_get",
    description:
      "Inspect one hosted integration environment config with sanitized secret metadata.",
    parameters: z
      .object({
        family_id: FamilyId,
        environment: z.enum(["prod", "test_debug"]),
      })
      .strict(),
  },
  {
    name: "hosted_tool_readiness_get",
    description:
      "Inspect normalized hosted integration lifecycle readiness for environment config, binding, publish, debug, or invocation targets.",
    parameters: ReadinessTargetParams,
  },
  {
    name: "hosted_tool_debug_run",
    description:
      "Run a debug invocation as the Tool Developer Agent. Writes require explicit allow_writes.",
    parameters: z
      .object({
        family_id: FamilyId,
        tool_name: NativeToolName,
        environment: z.enum(["prod", "test_debug"]).default("test_debug"),
        args: JsonObjectParam.default({}),
        generation_id: GenerationId.nullable().optional(),
        operation_class: z
          .enum(["read", "write", "destructive"])
          .default("read"),
        allow_writes: z.boolean().optional(),
      })
      .strict(),
  },
  {
    name: "hosted_tool_run_get",
    description: "Inspect a hosted integration execution log entry.",
    parameters: z.object({ run_id: RunId }).strict(),
  },
  {
    name: "hosted_tool_artifact_get",
    description: "Read a sanitized hosted integration run artifact.",
    parameters: z.object({ run_id: RunId, name: z.string().min(1) }).strict(),
  },
  {
    name: "hosted_tool_failure_bucket_list",
    description: "List hosted integration failure buckets assigned for repair.",
    parameters: z
      .object({ family_id: FamilyId.nullable().optional() })
      .strict(),
  },
  {
    name: "hosted_tool_failure_bucket_get",
    description: "Inspect one hosted integration failure bucket.",
    parameters: z.object({ bucket_id: BucketId }).strict(),
  },
  {
    name: "hosted_tool_failure_bucket_assign",
    description: "Assign a hosted integration failure bucket to an agent.",
    parameters: z
      .object({ bucket_id: BucketId, assigned_to: z.string().min(1) })
      .strict(),
  },
  {
    name: "hosted_tool_failure_bucket_close",
    description:
      "Close a hosted integration failure bucket after repair evidence exists.",
    parameters: z
      .object({
        bucket_id: BucketId,
        draft_id: DraftId.nullable().optional(),
        generation_id: GenerationId.nullable().optional(),
        regression_example_id: OptionalStringParam,
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
    handler: async (args) => {
      const parsed = definition.parameters.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "invalid_params",
            message: parsed.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; "),
          },
        });
      }
      return invokeManagementTool(
        definition.name,
        parsed.data as Record<string, unknown>,
      );
    },
  });
}

async function invokeManagementTool(
  toolName: HostedToolManagementToolName,
  args: Record<string, unknown>,
): Promise<string> {
  if (!bindings) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "platform_unavailable",
        message:
          "hosted tool management tools are not initialized — ServerRuntime must bind them.",
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
          "hosted tool management tools require an active agent context.",
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
    return JSON.stringify(sanitizeHostedToolControlPlaneResult(result));
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      ok: false,
      error: {
        code: "runtime_error",
        message: sanitizeHostedToolControlPlaneResult(rawMessage),
      },
    });
  }
}
