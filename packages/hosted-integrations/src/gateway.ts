import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createFileHostedIntegrationArtifactStore,
  sanitizeHostedIntegrationJsonValue,
  type HostedIntegrationArtifactRef,
  type HostedIntegrationArtifactStore,
  type HostedIntegrationSuccessEnvelope,
} from "./artifacts.js";
import {
  createFileHostedIntegrationCatalog,
  type HostedIntegrationCatalog,
} from "./catalog.js";
import {
  createFileHostedIntegrationEnvironmentConfigStore,
  type HostedIntegrationEnvironmentConfigStore,
} from "./environment-configs.js";
import {
  resolveHostedIntegrationExecutionConfig,
  type HostedIntegrationExecutionPurpose,
} from "./execution-config.js";
import {
  createFileHostedIntegrationDisablementStore,
  type HostedIntegrationDisablement,
  type HostedIntegrationDisablementStore,
} from "./disablements.js";
import { isNodeError, safePathSegment } from "./file-access.js";
import {
  createFileHostedIntegrationGenerationStore,
  type HostedIntegrationGenerationStore,
} from "./generations.js";
import {
  createFileHostedIntegrationFailureBucketStore,
  type HostedIntegrationFailureBucketStore,
} from "./failure-buckets.js";
import {
  evaluateHostedIntegrationPolicy,
  type HostedIntegrationPolicyActor,
} from "./policy.js";
import {
  resolveEnvironmentConfigReadiness,
  resolveInvocationReadiness,
  type HostedIntegrationReadiness,
} from "./readiness.js";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationEnvironmentSchema,
  HostedIntegrationIdempotencyRecordSchema,
  HostedIntegrationToolNameSchema,
  JsonObjectSchema,
  type HostedIntegrationFailureBucket,
  type HostedIntegrationHostedToolBinding,
  type HostedIntegrationIdempotencyRecord,
  type HostedIntegrationToolClassification,
  type HostedIntegrationToolSpec,
  type JsonObject,
  type JsonValue,
} from "./schemas.js";
import {
  HostedIntegrationPythonRuntime,
  type HostedIntegrationPythonRuntimeError,
} from "./python-runtime.js";
import {
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationSecretStore,
} from "./secrets.js";
import {
  createOpenTelemetryHostedIntegrationTelemetry,
  type HostedIntegrationTelemetry,
  type HostedIntegrationTelemetrySpan,
} from "./telemetry.js";

export interface FileHostedIntegrationGatewayOptions {
  dataDir: string;
  catalog?: HostedIntegrationCatalog;
  environmentConfigs?: HostedIntegrationEnvironmentConfigStore;
  secrets?: HostedIntegrationSecretStore;
  disablements?: HostedIntegrationDisablementStore;
  generations?: HostedIntegrationGenerationStore;
  artifacts?: HostedIntegrationArtifactStore;
  executionLogs?: HostedIntegrationExecutionLogStore;
  failureBuckets?: HostedIntegrationFailureBucketStore;
  telemetry?: HostedIntegrationTelemetry;
  onFailureBucketRecorded?: (
    event: HostedIntegrationFailureBucketRecordedEvent,
  ) => void | Promise<void>;
  idempotency?: HostedIntegrationIdempotencyStore;
  runtime?: Pick<HostedIntegrationPythonRuntime, "callTool">;
  now?: () => Date;
}

export interface InvokeHostedIntegrationRequest {
  actor: HostedIntegrationPolicyActor;
  familyId: string;
  toolName: string;
  environment: string;
  args: JsonObject;
  hostedToolBindings?: HostedIntegrationHostedToolBinding[];
  invocationPurpose?: "consumer" | "tool_maintenance";
  executionPurpose?: HostedIntegrationExecutionPurpose;
  requestedEnvironment?: string;
  generationId?: string;
  idempotencyKey?: string;
  approvalGranted?: boolean;
}

export type InvokeHostedIntegrationResult =
  | {
      ok: true;
      replayed: false;
      runId: string;
      generationId: string;
      envelope: HostedIntegrationSuccessEnvelope;
    }
  | {
      ok: true;
      replayed: true;
      resultEnvelopeRef: string;
    }
  | {
      ok: false;
      error: HostedIntegrationGatewayError;
      runId?: string;
    };

export interface HostedIntegrationGatewayError {
  code:
    | "policy_denied"
    | "approval_required"
    | "auth_failed"
    | "bad_arguments"
    | "config_missing"
    | "environment_config_not_found"
    | "connection_error"
    | "family_not_found"
    | "missing_config"
    | "tool_not_found"
    | "environment_missing"
    | "environment_incomplete"
    | "binding_missing"
    | "binding_invalid"
    | "tool_not_enabled"
    | "no_active_generation"
    | "generation_not_found"
    | "rate_limited"
    | "stale_generation"
    | "generation_stale"
    | "runtime_missing"
    | "runtime_config_contract_missing"
    | "runtime_error"
    | "timeout"
    | "tool_bug"
    | "tool_disabled"
    | "operationally_disabled"
    | "idempotency_conflict"
    | "upstream_error";
  message: string;
  details?: JsonValue;
}

export interface HostedIntegrationGateway {
  readonly executionLogs: HostedIntegrationExecutionLogStore;
  invoke(
    request: InvokeHostedIntegrationRequest,
  ): Promise<InvokeHostedIntegrationResult>;
}

export interface HostedIntegrationFailureBucketRecordedEvent {
  created: boolean;
  bucket: HostedIntegrationFailureBucket;
  log: HostedIntegrationExecutionLogEntry;
}

export interface HostedIntegrationExecutionLogEntry {
  runId: string;
  familyId: string;
  toolName: string;
  generationId: string;
  actorId: string;
  environmentConfigId: string | null;
  configRevision: number | null;
  executionPurpose: HostedIntegrationExecutionPurpose;
  sanitizedArgs: JsonObject;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  resultEnvelopeRef?: string;
  resultMetadata?: HostedIntegrationExecutionResultMetadata;
  error?: HostedIntegrationGatewayError;
}

export interface ListHostedIntegrationExecutionLogsRequest {
  familyId?: string;
  toolName?: string;
  generationId?: string;
  status?: HostedIntegrationExecutionLogEntry["status"];
  limit?: number;
}

export interface HostedIntegrationExecutionResultMetadata {
  envelopeRef: string;
  responseMode: "inline" | "artifact";
  artifact?: {
    name: string;
    sizeBytes: number;
    estimatedTokens: number;
  };
}

export interface HostedIntegrationExecutionLogStore {
  startLog(entry: HostedIntegrationExecutionLogEntry): Promise<void>;
  finishLog(
    runId: string,
    update: Pick<
      HostedIntegrationExecutionLogEntry,
      | "status"
      | "endedAt"
      | "durationMs"
      | "resultEnvelopeRef"
      | "resultMetadata"
      | "error"
    >,
  ): Promise<void>;
  getRunLog(runId: string): Promise<HostedIntegrationExecutionLogEntry | null>;
  listRunLogs(
    request?: ListHostedIntegrationExecutionLogsRequest,
  ): Promise<HostedIntegrationExecutionLogEntry[]>;
}

export interface HostedIntegrationIdempotencyStore {
  reserve(
    request: ReserveHostedIntegrationIdempotencyRequest,
  ): Promise<ReserveHostedIntegrationIdempotencyResult>;
  complete(request: CompleteHostedIntegrationIdempotencyRequest): Promise<void>;
}

export interface ReserveHostedIntegrationIdempotencyRequest {
  key: string;
  actorId: string;
  target: string;
  fingerprint: string;
  now: string;
}

export type ReserveHostedIntegrationIdempotencyResult =
  | { ok: true; status: "new" }
  | {
      ok: true;
      status: "replay";
      record: HostedIntegrationIdempotencyRecord;
    }
  | { ok: false; reason: "fingerprint_mismatch" };

export interface CompleteHostedIntegrationIdempotencyRequest {
  key: string;
  resultEnvelopeRef: string;
  now: string;
}

const ExecutionLogEntrySchema: z.ZodType<HostedIntegrationExecutionLogEntry> = z
  .object({
    runId: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: HostedIntegrationToolNameSchema,
    generationId: z.string().min(1),
    actorId: z.string().min(1),
    environmentConfigId: z.string().min(1).nullable(),
    configRevision: z.number().int().positive().nullable(),
    executionPurpose: z
      .enum([
        "consumer",
        "debug",
        "example",
        "regression",
        "validation",
        "parity",
        "dogfood",
      ])
      .default("consumer"),
    sanitizedArgs: JsonObjectSchema,
    status: z.enum(["running", "succeeded", "failed"]),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    resultEnvelopeRef: z.string().min(1).optional(),
    resultMetadata: z
      .object({
        envelopeRef: z.string().min(1),
        responseMode: z.enum(["inline", "artifact"]),
        artifact: z
          .object({
            name: z.string().min(1),
            sizeBytes: z.number().int().nonnegative(),
            estimatedTokens: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .strict()
      .optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z.lazy(() => z.any()).optional(),
      })
      .optional(),
  })
  .strict() as z.ZodType<HostedIntegrationExecutionLogEntry>;

export function createFileHostedIntegrationGateway(
  options: FileHostedIntegrationGatewayOptions,
): HostedIntegrationGateway {
  const catalog =
    options.catalog ?? createFileHostedIntegrationCatalog(options);
  const environmentConfigs =
    options.environmentConfigs ??
    createFileHostedIntegrationEnvironmentConfigStore({ ...options, catalog });
  const secrets =
    options.secrets ?? createFileHostedIntegrationSecretStore(options);
  const disablements =
    options.disablements ??
    createFileHostedIntegrationDisablementStore(options);
  const generations =
    options.generations ?? createFileHostedIntegrationGenerationStore(options);
  const artifacts =
    options.artifacts ?? createFileHostedIntegrationArtifactStore(options);
  const executionLogs =
    options.executionLogs ??
    createFileHostedIntegrationExecutionLogStore(options);
  const failureBuckets =
    options.failureBuckets ??
    createFileHostedIntegrationFailureBucketStore(options);
  const idempotency =
    options.idempotency ?? createFileHostedIntegrationIdempotencyStore(options);
  return new FileHostedIntegrationGateway({
    dataDir: options.dataDir,
    catalog,
    environmentConfigs,
    secrets,
    disablements,
    generations,
    artifacts,
    executionLogs,
    failureBuckets,
    telemetry:
      options.telemetry ?? createOpenTelemetryHostedIntegrationTelemetry(),
    onFailureBucketRecorded: options.onFailureBucketRecorded,
    idempotency,
    runtime: options.runtime ?? new HostedIntegrationPythonRuntime(),
    now: options.now ?? (() => new Date()),
  });
}

class FileHostedIntegrationGateway implements HostedIntegrationGateway {
  readonly executionLogs: HostedIntegrationExecutionLogStore;
  private readonly failureBuckets: HostedIntegrationFailureBucketStore;
  private readonly onFailureBucketRecorded:
    | ((
        event: HostedIntegrationFailureBucketRecordedEvent,
      ) => void | Promise<void>)
    | null;

  private readonly dataDir: string;
  private readonly catalog: HostedIntegrationCatalog;
  private readonly environmentConfigs: HostedIntegrationEnvironmentConfigStore;
  private readonly secrets: HostedIntegrationSecretStore;
  private readonly disablements: HostedIntegrationDisablementStore;
  private readonly generations: HostedIntegrationGenerationStore;
  private readonly artifacts: HostedIntegrationArtifactStore;
  private readonly idempotency: HostedIntegrationIdempotencyStore;
  private readonly runtime: Pick<HostedIntegrationPythonRuntime, "callTool">;
  private readonly telemetry: HostedIntegrationTelemetry;
  private readonly now: () => Date;

  constructor(parts: {
    dataDir: string;
    catalog: HostedIntegrationCatalog;
    environmentConfigs: HostedIntegrationEnvironmentConfigStore;
    secrets: HostedIntegrationSecretStore;
    disablements: HostedIntegrationDisablementStore;
    generations: HostedIntegrationGenerationStore;
    artifacts: HostedIntegrationArtifactStore;
    executionLogs: HostedIntegrationExecutionLogStore;
    failureBuckets: HostedIntegrationFailureBucketStore;
    telemetry: HostedIntegrationTelemetry;
    onFailureBucketRecorded?:
      | ((
          event: HostedIntegrationFailureBucketRecordedEvent,
        ) => void | Promise<void>)
      | undefined;
    idempotency: HostedIntegrationIdempotencyStore;
    runtime: Pick<HostedIntegrationPythonRuntime, "callTool">;
    now: () => Date;
  }) {
    this.dataDir = parts.dataDir;
    this.catalog = parts.catalog;
    this.environmentConfigs = parts.environmentConfigs;
    this.secrets = parts.secrets;
    this.disablements = parts.disablements;
    this.generations = parts.generations;
    this.artifacts = parts.artifacts;
    this.executionLogs = parts.executionLogs;
    this.failureBuckets = parts.failureBuckets;
    this.telemetry = parts.telemetry;
    this.onFailureBucketRecorded = parts.onFailureBucketRecorded ?? null;
    this.idempotency = parts.idempotency;
    this.runtime = parts.runtime;
    this.now = parts.now;
  }

  async invoke(
    request: InvokeHostedIntegrationRequest,
  ): Promise<InvokeHostedIntegrationResult> {
    return this.telemetry.withInvocationSpan(
      {
        "openacme.span.type": "hosted_integration_invoke",
        "openacme.hosted_integration.family_id": request.familyId,
        "openacme.hosted_integration.tool_name": request.toolName,
        "openacme.hosted_integration.environment": request.environment,
        "openacme.hosted_integration.actor_kind": request.actor.kind,
      },
      async (span) => {
        const result = await this.invokeObserved(request, span);
        observeInvocationResult(this.telemetry, span, request, result);
        return result;
      },
    );
  }

  private async invokeObserved(
    request: InvokeHostedIntegrationRequest,
    span: HostedIntegrationTelemetrySpan,
  ): Promise<InvokeHostedIntegrationResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const toolName = HostedIntegrationToolNameSchema.parse(request.toolName);
    const args = JsonObjectSchema.parse(request.args);
    const tool = await this.getTool(familyId, toolName);
    if (!tool || tool.lifecycle === "removed") {
      return failure("tool_not_found", `tool ${toolName} was not found`);
    }
    if (tool.lifecycle === "disabled") {
      return failure("tool_disabled", `tool ${toolName} is disabled`);
    }
    const toolClassification = tool.classification;

    const familyOrToolDisablement = await this.disablements.findDisabled({
      familyId,
      toolName,
    });
    if (familyOrToolDisablement) {
      return disabledFailure(familyOrToolDisablement);
    }

    const policy = evaluateHostedIntegrationPolicy({
      actor: request.actor,
      action: "invoke",
      familyId,
      toolName,
      operationClass: toolClassification.operation,
      environment: request.environment,
      mode: "run",
      requestedEnvironment: request.requestedEnvironment,
      toolClassification,
      hostedToolBindings: request.hostedToolBindings,
      approvalGranted: request.approvalGranted,
    });
    if (!policy.ok) {
      return readinessFailure(
        resolveInvocationReadiness({
          actor: request.actor,
          familyId,
          toolName,
          toolLifecycle: tool.lifecycle,
          policyDecision: policy,
          environmentReadiness: readyEnvironmentReadinessForPolicyFailure(
            familyId,
            request.environment,
          ),
        }),
      );
    }

    const lease = await this.generations.beginInvocation({
      familyId,
      generationId: request.generationId,
    });
    if (!lease.ok) return failure(lease.reason, lease.reason);
    const generation = await this.generations.getGeneration(
      lease.lease.generationId,
    );
    span.setAttributes({
      "openacme.hosted_integration.generation_id": lease.lease.generationId,
    });
    if (!generation) {
      await this.generations.completeInvocation({ leaseId: lease.lease.id });
      return failure("generation_not_found", "generation was not found");
    }
    const generationDisablement = await this.disablements.findDisabled({
      familyId,
      generationId: generation.id,
    });
    if (generationDisablement) {
      await this.generations.completeInvocation({ leaseId: lease.lease.id });
      return disabledFailure(generationDisablement);
    }
    if (!generation.runtime) {
      await this.generations.completeInvocation({ leaseId: lease.lease.id });
      return failure("runtime_missing", "generation has no runtime metadata");
    }
    const environment = HostedIntegrationEnvironmentSchema.parse(
      policy.resolvedEnvironment ?? request.environment,
    );
    const environmentConfig =
      await this.environmentConfigs.getEnvironmentConfig(familyId, environment);
    const resolvedEnvironmentConfig =
      environmentConfig && environmentConfig.familyId === familyId
        ? environmentConfig
        : null;
    const executionConfig = resolveHostedIntegrationExecutionConfig({
      familyId,
      environment,
      generation,
      policyDecision: policy,
      environmentConfig: resolvedEnvironmentConfig,
      executionPurpose:
        request.executionPurpose ??
        (request.invocationPurpose === "tool_maintenance"
          ? "debug"
          : "consumer"),
    });
    if (!executionConfig.ok) {
      await this.generations.completeInvocation({ leaseId: lease.lease.id });
      return readinessFailure(
        resolveInvocationReadiness({
          actor: request.actor,
          familyId,
          toolName,
          toolLifecycle: tool.lifecycle,
          policyDecision: policy,
          environmentReadiness: executionConfig.error,
          capturedGenerationId: request.generationId,
          resolvedGenerationId: generation.id,
        }),
      );
    }
    span.setAttributes({
      "openacme.hosted_integration.config_mode": executionConfig.mode,
      "openacme.hosted_integration.execution_purpose":
        executionConfig.executionPurpose,
      "openacme.hosted_integration.environment_config_id":
        executionConfig.environmentConfigId ?? "",
      "openacme.hosted_integration.config_revision":
        executionConfig.configRevision ?? 0,
    });
    if (executionConfig.mode === "config_backed") {
      const environmentConfigDisablement = await this.disablements.findDisabled(
        {
          familyId,
          environmentConfigId: executionConfig.environmentConfigId,
        },
      );
      if (environmentConfigDisablement) {
        await this.generations.completeInvocation({ leaseId: lease.lease.id });
        return disabledFailure(environmentConfigDisablement);
      }
    }
    const dispatchReadiness = resolveInvocationReadiness({
      actor: request.actor,
      familyId,
      toolName,
      toolLifecycle: tool.lifecycle,
      policyDecision: policy,
      environmentReadiness: executionConfig.readiness,
      capturedGenerationId: request.generationId,
      resolvedGenerationId: generation.id,
    });
    if (dispatchReadiness.status !== "ready") {
      await this.generations.completeInvocation({ leaseId: lease.lease.id });
      return readinessFailure(dispatchReadiness);
    }

    const fingerprint = fingerprintInvocation({
      actorId: request.actor.id,
      familyId,
      toolName,
      args,
      environmentConfigId: executionConfig.environmentConfigId,
      configRevision: executionConfig.configRevision,
      executionPurpose: executionConfig.executionPurpose,
      generationId: generation.id,
    });
    const target = `${familyId}/${toolName}/${generation.id}`;
    if (request.idempotencyKey) {
      const reserved = await this.idempotency.reserve({
        key: request.idempotencyKey,
        actorId: request.actor.id,
        target,
        fingerprint,
        now: this.now().toISOString(),
      });
      if (!reserved.ok) {
        await this.generations.completeInvocation({ leaseId: lease.lease.id });
        return failure(
          "idempotency_conflict",
          "idempotency key was reused with a different fingerprint",
        );
      }
      if (reserved.status === "replay") {
        await this.generations.completeInvocation({ leaseId: lease.lease.id });
        return {
          ok: true,
          replayed: true,
          resultEnvelopeRef: reserved.record.resultEnvelopeRef ?? "",
        };
      }
    }

    const { run, familyHome, runDir } = await this.artifacts.createRun({
      familyId,
      toolName,
      generationId: generation.id,
      actorId: request.actor.id,
      input: args,
    });
    span.setAttributes({ "openacme.hosted_integration.run_id": run.id });
    await this.executionLogs.startLog({
      runId: run.id,
      familyId,
      toolName,
      generationId: generation.id,
      actorId: request.actor.id,
      environmentConfigId: executionConfig.environmentConfigId ?? null,
      configRevision: executionConfig.configRevision ?? null,
      executionPurpose: executionConfig.executionPurpose,
      sanitizedArgs: sanitizeJsonObject(args),
      status: "running",
      startedAt: run.startedAt,
    });

    const suppressFailureBucket =
      request.invocationPurpose === "tool_maintenance";

    try {
      const runtimeResult = await this.runtime.callTool({
        familyId,
        generationId: generation.id,
        filesRoot: generationFilesRoot(this.dataDir, generation.id),
        runtime: generation.runtime,
        timeoutMs: generation.runtime.defaultTimeoutMs,
        toolName,
        args,
        context: {
          familyId,
          generationId: generation.id,
          runId: run.id,
          familyHome,
          runDir,
          config: executionConfig.config,
          secrets: executionConfig.secretsEnvironmentConfigId
            ? await this.secrets.readSecretsForRuntime({
                environmentConfigId: executionConfig.secretsEnvironmentConfigId,
              })
            : {},
        },
      });
      if (!runtimeResult.ok) {
        return await this.failRun({
          familyId,
          runId: run.id,
          startedAt: run.startedAt,
          leaseId: lease.lease.id,
          error: normalizeRuntimeError(runtimeResult.error),
          suppressFailureBucket,
        });
      }

      const envelope = await this.artifacts.completeRunSuccess({
        familyId,
        runId: run.id,
        result: runtimeResult.result,
        inlineResultTokenLimit: generation.runtime.inlineResultTokenLimit,
      });
      const resultEnvelopeRef = `${run.id}/output.json`;
      const endedAt = this.now().toISOString();
      await this.executionLogs.finishLog(run.id, {
        status: "succeeded",
        endedAt,
        durationMs: durationMs(run.startedAt, endedAt),
        resultEnvelopeRef,
        resultMetadata: resultMetadata(resultEnvelopeRef, envelope),
      });
      if (request.idempotencyKey) {
        await this.idempotency.complete({
          key: request.idempotencyKey,
          resultEnvelopeRef,
          now: this.now().toISOString(),
        });
      }
      await this.generations.completeInvocation({ leaseId: lease.lease.id });
      return {
        ok: true,
        replayed: false,
        runId: run.id,
        generationId: generation.id,
        envelope,
      };
    } catch (error) {
      return await this.failRun({
        familyId,
        runId: run.id,
        startedAt: run.startedAt,
        leaseId: lease.lease.id,
        error: {
          code: "runtime_error",
          message: error instanceof Error ? error.message : String(error),
        },
        suppressFailureBucket,
      });
    }
  }

  private async getTool(
    familyId: string,
    toolName: string,
  ): Promise<HostedIntegrationToolSpec | null> {
    const family = await this.catalog.getFamily(familyId);
    return (
      family?.manifest.tools.find((candidate) => {
        return candidate.name === toolName;
      }) ?? null
    );
  }

  private async failRun(args: {
    familyId: string;
    runId: string;
    startedAt: string;
    leaseId: string;
    error: HostedIntegrationGatewayError;
    suppressFailureBucket?: boolean;
  }): Promise<InvokeHostedIntegrationResult> {
    const sanitizedError = sanitizeGatewayError(args.error);
    await this.artifacts.completeRunError({
      familyId: args.familyId,
      runId: args.runId,
      error: gatewayErrorToJson(sanitizedError),
    });
    const endedAt = this.now().toISOString();
    await this.executionLogs.finishLog(args.runId, {
      status: "failed",
      endedAt,
      durationMs: durationMs(args.startedAt, endedAt),
      error: sanitizedError,
    });
    if (!args.suppressFailureBucket) {
      await this.recordFailureBucket(args.runId);
    }
    await this.generations.completeInvocation({ leaseId: args.leaseId });
    return { ok: false, runId: args.runId, error: sanitizedError };
  }

  private async recordFailureBucket(runId: string): Promise<void> {
    try {
      const log = await this.executionLogs.getRunLog(runId);
      if (!log) return;
      const result = await this.failureBuckets.recordFailure({ log });
      if (result.ok) {
        await this.onFailureBucketRecorded?.({
          created: result.created,
          bucket: result.bucket,
          log,
        });
      }
    } catch {
      // Bucket creation is a repair signal, not part of the caller-visible
      // tool result. Do not mask the original hosted integration failure.
    }
  }
}

export function createFileHostedIntegrationExecutionLogStore(options: {
  dataDir: string;
}): HostedIntegrationExecutionLogStore {
  return new FileHostedIntegrationExecutionLogStore(options.dataDir);
}

class FileHostedIntegrationExecutionLogStore implements HostedIntegrationExecutionLogStore {
  private readonly logsDir: string;

  constructor(dataDir: string) {
    this.logsDir = path.join(dataDir, "hosted-integrations", "execution-logs");
  }

  async startLog(entry: HostedIntegrationExecutionLogEntry): Promise<void> {
    await this.writeLog(ExecutionLogEntrySchema.parse(entry));
  }

  async finishLog(
    runId: string,
    update: Pick<
      HostedIntegrationExecutionLogEntry,
      "status" | "endedAt" | "resultEnvelopeRef" | "error"
    >,
  ): Promise<void> {
    const existing = await this.getRunLog(runId);
    if (!existing) throw new Error(`execution log ${runId} not found`);
    await this.writeLog(
      ExecutionLogEntrySchema.parse({ ...existing, ...update }),
    );
  }

  async getRunLog(
    runId: string,
  ): Promise<HostedIntegrationExecutionLogEntry | null> {
    try {
      return ExecutionLogEntrySchema.parse(
        JSON.parse(await readFile(this.logPath(runId), "utf-8")),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async listRunLogs(
    request: ListHostedIntegrationExecutionLogsRequest = {},
  ): Promise<HostedIntegrationExecutionLogEntry[]> {
    const entries: HostedIntegrationExecutionLogEntry[] = [];
    try {
      const fileNames = (await readdir(this.logsDir)).filter((fileName) =>
        fileName.endsWith(".json"),
      );
      for (const fileName of fileNames) {
        try {
          entries.push(
            ExecutionLogEntrySchema.parse(
              JSON.parse(
                await readFile(path.join(this.logsDir, fileName), "utf-8"),
              ),
            ),
          );
        } catch {
          // Historical or partially-written logs must not take down list views.
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    return filterAndLimitExecutionLogs(entries, request);
  }

  private async writeLog(
    entry: HostedIntegrationExecutionLogEntry,
  ): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    const filePath = this.logPath(entry.runId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private logPath(runId: string): string {
    return path.join(this.logsDir, `${safePathSegment("runId", runId)}.json`);
  }
}

function filterAndLimitExecutionLogs(
  entries: HostedIntegrationExecutionLogEntry[],
  request: ListHostedIntegrationExecutionLogsRequest,
): HostedIntegrationExecutionLogEntry[] {
  const limit = normalizeExecutionLogLimit(request.limit);
  return entries
    .filter((entry) => {
      if (request.familyId && entry.familyId !== request.familyId) return false;
      if (request.toolName && entry.toolName !== request.toolName) return false;
      if (request.generationId && entry.generationId !== request.generationId) {
        return false;
      }
      if (request.status && entry.status !== request.status) return false;
      return true;
    })
    .sort((left, right) =>
      (right.endedAt ?? right.startedAt).localeCompare(
        left.endedAt ?? left.startedAt,
      ),
    )
    .slice(0, limit);
}

function normalizeExecutionLogLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return 25;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

export function createFileHostedIntegrationIdempotencyStore(options: {
  dataDir: string;
}): HostedIntegrationIdempotencyStore {
  return new FileHostedIntegrationIdempotencyStore(options.dataDir);
}

class FileHostedIntegrationIdempotencyStore implements HostedIntegrationIdempotencyStore {
  private readonly recordsDir: string;

  constructor(dataDir: string) {
    this.recordsDir = path.join(dataDir, "hosted-integrations", "idempotency");
  }

  async reserve(
    request: ReserveHostedIntegrationIdempotencyRequest,
  ): Promise<ReserveHostedIntegrationIdempotencyResult> {
    const existing = await this.getRecord(request.key);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint) {
        return { ok: false, reason: "fingerprint_mismatch" };
      }
      if (existing.status === "completed") {
        return { ok: true, status: "replay", record: existing };
      }
      return { ok: true, status: "replay", record: existing };
    }

    await this.writeRecord(
      HostedIntegrationIdempotencyRecordSchema.parse({
        key: request.key,
        operation: "invoke",
        actorId: request.actorId,
        target: request.target,
        fingerprint: request.fingerprint,
        status: "pending",
        createdAt: request.now,
        updatedAt: request.now,
      }),
    );
    return { ok: true, status: "new" };
  }

  async complete(
    request: CompleteHostedIntegrationIdempotencyRequest,
  ): Promise<void> {
    const existing = await this.getRecord(request.key);
    if (!existing) return;
    await this.writeRecord(
      HostedIntegrationIdempotencyRecordSchema.parse({
        ...existing,
        status: "completed",
        resultEnvelopeRef: request.resultEnvelopeRef,
        updatedAt: request.now,
      }),
    );
  }

  private async getRecord(
    key: string,
  ): Promise<HostedIntegrationIdempotencyRecord | null> {
    try {
      return HostedIntegrationIdempotencyRecordSchema.parse(
        JSON.parse(await readFile(this.recordPath(key), "utf-8")),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeRecord(
    record: HostedIntegrationIdempotencyRecord,
  ): Promise<void> {
    await mkdir(this.recordsDir, { recursive: true });
    const filePath = this.recordPath(record.key);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private recordPath(key: string): string {
    return path.join(
      this.recordsDir,
      `${safePathSegment("idempotencyKey", key)}.json`,
    );
  }
}

function generationFilesRoot(dataDir: string, generationId: string): string {
  return path.join(
    dataDir,
    "hosted-integrations",
    "generations",
    safePathSegment("generationId", generationId),
    "files",
  );
}

function normalizeRuntimeError(
  error: HostedIntegrationPythonRuntimeError,
): HostedIntegrationGatewayError {
  return {
    code: error.code,
    message: error.message,
    details: error.details,
  };
}

function gatewayErrorToJson(error: HostedIntegrationGatewayError): JsonObject {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function sanitizeJsonObject(value: JsonObject): JsonObject {
  return JsonObjectSchema.parse(sanitizeHostedIntegrationJsonValue(value));
}

function sanitizeGatewayError(
  error: HostedIntegrationGatewayError,
): HostedIntegrationGatewayError {
  const sanitized = sanitizeJsonObject(gatewayErrorToJson(error));
  return {
    code: String(sanitized.code) as HostedIntegrationGatewayError["code"],
    message: String(sanitized.message),
    ...(sanitized.details === undefined ? {} : { details: sanitized.details }),
  };
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function resultMetadata(
  envelopeRef: string,
  envelope: HostedIntegrationSuccessEnvelope,
): HostedIntegrationExecutionResultMetadata {
  if ("result_ref" in envelope) {
    return {
      envelopeRef,
      responseMode: "artifact",
      artifact: artifactMetadata(envelope.result_ref),
    };
  }
  return { envelopeRef, responseMode: "inline" };
}

function artifactMetadata(ref: HostedIntegrationArtifactRef): {
  name: string;
  sizeBytes: number;
  estimatedTokens: number;
} {
  return {
    name: ref.name,
    sizeBytes: ref.size_bytes,
    estimatedTokens: ref.estimated_tokens,
  };
}

function failure(
  code: HostedIntegrationGatewayError["code"],
  message: string,
): InvokeHostedIntegrationResult {
  return { ok: false, error: { code, message } };
}

function readinessFailure(
  readiness: HostedIntegrationReadiness,
): InvokeHostedIntegrationResult {
  const blocker = readiness.blockers[0];
  return failure(
    gatewayCodeForReadiness(readiness.code),
    blocker?.message ?? readiness.code,
  );
}

function readyEnvironmentReadinessForPolicyFailure(
  familyId: string,
  environment: string,
): HostedIntegrationReadiness {
  return {
    kind: "environment_config",
    status: "ready",
    code: "ready",
    target: {
      familyId,
      environment,
      environmentConfigId: `${familyId}-${environment}`,
    },
    blockers: [],
  };
}

function gatewayCodeForReadiness(
  code: string,
): HostedIntegrationGatewayError["code"] {
  switch (code) {
    case "environment_missing":
    case "environment_incomplete":
    case "binding_missing":
    case "binding_invalid":
    case "tool_not_enabled":
    case "tool_disabled":
    case "approval_required":
    case "generation_stale":
      return code;
    default:
      return "policy_denied";
  }
}

function disabledFailure(
  disablement: HostedIntegrationDisablement,
): InvokeHostedIntegrationResult {
  return {
    ok: false,
    error: {
      code: "operationally_disabled",
      message:
        disablement.reason ??
        `hosted integration ${disablement.key} is disabled`,
      details: { target: disablement.target },
    },
  };
}

function observeInvocationResult(
  telemetry: HostedIntegrationTelemetry,
  span: HostedIntegrationTelemetrySpan,
  request: InvokeHostedIntegrationRequest,
  result: InvokeHostedIntegrationResult,
): void {
  if (result.ok) {
    span.setAttributes({
      "openacme.hosted_integration.status": "succeeded",
      "openacme.hosted_integration.replayed": result.replayed,
    });
    span.setStatusOk();
    if (!result.replayed) {
      span.setAttributes({
        "openacme.hosted_integration.generation_id": result.generationId,
      });
      if ("result_ref" in result.envelope) {
        const attrs = largeResponseAttributes(request, result);
        span.addEvent("openacme.hosted_integration.large_response", attrs);
        telemetry.recordLargeResponse(attrs);
      }
    }
    return;
  }

  span.setAttributes({
    "openacme.hosted_integration.status": "failed",
    "openacme.hosted_integration.error_code": result.error.code,
  });
  if (result.runId) {
    span.setAttributes({ "openacme.hosted_integration.run_id": result.runId });
  }
  if (
    result.error.code === "policy_denied" ||
    result.error.code === "approval_required" ||
    result.error.code === "config_missing"
  ) {
    span.addEvent("openacme.hosted_integration.policy_denied", {
      "openacme.hosted_integration.error_code": result.error.code,
    });
  }
  span.setStatusError(result.error.code);
}

function largeResponseAttributes(
  request: InvokeHostedIntegrationRequest,
  result: Extract<InvokeHostedIntegrationResult, { ok: true; replayed: false }>,
): Record<string, string | number | boolean> {
  const ref =
    "result_ref" in result.envelope ? result.envelope.result_ref : null;
  return {
    "openacme.hosted_integration.family_id": request.familyId,
    "openacme.hosted_integration.tool_name": request.toolName,
    "openacme.hosted_integration.actor_kind": request.actor.kind,
    "openacme.hosted_integration.generation_id": result.generationId,
    "openacme.hosted_integration.response_mode": "artifact",
    "openacme.hosted_integration.artifact_size_bytes": ref?.size_bytes ?? 0,
    "openacme.hosted_integration.artifact_estimated_tokens":
      ref?.estimated_tokens ?? 0,
  };
}

function fingerprintInvocation(value: JsonValue): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
