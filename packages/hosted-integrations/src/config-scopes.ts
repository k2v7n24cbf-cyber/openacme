import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type HostedIntegrationCatalog,
  createFileHostedIntegrationCatalog,
} from "./catalog.js";
import {
  HostedIntegrationConfigScopeSchema,
  HostedIntegrationFamilyIdSchema,
  type HostedIntegrationConfigScope,
  type HostedIntegrationFamilyId,
  type JsonObject,
} from "./schemas.js";
import { isNodeError, safePathSegment } from "./file-access.js";

export interface FileHostedIntegrationConfigScopeStoreOptions {
  dataDir: string;
  catalog?: HostedIntegrationCatalog;
  now?: () => Date;
}

export interface UpsertHostedIntegrationConfigScopeRequest {
  scopeId: string;
  familyId: HostedIntegrationFamilyId | string;
  environment: string;
  config: JsonObject;
  secrets?: HostedIntegrationConfigScope["secrets"];
  updatedBy: string;
}

export type UpsertHostedIntegrationConfigScopeResult =
  | { ok: true; scope: HostedIntegrationConfigScope }
  | { ok: false; reason: "family_not_found" | "family_mismatch" };

export interface HostedIntegrationConfigScopeStore {
  listConfigScopes(): Promise<HostedIntegrationConfigScope[]>;
  getConfigScope(scopeId: string): Promise<HostedIntegrationConfigScope | null>;
  upsertConfigScope(
    request: UpsertHostedIntegrationConfigScopeRequest,
  ): Promise<UpsertHostedIntegrationConfigScopeResult>;
}

export function createFileHostedIntegrationConfigScopeStore(
  options: FileHostedIntegrationConfigScopeStoreOptions,
): HostedIntegrationConfigScopeStore {
  return new FileHostedIntegrationConfigScopeStore({
    dataDir: options.dataDir,
    catalog: options.catalog ?? createFileHostedIntegrationCatalog(options),
    now: options.now ?? (() => new Date()),
  });
}

class FileHostedIntegrationConfigScopeStore
  implements HostedIntegrationConfigScopeStore
{
  private readonly scopesDir: string;
  private readonly catalog: HostedIntegrationCatalog;
  private readonly now: () => Date;

  constructor(parts: {
    dataDir: string;
    catalog: HostedIntegrationCatalog;
    now: () => Date;
  }) {
    this.scopesDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "config-scopes",
    );
    this.catalog = parts.catalog;
    this.now = parts.now;
  }

  async listConfigScopes(): Promise<HostedIntegrationConfigScope[]> {
    let entries;
    try {
      entries = await readdir(this.scopesDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const scopes: HostedIntegrationConfigScope[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const scope = await this.readScopeFile(
        path.join(this.scopesDir, entry.name),
      );
      scopes.push(scope);
    }
    scopes.sort((a, b) => a.id.localeCompare(b.id));
    return scopes;
  }

  async getConfigScope(
    scopeId: string,
  ): Promise<HostedIntegrationConfigScope | null> {
    try {
      return await this.readScopeFile(this.scopePath(scopeId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async upsertConfigScope(
    request: UpsertHostedIntegrationConfigScopeRequest,
  ): Promise<UpsertHostedIntegrationConfigScopeResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("scopeId", request.scopeId);
    assertNonEmpty("environment", request.environment);
    assertNonEmpty("updatedBy", request.updatedBy);

    if (!(await this.catalog.getFamily(familyId))) {
      return { ok: false, reason: "family_not_found" };
    }

    const existing = await this.getConfigScope(request.scopeId);
    if (existing && existing.familyId !== familyId) {
      return { ok: false, reason: "family_mismatch" };
    }

    const scope = HostedIntegrationConfigScopeSchema.parse({
      id: request.scopeId,
      familyId,
      revision: existing ? existing.revision + 1 : 1,
      environment: request.environment,
      config: request.config,
      secrets: request.secrets ?? existing?.secrets ?? {},
      updatedAt: this.now().toISOString(),
      updatedBy: request.updatedBy,
    });
    await this.writeScope(scope);
    return { ok: true, scope };
  }

  private async readScopeFile(
    filePath: string,
  ): Promise<HostedIntegrationConfigScope> {
    const raw = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    return HostedIntegrationConfigScopeSchema.parse(normalizeRawScope(raw));
  }

  private async writeScope(
    scope: HostedIntegrationConfigScope,
  ): Promise<void> {
    await mkdir(this.scopesDir, { recursive: true });
    const filePath = this.scopePath(scope.id);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(scope, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private scopePath(scopeId: string): string {
    return path.join(
      this.scopesDir,
      `${safePathSegment("scopeId", scopeId)}.json`,
    );
  }
}

function normalizeRawScope(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  return {
    ...raw,
    familyId: raw.familyId ?? raw.family,
    updatedAt: raw.updatedAt ?? raw.updated_at,
    updatedBy: raw.updatedBy ?? raw.updated_by,
    secrets: sanitizeSecretMetadata(raw.secrets),
  };
}

function sanitizeSecretMetadata(rawSecrets: unknown) {
  if (!isRecord(rawSecrets)) return {};
  return Object.fromEntries(
    Object.entries(rawSecrets).map(([key, value]) => [
      key,
      {
        configured:
          isRecord(value) && typeof value.configured === "boolean"
            ? value.configured
            : false,
      },
    ]),
  );
}

function assertNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
