import { z } from "zod";
import {
  getWorkflowCardCatalog,
  JsonValueSchema,
  WorkflowDefinitionUiSchema,
  WorkflowNodeSchema,
  WorkflowRunModeSchema,
  WorkflowRunStatusSchema,
  WorkflowTriggerSchema,
} from "@openacme/workflows";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

export const WORKFLOW_AUTHORING_TOOL_NAMES = [
  "workflow_card_catalog",
  "workflow_help",
  "workflow_help_upsert",
  "workflow_tool_inventory",
  "workflow_agent_inventory",
  "workflow_validate",
  "workflow_list",
  "workflow_get",
  "workflow_create",
  "workflow_update",
  "workflow_delete",
  "workflow_publish",
  "workflow_export",
  "workflow_import",
  "workflow_card_test_run",
  "workflow_test_run",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_run_cancel",
  "workflow_run_rerun",
  "workflow_artifact_get",
] as const;

export const WORKFLOW_CONSUMER_TOOL_NAMES = [
  "workflow_help",
  "workflow_callable_list",
  "workflow_callable_get",
  "workflow_run",
  "workflow_run_get",
  "workflow_artifact_get",
] as const;

export const WORKFLOW_MANAGEMENT_TOOL_NAMES = [
  ...WORKFLOW_AUTHORING_TOOL_NAMES,
  "workflow_callable_list",
  "workflow_callable_get",
  "workflow_run",
] as const;

export type WorkflowManagementToolName =
  (typeof WORKFLOW_MANAGEMENT_TOOL_NAMES)[number];

export interface WorkflowManagementRequest {
  actorId: string;
  toolName: WorkflowManagementToolName;
  operation: WorkflowManagementToolName;
  params: Record<string, unknown>;
}

export interface WorkflowManagementBindings {
  invoke(request: WorkflowManagementRequest): Promise<unknown>;
}

let bindings: WorkflowManagementBindings | null = null;

export function bindWorkflowManagement(
  b: WorkflowManagementBindings | null,
): void {
  bindings = b;
}

const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const OptionalSafeId = SafeId.nullable().optional();
const OptionalLimit = z.number().int().min(1).max(500).nullable().optional();
const OptionalOffset = z
  .number()
  .int()
  .min(0)
  .max(1_000_000)
  .nullable()
  .optional();
const OptionalDate = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .optional();
const OptionalJson = JsonValueSchema.nullable().optional();

const WorkflowCreateParams = z
  .object({
    id: OptionalSafeId,
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    inputSchema: OptionalJson,
    outputSchema: OptionalJson,
    triggers: z.array(WorkflowTriggerSchema).optional(),
    nodes: z.array(WorkflowNodeSchema).optional(),
    ui: WorkflowDefinitionUiSchema.nullable().optional(),
  })
  .strict();

const WorkflowUpdateParams = z
  .object({
    workflow_id: SafeId,
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    inputSchema: OptionalJson,
    outputSchema: OptionalJson,
    triggers: z.array(WorkflowTriggerSchema).optional(),
    nodes: z.array(WorkflowNodeSchema).optional(),
    ui: WorkflowDefinitionUiSchema.nullable().optional(),
  })
  .strict();

const RunListParams = z
  .object({
    workflow_id: OptionalSafeId,
    mode: WorkflowRunModeSchema.nullable().optional(),
    status: WorkflowRunStatusSchema.nullable().optional(),
    trigger_id: OptionalSafeId,
    created_from: OptionalDate,
    created_to: OptionalDate,
    limit: OptionalLimit,
    offset: OptionalOffset,
  })
  .strict();

const WorkflowRunParams = z
  .object({
    workflow_id: SafeId,
    trigger_id: OptionalSafeId,
    input: JsonValueSchema.optional(),
    async: z.boolean().optional(),
  })
  .strict();

const WorkflowRunGetParams = z
  .object({
    run_id: SafeId,
    detail: z.enum(["summary", "step", "full"]).optional(),
    step_id: SafeId.optional(),
    include: z
      .array(z.enum(["input", "output", "logs", "error", "context"]))
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.detail === "step" && !value.step_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["step_id"],
        message: "step_id is required when detail is step",
      });
    }
  });

const WorkflowAssertionParams = z
  .object({
    path: z.string().min(1),
    operator: z.enum([
      "exists",
      "equals",
      "not_equals",
      "contains",
      "not_contains",
      "matches",
      "greater_than",
      "less_than",
    ]),
    value: JsonValueSchema.optional(),
  })
  .strict();

const WorkflowCardTestParams = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("candidate"),
      node: WorkflowNodeSchema,
      input: JsonValueSchema.optional(),
      context: z.record(z.string(), JsonValueSchema).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("from_workflow"),
      workflow_id: SafeId,
      step_id: SafeId,
      input: JsonValueSchema.optional(),
      context: z.record(z.string(), JsonValueSchema).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("from_run"),
      run_id: SafeId,
      step_id: SafeId,
      input: JsonValueSchema.optional(),
      context: z.record(z.string(), JsonValueSchema).optional(),
    })
    .strict(),
]);

const WorkflowHelpTargetParams = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("overview") }).strict(),
  z
    .object({ kind: z.literal("card_type"), card_type: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("workflow_schema") }).strict(),
  z.object({ kind: z.literal("reference_syntax") }).strict(),
  z
    .object({ kind: z.literal("input_schema"), workflow_id: SafeId.optional() })
    .strict(),
  z.object({ kind: z.literal("output_schema") }).strict(),
  z.object({ kind: z.literal("run_evidence") }).strict(),
  z.object({ kind: z.literal("promotion_gate") }).strict(),
]);

const WorkflowHelpParams = z
  .object({
    target: WorkflowHelpTargetParams,
    detail: z.enum(["summary", "full"]).optional(),
    include_examples: z.boolean().optional(),
    parameters: z
      .array(
        z
          .object({
            name: z.string().min(1),
            detail: z.enum(["summary", "full"]).optional(),
            include_examples: z.boolean().optional(),
            query: z.string().min(1).optional(),
            value: JsonValueSchema.optional(),
          })
          .strict(),
      )
      .nullable()
      .optional(),
  })
  .strict();

const WorkflowHelpValueParams = z
  .object({
    summary: z.string().min(1),
    full: z.string().min(1).optional(),
    whenToUse: z.array(z.string().min(1)).optional(),
    whenNotToUse: z.array(z.string().min(1)).optional(),
    parameters: z
      .record(
        z.string().min(1),
        z
          .object({
            summary: z.string().min(1),
            full: z.string().min(1).optional(),
            examples: z.array(JsonValueSchema).optional(),
            noExampleJustification: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    examples: z.array(JsonValueSchema).optional(),
    noExampleJustification: z.string().min(1).optional(),
  })
  .strict();

const WorkflowHelpUpsertParams = z
  .object({
    target: WorkflowHelpTargetParams,
    help: WorkflowHelpValueParams,
  })
  .strict();

const ValidateTargetParams = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("saved"),
      workflow_id: SafeId,
    })
    .strict(),
  z
    .object({
      mode: z.literal("definition"),
      definition: z.object({}).passthrough(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("candidate"),
      candidate: z.object({}).passthrough(),
    })
    .strict(),
]);

const definitions: Array<{
  name: WorkflowManagementToolName;
  description: string;
  parameters: z.ZodType;
}> = [
  {
    name: "workflow_card_catalog",
    description:
      "List authorable OpenAcme workflow card types with config schemas, default config, output schema, routes, and examples.",
    parameters: z.object({}).strict(),
  },
  {
    name: "workflow_help",
    description:
      "Get workflow authoring help. Use this before authoring unfamiliar cards, references, schemas, run evidence inspection, or publish readiness; request parameter-specific guidance through parameters[].",
    parameters: WorkflowHelpParams,
  },
  {
    name: "workflow_help_upsert",
    description:
      "Upsert structured workflow authoring help for a target. This is for Workflow Engineer/admin contexts to improve card, schema, reference, run evidence, or promotion guidance.",
    parameters: WorkflowHelpUpsertParams,
  },
  {
    name: "workflow_tool_inventory",
    description:
      "List runtime MCP tools and OpenAcme hosted tools that can be used by workflow mcp.tool and hosted.tool cards.",
    parameters: z.object({}).strict(),
  },
  {
    name: "workflow_agent_inventory",
    description:
      "List OpenAcme agents that can be used by workflow agent.call cards.",
    parameters: z.object({}).strict(),
  },
  {
    name: "workflow_validate",
    description:
      "Validate a workflow against workflow schema, graph, trigger, MCP tool, and agent references. Use { mode: 'candidate', candidate: <create body> } before create, { mode: 'saved', workflow_id } for an existing draft, or { mode: 'definition', definition } for a full stored/exported definition.",
    parameters: ValidateTargetParams,
  },
  {
    name: "workflow_list",
    description: "List workflow definitions.",
    parameters: z
      .object({
        status: z
          .enum(["draft", "published", "archived"])
          .nullable()
          .optional(),
        limit: OptionalLimit,
      })
      .strict(),
  },
  {
    name: "workflow_get",
    description: "Inspect one workflow definition.",
    parameters: z.object({ workflow_id: SafeId }).strict(),
  },
  {
    name: "workflow_create",
    description: "Create a workflow draft after validating the candidate.",
    parameters: WorkflowCreateParams,
  },
  {
    name: "workflow_update",
    description:
      "Update a workflow draft after validating the resulting definition.",
    parameters: WorkflowUpdateParams,
  },
  {
    name: "workflow_delete",
    description: "Archive a workflow definition while preserving run history.",
    parameters: z.object({ workflow_id: SafeId }).strict(),
  },
  {
    name: "workflow_publish",
    description: "Publish the current workflow draft as an immutable version.",
    parameters: z.object({ workflow_id: SafeId }).strict(),
  },
  {
    name: "workflow_export",
    description:
      "Export a workflow as an openacme.workflow.definition.v1 package.",
    parameters: z.object({ workflow_id: SafeId }).strict(),
  },
  {
    name: "workflow_import",
    description:
      "Import an openacme.workflow.definition.v1 package as a new workflow draft.",
    parameters: z
      .object({
        package_document: z.record(z.string(), z.unknown()),
      })
      .strict(),
  },
  {
    name: "workflow_card_test_run",
    description:
      "Run a single workflow card through normal runner semantics. Use candidate for an unsaved card, from_workflow for an existing draft card, or from_run to reuse previous run input/context/step state.",
    parameters: WorkflowCardTestParams,
  },
  {
    name: "workflow_test_run",
    description: "Start a draft-mode workflow test run with manual input.",
    parameters: z
      .object({
        workflow_id: SafeId,
        input: JsonValueSchema.optional(),
        async: z.boolean().optional(),
        stop_after_step_id: SafeId.optional(),
        assertions: z.array(WorkflowAssertionParams).optional(),
      })
      .strict(),
  },
  {
    name: "workflow_run_list",
    description:
      "List workflow runs with optional workflow, mode, status, trigger, and date filters.",
    parameters: RunListParams,
  },
  {
    name: "workflow_run_get",
    description:
      "Inspect one workflow run. Defaults to a compact summary; use detail: 'step' with step_id for targeted step evidence, or detail: 'full' for UI/debug exports.",
    parameters: WorkflowRunGetParams,
  },
  {
    name: "workflow_run_cancel",
    description: "Cancel a running workflow run.",
    parameters: z.object({ run_id: SafeId }).strict(),
  },
  {
    name: "workflow_run_rerun",
    description:
      "Rerun a workflow run using its original mode, input, trigger, and definition source.",
    parameters: z.object({ run_id: SafeId }).strict(),
  },
  {
    name: "workflow_artifact_get",
    description: "Read one spilled workflow run artifact.",
    parameters: z.object({ run_id: SafeId, artifact_id: SafeId }).strict(),
  },
  {
    name: "workflow_callable_list",
    description:
      "List published workflows callable by normal agents, including trigger, input schema, output schema, and description metadata. Does not expose draft nodes.",
    parameters: z
      .object({
        limit: OptionalLimit,
      })
      .strict(),
  },
  {
    name: "workflow_callable_get",
    description:
      "Inspect one published workflow callable contract without exposing draft/editor internals.",
    parameters: z.object({ workflow_id: SafeId }).strict(),
  },
  {
    name: "workflow_run",
    description:
      "Run a published workflow through an enabled manual trigger. Normal agents use this instead of draft test tools.",
    parameters: WorkflowRunParams,
  },
];

for (const definition of definitions) {
  registry.register({
    name: definition.name,
    toolset: "workflow-management",
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
      return invokeWorkflowManagementTool(
        definition.name,
        parsed.data as Record<string, unknown>,
      );
    },
  });
}

async function invokeWorkflowManagementTool(
  toolName: WorkflowManagementToolName,
  args: Record<string, unknown>,
): Promise<string> {
  const actorId = getCurrentAgentId();
  if (!actorId) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "policy_denied",
        message: "workflow management tools require an active agent context.",
      },
    });
  }

  if (toolName === "workflow_card_catalog") {
    return JSON.stringify({ ok: true, cards: getWorkflowCardCatalog() });
  }

  if (!bindings) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "platform_unavailable",
        message:
          "workflow management tools are not initialized - ServerRuntime must bind them.",
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
    return JSON.stringify(result);
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
