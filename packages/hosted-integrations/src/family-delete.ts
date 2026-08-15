import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HostedIntegrationDisablementSchema } from "./disablements.js";
import type { HostedIntegrationDisablementStore } from "./disablements.js";
import type { HostedIntegrationRegistryRefreshEvent } from "./generations.js";
import {
  HostedIntegrationDraftSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationGenerationSchema,
  type HostedIntegrationFamilyId,
} from "./schemas.js";
import type { HostedIntegrationGenerationStore } from "./generations.js";
import type { HostedIntegrationSqlDatabase } from "./db-store.js";

export interface DeleteHostedIntegrationFamilyRequest {
  familyId: HostedIntegrationFamilyId | string;
  deletedBy: string;
}

export type DeleteHostedIntegrationFamilyResult =
  | {
      ok: true;
      familyId: HostedIntegrationFamilyId;
      status: "deleted";
      deleted: boolean;
      generationIds: string[];
    }
  | {
      ok: true;
      familyId: HostedIntegrationFamilyId;
      status: "delete_draining";
      deleted: false;
      generationIds: string[];
      inflightInvocations: number;
    };

export type HostedIntegrationFamilyDeleter = (
  request: DeleteHostedIntegrationFamilyRequest,
) => Promise<DeleteHostedIntegrationFamilyResult>;

export interface FileHostedIntegrationFamilyDeleterOptions {
  dataDir: string;
  generations: HostedIntegrationGenerationStore;
  disablements: HostedIntegrationDisablementStore;
  onRegistryRefresh?: (
    event: HostedIntegrationRegistryRefreshEvent,
  ) => void | Promise<void>;
}

const EnvironmentConfigSchema = z
  .object({
    id: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
  })
  .passthrough();

export function createFileHostedIntegrationFamilyDeleter(
  options: FileHostedIntegrationFamilyDeleterOptions,
): HostedIntegrationFamilyDeleter {
  return async (request) => {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("deletedBy", request.deletedBy);
    const root = path.join(options.dataDir, "hosted-integrations");
    const ownedPaths = [
      path.join(root, "source", "families", familyId),
      path.join(root, "source", "revisions", `${familyId}.json`),
      path.join(root, "proposed-families", `${familyId}.json`),
      path.join(root, "locks", `${familyId}.json`),
      path.join(root, "generations", "active", `${familyId}.json`),
      path.join(root, "workspaces", familyId),
    ];
    const hadOwnedPaths = await anyPathExists(ownedPaths);
    const generations = await options.generations.listGenerations({ familyId });
    const generationIds = generations.map((generation) => generation.id);
    const inflightInvocations =
      await options.generations.getInflightInvocationCount(familyId);
    if (inflightInvocations > 0) {
      await markDeleteDraining(options, familyId, request.deletedBy);
      return {
        ok: true,
        familyId,
        status: "delete_draining",
        deleted: false,
        generationIds,
        inflightInvocations,
      };
    }
    const environmentConfigIds = await matchingEnvironmentConfigIds(
      root,
      familyId,
    );
    const draftIds = await matchingDraftIds(root, familyId);

    await Promise.all([
      rm(ownedPaths[0]!, {
        recursive: true,
        force: true,
      }),
      rm(ownedPaths[1]!, { force: true }),
      rm(ownedPaths[2]!, { force: true }),
      rm(ownedPaths[3]!, { force: true }),
      rm(ownedPaths[4]!, { force: true }),
      rm(ownedPaths[5]!, { recursive: true, force: true }),
      ...draftIds.map((draftId) =>
        rm(path.join(root, "drafts", draftId), {
          recursive: true,
          force: true,
        }),
      ),
      ...environmentConfigIds.map((id) =>
        rm(path.join(root, "environment-configs", `${id}.json`), {
          force: true,
        }),
      ),
      ...environmentConfigIds.map((id) =>
        rm(path.join(root, "secrets", `${id}.json`), { force: true }),
      ),
    ]);
    await disableFileGenerations(root, generationIds, request.deletedBy);
    await removeMatchingDisablements(root, familyId, {
      generationIds,
      environmentConfigIds,
    });
    await options.onRegistryRefresh?.({
      familyId,
      reason: "delete",
      toolNames: [],
    });
    return {
      ok: true,
      familyId,
      status: "deleted",
      deleted:
        hadOwnedPaths ||
        generationIds.length > 0 ||
        draftIds.length > 0 ||
        environmentConfigIds.length > 0,
      generationIds,
    };
  };
}

export function createDbHostedIntegrationFamilyDeleter(options: {
  dataDir: string;
  db: HostedIntegrationSqlDatabase;
  generations: HostedIntegrationGenerationStore;
  disablements: HostedIntegrationDisablementStore;
  onRegistryRefresh?: (
    event: HostedIntegrationRegistryRefreshEvent,
  ) => void | Promise<void>;
}): HostedIntegrationFamilyDeleter {
  return async (request) => {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("deletedBy", request.deletedBy);
    const familyRow = options.db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM hosted_integration_families WHERE id = ?")
      .get(familyId);
    const sourceRevisionRows = options.db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM hosted_integration_source_revisions WHERE family_id = ?")
      .all(familyId);
    const sourceRevisionIds = sourceRevisionRows.map((row) => row.id);
    const draftRows = options.db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM hosted_integration_drafts WHERE family_id = ?")
      .all(familyId);
    const draftIds = draftRows.map((row) => row.id);
    const generationRows = options.db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM hosted_integration_generations WHERE family_id = ?")
      .all(familyId);
    const generationIds = generationRows.map((row) => row.id);
    const inflightInvocations =
      await options.generations.getInflightInvocationCount(familyId);
    if (inflightInvocations > 0) {
      await markDeleteDraining(options, familyId, request.deletedBy);
      return {
        ok: true,
        familyId,
        status: "delete_draining",
        deleted: false,
        generationIds,
        inflightInvocations,
      };
    }
    const environmentConfigRows = options.db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM hosted_integration_environment_configs WHERE family_id = ?")
      .all(familyId);
    const environmentConfigIds = environmentConfigRows.map((row) => row.id);

    options.db.transaction(() => {
      runDeleteIn(
        options.db,
        "hosted_integration_source_files",
        "source_revision_id",
        sourceRevisionIds,
      );
      runDeleteIn(
        options.db,
        "hosted_integration_draft_files",
        "draft_id",
        draftIds,
      );
      runDeleteIn(
        options.db,
        "hosted_integration_examples",
        "draft_id",
        draftIds,
      );
      runDeleteIn(
        options.db,
        "hosted_integration_secret_metadata",
        "environment_config_id",
        environmentConfigIds,
      );
      options.db
        .prepare(
          "DELETE FROM hosted_integration_disablements " +
            "WHERE family_id = ? " +
            placeholders("OR id IN", [
              ...generationIds.map((id) => `generation:${id}`),
              ...environmentConfigIds.map((id) => `environment_config:${id}`),
            ]),
        )
        .run(
          familyId,
          ...generationIds.map((id) => `generation:${id}`),
          ...environmentConfigIds.map((id) => `environment_config:${id}`),
        );
      options.db
        .prepare(
          "DELETE FROM hosted_integration_active_generations WHERE family_id = ?",
        )
        .run(familyId);
      options.db
        .prepare(
          "DELETE FROM hosted_integration_generation_invocations WHERE family_id = ?",
        )
        .run(familyId);
      options.db
        .prepare(
          "UPDATE hosted_integration_generations SET status = 'disabled' " +
            "WHERE family_id = ?",
        )
        .run(familyId);
      options.db
        .prepare("DELETE FROM hosted_integration_drafts WHERE family_id = ?")
        .run(familyId);
      options.db
        .prepare(
          "DELETE FROM hosted_integration_source_revisions WHERE family_id = ?",
        )
        .run(familyId);
      options.db
        .prepare(
          "DELETE FROM hosted_integration_proposed_families WHERE family_id = ?",
        )
        .run(familyId);
      options.db
        .prepare("DELETE FROM hosted_integration_locks WHERE family_id = ?")
        .run(familyId);
      options.db
        .prepare(
          "DELETE FROM hosted_integration_environment_configs WHERE family_id = ?",
        )
        .run(familyId);
      options.db
        .prepare("DELETE FROM hosted_integration_families WHERE id = ?")
        .run(familyId);
    })();

    const root = path.join(options.dataDir, "hosted-integrations");
    await Promise.all([
      rm(path.join(root, "source", "families", familyId), {
        recursive: true,
        force: true,
      }),
      rm(path.join(root, "source", "revisions", `${familyId}.json`), {
        force: true,
      }),
      rm(path.join(root, "proposed-families", `${familyId}.json`), {
        force: true,
      }),
      rm(path.join(root, "locks", `${familyId}.json`), { force: true }),
      rm(path.join(root, "generations", "active", `${familyId}.json`), {
        force: true,
      }),
      rm(path.join(root, "workspaces", familyId), {
        recursive: true,
        force: true,
      }),
    ]);

    await options.onRegistryRefresh?.({
      familyId,
      reason: "delete",
      toolNames: [],
    });
    return {
      ok: true,
      familyId,
      status: "deleted",
      deleted:
        Boolean(familyRow) ||
        sourceRevisionIds.length > 0 ||
        draftIds.length > 0 ||
        generationIds.length > 0 ||
        environmentConfigIds.length > 0,
      generationIds,
    };
  };
}

async function markDeleteDraining(
  options: {
    disablements: HostedIntegrationDisablementStore;
    onRegistryRefresh?: (
      event: HostedIntegrationRegistryRefreshEvent,
    ) => void | Promise<void>;
  },
  familyId: HostedIntegrationFamilyId,
  updatedBy: string,
): Promise<void> {
  await options.disablements.setDisabled({
    target: { level: "family", familyId },
    disabled: true,
    reason: "delete_draining",
    updatedBy,
  });
  await options.onRegistryRefresh?.({
    familyId,
    reason: "delete",
    toolNames: [],
  });
}

function runDeleteIn(
  db: HostedIntegrationSqlDatabase,
  table: string,
  column: string,
  values: string[],
): void {
  if (values.length === 0) return;
  db.prepare(
    `DELETE FROM ${table} WHERE ${column} IN (${values.map(() => "?").join(", ")})`,
  ).run(...values);
}

async function matchingDraftIds(
  root: string,
  familyId: HostedIntegrationFamilyId,
): Promise<string[]> {
  const draftsDir = path.join(root, "drafts");
  const entries = await safeReadDir(draftsDir);
  const draftIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const draft = await readJsonFile(
      path.join(draftsDir, entry.name, "metadata.json"),
      HostedIntegrationDraftSchema,
    );
    if (draft?.familyId === familyId) draftIds.push(entry.name);
  }
  return draftIds;
}

async function matchingEnvironmentConfigIds(
  root: string,
  familyId: HostedIntegrationFamilyId,
): Promise<string[]> {
  const configsDir = path.join(root, "environment-configs");
  const entries = await safeReadDir(configsDir);
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const config = await readJsonFile(
      path.join(configsDir, entry.name),
      EnvironmentConfigSchema,
    );
    if (config?.familyId === familyId) ids.push(config.id);
  }
  return ids;
}

async function removeMatchingDisablements(
  root: string,
  familyId: HostedIntegrationFamilyId,
  refs: { generationIds: string[]; environmentConfigIds: string[] },
): Promise<void> {
  const disablementsDir = path.join(root, "disablements");
  const entries = await safeReadDir(disablementsDir);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return;
      const filePath = path.join(disablementsDir, entry.name);
      const disablement = await readJsonFile(
        filePath,
        HostedIntegrationDisablementSchema,
      );
      if (!disablement) return;
      const target = disablement.target;
      const matches =
        ("familyId" in target && target.familyId === familyId) ||
        ("generationId" in target &&
          refs.generationIds.includes(target.generationId)) ||
        ("environmentConfigId" in target &&
          refs.environmentConfigIds.includes(target.environmentConfigId));
      if (matches) await rm(filePath, { force: true });
    }),
  );
}

async function disableFileGenerations(
  root: string,
  generationIds: string[],
  updatedBy: string,
): Promise<void> {
  if (generationIds.length === 0) return;
  const stateDir = path.join(root, "generations", "state");
  await mkdir(stateDir, { recursive: true });
  const updatedAt = new Date().toISOString();
  await Promise.all(
    generationIds.map((generationId) =>
      writeFile(
        path.join(stateDir, `${generationId}.json`),
        `${JSON.stringify(
          { generationId, status: "disabled", updatedAt, updatedBy },
          null,
          2,
        )}\n`,
        "utf-8",
      ),
    ),
  );
}

async function safeReadDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(filePath, "utf-8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
}

function placeholders(prefix: string, values: string[]): string {
  return values.length === 0
    ? ""
    : ` ${prefix} (${values.map(() => "?").join(", ")})`;
}

async function anyPathExists(paths: string[]): Promise<boolean> {
  for (const filePath of paths) {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return false;
}
