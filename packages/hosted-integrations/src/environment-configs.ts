import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type HostedIntegrationCatalog,
  createFileHostedIntegrationCatalog,
} from "./catalog.js";
import { isNodeError, safePathSegment } from "./file-access.js";
import {
  HOSTED_INTEGRATION_ENVIRONMENTS,
  HostedIntegrationEnvironmentConfigSchema,
  HostedIntegrationEnvironmentSchema,
  HostedIntegrationFamilyIdSchema,
  type HostedIntegrationEnvironment,
  type HostedIntegrationEnvironmentConfig,
  type HostedIntegrationFamilyId,
  type JsonObject,
} from "./schemas.js";

export interface FileHostedIntegrationEnvironmentConfigStoreOptions {
  dataDir: string;
  catalog?: HostedIntegrationCatalog;
  now?: () => Date;
}

export interface UpsertHostedIntegrationEnvironmentConfigRequest {
  familyId: HostedIntegrationFamilyId | string;
  environment: HostedIntegrationEnvironment | string;
  config: JsonObject;
  secrets?: HostedIntegrationEnvironmentConfig["secrets"];
  updatedBy: string;
}

export type UpsertHostedIntegrationEnvironmentConfigResult =
  | { ok: true; environmentConfig: HostedIntegrationEnvironmentConfig }
  | {
      ok: false;
      reason: "invalid_environment";
      allowedEnvironments: readonly HostedIntegrationEnvironment[];
    }
  | { ok: false; reason: "family_not_found" };

export interface HostedIntegrationEnvironmentConfigStore {
  listEnvironmentConfigs(): Promise<HostedIntegrationEnvironmentConfig[]>;
  getEnvironmentConfig(
    familyId: HostedIntegrationFamilyId | string,
    environment: HostedIntegrationEnvironment | string,
  ): Promise<HostedIntegrationEnvironmentConfig | null>;
  upsertEnvironmentConfig(
    request: UpsertHostedIntegrationEnvironmentConfigRequest,
  ): Promise<UpsertHostedIntegrationEnvironmentConfigResult>;
}

export function hostedIntegrationEnvironmentConfigId(
  familyId: HostedIntegrationFamilyId | string,
  environment: HostedIntegrationEnvironment,
): string {
  return `${familyId}-${environment}`;
}

export function createFileHostedIntegrationEnvironmentConfigStore(
  options: FileHostedIntegrationEnvironmentConfigStoreOptions,
): HostedIntegrationEnvironmentConfigStore {
  return new FileHostedIntegrationEnvironmentConfigStore({
    dataDir: options.dataDir,
    catalog: options.catalog ?? createFileHostedIntegrationCatalog(options),
    now: options.now ?? (() => new Date()),
  });
}

class FileHostedIntegrationEnvironmentConfigStore
  implements HostedIntegrationEnvironmentConfigStore
{
  private readonly environmentConfigsDir: string;
  private readonly catalog: HostedIntegrationCatalog;
  private readonly now: () => Date;

  constructor(parts: {
    dataDir: string;
    catalog: HostedIntegrationCatalog;
    now: () => Date;
  }) {
    this.environmentConfigsDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "environment-configs",
    );
    this.catalog = parts.catalog;
    this.now = parts.now;
  }

  async listEnvironmentConfigs(): Promise<HostedIntegrationEnvironmentConfig[]> {
    let entries;
    try {
      entries = await readdir(this.environmentConfigsDir, {
        withFileTypes: true,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const environmentConfigs: HostedIntegrationEnvironmentConfig[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const environmentConfig = await this.readEnvironmentConfigFile(
        path.join(this.environmentConfigsDir, entry.name),
      );
      environmentConfigs.push(environmentConfig);
    }
    environmentConfigs.sort((a, b) => a.id.localeCompare(b.id));
    return environmentConfigs;
  }

  async getEnvironmentConfig(
    familyId: HostedIntegrationFamilyId | string,
    environment: HostedIntegrationEnvironment | string,
  ): Promise<HostedIntegrationEnvironmentConfig | null> {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.parse(familyId);
    const parsedEnvironment = HostedIntegrationEnvironmentSchema.safeParse(
      environment,
    );
    if (!parsedEnvironment.success) return null;
    try {
      return await this.readEnvironmentConfigFile(
        this.environmentConfigPath(parsedFamilyId, parsedEnvironment.data),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async upsertEnvironmentConfig(
    request: UpsertHostedIntegrationEnvironmentConfigRequest,
  ): Promise<UpsertHostedIntegrationEnvironmentConfigResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const environment = HostedIntegrationEnvironmentSchema.safeParse(
      request.environment,
    );
    if (!environment.success) {
      return {
        ok: false,
        reason: "invalid_environment",
        allowedEnvironments: HOSTED_INTEGRATION_ENVIRONMENTS,
      };
    }
    assertNonEmpty("updatedBy", request.updatedBy);

    if (!(await this.catalog.getFamily(familyId))) {
      return { ok: false, reason: "family_not_found" };
    }

    const existing = await this.getEnvironmentConfig(
      familyId,
      environment.data,
    );
    const environmentConfig = HostedIntegrationEnvironmentConfigSchema.parse({
      id: hostedIntegrationEnvironmentConfigId(familyId, environment.data),
      familyId,
      revision: existing ? existing.revision + 1 : 1,
      environment: environment.data,
      config: request.config,
      secrets: sanitizeSecretMetadata(request.secrets ?? existing?.secrets),
      updatedAt: this.now().toISOString(),
      updatedBy: request.updatedBy,
    });
    await this.writeEnvironmentConfig(environmentConfig);
    return { ok: true, environmentConfig };
  }

  private async readEnvironmentConfigFile(
    filePath: string,
  ): Promise<HostedIntegrationEnvironmentConfig> {
    const raw = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    return HostedIntegrationEnvironmentConfigSchema.parse(
      normalizeRawEnvironmentConfig(raw),
    );
  }

  private async writeEnvironmentConfig(
    environmentConfig: HostedIntegrationEnvironmentConfig,
  ): Promise<void> {
    await mkdir(this.environmentConfigsDir, { recursive: true });
    const filePath = this.environmentConfigPath(
      environmentConfig.familyId,
      environmentConfig.environment,
    );
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(
      tmpPath,
      `${JSON.stringify(environmentConfig, null, 2)}\n`,
      "utf-8",
    );
    await rename(tmpPath, filePath);
  }

  private environmentConfigPath(
    familyId: HostedIntegrationFamilyId,
    environment: HostedIntegrationEnvironment,
  ): string {
    return path.join(
      this.environmentConfigsDir,
      `${safePathSegment(
        "environmentConfigId",
        hostedIntegrationEnvironmentConfigId(familyId, environment),
      )}.json`,
    );
  }
}

function normalizeRawEnvironmentConfig(raw: unknown): unknown {
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
