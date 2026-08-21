import { z } from "zod";

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const WorkflowDefinitionStatusSchema = z.enum([
  "draft",
  "published",
  "archived",
]);
export type WorkflowDefinitionStatus = z.infer<
  typeof WorkflowDefinitionStatusSchema
>;

export const WorkflowDefinitionSourceSchema = z.enum(["draft", "published"]);
export type WorkflowDefinitionSource = z.infer<
  typeof WorkflowDefinitionSourceSchema
>;

export const WorkflowRunModeSchema = z.enum(["test", "live"]);
export type WorkflowRunMode = z.infer<typeof WorkflowRunModeSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowStepStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;

export const WorkflowRunEventLevelSchema = z.enum([
  "debug",
  "info",
  "warn",
  "error",
  "system",
]);
export type WorkflowRunEventLevel = z.infer<typeof WorkflowRunEventLevelSchema>;

export const WorkflowRunEventKindSchema = z.enum([
  "run_started",
  "step_started",
  "step_output",
  "step_failed",
  "step_completed",
  "branch_selected",
  "parallel_started",
  "parallel_branch_started",
  "parallel_branch_completed",
  "parallel_branch_failed",
  "parallel_completed",
  "parallel_failed",
  "log",
  "run_completed",
  "run_failed",
  "run_canceled",
]);
export type WorkflowRunEventKind = z.infer<typeof WorkflowRunEventKindSchema>;

export const WorkflowTransformNodeTypeValues = [
  "builtin.transform.value_resolve",
  "builtin.transform.object_pick",
  "builtin.transform.string_replace",
  "builtin.transform.string_regex_replace",
  "builtin.transform.string_regex_match",
  "builtin.transform.json_parse",
  "builtin.transform.json_stringify",
  "builtin.transform.csv_parse",
  "builtin.transform.csv_stringify",
  "builtin.transform.ip_parse",
  "builtin.transform.ip_is_ipv4",
  "builtin.transform.ip_is_ipv6",
  "builtin.transform.ip_in_subnet",
  "builtin.transform.ip_netmask",
  "builtin.transform.ip_network",
  "builtin.transform.uri_parse",
] as const;
export const WorkflowTransformNodeTypeSchema = z.enum(
  WorkflowTransformNodeTypeValues,
);
export type WorkflowTransformNodeType = z.infer<
  typeof WorkflowTransformNodeTypeSchema
>;

export function isWorkflowTransformNodeType(
  value: string,
): value is WorkflowTransformNodeType {
  return WorkflowTransformNodeTypeSchema.safeParse(value).success;
}

export function workflowTransformKindFromNodeType(
  value: WorkflowTransformNodeType,
): string {
  switch (value) {
    case "builtin.transform.value_resolve":
      return "value.resolve";
    case "builtin.transform.object_pick":
      return "object_pick";
    case "builtin.transform.string_replace":
      return "string.replace";
    case "builtin.transform.string_regex_replace":
      return "string.regex_replace";
    case "builtin.transform.string_regex_match":
      return "string.regex_match";
    case "builtin.transform.json_parse":
      return "json.parse";
    case "builtin.transform.json_stringify":
      return "json.stringify";
    case "builtin.transform.csv_parse":
      return "csv.parse";
    case "builtin.transform.csv_stringify":
      return "csv.stringify";
    case "builtin.transform.ip_parse":
      return "ip.parse";
    case "builtin.transform.ip_is_ipv4":
      return "ip.is_ipv4";
    case "builtin.transform.ip_is_ipv6":
      return "ip.is_ipv6";
    case "builtin.transform.ip_in_subnet":
      return "ip.in_subnet";
    case "builtin.transform.ip_netmask":
      return "ip.netmask";
    case "builtin.transform.ip_network":
      return "ip.network";
    case "builtin.transform.uri_parse":
      return "uri.parse";
  }
}

export const WorkflowLogNodeTypeValues = [
  "builtin.log.info",
  "builtin.log.debug",
  "builtin.log.warn",
  "builtin.log.error",
] as const;
export const WorkflowLogNodeTypeSchema = z.enum(WorkflowLogNodeTypeValues);
export type WorkflowLogNodeType = z.infer<typeof WorkflowLogNodeTypeSchema>;

export const WorkflowBuiltinNodeTypeValues = [
  "builtin.set",
  "builtin.output.set",
  ...WorkflowTransformNodeTypeValues,
  "builtin.if",
  "builtin.if_else",
  "builtin.switch",
  "builtin.foreach",
  "builtin.exit",
  "builtin.throw_error",
  "builtin.sleep",
  ...WorkflowLogNodeTypeValues,
  "builtin.parallel",
  "builtin.python",
] as const;
export const WorkflowExternalNodeTypeValues = [
  "mcp.tool",
  "hosted.tool",
  "agent.call",
] as const;
export const WorkflowNodeTypeValues = [
  ...WorkflowBuiltinNodeTypeValues,
  ...WorkflowExternalNodeTypeValues,
] as const;
export const WorkflowAuthoringNodeTypeValues = WorkflowNodeTypeValues.filter(
  (value) => value !== "builtin.if_else",
);
export const WorkflowNodeTypeSchema = z.enum(WorkflowNodeTypeValues);
export type WorkflowNodeType = z.infer<typeof WorkflowNodeTypeSchema>;
export type WorkflowAuthoringNodeType =
  (typeof WorkflowAuthoringNodeTypeValues)[number];

export const WorkflowTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("manual"),
      enabled: z.literal(true),
      inputSchema: JsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("scheduled"),
      enabled: z.boolean(),
      schedule: z
        .object({
          kind: z.literal("cron"),
          expr: z.string().min(1),
          tz: z.string().min(1).optional(),
        })
        .strict(),
      input: JsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("task"),
      enabled: z.literal(false),
      filter: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal("webhook"),
      enabled: z.boolean(),
      path: z.string().min(1).optional(),
      inputSchema: JsonValueSchema.optional(),
      secretSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    })
    .strict(),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowRunTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("manual"),
      triggerId: z.string().min(1).default("manual"),
      requestedBy: z.string().min(1).optional(),
      input: JsonValueSchema.optional(),
      draftHash: z.string().min(1).optional(),
      stopAfterStepId: z.string().min(1).optional(),
      testAssertions: z
        .array(
          z
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
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scheduled"),
      triggerId: z.string().min(1),
      scheduledAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      triggerId: z.string().min(1),
      taskId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("webhook"),
      triggerId: z.string().min(1),
      requestId: z.string().min(1).optional(),
    })
    .strict(),
]);
export type WorkflowRunTrigger = z.infer<typeof WorkflowRunTriggerSchema>;

export const WorkflowAssignmentPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    "Assignment path must be a dotted context path",
  );
export type WorkflowAssignmentPath = z.infer<
  typeof WorkflowAssignmentPathSchema
>;

export const WorkflowAssignmentModeSchema = z.enum([
  "replace",
  "merge",
  "append",
]);
export type WorkflowAssignmentMode = z.infer<
  typeof WorkflowAssignmentModeSchema
>;

export const WorkflowAssignmentValueSchema = z.union([
  z.string().min(1),
  z
    .object({
      from: z.string().min(1),
      mode: WorkflowAssignmentModeSchema.default("replace"),
    })
    .strict(),
]);
export type WorkflowAssignmentValue = z.infer<
  typeof WorkflowAssignmentValueSchema
>;

export const WorkflowAssignmentMapSchema = z
  .record(WorkflowAssignmentPathSchema, WorkflowAssignmentValueSchema)
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one assignment is required",
  });
export type WorkflowAssignmentMap = z.infer<typeof WorkflowAssignmentMapSchema>;

const NodeIdSchema = z.string().min(1);
const InputMapSchema = z.record(z.string(), JsonValueSchema).optional();
const NodeContinuationSchema = {
  next: z.array(NodeIdSchema).default([]),
};

export const WorkflowCanvasPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();
export type WorkflowCanvasPosition = z.infer<
  typeof WorkflowCanvasPositionSchema
>;

export const WorkflowCanvasNodeUiSchema = z
  .object({
    position: WorkflowCanvasPositionSchema,
  })
  .strict();
export type WorkflowCanvasNodeUi = z.infer<typeof WorkflowCanvasNodeUiSchema>;

export const WorkflowDefinitionUiSchema = z
  .object({
    canvas: z
      .object({
        nodes: z.record(NodeIdSchema, WorkflowCanvasNodeUiSchema).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkflowDefinitionUi = z.infer<typeof WorkflowDefinitionUiSchema>;

const AssignableNodeBase = {
  id: NodeIdSchema,
  label: z.string().min(1).optional(),
  ...NodeContinuationSchema,
  input: InputMapSchema,
  assign: WorkflowAssignmentMapSchema.optional(),
};

export const BuiltinSetNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.set"),
    assign: WorkflowAssignmentMapSchema,
  })
  .strict();

export const BuiltinOutputSetNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.output.set"),
    path: WorkflowAssignmentPathSchema,
    value: JsonValueSchema,
    mode: WorkflowAssignmentModeSchema.default("replace"),
  })
  .strict();

export const BuiltinTransformNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: WorkflowTransformNodeTypeSchema,
    transform: z
      .object({
        kind: z.string().min(1),
      })
      .catchall(JsonValueSchema),
  })
  .superRefine((node, ctx) => {
    const expected = workflowTransformKindFromNodeType(node.type);
    if (node.transform.kind !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transform", "kind"],
        message: `Expected transform kind ${expected} for node type ${node.type}`,
      });
    }
  })
  .strict();

export const BuiltinIfNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.if"),
    condition: z.string().min(1),
    then: z.array(NodeIdSchema).default([]),
    else: z.array(NodeIdSchema).default([]),
  })
  .strict();

export const BuiltinIfElseNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.if_else"),
    condition: z.string().min(1),
    then: z.array(NodeIdSchema).default([]),
    else: z.array(NodeIdSchema).default([]),
  })
  .strict();

export const BuiltinSwitchCaseSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    label: z.string().min(1).optional(),
    value: JsonValueSchema,
    nodes: z.array(NodeIdSchema).default([]),
  })
  .strict();
export type BuiltinSwitchCase = z.infer<typeof BuiltinSwitchCaseSchema>;

export const BuiltinSwitchNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.switch"),
    value: JsonValueSchema,
    cases: z.array(BuiltinSwitchCaseSchema).min(1),
    default: z.array(NodeIdSchema).default([]),
  })
  .strict();

export const BuiltinForeachNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: z.literal("builtin.foreach"),
    items: z.string().min(1),
    itemVar: z.string().min(1).default("item"),
    body: z.array(NodeIdSchema).default([]),
    concurrency: z.number().int().positive().max(1).optional(),
  })
  .strict();

export const BuiltinExitNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.exit"),
    status: z.enum(["succeeded", "failed", "canceled"]),
    output: JsonValueSchema.optional(),
  })
  .strict();

export const BuiltinThrowErrorNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.throw_error"),
    message: z.string().min(1),
    code: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
      .optional(),
    details: JsonValueSchema.optional(),
  })
  .strict();

export const BuiltinSleepNodeSchema = z
  .object({
    id: NodeIdSchema,
    label: z.string().min(1).optional(),
    ...NodeContinuationSchema,
    type: z.literal("builtin.sleep"),
    delayMs: z.number().int().min(1).max(300_000),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const BuiltinLogNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: WorkflowLogNodeTypeSchema,
    message: z.string().min(1),
    payload: JsonValueSchema.optional(),
  })
  .strict();

export const BuiltinParallelBranchSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    label: z.string().min(1).optional(),
    nodes: z.array(NodeIdSchema).default([]),
  })
  .strict();
export type BuiltinParallelBranch = z.infer<typeof BuiltinParallelBranchSchema>;

export const BuiltinParallelNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: z.literal("builtin.parallel"),
    branches: z.array(BuiltinParallelBranchSchema).min(1),
    concurrency: z.number().int().positive().max(16).optional(),
    failFast: z.boolean().default(true),
  })
  .strict();

export const BuiltinPythonNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: z.literal("builtin.python"),
    code: z.string().min(1),
    reset: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
  })
  .strict();

export const McpToolNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: z.literal("mcp.tool"),
    server: z.string().min(1),
    tool: z.string().min(1),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
  })
  .strict();

export const HostedToolNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: z.literal("hosted.tool"),
    toolName: z.string().min(1),
    timeoutMs: z.number().int().min(100).max(300_000).optional(),
  })
  .strict();

export const AgentCallNodeSchema = z
  .object({
    ...AssignableNodeBase,
    type: z.literal("agent.call"),
    agentId: z.string().min(1),
    prompt: z.string().min(1),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
  })
  .strict();

export const WorkflowNodeSchema = z.discriminatedUnion("type", [
  BuiltinSetNodeSchema,
  BuiltinOutputSetNodeSchema,
  BuiltinTransformNodeSchema,
  BuiltinIfNodeSchema,
  BuiltinIfElseNodeSchema,
  BuiltinSwitchNodeSchema,
  BuiltinForeachNodeSchema,
  BuiltinExitNodeSchema,
  BuiltinThrowErrorNodeSchema,
  BuiltinSleepNodeSchema,
  BuiltinLogNodeSchema,
  BuiltinParallelNodeSchema,
  BuiltinPythonNodeSchema,
  McpToolNodeSchema,
  HostedToolNodeSchema,
  AgentCallNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    status: WorkflowDefinitionStatusSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: JsonValueSchema.optional(),
    outputSchema: JsonValueSchema.optional(),
    triggers: z
      .array(WorkflowTriggerSchema)
      .default([{ id: "manual", kind: "manual", enabled: true }]),
    nodes: z.array(WorkflowNodeSchema),
    ui: WorkflowDefinitionUiSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowRunSchema = z
  .object({
    id: z.string().min(1),
    workflowId: z.string().min(1),
    workflowVersion: z.number().int().positive(),
    definitionSource: WorkflowDefinitionSourceSchema,
    definitionSnapshot: WorkflowDefinitionSchema.optional(),
    mode: WorkflowRunModeSchema,
    trigger: WorkflowRunTriggerSchema,
    status: WorkflowRunStatusSchema,
    input: JsonValueSchema,
    context: JsonValueSchema,
    currentNodeId: z.string().min(1).nullable().default(null),
    waitingReason: z.string().min(1).nullable().default(null),
    createdAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable().default(null),
    endedAt: z.string().datetime({ offset: true }).nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const WorkflowStepAttemptSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    attempt: z.number().int().positive(),
    status: WorkflowStepStatusSchema,
    startedAt: z.string().datetime({ offset: true }).nullable().default(null),
    endedAt: z.string().datetime({ offset: true }).nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
    input: JsonValueSchema.optional(),
    output: JsonValueSchema.optional(),
    error: JsonValueSchema.optional(),
    logsSummary: JsonValueSchema.optional(),
    contextDiff: JsonValueSchema.optional(),
  })
  .strict();
export type WorkflowStepAttempt = z.infer<typeof WorkflowStepAttemptSchema>;

export const WorkflowRunEventSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    stepRunId: z.string().min(1).nullable().default(null),
    sequence: z.number().int().positive(),
    level: WorkflowRunEventLevelSchema,
    kind: WorkflowRunEventKindSchema,
    message: z.string().min(1).optional(),
    payload: JsonValueSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type WorkflowRunEvent = z.infer<typeof WorkflowRunEventSchema>;
