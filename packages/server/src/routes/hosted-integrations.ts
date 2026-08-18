import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  HostedIntegrationExampleSchema,
  HostedIntegrationDisableTargetSchema,
  FamilyManifestSchema,
  HostedIntegrationPythonRuntime,
  HostedIntegrationHostedToolBindingSchema,
  HostedIntegrationPromotionApprovalTargetSchema,
  HostedIntegrationToolHelpRequestSchema,
  HostedIntegrationToolHelpSchema,
  HostedToolContractDocumentSchema,
  JsonObjectSchema,
  buildHostedIntegrationFocusedSourceView,
  buildHostedIntegrationGenerationDiff,
  buildHostedToolName,
  evaluateHostedIntegrationPolicy,
  evaluateHostedIntegrationPromotionApproval,
  generationFilesRoot,
  isHostedIntegrationToolVisibleForSelection,
  hostedToolContractToToolSpecs,
  listFilesUnderRoot,
  parseHostedToolName,
  readTextFileUnderRoot,
  resolveAgentHostedToolBindingReadiness,
  resolveDebugReadiness,
  resolveEnvironmentConfigReadiness,
  resolveInvocationReadiness,
  resolvePublishReadiness,
  resolveHostedIntegrationExecutionConfig,
  resolveRuntimeConfigContractReadiness,
  resolveHostedIntegrationToolHelp,
  sanitizeHostedToolControlPlaneString,
  type FamilyManifest,
  type HostedIntegrationDraft,
  type HostedIntegrationExample,
  type HostedIntegrationExecutionLogEntry,
  type HostedIntegrationGatewayError,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
  type HostedIntegrationJob,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationReadiness,
  type HostedIntegrationService,
  type HostedIntegrationToolSpec,
} from "@openacme/hosted-integrations";
import type { AuthStore } from "@openacme/db";
import { resolveMember } from "../middleware/auth.js";
import { validateHostedIntegrationRegressionClose } from "../hosted-integration-regression.js";

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;
const HOSTED_TOOL_HELP_TOOL_NAME = "hosted_tool_help";

export interface HostedIntegrationRouteOptions {
  authStore?: AuthStore;
  dataDir?: string;
  persistenceBackend?: "file" | "db";
  resolveAgentDef?: (agentId: string) => {
    id?: string;
    name?: string;
    tools: string[];
    hostedIntegrationBindings?: unknown[];
  } | null;
  listAgentDefs?: () => Array<{
    id: string;
    name?: string;
    tools: string[];
    hostedIntegrationBindings?: unknown[];
  }>;
  onHostedIntegrationDeleteDraining?: (familyId: string) => void;
}

export function registerHostedIntegrationRoutes(
  app: Hono,
  service: HostedIntegrationService,
  options: HostedIntegrationRouteOptions = {},
): void {
  app.get("/api/hosted-integrations/persistence", (c) => {
    return c.json({
      persistence: {
        backend: options.persistenceBackend ?? "file",
      },
    });
  });

  app.get(
    "/api/hosted-integrations/readiness/environment-configs/:family/:environment",
    async (c) => {
      try {
        const familyId = c.req.param("family");
        const environment = c.req.param("environment");
        const environmentConfig =
          await service.environmentConfigs.getEnvironmentConfig(
            familyId,
            environment,
          );
        return c.json({
          ok: true,
          readiness: resolveEnvironmentConfigReadinessForRoute(
            familyId,
            environment,
            environmentConfig,
          ),
        });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.get(
    "/api/hosted-integrations/readiness/bindings/:agentId/:family/:toolName",
    async (c) => {
      try {
        const agentId = c.req.param("agentId");
        const familyId = c.req.param("family");
        const toolName = c.req.param("toolName");
        const activeGeneration =
          await service.generations.getActiveGeneration(familyId);
        return c.json({
          ok: true,
          readiness: resolveAgentHostedToolBindingReadiness({
            agentId,
            familyId,
            toolName,
            hostedToolBindings: (
              options.resolveAgentDef?.(agentId)?.hostedIntegrationBindings ??
              []
            ).map((binding) =>
              isRecord(binding) && !("agentId" in binding)
                ? { agentId, ...binding }
                : binding,
            ),
            activeGenerationId: activeGeneration?.id,
          }),
        });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.get("/api/hosted-integrations/readiness/debug", async (c) => {
    try {
      const familyId = stringFieldFromQuery(c, "familyId");
      const toolName = stringFieldFromQuery(c, "toolName");
      const environment = c.req.query("environment") ?? "test_debug";
      const family = await service.getFamily(familyId);
      const tool = family?.tools.find(
        (candidate) => candidate.name === toolName,
      );
      const environmentConfig =
        await service.environmentConfigs.getEnvironmentConfig(
          familyId,
          environment,
        );
      const activeGeneration =
        await service.generations.getActiveGeneration(familyId);
      const executionConfig = resolveHostedIntegrationExecutionConfig({
        familyId,
        environment: environment === "prod" ? "prod" : "test_debug",
        generation: {
          runtimeConfig: activeGeneration?.runtimeConfig,
        },
        policyDecision: {
          ok: true,
          resolvedEnvironment: environment === "prod" ? "prod" : "test_debug",
        },
        environmentConfig,
        executionPurpose: "debug",
      });
      return c.json({
        ok: true,
        readiness: resolveDebugReadiness({
          actor: actorFromQuery(c),
          familyId,
          toolName,
          environment,
          allowProdEnvironment: c.req.query("allowProdEnvironment") === "true",
          operation: tool?.classification.operation ?? "read",
          environmentReadiness: executionConfig.ok
            ? executionConfig.readiness
            : executionConfig.error,
        }),
      });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/readiness/invocation", async (c) => {
    try {
      const agentId = stringFieldFromQuery(c, "agentId");
      const familyId = stringFieldFromQuery(c, "familyId");
      const toolName = stringFieldFromQuery(c, "toolName");
      const family = await service.getFamily(familyId);
      const tool = family?.tools.find(
        (candidate) => candidate.name === toolName,
      );
      const bindings = (
        options.resolveAgentDef?.(agentId)?.hostedIntegrationBindings ?? []
      ).map((binding) =>
        isRecord(binding) && !("agentId" in binding)
          ? { agentId, ...binding }
          : binding,
      );
      const policyDecision = evaluateHostedIntegrationPolicy({
        actor: { id: agentId, kind: "agent", roles: ["agent"] },
        action: "invoke",
        familyId,
        toolName,
        operationClass: tool?.classification.operation ?? "read",
        environment: "test_debug",
        mode: "run",
        toolClassification: tool?.classification,
        hostedToolBindings: bindings
          .map((binding) =>
            HostedIntegrationHostedToolBindingSchema.safeParse(binding),
          )
          .filter((result) => result.success)
          .map((result) => result.data),
      });
      const environment =
        policyDecision.ok && policyDecision.resolvedEnvironment
          ? policyDecision.resolvedEnvironment
          : "test_debug";
      const environmentConfig =
        await service.environmentConfigs.getEnvironmentConfig(
          familyId,
          environment,
        );
      const activeGeneration =
        await service.generations.getActiveGeneration(familyId);
      const executionConfig = resolveHostedIntegrationExecutionConfig({
        familyId,
        environment,
        generation: {
          runtimeConfig: activeGeneration?.runtimeConfig,
        },
        policyDecision,
        environmentConfig,
        executionPurpose: "consumer",
      });
      return c.json({
        ok: true,
        readiness: resolveInvocationReadiness({
          actor: { id: agentId, kind: "agent", roles: ["agent"] },
          familyId,
          toolName,
          toolLifecycle: tool?.lifecycle,
          policyDecision,
          environmentReadiness: executionConfig.ok
            ? executionConfig.readiness
            : executionConfig.error,
          capturedGenerationId:
            c.req.query("capturedGenerationId") ?? undefined,
          resolvedGenerationId: activeGeneration?.id,
        }),
      });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get(
    "/api/hosted-integrations/readiness/drafts/:draftId/publish",
    async (c) => {
      try {
        const draftId = c.req.param("draftId");
        const draft = await service.drafts.getDraft(draftId);
        const validation = draft
          ? await service.validator.validateDraft(draftId)
          : null;
        return c.json({
          ok: true,
          readiness: draft
            ? await resolvePublishReadinessForDraft({
                service,
                draftId,
                draftExists: true,
                validation,
              })
            : resolvePublishReadiness({
                draftId,
                draftExists: false,
                validation,
                runtimeConfigContract: { status: "missing" },
              }),
        });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.get(
    ["/api/hosted-integrations/readiness", "mig" + "ration"].join("/"),
    (c) =>
      c.json(
        {
          ok: false,
          error: {
            code: "not_found",
            message: "hosted integration readiness target is not available",
          },
        },
        404,
      ),
  );

  app.get(
    "/api/hosted-integrations/families/:familyId/tools/:toolName/agent-bindings",
    async (c) => {
      try {
        const familyId = c.req.param("familyId");
        const toolName = c.req.param("toolName");
        const family = await service.getFamily(familyId);
        const tool = family?.tools.find(
          (candidate) => candidate.name === toolName,
        );
        if (!family || !tool || tool.lifecycle === "removed") {
          return c.json({ ok: false, error: { code: "tool_not_found" } }, 404);
        }
        const hostedToolName = buildHostedToolName({
          familyId,
          toolName,
        });
        const bindings = (options.listAgentDefs?.() ?? [])
          .flatMap((agent) =>
            (agent.hostedIntegrationBindings ?? []).map((binding) => ({
              agent,
              binding,
            })),
          )
          .map(({ agent, binding }) => {
            const parsed = HostedIntegrationHostedToolBindingSchema.safeParse(
              isRecord(binding) && !("agentId" in binding)
                ? { agentId: agent.id, ...binding }
                : binding,
            );
            if (!parsed.success) return null;
            if (
              parsed.data.familyId !== familyId ||
              parsed.data.toolName !== toolName
            ) {
              return null;
            }
            if (!agent.tools.includes(hostedToolName)) return null;
            return {
              agentId: agent.id,
              agentName: agent.name ?? agent.id,
              hostedToolName,
              familyId,
              toolName,
              bindingKind: parsed.data.bindingKind,
              allowedEnvironments: parsed.data.allowedEnvironments,
              defaultEnvironment: parsed.data.defaultEnvironment,
              generationPin: parsed.data.generationPin,
              ...(parsed.data.purpose ? { purpose: parsed.data.purpose } : {}),
              ...(parsed.data.bindingNote
                ? { bindingNote: parsed.data.bindingNote }
                : {}),
              updatedAt: parsed.data.updatedAt,
              updatedBy: parsed.data.updatedBy,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null)
          .sort((a, b) => {
            if (a.bindingKind !== b.bindingKind) {
              return a.bindingKind === "agent" ? -1 : 1;
            }
            return a.agentId.localeCompare(b.agentId);
          });
        return c.json({
          ok: true,
          familyId,
          toolName,
          hostedToolName,
          bindings,
        });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.post("/api/hosted-integrations/invoke", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.gateway.invoke({
        actor: actorField(body),
        familyId: stringField(body, "familyId"),
        toolName: stringField(body, "toolName"),
        environment:
          optionalStringField(body, "requestedEnvironment") ?? "test_debug",
        args: JsonObjectSchema.parse(objectField(body, "args")),
        hostedToolBindings: hostedToolBindingsField(body),
        requestedEnvironment:
          optionalStringField(body, "requestedEnvironment") ?? undefined,
        generationId: optionalStringField(body, "generationId") ?? undefined,
        idempotencyKey:
          optionalStringField(body, "idempotencyKey") ?? undefined,
        approvalGranted: optionalBooleanField(body, "approvalGranted"),
      });
      if (result.ok) return c.json(result);
      return c.json(result, statusForGatewayError(result.error.code));
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/help", async (c) => {
    try {
      const body = await readJsonObject(c);
      if (!options.dataDir) {
        return c.json(
          {
            ok: false,
            error: {
              code: "platform_unavailable",
              message: "hosted integration help requires a configured dataDir",
            },
          },
          500,
        );
      }
      const actor = actorField(body);
      const request = HostedIntegrationToolHelpRequestSchema.parse({
        tool_name: stringField(body, "tool_name"),
        tool_detail: optionalStringField(body, "tool_detail") ?? undefined,
        include_examples:
          optionalBooleanField(body, "include_examples") ?? false,
        parameters: Array.isArray(body.parameters)
          ? body.parameters
          : undefined,
      });
      const parsedName = parseHostedToolName(request.tool_name);
      if (!parsedName) {
        return c.json(
          {
            ok: false,
            error: {
              code: "bad_arguments",
              message:
                "tool_name must be a hosted tool name like hosted_<family>__<tool>",
            },
          },
          400,
        );
      }
      const access = hostedIntegrationHelpAccess(options, {
        actorId: actor.id,
        familyId: parsedName.familyId,
        canonicalToolName: request.tool_name,
        toolName: parsedName.toolName,
      });
      if (!access.ok) {
        return c.json({ ok: false, error: access.error }, 403);
      }
      const result = await resolveHostedIntegrationToolHelp({
        dataDir: options.dataDir,
        generations: service.generations,
        hostedToolName: request.tool_name,
        familyId: parsedName.familyId,
        toolName: parsedName.toolName,
        request: {
          tool_detail: request.tool_detail,
          include_examples: request.include_examples,
          parameters: request.parameters,
        },
      });
      if (result.ok) return c.json({ ok: true, help: result.help });
      return c.json(result, statusForHelpError(result.error.code));
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/jobs", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      const familyId = stringField(body, "familyId");
      const toolName = stringField(body, "toolName");
      const requestedEnvironment =
        optionalStringField(body, "requestedEnvironment") ?? undefined;
      const args = JsonObjectSchema.parse(objectField(body, "args"));
      const family = await service.getFamily(familyId);
      const tool = family?.tools.find(
        (candidate) => candidate.name === toolName,
      );
      if (!family || !tool || tool.lifecycle === "removed") {
        return c.json({ ok: false, error: { code: "tool_not_found" } }, 404);
      }
      if (tool.lifecycle === "disabled") {
        return c.json({ ok: false, error: { code: "tool_disabled" } }, 403);
      }
      if (tool.classification.execution !== "async") {
        return c.json({ ok: false, error: { code: "sync_only" } }, 400);
      }

      const policy = evaluateHostedIntegrationPolicy({
        actor,
        action: "invoke",
        familyId,
        toolName,
        operationClass: tool.classification.operation,
        environment: requestedEnvironment ?? "test_debug",
        mode: "run",
        toolClassification: tool.classification,
        hostedToolBindings: hostedToolBindingsField(body),
        requestedEnvironment,
        approvalGranted: optionalBooleanField(body, "approvalGranted"),
      });
      if (!policy.ok) {
        const readiness = resolveInvocationReadiness({
          actor,
          familyId,
          toolName,
          toolLifecycle: tool.lifecycle,
          policyDecision: policy,
          environmentReadiness: readyEnvironmentReadinessForRoute(
            familyId,
            requestedEnvironment ?? "test_debug",
          ),
        });
        return c.json(
          {
            ok: false,
            error: { code: readiness.code, message: policy.message },
            readiness,
          },
          statusForGatewayError(readiness.code),
        );
      }
      const generationId = optionalStringField(body, "generationId");
      const generation = generationId
        ? await service.generations.getGeneration(generationId)
        : await service.generations.getActiveGeneration(familyId);
      if (!generation) {
        return c.json(
          {
            ok: false,
            error: {
              code: generationId
                ? "generation_not_found"
                : "no_active_generation",
            },
          },
          404,
        );
      }
      if (generation.familyId !== familyId || generation.status !== "active") {
        return c.json({ ok: false, error: { code: "stale_generation" } }, 404);
      }
      const environment = (policy.resolvedEnvironment ??
        requestedEnvironment ??
        "test_debug") as "prod" | "test_debug";
      const environmentConfig =
        await service.environmentConfigs.getEnvironmentConfig(
          familyId,
          environment,
        );
      const executionConfig = resolveHostedIntegrationExecutionConfig({
        familyId,
        environment,
        generation,
        policyDecision: policy,
        environmentConfig:
          environmentConfig && environmentConfig.familyId === familyId
            ? environmentConfig
            : null,
        executionPurpose: "consumer",
      });
      if (!executionConfig.ok) {
        const readiness = resolveInvocationReadiness({
          actor,
          familyId,
          toolName,
          toolLifecycle: tool.lifecycle,
          policyDecision: policy,
          environmentReadiness: executionConfig.error,
          resolvedGenerationId: generation.id,
        });
        return c.json(
          { ok: false, error: { code: readiness.code }, readiness },
          statusForGatewayError(readiness.code),
        );
      }

      const requestFingerprint = fingerprintJson({
        actorId: actor.id,
        familyId,
        toolName,
        generationId: generation.id,
        environmentConfigId: executionConfig.environmentConfigId,
        environmentConfigRevision: executionConfig.configRevision,
        environment: executionConfig.environment,
        executionPurpose: executionConfig.executionPurpose,
        args,
      });
      const started = await service.jobs.startJob({
        familyId,
        toolName,
        generationId: generation.id,
        actorId: actor.id,
        executionMode: tool.classification.execution,
        idempotencyKey:
          optionalStringField(body, "idempotencyKey") ?? undefined,
        requestFingerprint,
      });
      if (!started.ok) {
        return c.json(
          { ok: false, error: { code: started.reason } },
          started.reason === "idempotency_conflict" ? 409 : 400,
        );
      }
      return c.json(
        { ok: true, replayed: started.replayed, job: publicJob(started.job) },
        started.replayed ? 200 : 201,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/jobs/:jobId", async (c) => {
    const job = await service.jobs.getJob(c.req.param("jobId"));
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json({ job: publicJob(job) });
  });

  app.post("/api/hosted-integrations/jobs/:jobId/cancel", async (c) => {
    try {
      const actor = actorField(await readJsonObject(c));
      const result = await service.jobs.cancelJob({
        jobId: c.req.param("jobId"),
        cancelledBy: actor.id,
      });
      if (result.ok) return c.json({ ok: true, job: publicJob(result.job) });
      return c.json(
        { ok: false, error: { code: result.reason } },
        result.reason === "not_found" ? 404 : 409,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/jobs/:jobId/result", async (c) => {
    const result = await service.jobs.getResult(c.req.param("jobId"));
    if (result.ok) return c.json(result);
    return c.json(
      { ok: false, error: { code: result.reason } },
      result.reason === "not_found" ? 404 : 409,
    );
  });

  app.post("/api/hosted-integrations/debug-runs", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      const debugOperation = debugOperationField(body);
      const debugFamilyId = optionalStringField(body, "familyId") ?? "debug";
      const debugToolName = optionalStringField(body, "toolName") ?? "debug";
      if (!isToolDeveloperActor(actor)) {
        const readiness = resolveDebugReadiness({
          actor: {
            ...actor,
            roles: actor.roles.filter((role) => role !== "tool_developer"),
          },
          familyId: debugFamilyId,
          toolName: debugToolName,
          operation: debugOperation,
          environmentReadiness: readyEnvironmentReadinessForRoute(
            debugFamilyId,
            optionalStringField(body, "environment") ?? "test_debug",
          ),
        });
        return c.json(
          { ok: false, error: { code: readiness.code }, readiness },
          statusForGatewayError(readiness.code),
        );
      }
      if (
        optionalBooleanField(body, "allowWrites") !== true &&
        debugOperation !== "read"
      ) {
        const readiness = resolveDebugReadiness({
          actor,
          familyId: debugFamilyId,
          toolName: debugToolName,
          operation: debugOperation,
          environmentReadiness: readyEnvironmentReadinessForRoute(
            debugFamilyId,
            optionalStringField(body, "environment") ?? "test_debug",
          ),
        });
        return c.json(
          { ok: false, error: { code: readiness.code }, readiness },
          statusForGatewayError(readiness.code),
        );
      }
      const draftId = optionalStringField(body, "draftId");
      if (draftId) {
        const draft = await service.drafts.getDraft(draftId);
        if (!draft) return c.json({ ok: false, error: "not_found" }, 404);
        return c.json({ ok: true, target: "draft", draft });
      }
      const familyId = stringField(body, "familyId");
      const toolName = stringField(body, "toolName");
      const environment =
        optionalStringField(body, "environment") ?? "test_debug";
      const result = await service.gateway.invoke({
        actor,
        familyId,
        toolName,
        environment,
        args: JsonObjectSchema.parse(objectField(body, "args")),
        hostedToolBindings: [
          {
            agentId: actor.id,
            familyId,
            toolName,
            allowedEnvironments: [environment as "prod" | "test_debug"],
            defaultEnvironment: environment as "prod" | "test_debug",
            generationPin: optionalStringField(body, "generationId")
              ? {
                  type: "generation",
                  generationId: stringField(body, "generationId"),
                }
              : { type: "current" },
            bindingKind: "internal",
            purpose: "debug",
            updatedAt: new Date().toISOString(),
            updatedBy: actor.id,
          },
        ],
        invocationPurpose: "tool_maintenance",
        executionPurpose: "debug",
        generationId: optionalStringField(body, "generationId") ?? undefined,
      });
      if (result.ok) return c.json(result);
      return c.json(result, statusForGatewayError(result.error.code));
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/runs", async (c) => {
    if (!canManageExecutionLogs(c)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const status = c.req.query("status");
    if (
      status !== undefined &&
      status !== "running" &&
      status !== "succeeded" &&
      status !== "failed"
    ) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limitRaw !== undefined && !Number.isFinite(limit)) {
      return c.json({ error: "invalid_limit" }, 400);
    }
    const runs = await service.gateway.executionLogs.listRunLogs({
      familyId: c.req.query("familyId"),
      toolName: c.req.query("toolName"),
      generationId: c.req.query("generationId"),
      status,
      limit,
    });
    return c.json({ runs });
  });

  app.get("/api/hosted-integrations/runs/:runId", async (c) => {
    const log = await service.gateway.executionLogs.getRunLog(
      c.req.param("runId"),
    );
    if (!log) return c.json({ error: "not_found" }, 404);
    if (!canReadRun(c, log)) return c.json({ error: "forbidden" }, 403);
    return c.json({ run: log });
  });

  app.get("/api/hosted-integrations/runs/:runId/artifacts/*", async (c) => {
    const runId = c.req.param("runId");
    const log = await service.gateway.executionLogs.getRunLog(runId);
    if (!log) return c.json({ error: "not_found" }, 404);
    if (!canReadRun(c, log)) return c.json({ error: "forbidden" }, 403);
    try {
      const name = relPathFromWildcard(
        c,
        `/api/hosted-integrations/runs/${runId}/artifacts/`,
      );
      if (!name) return c.json({ error: "path_required" }, 400);
      const content = await service.artifacts.readArtifact({
        familyId: log.familyId,
        runId,
        name,
      });
      return c.json({ runId, name, content });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/generations", async (c) => {
    try {
      const generations = await service.generations.listGenerations({
        familyId: c.req.query("familyId") ?? undefined,
      });
      return c.json({
        generations: generations.map(generationSummary),
      });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get(
    "/api/hosted-integrations/generations/:baseGenerationId/diff/:compareGenerationId",
    async (c) => {
      try {
        if (!isToolDeveloperAgentId(c.req.query("actorId"))) {
          return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
        }
        if (!options.dataDir) {
          return c.json(
            { ok: false, error: { code: "platform_unavailable" } },
            500,
          );
        }
        const base = await readGenerationDiffSnapshot({
          service,
          dataDir: options.dataDir,
          generationId: c.req.param("baseGenerationId"),
        });
        if (!base.ok) {
          return c.json(
            { ok: false, error: { code: base.reason } },
            statusForSourceViewError(base.reason),
          );
        }
        const compare = await readGenerationDiffSnapshot({
          service,
          dataDir: options.dataDir,
          generationId: c.req.param("compareGenerationId"),
        });
        if (!compare.ok) {
          return c.json(
            { ok: false, error: { code: compare.reason } },
            statusForSourceViewError(compare.reason),
          );
        }
        const result = await buildHostedIntegrationGenerationDiff({
          base: base.snapshot,
          compare: compare.snapshot,
          options: {
            mode: generationDiffMode(c.req.query("mode")),
            path: c.req.query("path"),
            toolName: c.req.query("toolName"),
            includeSharedHelpers:
              c.req.query("includeSharedHelpers") === "true",
            includeHooks: c.req.query("includeHooks") === "true",
          },
        });
        if (result.ok) return c.json(result);
        return c.json(
          result,
          result.error.code === "family_mismatch" ? 400 : 404,
        );
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.get("/api/hosted-integrations/generations/:generationId", async (c) => {
    const generation = await service.generations.getGeneration(
      c.req.param("generationId"),
    );
    if (!generation) return c.json({ error: "not_found" }, 404);
    return c.json({ generation });
  });

  app.post(
    "/api/hosted-integrations/generations/:generationId/rollback",
    async (c) => {
      try {
        const body = await readJsonObject(c);
        const actor = actorField(body);
        if (!isToolDeveloperActor(actor)) {
          return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
        }
        const generation = await service.generations.getGeneration(
          c.req.param("generationId"),
        );
        if (!generation) return c.json({ error: "not_found" }, 404);
        const result = await service.generations.rollback({
          familyId: generation.familyId,
          generationId: generation.id,
          rolledBackBy: actor.id,
        });
        if (result.ok) {
          return c.json({
            ok: true,
            activeGeneration: generationSummary(result.activeGeneration),
          });
        }
        return c.json(
          { ok: false, error: { code: result.reason } },
          result.reason === "generation_not_found" ? 404 : 409,
        );
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.get("/api/hosted-integrations/disablements", async (c) => {
    return c.json({
      disablements: await service.disablements.listDisablements(),
    });
  });

  app.put("/api/hosted-integrations/disablements", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const disablement = await service.disablements.setDisabled({
        target: HostedIntegrationDisableTargetSchema.parse(
          objectField(body, "target"),
        ),
        disabled: booleanField(body, "disabled"),
        reason: optionalStringField(body, "reason") ?? undefined,
        updatedBy: actor.id,
      });
      return c.json({ ok: true, disablement });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/families", async (c) => {
    const includeProposed = c.req.query("includeProposed") === "true";
    const families = (await service.listFamilies()).filter(
      (family) => includeProposed || family.status === "active",
    );
    return c.json({ families });
  });

  app.post("/api/hosted-integrations/families", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.proposedFamilies.createProposedFamily({
        familyId: stringField(body, "familyId"),
        name: stringField(body, "name"),
        toolName: stringField(body, "toolName"),
        lockedBy: stringField(body, "lockedBy"),
        ttlMs: optionalPositiveInteger(body, "ttlMs") ?? DEFAULT_LOCK_TTL_MS,
      });
      if (result.ok) {
        return c.json(
          {
            family: result.family,
            lock: result.lock,
            draft: result.draft,
            sourceRevisionId: result.sourceRevisionId,
          },
          201,
        );
      }
      return c.json(
        { error: result.reason },
        result.reason === "duplicate_family" ? 409 : 400,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/packages/validate", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const result = await service.packages.validatePackage({
        packageDocument: body.packageDocument ?? body.package,
        targetFamilyId: optionalStringField(body, "targetFamilyId") ?? undefined,
      });
      return c.json(
        {
          ok: result.ok,
          diagnostics: result.diagnostics,
          digest: result.package?.digest,
          files: result.package?.fileEntries.map((file) => file.path) ?? [],
        },
        200,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/packages/import", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const mode = stringField(body, "mode");
      if (mode !== "create" && mode !== "update") {
        return c.json(
          { ok: false, error: { code: "invalid_mode" } },
          400,
        );
      }
      const result = await service.packages.importPackage({
        mode,
        packageDocument: body.packageDocument ?? body.package,
        importedBy: actor.id,
        targetFamilyId: optionalStringField(body, "targetFamilyId") ?? undefined,
        lockId: optionalStringField(body, "lockId") ?? undefined,
        ttlMs: optionalPositiveInteger(body, "ttlMs") ?? undefined,
        sourceRevisionId:
          optionalStringField(body, "sourceRevisionId") ?? undefined,
      });
      return c.json(
        result,
        result.ok
          ? mode === "create"
            ? 201
            : 200
          : statusForPackageImportError(result.error.code),
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/packages/export", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const result = await service.packages.exportPackage({
        source: packageExportSourceField(body),
        exportedBy: actor.id,
        includeExamples: optionalBooleanField(body, "includeExamples"),
      });
      return c.json(
        result,
        result.ok ? 200 : statusForPackageExportError(result.error.code),
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.delete("/api/hosted-integrations/families/:family", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const result = await service.deleteFamily({
        familyId: c.req.param("family"),
        deletedBy: actor.id,
      });
      if (result.status === "delete_draining") {
        options.onHostedIntegrationDeleteDraining?.(result.familyId);
      }
      return c.json(result);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/families/:family/tools", async (c) => {
    const family = await service.getFamily(c.req.param("family"));
    if (!family) return c.json({ error: "not_found" }, 404);
    return c.json({
      tools: family.tools.filter(
        isHostedIntegrationToolVisibleForSelection,
      ),
    });
  });

  app.get("/api/hosted-integrations/families/:family/examples", async (c) => {
    if (!options.dataDir) {
      return c.json({ error: "platform_unavailable" }, 500);
    }
    const familyId = c.req.param("family");
    const toolName = c.req.query("toolName");
    const generationId = c.req.query("generationId");
    const generation = generationId
      ? await service.generations.getGeneration(generationId)
      : await service.generations.getActiveGeneration(familyId);
    if (!generation) return c.json({ error: "generation_not_found" }, 404);
    if (generation.familyId !== familyId) {
      return c.json({ error: "generation_not_found" }, 404);
    }
    try {
      const examples = await readGenerationExamplesForRoute({
        dataDir: options.dataDir,
        generation,
        toolName,
      });
      return c.json({ generationId: generation.id, examples });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/families/:family/lock", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.locks.acquireLock({
        familyId: c.req.param("family"),
        lockedBy: stringField(body, "lockedBy"),
        ttlMs: optionalPositiveInteger(body, "ttlMs") ?? DEFAULT_LOCK_TTL_MS,
      });
      if (result.ok) return c.json({ lock: result.lock }, 201);
      return c.json({ error: result.reason, lock: result.lock }, 409);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/families/:family/lock", async (c) => {
    const lock = await service.locks.getActiveLock(c.req.param("family"));
    return c.json({ lock });
  });

  app.get(
    "/api/hosted-integrations/families/:family/source/files",
    async (c) => {
      try {
        const result = await service.sourceFiles.listSourceFiles(
          c.req.param("family"),
        );
        if (!result.ok) return c.json({ error: result.reason }, 404);
        return c.json({ files: result.files });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.get(
    "/api/hosted-integrations/families/:family/source/files/*",
    async (c) => {
      const family = c.req.param("family");
      try {
        const filePath = relPathFromWildcard(
          c,
          `/api/hosted-integrations/families/${family}/source/files/`,
        );
        if (!filePath) return c.json({ error: "path_required" }, 400);
        const result = await service.sourceFiles.readSourceFile({
          familyId: family,
          path: filePath,
        });
        if (!result.ok) return c.json({ error: result.reason }, 404);
        return c.json({ path: filePath, content: result.content });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.post("/api/hosted-integrations/source-view", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      if (!options.dataDir) {
        return c.json(
          { ok: false, error: { code: "platform_unavailable" } },
          500,
        );
      }
      const familyId = stringField(body, "familyId");
      const toolName = stringField(body, "toolName");
      const sourceTarget = await readSourceViewTarget({
        service,
        dataDir: options.dataDir,
        familyId,
        draftId: optionalStringField(body, "draftId"),
        generationId: optionalStringField(body, "generationId"),
      });
      if (!sourceTarget.ok) {
        return c.json(
          { ok: false, error: { code: sourceTarget.reason } },
          statusForSourceViewError(sourceTarget.reason),
        );
      }
      const view = await buildHostedIntegrationFocusedSourceView({
        familyId,
        generationId: sourceTarget.generationId,
        manifest: sourceTarget.manifest,
        tools: sourceTarget.tools,
        entrypointPath: sourceTarget.manifest.runtime.entrypoint,
        source: sourceTarget.source,
        toolName,
        options: {
          includeSharedHelpers:
            optionalBooleanField(body, "includeSharedHelpers") ?? false,
          includeHooks: optionalBooleanField(body, "includeHooks") ?? false,
          includeAllTools:
            optionalBooleanField(body, "includeAllTools") ?? false,
          helperDepthLimit:
            optionalPositiveInteger(body, "helperDepthLimit") ?? undefined,
          maxHelperSnippets:
            optionalPositiveInteger(body, "maxHelperSnippets") ?? undefined,
          maxSourceChars:
            optionalPositiveInteger(body, "maxSourceChars") ?? undefined,
        },
      });
      return c.json({ ok: true, view });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/families/:family/drafts", async (c) => {
    try {
      const body = await readJsonObject(c);
      const familyId = c.req.param("family");
      const lockId = stringField(body, "lockId");
      const requestedSourceRevisionId = optionalStringField(
        body,
        "sourceRevisionId",
      );
      const activeGeneration =
        requestedSourceRevisionId || !options.dataDir
          ? null
          : await service.generations.getActiveGeneration(familyId);
      const activeSnapshot =
        activeGeneration && options.dataDir
          ? await readGenerationDiffSnapshot({
              service,
              dataDir: options.dataDir,
              generationId: activeGeneration.id,
            })
          : null;
      const result =
        activeGeneration && activeSnapshot?.ok
          ? await service.drafts.createDraftFromFiles({
              familyId,
              lockId,
              sourceRevisionId: activeGeneration.sourceRevisionId,
              files: activeSnapshot.snapshot.files,
            })
          : await service.drafts.createDraft({
              familyId,
              lockId,
              sourceRevisionId:
                requestedSourceRevisionId ??
                (await service.sourceFiles.getCurrentSourceRevisionId(
                  familyId,
                )) ??
                "source_current",
            });
      if (result.ok) return c.json({ draft: result.draft }, 201);
      return c.json(
        { error: result.reason },
        result.reason === "lock_required" ? 409 : 404,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/families/:family", async (c) => {
    const family = await service.getFamily(c.req.param("family"));
    if (!family) return c.json({ error: "not_found" }, 404);
    return c.json({ family });
  });

  app.post("/api/hosted-integrations/locks/:lockId/renew", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.locks.renewLock({
        lockId: c.req.param("lockId"),
        lockedBy: stringField(body, "lockedBy"),
        ttlMs: optionalPositiveInteger(body, "ttlMs") ?? DEFAULT_LOCK_TTL_MS,
      });
      if (result.ok) return c.json({ lock: result.lock });
      if (result.reason === "conflict") {
        return c.json({ error: result.reason, lock: result.lock }, 409);
      }
      return c.json({ error: result.reason }, 404);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.delete("/api/hosted-integrations/locks/:lockId", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.locks.releaseLock({
        lockId: c.req.param("lockId"),
        lockedBy: stringField(body, "lockedBy"),
      });
      if (result.ok) return c.json({ ok: true });
      if (result.reason === "conflict") {
        return c.json({ error: result.reason, lock: result.lock }, 409);
      }
      return c.json({ error: result.reason }, 404);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/drafts/:draftId", async (c) => {
    try {
      const draft = await service.drafts.getDraft(c.req.param("draftId"));
      if (!draft) return c.json({ error: "not_found" }, 404);
      return c.json({ draft });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/drafts/:draftId/files", async (c) => {
    try {
      const result = await service.drafts.listDraftFiles(
        c.req.param("draftId"),
      );
      if (!result.ok) return c.json({ error: result.reason }, 404);
      return c.json({ files: result.files });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/drafts/:draftId/files/*", async (c) => {
    const draftId = c.req.param("draftId");
    try {
      const filePath = relPathFromWildcard(
        c,
        `/api/hosted-integrations/drafts/${draftId}/files/`,
      );
      if (!filePath) return c.json({ error: "path_required" }, 400);
      const result = await service.drafts.readDraftFile({
        draftId,
        path: filePath,
      });
      if (!result.ok) return c.json({ error: result.reason }, 404);
      return c.json({ path: filePath, content: result.content });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.put("/api/hosted-integrations/drafts/:draftId/files/*", async (c) => {
    const draftId = c.req.param("draftId");
    try {
      const filePath = relPathFromWildcard(
        c,
        `/api/hosted-integrations/drafts/${draftId}/files/`,
      );
      if (!filePath) return c.json({ error: "path_required" }, 400);
      const body = await readJsonObject(c);
      const lockId = stringField(body, "lockId");
      const ownerError = await optionalLockOwnerError(c, service, {
        draftId,
        lockId,
        lockedBy: optionalStringField(body, "lockedBy") ?? undefined,
      });
      if (ownerError) return ownerError;
      const result = await service.drafts.writeDraftFile({
        draftId,
        lockId,
        path: filePath,
        content: stringField(body, "content"),
      });
      return writeResultResponse(c, result);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.put(
    "/api/hosted-integrations/drafts/:draftId/tools/:toolName/help",
    async (c) => {
      const draftId = c.req.param("draftId");
      const toolName = c.req.param("toolName");
      try {
        const body = await readJsonObject(c);
        const lockId = stringField(body, "lockId");
        const ownerError = await optionalLockOwnerError(c, service, {
          draftId,
          lockId,
          lockedBy: optionalStringField(body, "lockedBy") ?? undefined,
        });
        if (ownerError) return ownerError;

        const toolContract = await readDraftToolContract(service, draftId);
        const toolIndex = toolContract.tools.findIndex(
          (tool) => tool.openacme.toolName === toolName,
        );
        if (toolIndex < 0) return c.json({ error: "tool_not_found" }, 404);

        const help = HostedIntegrationToolHelpSchema.parse(
          objectField(body, "help"),
        );
        const nextToolContract = {
          ...toolContract,
          tools: toolContract.tools.map((tool, index) =>
            index === toolIndex
              ? {
                  ...tool,
                  mcp: {
                    ...tool.mcp,
                    description: help.summary ?? tool.mcp.description,
                  },
                  openacme: {
                    ...tool.openacme,
                    fullHelp: help.full,
                    selectWhen: help.whenToUse,
                    doNotSelectWhen: help.whenNotToUse,
                    parameterHelp: help.parameters,
                    examples: help.examples,
                    noExampleJustification: help.noExampleJustification,
                  },
                }
              : tool,
          ),
        };
        const result = await service.drafts.writeDraftFile({
          draftId,
          lockId,
          path: "tools.yaml",
          content: stringifyYaml(nextToolContract),
        });
        return writeResultResponse(c, result);
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.delete("/api/hosted-integrations/drafts/:draftId/files/*", async (c) => {
    const draftId = c.req.param("draftId");
    try {
      const filePath = relPathFromWildcard(
        c,
        `/api/hosted-integrations/drafts/${draftId}/files/`,
      );
      if (!filePath) return c.json({ error: "path_required" }, 400);
      const body = await readJsonObject(c);
      const lockId = stringField(body, "lockId");
      const ownerError = await optionalLockOwnerError(c, service, {
        draftId,
        lockId,
        lockedBy: optionalStringField(body, "lockedBy") ?? undefined,
      });
      if (ownerError) return ownerError;
      const result = await service.drafts.deleteDraftFile({
        draftId,
        lockId,
        path: filePath,
      });
      return writeResultResponse(c, result);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/drafts/:draftId/examples", async (c) => {
    try {
      const examples = await service.examples.listExamples(
        c.req.param("draftId"),
      );
      return c.json({ examples });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/drafts/:draftId/examples", async (c) => {
    try {
      const body = await readJsonObject(c);
      const lockId = stringField(body, "lockId");
      const ownerError = await optionalLockOwnerError(c, service, {
        draftId: c.req.param("draftId"),
        lockId,
        lockedBy: optionalStringField(body, "lockedBy") ?? undefined,
      });
      if (ownerError) return ownerError;
      const result = await service.examples.upsertExample({
        draftId: c.req.param("draftId"),
        lockId,
        example: HostedIntegrationExampleSchema.parse(
          objectField(body, "example"),
        ),
      });
      if (result.ok) return c.json({ ok: true });
      const status =
        result.reason === "not_found"
          ? 404
          : result.reason === "lock_required"
            ? 409
            : 400;
      return c.json(
        "message" in result
          ? { error: result.reason, message: result.message }
          : { error: result.reason },
        status,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/drafts/:draftId/validate", async (c) => {
    try {
      return c.json(
        await service.validator.validateDraft(c.req.param("draftId")),
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post(
    "/api/hosted-integrations/drafts/:draftId/run-example",
    async (c): Promise<Response> => runDraftExampleRoute(c as Context, service),
  );

  app.post("/api/hosted-integrations/drafts/:draftId/promote", async (c) => {
    try {
      const draftId = c.req.param("draftId");
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!isToolDeveloperActor(actor)) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const draft = await service.drafts.getDraft(draftId);
      if (!draft) return c.json({ ok: false, error: "not_found" }, 404);
      const lockId = stringField(body, "lockId");
      if (!(await hasCurrentDraftLock(service, draft, lockId))) {
        const readiness = resolvePublishReadiness({
          draftId,
          draftExists: true,
          hasLock: false,
          validation: null,
          runtimeConfigContract: { status: "missing" },
        });
        return c.json(
          { ok: false, error: { code: readiness.code }, readiness },
          409,
        );
      }
      const validation = await service.validator.validateDraft(draftId);
      if (!validation.ok) {
        const readiness = resolvePublishReadiness({
          draftId,
          draftExists: true,
          hasLock: true,
          validation,
          runtimeConfigContract: { status: "missing" },
        });
        return c.json(
          {
            ok: false,
            error: { code: readiness.code },
            readiness,
            validation,
          },
          400,
        );
      }
      const tools = await readDraftTools(service, draftId);
      const examples = await service.examples.listExamples(draftId);
      const missingExamples = missingExampleToolNames(tools, examples);
      if (missingExamples.length > 0) {
        return c.json(
          {
            ok: false,
            error: {
              code: "missing_required_examples",
              toolNames: missingExamples,
            },
          },
          400,
        );
      }

      const target = promotionTargetForDraft(draft, tools);
      const approvalId = optionalStringField(body, "approvalId");
      let approval: HostedIntegrationHumanApprovalRecord | null = null;
      if (approvalId)
        approval = await service.approvals.getApproval(approvalId);
      const approvalDecision = evaluateHostedIntegrationPromotionApproval({
        actor,
        target,
        approval,
      });
      if (!approvalDecision.ok) {
        return c.json(
          { ok: false, error: { code: approvalDecision.reason } },
          403,
        );
      }

      const publishReadiness = await resolvePublishReadinessForDraft({
        service,
        draftId,
        draftExists: true,
        hasLock: true,
        validation,
      });
      if (publishReadiness.status !== "ready") {
        return c.json(
          {
            ok: false,
            error: { code: publishReadiness.code },
            readiness: publishReadiness,
          },
          400,
        );
      }

      const files = await collectDraftFiles(service, draftId);
      const source = await service.sourceFiles.replaceSourceFiles({
        familyId: draft.familyId,
        files,
        updatedBy: actor.id,
      });
      const promoted = await service.generations.promoteDraft({
        draftId,
        promotedBy: actor.id,
        validation,
        draftRevisionId: draft.updatedAt,
        sourceRevisionId: source.sourceRevisionId,
        approval: approvalDecision.approval,
      });
      if (!promoted.ok) {
        return c.json(
          { ok: false, error: { code: promoted.reason } },
          promoted.reason === "draft_not_found" ? 404 : 400,
        );
      }
      return c.json({
        ok: true,
        generation: promoted.generation,
        sourceRevisionId: source.sourceRevisionId,
      });
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.post("/api/hosted-integrations/approvals", async (c) => {
    const member = options.authStore
      ? resolveMember(c, options.authStore)
      : null;
    if (!member) return c.json({ error: "Unauthorized" }, 401);

    try {
      const body = await readJsonObject(c);
      const result = await service.approvals.createApproval({
        actor: {
          id: member.id,
          kind: "human",
          email: member.email,
        },
        target: HostedIntegrationPromotionApprovalTargetSchema.parse(
          objectField(body, "target"),
        ),
      });
      if (result.ok) return c.json({ approval: result.approval }, 201);
      return c.json({ error: result.reason }, 403);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.get("/api/hosted-integrations/environment-configs", async (c) => {
    return c.json({
      environmentConfigs:
        await service.environmentConfigs.listEnvironmentConfigs(),
    });
  });

  app.get(
    "/api/hosted-integrations/environment-configs/:familyId/:environment",
    async (c) => {
      const environmentConfig =
        await service.environmentConfigs.getEnvironmentConfig(
          c.req.param("familyId"),
          c.req.param("environment"),
        );
      if (!environmentConfig) return c.json({ error: "not_found" }, 404);
      return c.json({ environmentConfig });
    },
  );

  app.get("/api/hosted-integrations/failure-buckets", async (c) => {
    if (!canManageFailureBuckets(c)) return c.json({ error: "forbidden" }, 403);
    const familyId = c.req.query("familyId");
    const buckets = await service.failureBuckets.listBuckets();
    return c.json({
      buckets: familyId
        ? buckets.filter((bucket) => bucket.familyId === familyId)
        : buckets,
    });
  });

  app.get("/api/hosted-integrations/failure-buckets/:bucketId", async (c) => {
    if (!canManageFailureBuckets(c)) return c.json({ error: "forbidden" }, 403);
    const bucket = await service.failureBuckets.getBucket(
      c.req.param("bucketId"),
    );
    if (!bucket) return c.json({ error: "not_found" }, 404);
    return c.json({ bucket });
  });

  app.post(
    "/api/hosted-integrations/failure-buckets/:bucketId/assign",
    async (c) => {
      try {
        const body = await readJsonObject(c);
        if (!isToolDeveloperActor(actorField(body))) {
          return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
        }
        const result = await service.failureBuckets.assignBucket({
          bucketId: c.req.param("bucketId"),
          assignedTo: stringField(body, "assignedTo"),
        });
        if (result.ok) return c.json({ ok: true, bucket: result.bucket });
        return c.json({ ok: false, error: { code: result.reason } }, 404);
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.post(
    "/api/hosted-integrations/failure-buckets/:bucketId/close",
    async (c) => {
      try {
        const body = await readJsonObject(c);
        if (!isToolDeveloperActor(actorField(body))) {
          return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
        }
        const bucket = await service.failureBuckets.getBucket(
          c.req.param("bucketId"),
        );
        if (!bucket)
          return c.json({ ok: false, error: { code: "not_found" } }, 404);
        const actor = actorField(body);
        if (!options.dataDir) {
          return c.json(
            { ok: false, error: { code: "platform_unavailable" } },
            500,
          );
        }
        const regression = await validateHostedIntegrationRegressionClose({
          service,
          dataDir: options.dataDir,
          actorId: actor.id,
          bucket,
          draftId: optionalStringField(body, "draftId"),
          generationId: optionalStringField(body, "generationId"),
          regressionExampleId: optionalStringField(body, "regressionExampleId"),
        });
        if (!regression.ok) {
          return c.json(
            {
              ok: false,
              error: { code: regression.code },
              ...(regression.runId ? { runId: regression.runId } : {}),
            },
            regression.code === "generation_not_found" ? 404 : 400,
          );
        }
        const result = await service.failureBuckets.closeBucket({
          bucketId: bucket.id,
        });
        if (result.ok) return c.json({ ok: true, bucket: result.bucket });
        return c.json({ ok: false, error: { code: result.reason } }, 404);
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.put(
    "/api/hosted-integrations/environment-configs/:familyId/:environment",
    async (c) => {
      try {
        const body = await readJsonObject(c);
        const result = await service.environmentConfigs.upsertEnvironmentConfig(
          {
            familyId: c.req.param("familyId"),
            environment: c.req.param("environment"),
            config: JsonObjectSchema.parse(objectField(body, "config")),
            secrets: optionalSecretMetadata(body),
            updatedBy: stringField(body, "updatedBy"),
          },
        );
        if (result.ok) {
          return c.json({
            environmentConfig: result.environmentConfig,
          });
        }
        return c.json(
          { error: result.reason },
          result.reason === "family_not_found" ? 404 : 400,
        );
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );

  app.put(
    "/api/hosted-integrations/environment-configs/:familyId/:environment/secrets",
    async (c) => {
      if (options.authStore && !resolveMember(c, options.authStore)) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      try {
        const familyId = c.req.param("familyId");
        const environment = c.req.param("environment");
        const body = await readJsonObject(c);
        const existing = await service.environmentConfigs.getEnvironmentConfig(
          familyId,
          environment,
        );
        if (!existing) return c.json({ error: "not_found" }, 404);

        await service.secrets.writeHumanOwnedSecrets({
          environmentConfigId: existing.id,
          secrets: stringRecordField(body, "secrets"),
          updatedBy: stringField(body, "updatedBy"),
        });
        const metadata = await service.secrets.getSecretMetadata({
          environmentConfigId: existing.id,
          secretNames: Object.keys(existing.secrets),
        });
        const result = await service.environmentConfigs.upsertEnvironmentConfig(
          {
            familyId: existing.familyId,
            environment: existing.environment,
            config: existing.config,
            secrets: metadata.secrets,
            updatedBy: stringField(body, "updatedBy"),
          },
        );
        if (!result.ok) return c.json({ error: result.reason }, 409);
        return c.json({
          metadata,
          environmentConfig: result.environmentConfig,
        });
      } catch (error) {
        return invalidRequest(c, error);
      }
    },
  );
}

type JsonRecord = Record<string, unknown>;

async function readJsonObject(c: Context): Promise<JsonRecord> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new Error("invalid_json");
  }
  if (!isRecord(body)) throw new Error("json_object_required");
  return body;
}

function stringField(body: JsonRecord, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalStringField(body: JsonRecord, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveInteger(
  body: JsonRecord,
  name: string,
): number | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalBooleanField(
  body: JsonRecord,
  name: string,
): boolean | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function booleanField(body: JsonRecord, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function objectField(body: JsonRecord, name: string): JsonRecord {
  const value = body[name];
  if (!isRecord(value)) throw new Error(`${name} is required`);
  return value;
}

function packageExportSourceField(body: JsonRecord):
  | { type: "active_generation"; familyId: string }
  | { type: "generation"; generationId: string }
  | { type: "draft"; draftId: string }
  | { type: "current_source"; familyId: string } {
  const source = objectField(body, "source");
  const type = stringField(source, "type");
  if (type === "active_generation") {
    return { type, familyId: stringField(source, "familyId") };
  }
  if (type === "generation") {
    return { type, generationId: stringField(source, "generationId") };
  }
  if (type === "draft") {
    return { type, draftId: stringField(source, "draftId") };
  }
  if (type === "current_source") {
    return { type, familyId: stringField(source, "familyId") };
  }
  throw new Error("source.type is invalid");
}

function actorField(body: JsonRecord): HostedIntegrationPolicyActor {
  const raw = objectField(body, "actor");
  const roles = raw.roles;
  return {
    id: stringField(raw, "id"),
    kind:
      raw.kind === "agent" || raw.kind === "human" || raw.kind === "system"
        ? raw.kind
        : "agent",
    roles: Array.isArray(roles)
      ? roles.map((role) => {
          if (typeof role !== "string") throw new Error("actor.roles invalid");
          return role;
        })
      : [],
  };
}

function isToolDeveloperActor(actor: HostedIntegrationPolicyActor): boolean {
  if (actor.kind === "human" && actor.roles.includes("tool_developer")) {
    return true;
  }
  if (actor.kind !== "agent") return false;
  return isToolDeveloperAgentId(actor.id);
}

function isToolDeveloperAgentId(actorId: string | undefined): boolean {
  return actorId === "tool-developer" || actorId === "agent:tool-developer";
}

function hostedToolBindingsField(body: JsonRecord) {
  const value = body.hostedToolBindings;
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    HostedIntegrationHostedToolBindingSchema.parse(item),
  );
}

function stringRecordField(
  body: JsonRecord,
  name: string,
): Record<string, string> {
  const value = objectField(body, name);
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => {
      if (typeof rawValue !== "string") {
        throw new Error(`${name}.${key} must be a string`);
      }
      return [key, rawValue];
    }),
  );
}

function optionalSecretMetadata(body: JsonRecord) {
  const value = body.secrets;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("secrets must be an object");
  return Object.fromEntries(
    Object.entries(value).map(([key, rawMetadata]) => {
      const configured =
        isRecord(rawMetadata) && typeof rawMetadata.configured === "boolean"
          ? rawMetadata.configured
          : false;
      return [key, { configured }];
    }),
  );
}

function writeResultResponse(
  c: Context,
  result: { ok: true } | { ok: false; reason: "not_found" | "lock_required" },
) {
  if (result.ok) return c.json({ ok: true });
  return c.json(
    { error: result.reason },
    result.reason === "lock_required" ? 409 : 404,
  );
}

function hostedIntegrationHelpAccess(
  options: HostedIntegrationRouteOptions,
  request: {
    actorId: string;
    familyId: string;
    canonicalToolName: string;
    toolName: string;
  },
):
  | { ok: true }
  | { ok: false; error: { code: "policy_denied"; message: string } } {
  const def = options.resolveAgentDef?.(request.actorId);
  if (!def) {
    return {
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted integration help caller agent was not found",
      },
    };
  }
  if (!def.tools.includes(request.canonicalToolName)) {
    return {
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted integration tool is not enabled for agent",
      },
    };
  }
  if (!def.tools.includes(HOSTED_TOOL_HELP_TOOL_NAME)) {
    return {
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted tool help is not enabled for agent",
      },
    };
  }
  const bound = (def.hostedIntegrationBindings ?? []).some(
    (binding) =>
      isRecord(binding) &&
      binding["familyId"] === request.familyId &&
      binding["toolName"] === request.toolName,
  );
  if (!bound) {
    return {
      ok: false,
      error: {
        code: "policy_denied",
        message: "agent is not bound to hosted integration tool",
      },
    };
  }
  return { ok: true };
}

function relPathFromWildcard(c: Context, prefix: string): string | null {
  const fullPath = c.req.path;
  if (!fullPath.startsWith(prefix)) return null;
  const rel = decodeURIComponent(fullPath.slice(prefix.length));
  return rel.length > 0 ? rel : null;
}

function invalidRequest(c: Context, error: unknown) {
  if (isInvalidRequestError(error)) {
    return c.json({ error: sanitizeRouteErrorMessage(error.message) }, 400);
  }
  throw error;
}

function sanitizeRouteErrorMessage(message: string): string {
  return sanitizeHostedToolControlPlaneString(message);
}

function isInvalidRequestError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "invalid_json" ||
    error.message === "json_object_required" ||
    error.message.includes(" is required") ||
    error.message.includes(" must be ") ||
    error.message.includes(" invalid") ||
    error.message.includes("path escapes") ||
    error.message.includes("safe path segment") ||
    error.name === "ZodError"
  );
}

function resolveEnvironmentConfigReadinessForRoute(
  familyId: string,
  environment: string,
  environmentConfig: Awaited<
    ReturnType<
      HostedIntegrationService["environmentConfigs"]["getEnvironmentConfig"]
    >
  >,
  requiredKeys?: {
    requiredConfigKeys?: string[];
    requiredSecretKeys?: string[];
  },
) {
  return resolveEnvironmentConfigReadiness({
    familyId,
    environment,
    environmentConfig,
    requiredConfigKeys:
      requiredKeys?.requiredConfigKeys ??
      (environmentConfig ? Object.keys(environmentConfig.config) : []),
    requiredSecretKeys:
      requiredKeys?.requiredSecretKeys ??
      (environmentConfig ? Object.keys(environmentConfig.secrets) : []),
  });
}

async function resolvePublishReadinessForDraft(input: {
  service: HostedIntegrationService;
  draftId: string;
  draftExists: boolean;
  hasLock?: boolean;
  validation?: { ok: boolean } | null;
}): Promise<HostedIntegrationReadiness> {
  if (!input.draftExists || !input.validation?.ok) {
    return resolvePublishReadiness({
      draftId: input.draftId,
      draftExists: input.draftExists,
      hasLock: input.hasLock,
      validation: input.validation,
      runtimeConfigContract: { status: "missing" },
    });
  }

  const manifest = await readDraftManifest(input.service, input.draftId);
  const runtimeConfigContract = resolveRuntimeConfigContractReadiness(manifest);
  const productionEnvironmentReadiness =
    runtimeConfigContract.contract.status === "requires"
      ? resolveEnvironmentConfigReadinessForRoute(
          manifest.id,
          "prod",
          await input.service.environmentConfigs.getEnvironmentConfig(
            manifest.id,
            "prod",
          ),
          {
            requiredConfigKeys: runtimeConfigContract.requiredConfigKeys,
            requiredSecretKeys: runtimeConfigContract.requiredSecretKeys,
          },
        )
      : null;

  return resolvePublishReadiness({
    draftId: input.draftId,
    draftExists: input.draftExists,
    hasLock: input.hasLock,
    validation: input.validation,
    runtimeConfigContract: runtimeConfigContract.contract,
    productionEnvironmentReadiness,
  });
}

function readyEnvironmentReadinessForRoute(
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

function debugOperationField(
  body: JsonRecord,
): "read" | "write" | "destructive" {
  const operation = optionalStringField(body, "operationClass") ?? "read";
  if (
    operation === "read" ||
    operation === "write" ||
    operation === "destructive"
  ) {
    return operation;
  }
  throw new Error("operationClass must be read, write, or destructive");
}

function stringFieldFromQuery(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function actorFromQuery(c: Context): HostedIntegrationPolicyActor {
  const actorId = c.req.query("actorId") ?? "agent:tool-developer";
  const roles = (c.req.query("roles") ?? "tool_developer")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return {
    id: actorId,
    kind: actorId.startsWith("human:") ? "human" : "agent",
    roles,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusForGatewayError(
  code: string,
): 400 | 403 | 404 | 409 | 429 | 500 | 504 {
  switch (code) {
    case "bad_arguments":
      return 400;
    case "policy_denied":
    case "approval_required":
    case "auth_failed":
    case "actor_denied":
    case "binding_missing":
    case "binding_invalid":
    case "tool_not_debuggable":
    case "tool_disabled":
    case "tool_not_enabled":
    case "operationally_disabled":
      return 403;
    case "environment_config_not_found":
    case "environment_missing":
    case "environment_incomplete":
    case "family_not_found":
    case "tool_not_found":
    case "no_active_generation":
    case "generation_not_found":
    case "stale_generation":
    case "generation_stale":
      return 404;
    case "idempotency_conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "timeout":
      return 504;
    default:
      return 500;
  }
}

function statusForHelpError(
  code: string,
): 400 | 403 | 404 | 409 | 429 | 500 | 504 {
  switch (code) {
    case "help_file_invalid":
      return 400;
    case "family_not_found":
    case "tool_not_found":
    case "no_active_generation":
    case "generation_not_found":
    case "help_file_not_found":
      return 404;
    default:
      return statusForGatewayError(code);
  }
}

function statusForSourceViewError(
  code: string,
): 400 | 403 | 404 | 409 | 429 | 500 | 504 {
  switch (code) {
    case "not_found":
    case "source_not_found":
      return 404;
    default:
      return statusForGatewayError(code);
  }
}

function statusForPackageImportError(
  code: string,
): 400 | 403 | 404 | 409 | 429 | 500 | 504 {
  switch (code) {
    case "family_not_found":
      return 404;
    case "duplicate_family":
    case "lock_required":
    case "lock_conflict":
      return 409;
    default:
      return 400;
  }
}

function statusForPackageExportError(
  code: string,
): 400 | 403 | 404 | 409 | 429 | 500 | 504 {
  switch (code) {
    case "family_not_found":
    case "generation_not_found":
    case "draft_not_found":
    case "source_not_found":
      return 404;
    default:
      return 400;
  }
}

function generationDiffMode(
  value: string | undefined,
): "summary" | "unified" | "manifest" | "tool_focused" {
  if (value === undefined) return "summary";
  if (
    value === "summary" ||
    value === "unified" ||
    value === "manifest" ||
    value === "tool_focused"
  ) {
    return value;
  }
  throw new Error("mode must be summary, unified, manifest, or tool_focused");
}

function publicJob(job: HostedIntegrationJob) {
  return {
    id: job.id,
    familyId: job.familyId,
    toolName: job.toolName,
    generationId: job.generationId,
    actorId: job.actorId,
    runId: job.runId,
    status: job.status,
    progress: job.progress,
    resultEnvelopeRef: job.resultEnvelopeRef,
    error: job.error,
    cancelledBy: job.cancelledBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function fingerprintJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canReadRun(
  c: Context,
  log: HostedIntegrationExecutionLogEntry,
): boolean {
  const actorId = c.req.query("actorId");
  return actorId === log.actorId || isToolDeveloperAgentId(actorId);
}

function canManageFailureBuckets(c: Context): boolean {
  return isToolDeveloperAgentId(c.req.query("actorId"));
}

function canManageExecutionLogs(c: Context): boolean {
  return isToolDeveloperAgentId(c.req.query("actorId"));
}

async function hasCurrentDraftLock(
  service: HostedIntegrationService,
  draft: HostedIntegrationDraft,
  lockId: string,
): Promise<boolean> {
  if (draft.lockId !== lockId) return false;
  const lock = await service.locks.getActiveLock(draft.familyId);
  return lock?.id === lockId;
}

async function optionalLockOwnerError(
  c: Context,
  service: HostedIntegrationService,
  request: { draftId: string; lockId: string; lockedBy?: string },
): Promise<Response | null> {
  if (!request.lockedBy) return null;
  const draft = await service.drafts.getDraft(request.draftId);
  if (!draft) return c.json({ error: "not_found" }, 404);
  const lock = await service.locks.getActiveLock(draft.familyId);
  if (!lock || lock.id !== request.lockId) {
    return c.json({ error: "lock_required" }, 409);
  }
  if (lock.lockedBy !== request.lockedBy) {
    return c.json({ error: "lock_conflict", lock }, 409);
  }
  return null;
}

async function runDraftExampleRoute(
  c: Context,
  service: HostedIntegrationService,
): Promise<Response> {
  try {
    const draftId = requiredPathParam(c, "draftId");
    const body = await readJsonObject(c);
    const actor = actorField(body);
    const draft = await service.drafts.getDraft(draftId);
    if (!draft) return c.json({ ok: false, error: "not_found" }, 404);
    const exampleId = stringField(body, "exampleId");
    const examples = await service.examples.listExamples(draftId);
    const example = examples.find((candidate) => candidate.id === exampleId);
    if (!example) return c.json({ ok: false, error: "not_found" }, 404);
    const manifest = await readDraftManifest(service, draftId);
    const tools = await readDraftTools(service, draftId);
    const tool = tools.find(
      (candidate) => candidate.name === example.toolName,
    );
    if (!tool) {
      return c.json({ ok: false, error: { code: "tool_not_found" } }, 404);
    }
    if (example.category === "discovery_required") {
      return c.json(
        {
          ok: false,
          error: {
            code: "example_not_runnable",
            message:
              "discovery_required examples document prerequisite lookup and are not ready-to-send invocation payloads",
          },
        },
        400,
      );
    }

    const draftGenerationId = `draft:${draft.id}`;
    const environmentConfig =
      await service.environmentConfigs.getEnvironmentConfig(
        draft.familyId,
        "test_debug",
      );
    const executionConfig = resolveHostedIntegrationExecutionConfig({
      familyId: draft.familyId,
      environment: "test_debug",
      generation: { runtimeConfig: manifest.runtimeConfig },
      policyDecision: { ok: true, resolvedEnvironment: "test_debug" },
      environmentConfig,
      executionPurpose: "example",
    });
    if (!executionConfig.ok) {
      return c.json(
        { ok: false, error: { code: executionConfig.error.code } },
        statusForGatewayError(executionConfig.error.code),
      );
    }
    const { run, familyHome, runDir } = await service.artifacts.createRun({
      familyId: draft.familyId,
      toolName: example.toolName,
      generationId: draftGenerationId,
      actorId: actor.id,
      input: example.args,
    });
    await service.gateway.executionLogs.startLog({
      runId: run.id,
      familyId: draft.familyId,
      toolName: example.toolName,
      generationId: draftGenerationId,
      actorId: actor.id,
      environmentConfigId: executionConfig.environmentConfigId ?? null,
      configRevision: executionConfig.configRevision ?? null,
      executionPurpose: executionConfig.executionPurpose,
      sanitizedArgs: JsonObjectSchema.parse(example.args),
      status: "running",
      startedAt: run.startedAt,
    });
    const filesRoot = path.join(runDir, "files");
    await copyDraftFilesToDirectory(service, draftId, filesRoot);
    const runtimeResult = await new HostedIntegrationPythonRuntime().callTool({
      familyId: draft.familyId,
      generationId: draftGenerationId,
      filesRoot,
      runtime: manifest.runtime,
      timeoutMs: manifest.runtime.defaultTimeoutMs,
      toolName: example.toolName,
      args: JsonObjectSchema.parse(example.args),
      context: {
        familyId: draft.familyId,
        generationId: draftGenerationId,
        runId: run.id,
        familyHome,
        runDir,
        config: executionConfig.config,
        secrets: executionConfig.secretsEnvironmentConfigId
          ? await service.secrets.readSecretsForRuntime({
              environmentConfigId: executionConfig.secretsEnvironmentConfigId,
            })
          : {},
      },
    });
    if (!runtimeResult.ok) {
      const normalizedError = routeRuntimeError(runtimeResult.error);
      const artifactError = JsonObjectSchema.parse(normalizedError);
      const errorEnvelope = await service.artifacts.completeRunError({
        familyId: draft.familyId,
        runId: run.id,
        error: artifactError,
      });
      await service.gateway.executionLogs.finishLog(run.id, {
        status: "failed",
        endedAt: new Date().toISOString(),
        error: normalizedError,
      });
      return c.json(
        { ok: false, runId: run.id, error: errorEnvelope.error },
        runtimeResult.error.code === "timeout" ? 504 : 500,
      );
    }
    const envelope = await service.artifacts.completeRunSuccess({
      familyId: draft.familyId,
      runId: run.id,
      result: runtimeResult.result,
      inlineResultTokenLimit: manifest.runtime.inlineResultTokenLimit,
    });
    await service.gateway.executionLogs.finishLog(run.id, {
      status: "succeeded",
      endedAt: new Date().toISOString(),
      resultEnvelopeRef: `${run.id}/output.json`,
    });
    return c.json({ ok: true, runId: run.id, envelope });
  } catch (error) {
    return invalidRequest(c, error);
  }
}

function requiredPathParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function routeRuntimeError(error: {
  code: HostedIntegrationGatewayError["code"];
  message: string;
  details?: HostedIntegrationGatewayError["details"];
}): HostedIntegrationGatewayError {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

async function readDraftManifest(
  service: HostedIntegrationService,
  draftId: string,
): Promise<FamilyManifest> {
  const manifestFile = await service.drafts.readDraftFile({
    draftId,
    path: "family.yaml",
  });
  if (!manifestFile.ok) throw new Error("family.yaml is required");
  return FamilyManifestSchema.parse(parseYaml(manifestFile.content));
}

async function readDraftToolContract(
  service: HostedIntegrationService,
  draftId: string,
) {
  const toolsFile = await service.drafts.readDraftFile({
    draftId,
    path: "tools.yaml",
  });
  if (!toolsFile.ok) throw new Error("tools.yaml is required");
  return HostedToolContractDocumentSchema.parse(parseYaml(toolsFile.content));
}

async function readDraftTools(
  service: HostedIntegrationService,
  draftId: string,
): Promise<HostedIntegrationToolSpec[]> {
  return hostedToolContractToToolSpecs(
    await readDraftToolContract(service, draftId),
  );
}

async function readSourceViewTarget(args: {
  service: HostedIntegrationService;
  dataDir: string;
  familyId: string;
  draftId: string | null;
  generationId: string | null;
}): Promise<
  | {
      ok: true;
      generationId: string;
      manifest: FamilyManifest;
      tools: HostedIntegrationToolSpec[];
      source: string;
    }
  | { ok: false; reason: string }
> {
  if (args.draftId) {
    const draft = await args.service.drafts.getDraft(args.draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    if (draft.familyId !== args.familyId) {
      return { ok: false, reason: "not_found" };
    }
    const manifest = await readDraftManifest(args.service, args.draftId);
    const tools = await readDraftTools(args.service, args.draftId);
    const source = await args.service.drafts.readDraftFile({
      draftId: args.draftId,
      path: manifest.runtime.entrypoint,
    });
    if (!source.ok) return { ok: false, reason: source.reason };
    return {
      ok: true,
      generationId: `draft:${draft.id}`,
      manifest,
      tools,
      source: source.content,
    };
  }

  const generation = args.generationId
    ? await args.service.generations.getGeneration(args.generationId)
    : await args.service.generations.getActiveGeneration(args.familyId);
  if (!generation) {
    return {
      ok: false,
      reason: args.generationId
        ? "generation_not_found"
        : "no_active_generation",
    };
  }
  if (generation.familyId !== args.familyId) {
    return { ok: false, reason: "generation_not_found" };
  }

  const filesRoot = generationFilesRoot(args.dataDir, generation.id);
  try {
    const manifest = FamilyManifestSchema.parse(
      parseYaml(
        await readTextFileUnderRoot(
          filesRoot,
          "family.yaml",
          "generation files root",
        ),
      ),
    );
    const tools = hostedToolContractToToolSpecs(
      HostedToolContractDocumentSchema.parse(
        parseYaml(
          await readTextFileUnderRoot(
            filesRoot,
            "tools.yaml",
            "generation files root",
          ),
        ),
      ),
    );
    return {
      ok: true,
      generationId: generation.id,
      manifest,
      tools,
      source: await readTextFileUnderRoot(
        filesRoot,
        manifest.runtime.entrypoint,
        "generation files root",
      ),
    };
  } catch {
    return { ok: false, reason: "source_not_found" };
  }
}

async function readGenerationExamplesForRoute(args: {
  dataDir: string;
  generation: HostedIntegrationGeneration;
  toolName?: string;
}): Promise<HostedIntegrationExample[]> {
  const filesRoot = generationFilesRoot(args.dataDir, args.generation.id);
  let raw: string;
  try {
    raw = await readTextFileUnderRoot(
      filesRoot,
      "examples.yaml",
      "generation files root",
    );
  } catch (error) {
    if (isNodeENOENT(error)) return [];
    throw error;
  }
  const parsed = parseYaml(raw);
  const rawExamples =
    parsed && typeof parsed === "object" && "examples" in parsed
      ? (parsed as { examples?: unknown }).examples
      : [];
  const examples = Array.isArray(rawExamples)
    ? rawExamples.map((example) =>
        HostedIntegrationExampleSchema.parse(example),
      )
    : [];
  return args.toolName
    ? examples.filter((example) => example.toolName === args.toolName)
    : examples;
}

function isNodeENOENT(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readGenerationDiffSnapshot(args: {
  service: HostedIntegrationService;
  dataDir: string;
  generationId: string;
}): Promise<
  | {
      ok: true;
      snapshot: {
        generationId: string;
        familyId: string;
        files: Record<string, string>;
      };
    }
  | { ok: false; reason: string }
> {
  const generation = await args.service.generations.getGeneration(
    args.generationId,
  );
  if (!generation) return { ok: false, reason: "generation_not_found" };
  const filesRoot = generationFilesRoot(args.dataDir, generation.id);
  try {
    const files: Record<string, string> = {};
    for (const file of await listFilesUnderRoot(filesRoot)) {
      files[file.path] = await readTextFileUnderRoot(
        filesRoot,
        file.path,
        "generation files root",
      );
    }
    return {
      ok: true,
      snapshot: {
        generationId: generation.id,
        familyId: generation.familyId,
        files,
      },
    };
  } catch {
    return { ok: false, reason: "source_not_found" };
  }
}

async function collectDraftFiles(
  service: HostedIntegrationService,
  draftId: string,
): Promise<Record<string, string>> {
  const listed = await service.drafts.listDraftFiles(draftId);
  if (!listed.ok) throw new Error("draft files not found");
  const files: Record<string, string> = {};
  for (const file of listed.files) {
    const read = await service.drafts.readDraftFile({
      draftId,
      path: file.path,
    });
    if (!read.ok) throw new Error(`draft file ${file.path} not found`);
    files[file.path] = read.content;
  }
  return files;
}

async function copyDraftFilesToDirectory(
  service: HostedIntegrationService,
  draftId: string,
  outputRoot: string,
): Promise<void> {
  const files = await collectDraftFiles(service, draftId);
  await mkdir(outputRoot, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const resolved = path.resolve(outputRoot, relPath);
    const relative = path.relative(outputRoot, resolved);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error("path escapes draft runtime root");
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf-8");
  }
}

function missingExampleToolNames(
  tools: HostedIntegrationToolSpec[],
  examples: HostedIntegrationExample[],
): string[] {
  const covered = new Set(examples.map((example) => example.toolName));
  return tools
    .map((tool) => tool.name)
    .filter((toolName) => !covered.has(toolName));
}

function promotionTargetForDraft(
  draft: HostedIntegrationDraft,
  tools: HostedIntegrationToolSpec[],
) {
  const toolNames = tools.map((tool) => tool.name);
  const destructiveToolNames = tools
    .filter((tool) => tool.classification.operation === "destructive")
    .map((tool) => tool.name);
  return HostedIntegrationPromotionApprovalTargetSchema.parse({
    familyId: draft.familyId,
    draftId: draft.id,
    draftRevisionId: draft.updatedAt,
    operation: "promote",
    operationClass: operationClassForTools(tools),
    toolNames,
    destructiveToolNames,
  });
}

function operationClassForTools(
  tools: HostedIntegrationToolSpec[],
): "read" | "write" | "destructive" {
  if (
    tools.some(
      (tool) => tool.classification.operation === "destructive",
    )
  ) {
    return "destructive";
  }
  if (tools.some((tool) => tool.classification.operation === "write")) {
    return "write";
  }
  return "read";
}

function generationSummary(generation: HostedIntegrationGeneration) {
  return {
    id: generation.id,
    familyId: generation.familyId,
    sourceRevisionId: generation.sourceRevisionId,
    status: generation.status,
    promotedAt: generation.promotedAt,
    promotedBy: generation.promotedBy,
  };
}
