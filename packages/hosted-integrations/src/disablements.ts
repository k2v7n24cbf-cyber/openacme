import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationToolName,
} from "./schemas.js";
import { isNodeError, safePathSegment } from "./file-access.js";

export const HostedIntegrationDisableTargetSchema = z.discriminatedUnion(
  "level",
  [
    z
      .object({
        level: z.literal("family"),
        familyId: HostedIntegrationFamilyIdSchema,
      })
      .strict(),
    z
      .object({
        level: z.literal("tool"),
        familyId: HostedIntegrationFamilyIdSchema,
        toolName: HostedIntegrationToolNameSchema,
      })
      .strict(),
    z
      .object({
        level: z.literal("generation"),
        generationId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        level: z.literal("config_scope"),
        scopeId: z.string().min(1),
      })
      .strict(),
  ],
);
export type HostedIntegrationDisableTarget = z.infer<
  typeof HostedIntegrationDisableTargetSchema
>;

export const HostedIntegrationDisablementSchema = z
  .object({
    key: z.string().min(1),
    target: HostedIntegrationDisableTargetSchema,
    disabled: z.boolean(),
    reason: z.string().min(1).optional(),
    updatedAt: z.string().datetime({ offset: true }),
    updatedBy: z.string().min(1),
  })
  .strict();
export type HostedIntegrationDisablement = z.infer<
  typeof HostedIntegrationDisablementSchema
>;

export interface FileHostedIntegrationDisablementStoreOptions {
  dataDir: string;
  now?: () => Date;
}

export interface SetHostedIntegrationDisablementRequest {
  target: HostedIntegrationDisableTarget;
  disabled: boolean;
  reason?: string;
  updatedBy: string;
}

export interface FindHostedIntegrationDisablementRequest {
  familyId: HostedIntegrationFamilyId | string;
  toolName?: HostedIntegrationToolName | string;
  generationId?: string;
  configScopeId?: string;
}

export interface HostedIntegrationDisablementStore {
  listDisablements(): Promise<HostedIntegrationDisablement[]>;
  setDisabled(
    request: SetHostedIntegrationDisablementRequest,
  ): Promise<HostedIntegrationDisablement>;
  findDisabled(
    request: FindHostedIntegrationDisablementRequest,
  ): Promise<HostedIntegrationDisablement | null>;
}

export function createFileHostedIntegrationDisablementStore(
  options: FileHostedIntegrationDisablementStoreOptions,
): HostedIntegrationDisablementStore {
  return new FileHostedIntegrationDisablementStore({
    dataDir: options.dataDir,
    now: options.now ?? (() => new Date()),
  });
}

class FileHostedIntegrationDisablementStore implements HostedIntegrationDisablementStore {
  private readonly disablementsDir: string;
  private readonly now: () => Date;

  constructor(parts: { dataDir: string; now: () => Date }) {
    this.disablementsDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "disablements",
    );
    this.now = parts.now;
  }

  async listDisablements(): Promise<HostedIntegrationDisablement[]> {
    let entries;
    try {
      entries = await readdir(this.disablementsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const records: HostedIntegrationDisablement[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      records.push(
        HostedIntegrationDisablementSchema.parse(
          JSON.parse(
            await readFile(
              path.join(this.disablementsDir, entry.name),
              "utf-8",
            ),
          ),
        ),
      );
    }
    records.sort((a, b) => a.key.localeCompare(b.key));
    return records;
  }

  async setDisabled(
    request: SetHostedIntegrationDisablementRequest,
  ): Promise<HostedIntegrationDisablement> {
    const target = HostedIntegrationDisableTargetSchema.parse(request.target);
    if (!request.updatedBy) throw new Error("updatedBy is required");
    const record = HostedIntegrationDisablementSchema.parse({
      key: disablementKey(target),
      target,
      disabled: request.disabled,
      reason:
        request.reason && request.reason.trim().length > 0
          ? request.reason.trim()
          : undefined,
      updatedAt: this.now().toISOString(),
      updatedBy: request.updatedBy,
    });
    await this.writeDisablement(record);
    return record;
  }

  async findDisabled(
    request: FindHostedIntegrationDisablementRequest,
  ): Promise<HostedIntegrationDisablement | null> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const keys = [disablementKey({ level: "family", familyId })];
    if (request.toolName) {
      keys.push(
        disablementKey({
          level: "tool",
          familyId,
          toolName: HostedIntegrationToolNameSchema.parse(request.toolName),
        }),
      );
    }
    if (request.generationId) {
      keys.push(
        disablementKey({
          level: "generation",
          generationId: request.generationId,
        }),
      );
    }
    if (request.configScopeId) {
      keys.push(
        disablementKey({
          level: "config_scope",
          scopeId: request.configScopeId,
        }),
      );
    }

    for (const key of keys) {
      const record = await this.readDisablement(key);
      if (record?.disabled) return record;
    }
    return null;
  }

  private async readDisablement(
    key: string,
  ): Promise<HostedIntegrationDisablement | null> {
    try {
      return HostedIntegrationDisablementSchema.parse(
        JSON.parse(await readFile(this.disablementPath(key), "utf-8")),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeDisablement(
    record: HostedIntegrationDisablement,
  ): Promise<void> {
    await mkdir(this.disablementsDir, { recursive: true });
    const filePath = this.disablementPath(record.key);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private disablementPath(key: string): string {
    return path.join(
      this.disablementsDir,
      `${safePathSegment("disablementKey", key)}.json`,
    );
  }
}

export function disablementKey(target: HostedIntegrationDisableTarget): string {
  switch (target.level) {
    case "family":
      return `family:${target.familyId}`;
    case "tool":
      return `tool:${target.familyId}:${target.toolName}`;
    case "generation":
      return `generation:${target.generationId}`;
    case "config_scope":
      return `config_scope:${target.scopeId}`;
  }
}
