import type { Context, Hono } from "hono";
import {
  HostedIntegrationExampleSchema,
  JsonObjectSchema,
  type HostedIntegrationService,
} from "@openacme/hosted-integrations";
import type { AuthStore } from "@openacme/db";
import { resolveMember } from "../middleware/auth.js";

const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

export interface HostedIntegrationRouteOptions {
  authStore?: AuthStore;
}

export function registerHostedIntegrationRoutes(
  app: Hono,
  service: HostedIntegrationService,
  options: HostedIntegrationRouteOptions = {},
): void {
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
    return c.json({ tools: family.manifest.tools });
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
      const result = await service.drafts.createDraft({
        familyId: c.req.param("family"),
        lockId: stringField(body, "lockId"),
        sourceRevisionId:
          optionalStringField(body, "sourceRevisionId") ?? "source_current",
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

function objectField(body: JsonRecord, name: string): JsonRecord {
  const value = body[name];
  if (!isRecord(value)) throw new Error(`${name} is required`);
  return value;
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
  result:
    | { ok: true }
    | { ok: false; reason: "not_found" | "lock_required" },
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
    error.message.includes("path escapes") ||
    error.message.includes("safe path segment") ||
    error.name === "ZodError"
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
