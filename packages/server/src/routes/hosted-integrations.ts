import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { parse as parseYaml } from "yaml";
import {
  HostedIntegrationExampleSchema,
  HostedIntegrationDisableTargetSchema,
  FamilyManifestSchema,
  HostedIntegrationPythonRuntime,
  HostedIntegrationPolicyBindingSchema,
  HostedIntegrationPromotionApprovalTargetSchema,
  JsonObjectSchema,
  evaluateHostedIntegrationPromotionApproval,
  isHostedIntegrationToolVisibleForSelection,
  type FamilyManifest,
  type HostedIntegrationDraft,
  type HostedIntegrationExample,
  type HostedIntegrationExecutionLogEntry,
  type HostedIntegrationGatewayError,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationService,
} from "@openacme/hosted-integrations";
import type { AuthStore } from "@openacme/db";
import { resolveMember } from "../middleware/auth.js";
import { validateHostedIntegrationRegressionClose } from "../hosted-integration-regression.js";

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

export interface HostedIntegrationRouteOptions {
  authStore?: AuthStore;
  dataDir?: string;
}

export function registerHostedIntegrationRoutes(
  app: Hono,
  service: HostedIntegrationService,
  options: HostedIntegrationRouteOptions = {},
): void {
  app.post("/api/hosted-integrations/invoke", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.gateway.invoke({
        actor: actorField(body),
        familyId: stringField(body, "familyId"),
        toolName: stringField(body, "toolName"),
        environment: stringField(body, "environment"),
        args: JsonObjectSchema.parse(objectField(body, "args")),
        bindings: policyBindingsField(body),
        requestedConfigScopeId:
          optionalStringField(body, "requestedConfigScopeId") ?? undefined,
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

  app.post("/api/hosted-integrations/debug-runs", async (c) => {
    try {
      const body = await readJsonObject(c);
      const actor = actorField(body);
      if (!actor.roles.includes("tool_developer")) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      if (
        optionalBooleanField(body, "allowWrites") !== true &&
        optionalStringField(body, "operationClass") !== "read"
      ) {
        return c.json({ ok: false, error: { code: "approval_required" } }, 403);
      }
      const draftId = optionalStringField(body, "draftId");
      if (draftId) {
        const draft = await service.drafts.getDraft(draftId);
        if (!draft) return c.json({ ok: false, error: "not_found" }, 404);
        return c.json({ ok: true, target: "draft", draft });
      }
      const familyId = stringField(body, "familyId");
      const toolName = stringField(body, "toolName");
      const result = await service.gateway.invoke({
        actor,
        familyId,
        toolName,
        environment: stringField(body, "environment"),
        args: JsonObjectSchema.parse(objectField(body, "args")),
        bindings: [
          {
            agentId: actor.id,
            familyId,
            toolName,
            allowedConfigScopeIds: [stringField(body, "configScopeId")],
            defaultConfigScopeId: stringField(body, "configScopeId"),
            environment: stringField(body, "environment"),
          },
        ],
        generationId: optionalStringField(body, "generationId") ?? undefined,
      });
      if (result.ok) return c.json(result);
      return c.json(result, statusForGatewayError(result.error.code));
    } catch (error) {
      return invalidRequest(c, error);
    }
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
        if (!actor.roles.includes("tool_developer")) {
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
      if (!actor.roles.includes("tool_developer")) {
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
    const families = await service.listFamilies();
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

  app.get("/api/hosted-integrations/families/:family/tools", async (c) => {
    const family = await service.getFamily(c.req.param("family"));
    if (!family) return c.json({ error: "not_found" }, 404);
    return c.json({
      tools: family.manifest.tools.filter(
        isHostedIntegrationToolVisibleForSelection,
      ),
    });
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

  app.post("/api/hosted-integrations/families/:family/drafts", async (c) => {
    try {
      const body = await readJsonObject(c);
      const familyId = c.req.param("family");
      const result = await service.drafts.createDraft({
        familyId,
        lockId: stringField(body, "lockId"),
        sourceRevisionId:
          optionalStringField(body, "sourceRevisionId") ??
          (await service.sourceFiles.getCurrentSourceRevisionId(familyId)) ??
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
      const result = await service.drafts.writeDraftFile({
        draftId,
        lockId: stringField(body, "lockId"),
        path: filePath,
        content: stringField(body, "content"),
      });
      return writeResultResponse(c, result);
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.delete("/api/hosted-integrations/drafts/:draftId/files/*", async (c) => {
    const draftId = c.req.param("draftId");
    try {
      const filePath = relPathFromWildcard(
        c,
        `/api/hosted-integrations/drafts/${draftId}/files/`,
      );
      if (!filePath) return c.json({ error: "path_required" }, 400);
      const body = await readJsonObject(c);
      const result = await service.drafts.deleteDraftFile({
        draftId,
        lockId: stringField(body, "lockId"),
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
      const result = await service.examples.upsertExample({
        draftId: c.req.param("draftId"),
        lockId: stringField(body, "lockId"),
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
      if (!actor.roles.includes("tool_developer")) {
        return c.json({ ok: false, error: { code: "policy_denied" } }, 403);
      }
      const draft = await service.drafts.getDraft(draftId);
      if (!draft) return c.json({ ok: false, error: "not_found" }, 404);
      const lockId = stringField(body, "lockId");
      if (!(await hasCurrentDraftLock(service, draft, lockId))) {
        return c.json({ ok: false, error: { code: "lock_required" } }, 409);
      }
      const validation = await service.validator.validateDraft(draftId);
      if (!validation.ok) {
        return c.json(
          { ok: false, error: { code: "validation_failed" }, validation },
          400,
        );
      }
      const manifest = await readDraftManifest(service, draftId);
      const examples = await service.examples.listExamples(draftId);
      const missingExamples = missingExampleToolNames(manifest, examples);
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

      const target = promotionTargetForDraft(draft, manifest);
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

  app.get("/api/hosted-integrations/config-scopes", async (c) => {
    return c.json({
      configScopes: await service.configScopes.listConfigScopes(),
    });
  });

  app.get("/api/hosted-integrations/config-scopes/:scopeId", async (c) => {
    const configScope = await service.configScopes.getConfigScope(
      c.req.param("scopeId"),
    );
    if (!configScope) return c.json({ error: "not_found" }, 404);
    return c.json({ configScope });
  });

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
        if (!actorField(body).roles.includes("tool_developer")) {
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
        if (!actorField(body).roles.includes("tool_developer")) {
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

  app.put("/api/hosted-integrations/config-scopes/:scopeId", async (c) => {
    try {
      const body = await readJsonObject(c);
      const result = await service.configScopes.upsertConfigScope({
        scopeId: c.req.param("scopeId"),
        familyId: stringField(body, "familyId"),
        environment: stringField(body, "environment"),
        config: JsonObjectSchema.parse(objectField(body, "config")),
        secrets: optionalSecretMetadata(body),
        updatedBy: stringField(body, "updatedBy"),
      });
      if (result.ok) return c.json({ configScope: result.scope });
      return c.json(
        { error: result.reason },
        result.reason === "family_not_found" ? 404 : 409,
      );
    } catch (error) {
      return invalidRequest(c, error);
    }
  });

  app.put(
    "/api/hosted-integrations/config-scopes/:scopeId/secrets",
    async (c) => {
      if (options.authStore && !resolveMember(c, options.authStore)) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      try {
        const scopeId = c.req.param("scopeId");
        const body = await readJsonObject(c);
        const existing = await service.configScopes.getConfigScope(scopeId);
        if (!existing) return c.json({ error: "not_found" }, 404);

        await service.secrets.writeHumanOwnedSecrets({
          scopeId,
          secrets: stringRecordField(body, "secrets"),
          updatedBy: stringField(body, "updatedBy"),
        });
        const metadata = await service.secrets.getSecretMetadata({
          scopeId,
          secretNames: Object.keys(existing.secrets),
        });
        const result = await service.configScopes.upsertConfigScope({
          scopeId,
          familyId: existing.familyId,
          environment: existing.environment,
          config: existing.config,
          secrets: metadata.secrets,
          updatedBy: stringField(body, "updatedBy"),
        });
        if (!result.ok) return c.json({ error: result.reason }, 409);
        return c.json({ metadata, configScope: result.scope });
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

function policyBindingsField(body: JsonRecord) {
  const value = body.bindings;
  if (!Array.isArray(value)) return [];
  return value.map((item) => HostedIntegrationPolicyBindingSchema.parse(item));
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

function relPathFromWildcard(c: Context, prefix: string): string | null {
  const fullPath = c.req.path;
  if (!fullPath.startsWith(prefix)) return null;
  const rel = decodeURIComponent(fullPath.slice(prefix.length));
  return rel.length > 0 ? rel : null;
}

function invalidRequest(c: Context, error: unknown) {
  if (isInvalidRequestError(error)) {
    return c.json({ error: error.message }, 400);
  }
  throw error;
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusForGatewayError(
  code: string,
): 400 | 403 | 404 | 409 | 500 | 504 {
  switch (code) {
    case "policy_denied":
    case "approval_required":
    case "tool_disabled":
    case "operationally_disabled":
      return 403;
    case "config_scope_not_found":
    case "family_not_found":
    case "tool_not_found":
    case "no_active_generation":
    case "generation_not_found":
    case "stale_generation":
      return 404;
    case "idempotency_conflict":
      return 409;
    case "timeout":
      return 504;
    default:
      return 500;
  }
}

function canReadRun(
  c: Context,
  log: HostedIntegrationExecutionLogEntry,
): boolean {
  const actorId = c.req.query("actorId");
  const roles = (c.req.query("roles") ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return actorId === log.actorId || roles.includes("tool_developer");
}

function canManageFailureBuckets(c: Context): boolean {
  const roles = (c.req.query("roles") ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return roles.includes("tool_developer") || roles.includes("management_tool");
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
    const tool = manifest.tools.find(
      (candidate) => candidate.name === example.toolName,
    );
    if (!tool) {
      return c.json({ ok: false, error: { code: "tool_not_found" } }, 404);
    }

    const draftGenerationId = `draft:${draft.id}`;
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
      configScopeId: "debug",
      configRevision: 1,
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
        config: {},
        secrets: {},
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
  manifest: FamilyManifest,
  examples: HostedIntegrationExample[],
): string[] {
  const covered = new Set(examples.map((example) => example.toolName));
  return manifest.tools
    .map((tool) => tool.name)
    .filter((toolName) => !covered.has(toolName));
}

function promotionTargetForDraft(
  draft: HostedIntegrationDraft,
  manifest: FamilyManifest,
) {
  const toolNames = manifest.tools.map((tool) => tool.name);
  const destructiveToolNames = manifest.tools
    .filter((tool) => tool.classification.operation === "destructive")
    .map((tool) => tool.name);
  return HostedIntegrationPromotionApprovalTargetSchema.parse({
    familyId: draft.familyId,
    draftId: draft.id,
    draftRevisionId: draft.updatedAt,
    operation: "promote",
    operationClass: operationClassForManifest(manifest),
    toolNames,
    destructiveToolNames,
  });
}

function operationClassForManifest(
  manifest: FamilyManifest,
): "read" | "write" | "destructive" {
  if (
    manifest.tools.some(
      (tool) => tool.classification.operation === "destructive",
    )
  ) {
    return "destructive";
  }
  if (
    manifest.tools.some((tool) => tool.classification.operation === "write")
  ) {
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
