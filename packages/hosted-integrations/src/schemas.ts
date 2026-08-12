import { z } from "zod";

export const HostedIntegrationFamilyIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export type HostedIntegrationFamilyId = z.infer<
  typeof HostedIntegrationFamilyIdSchema
>;

export const HostedIntegrationToolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
export type HostedIntegrationToolName = z.infer<
  typeof HostedIntegrationToolNameSchema
>;

const IsoTimestampSchema = z.string().datetime({ offset: true });

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

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

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const HostedIntegrationOperationSchema = z.enum([
  "read",
  "write",
  "destructive",
]);
export type HostedIntegrationOperation = z.infer<
  typeof HostedIntegrationOperationSchema
>;

export const HostedIntegrationFreshnessSchema = z.enum([
  "live",
  "cached",
  "sync",
]);
export type HostedIntegrationFreshness = z.infer<
  typeof HostedIntegrationFreshnessSchema
>;

export const HostedIntegrationIdempotencySchema = z.enum([
  "idempotent",
  "non_idempotent",
]);
export type HostedIntegrationIdempotency = z.infer<
  typeof HostedIntegrationIdempotencySchema
>;

export const HostedIntegrationExecutionModeSchema = z.enum(["sync", "async"]);
export type HostedIntegrationExecutionMode = z.infer<
  typeof HostedIntegrationExecutionModeSchema
>;

export const HostedIntegrationApprovalSchema = z.enum([
  "none",
  "confirm",
  "human",
]);
export type HostedIntegrationApproval = z.infer<
  typeof HostedIntegrationApprovalSchema
>;

export const HostedIntegrationToolLifecycleSchema = z
  .enum(["active", "deprecated", "hidden", "disabled", "removed"])
  .default("active");
export type HostedIntegrationToolLifecycle = z.infer<
  typeof HostedIntegrationToolLifecycleSchema
>;

export const HostedIntegrationToolClassificationSchema = z
  .object({
    operation: HostedIntegrationOperationSchema,
    freshness: HostedIntegrationFreshnessSchema,
    idempotency: HostedIntegrationIdempotencySchema,
    execution: HostedIntegrationExecutionModeSchema,
    approval: HostedIntegrationApprovalSchema,
  })
  .strict();
export type HostedIntegrationToolClassification = z.infer<
  typeof HostedIntegrationToolClassificationSchema
>;

export const HostedIntegrationRuntimePolicySchema = z
  .object({
    filesystem: z.enum(["run_dir_only", "run_dir_and_family_home"]),
    processEnv: z.enum(["tool_context_only"]),
    subprocess: z.enum(["denied", "policy_allowed"]),
    network: z.enum(["denied", "declared_egress"]),
    declaredEgress: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type HostedIntegrationRuntimePolicy = z.infer<
  typeof HostedIntegrationRuntimePolicySchema
>;

export const HostedIntegrationPythonDependencySchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.!+_*-]*$/),
  })
  .strict();
export type HostedIntegrationPythonDependency = z.infer<
  typeof HostedIntegrationPythonDependencySchema
>;

export const HostedIntegrationResolvedPythonDependencySchema = z
  .object({
    name: z.string().min(1),
    normalizedName: z.string().min(1),
    version: z.string().min(1),
    requirement: z.string().min(1),
  })
  .strict();
export type HostedIntegrationResolvedPythonDependency = z.infer<
  typeof HostedIntegrationResolvedPythonDependencySchema
>;

export const HostedIntegrationDependencyResolutionSchema = z
  .object({
    language: z.literal("python"),
    installDuringInvocation: z.literal(false),
    dependencies: z.array(HostedIntegrationResolvedPythonDependencySchema),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type HostedIntegrationDependencyResolution = z.infer<
  typeof HostedIntegrationDependencyResolutionSchema
>;

export const HostedIntegrationDependencyPolicySchema = z
  .object({
    installDuringInvocation: z.literal(false),
    allowedPackages: z.array(z.string().min(1)).default([]),
    deniedPackages: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type HostedIntegrationDependencyPolicy = z.infer<
  typeof HostedIntegrationDependencyPolicySchema
>;

export const HostedIntegrationRuntimeSettingsSchema = z
  .object({
    language: z.literal("python"),
    entrypoint: z.string().min(1),
    defaultTimeoutMs: z.number().int().positive(),
    inlineResultTokenLimit: z.number().int().positive(),
    maxConcurrency: z.number().int().positive(),
    dependencies: z.array(HostedIntegrationPythonDependencySchema).default([]),
    runtimePolicy: HostedIntegrationRuntimePolicySchema,
    dependencyPolicy: HostedIntegrationDependencyPolicySchema,
  })
  .strict();
export type HostedIntegrationRuntimeSettings = z.infer<
  typeof HostedIntegrationRuntimeSettingsSchema
>;

export const HostedIntegrationToolSpecSchema = z
  .object({
    name: HostedIntegrationToolNameSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    lifecycle: HostedIntegrationToolLifecycleSchema,
    inputSchema: JsonObjectSchema,
    classification: HostedIntegrationToolClassificationSchema,
    runtime: HostedIntegrationRuntimeSettingsSchema.partial().optional(),
  })
  .strict();
export type HostedIntegrationToolSpec = z.infer<
  typeof HostedIntegrationToolSpecSchema
>;

export const FamilyManifestSchema = z
  .object({
    id: HostedIntegrationFamilyIdSchema,
    name: z.string().min(1),
    version: z.number().int().positive(),
    runtime: HostedIntegrationRuntimeSettingsSchema,
    tools: z.array(HostedIntegrationToolSpecSchema).min(1),
  })
  .strict();
export type FamilyManifest = z.infer<typeof FamilyManifestSchema>;

export const HostedIntegrationSourceRevisionSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    createdAt: IsoTimestampSchema,
    createdBy: z.string().min(1),
    parentRevisionId: z.string().min(1).optional(),
  })
  .strict();
export type HostedIntegrationSourceRevision = z.infer<
  typeof HostedIntegrationSourceRevisionSchema
>;

export const HostedIntegrationFamilyLockSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    lockedBy: z.string().min(1),
    draftId: z.string().min(1).optional(),
    acquiredAt: IsoTimestampSchema,
    renewedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict();
export type HostedIntegrationFamilyLock = z.infer<
  typeof HostedIntegrationFamilyLockSchema
>;

export const HostedIntegrationDraftSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    sourceRevisionId: z.string().min(1),
    lockId: z.string().min(1),
    status: z.enum(["open", "promoted", "cancelled"]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type HostedIntegrationDraft = z.infer<
  typeof HostedIntegrationDraftSchema
>;

export const HostedIntegrationGenerationSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    sourceRevisionId: z.string().min(1),
    status: z.enum(["active", "draining", "retired", "disabled"]),
    promotedAt: IsoTimestampSchema,
    promotedBy: z.string().min(1),
    runtime: HostedIntegrationRuntimeSettingsSchema.optional(),
    dependencyResolution:
      HostedIntegrationDependencyResolutionSchema.optional(),
    provenance: z
      .lazy(() => HostedIntegrationGenerationProvenanceSchema)
      .optional(),
  })
  .strict();
export type HostedIntegrationGeneration = z.infer<
  typeof HostedIntegrationGenerationSchema
>;

export const HostedIntegrationApprovalActorSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["agent", "human", "system"]),
    email: z.string().email().optional(),
  })
  .strict();
export type HostedIntegrationApprovalActor = z.infer<
  typeof HostedIntegrationApprovalActorSchema
>;

export const HostedIntegrationPromotionApprovalTargetSchema = z
  .object({
    familyId: HostedIntegrationFamilyIdSchema,
    draftId: z.string().min(1),
    draftRevisionId: z.string().min(1),
    operation: z.literal("promote"),
    operationClass: z.enum(["read", "write", "destructive"]),
    toolNames: z.array(HostedIntegrationToolNameSchema).default([]),
    destructiveToolNames: z.array(HostedIntegrationToolNameSchema).default([]),
  })
  .strict();
export type HostedIntegrationPromotionApprovalTarget = z.infer<
  typeof HostedIntegrationPromotionApprovalTargetSchema
>;

export const HostedIntegrationHumanApprovalRecordSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    draftId: z.string().min(1),
    draftRevisionId: z.string().min(1),
    operation: z.literal("promote"),
    operationClass: z.enum(["read", "write", "destructive"]),
    approvedBy: z.string().min(1),
    approvedByEmail: z.string().email().optional(),
    approvedAt: IsoTimestampSchema,
    target: z
      .object({
        toolNames: z.array(HostedIntegrationToolNameSchema).default([]),
        destructiveToolNames: z
          .array(HostedIntegrationToolNameSchema)
          .default([]),
      })
      .strict(),
  })
  .strict();
export type HostedIntegrationHumanApprovalRecord = z.infer<
  typeof HostedIntegrationHumanApprovalRecordSchema
>;

export const HostedIntegrationGenerationProvenanceSchema = z
  .object({
    draftId: z.string().min(1),
    draftRevisionId: z.string().min(1),
    promotedBy: z.string().min(1),
    validation: z.object({
      ok: z.boolean(),
      diagnostics: z.array(JsonObjectSchema).default([]),
    }),
    approval: HostedIntegrationHumanApprovalRecordSchema.optional(),
    dependencyResolution:
      HostedIntegrationDependencyResolutionSchema.optional(),
  })
  .strict();
export type HostedIntegrationGenerationProvenance = z.infer<
  typeof HostedIntegrationGenerationProvenanceSchema
>;

export const HostedIntegrationConfigScopeSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    revision: z.number().int().positive(),
    environment: z.string().min(1),
    config: JsonObjectSchema,
    secrets: z.record(
      z.string(),
      z
        .object({
          configured: z.boolean(),
        })
        .strict(),
    ),
    updatedAt: IsoTimestampSchema,
    updatedBy: z.string().min(1),
  })
  .strict();
export type HostedIntegrationConfigScope = z.infer<
  typeof HostedIntegrationConfigScopeSchema
>;

export const HostedIntegrationExampleCategorySchema = z.enum([
  "smoke",
  "live_safe",
  "regression",
  "mock_only",
  "destructive_requires_human",
]);
export type HostedIntegrationExampleCategory = z.infer<
  typeof HostedIntegrationExampleCategorySchema
>;

export const HostedIntegrationExampleSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: HostedIntegrationToolNameSchema,
    category: HostedIntegrationExampleCategorySchema,
    args: JsonObjectSchema,
    expected: JsonValueSchema.optional(),
  })
  .strict();
export type HostedIntegrationExample = z.infer<
  typeof HostedIntegrationExampleSchema
>;

export const HostedIntegrationRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type HostedIntegrationRunStatus = z.infer<
  typeof HostedIntegrationRunStatusSchema
>;

export const HostedIntegrationRunSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: HostedIntegrationToolNameSchema,
    generationId: z.string().min(1),
    status: HostedIntegrationRunStatusSchema,
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type HostedIntegrationRun = z.infer<typeof HostedIntegrationRunSchema>;

export const HostedIntegrationJobSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: HostedIntegrationToolNameSchema,
    runId: z.string().min(1).optional(),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type HostedIntegrationJob = z.infer<typeof HostedIntegrationJobSchema>;

export const HostedIntegrationPolicyBindingSchema = z
  .object({
    agentId: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: HostedIntegrationToolNameSchema,
    allowedConfigScopeIds: z.array(z.string().min(1)).min(1),
    defaultConfigScopeId: z.string().min(1).optional(),
    environment: z.string().min(1),
  })
  .strict();
export type HostedIntegrationPolicyBinding = z.infer<
  typeof HostedIntegrationPolicyBindingSchema
>;

export const HostedIntegrationFailureBucketSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: HostedIntegrationToolNameSchema,
    generationId: z.string().min(1),
    fingerprint: z.string().min(1),
    status: z.enum(["open", "closed"]),
    count: z.number().int().positive(),
    firstSeenAt: IsoTimestampSchema,
    latestSeenAt: IsoTimestampSchema,
    assignedTo: z.string().min(1).optional(),
  })
  .strict();
export type HostedIntegrationFailureBucket = z.infer<
  typeof HostedIntegrationFailureBucketSchema
>;

export const HostedIntegrationIdempotencyRecordSchema = z
  .object({
    key: z.string().min(1),
    operation: z.enum([
      "invoke",
      "async_start",
      "promote",
      "rollback",
      "lock_change",
    ]),
    actorId: z.string().min(1),
    target: z.string().min(1),
    fingerprint: z.string().min(1),
    status: z.enum(["pending", "completed", "failed"]),
    resultEnvelopeRef: z.string().min(1).optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type HostedIntegrationIdempotencyRecord = z.infer<
  typeof HostedIntegrationIdempotencyRecordSchema
>;
