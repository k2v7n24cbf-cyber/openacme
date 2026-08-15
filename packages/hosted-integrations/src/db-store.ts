import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  buildHostedIntegrationGenerationProvenance,
  type CreateHostedIntegrationApprovalRequest,
  type CreateHostedIntegrationApprovalResult,
  type HostedIntegrationApprovalStore,
} from "./approvals.js";
import {
  type CompleteHostedIntegrationRunErrorRequest,
  type CompleteHostedIntegrationRunSuccessRequest,
  type CreateHostedIntegrationRunRequest,
  type CreateHostedIntegrationRunResult,
  type HostedIntegrationArtifactRef,
  type HostedIntegrationArtifactStore,
  type HostedIntegrationSuccessEnvelope,
  type ReadHostedIntegrationArtifactRequest,
  type WriteHostedIntegrationDiagnosticsRequest,
  sanitizeHostedIntegrationJsonValue,
} from "./artifacts.js";
import type { HostedIntegrationCatalog } from "./catalog.js";
import {
  hostedIntegrationEnvironmentConfigId,
  type HostedIntegrationEnvironmentConfigStore,
  type UpsertHostedIntegrationEnvironmentConfigRequest,
  type UpsertHostedIntegrationEnvironmentConfigResult,
} from "./environment-configs.js";
import {
  HostedIntegrationDisableTargetSchema,
  HostedIntegrationDisablementSchema,
  disablementKey,
  type FindHostedIntegrationDisablementRequest,
  type HostedIntegrationDisablement,
  type HostedIntegrationDisablementStore,
  type SetHostedIntegrationDisablementRequest,
} from "./disablements.js";
import {
  type CreateHostedIntegrationDraftFromFilesRequest,
  type CreateHostedIntegrationDraftRequest,
  type CreateHostedIntegrationDraftResult,
  type DeleteHostedIntegrationDraftFileRequest,
  type DeleteHostedIntegrationDraftFileResult,
  type HostedIntegrationDraftStore,
  type ListHostedIntegrationDraftFilesResult,
  type ReadHostedIntegrationDraftFileRequest,
  type ReadHostedIntegrationDraftFileResult,
  type WriteHostedIntegrationDraftFileRequest,
  type WriteHostedIntegrationDraftFileResult,
} from "./drafts.js";
import { resolveHostedIntegrationPythonDependencies } from "./dependencies.js";
import {
  readTextFileUnderRoot,
  resolveInsideRoot,
  type HostedIntegrationFileEntry,
  safePathSegment,
} from "./file-access.js";
import {
  classifyHostedIntegrationFailure,
  fingerprintHostedIntegrationFailure,
  type HostedIntegrationFailureBucketStore,
  type RecordHostedIntegrationFailureRequest,
  type RecordHostedIntegrationFailureResult,
} from "./failure-buckets.js";
import {
  type HostedIntegrationExecutionLogEntry,
  type HostedIntegrationExecutionLogStore,
  type HostedIntegrationIdempotencyStore,
  type ListHostedIntegrationExecutionLogsRequest,
  type ReserveHostedIntegrationIdempotencyRequest,
  type ReserveHostedIntegrationIdempotencyResult,
  type CompleteHostedIntegrationIdempotencyRequest,
} from "./gateway.js";
import {
  type BeginHostedIntegrationInvocationRequest,
  type BeginHostedIntegrationInvocationResult,
  type CompleteHostedIntegrationInvocationRequest,
  type HostedIntegrationGenerationStore,
  type HostedIntegrationRegistryRefreshEvent,
  type ListHostedIntegrationGenerationsRequest,
  type PromoteHostedIntegrationDraftRequest,
  type PromoteHostedIntegrationDraftResult,
  type RollbackHostedIntegrationGenerationRequest,
  type RollbackHostedIntegrationGenerationResult,
} from "./generations.js";
import {
  type AcquireHostedIntegrationLockRequest,
  type AcquireHostedIntegrationLockResult,
  type HostedIntegrationLockStore,
  type ReleaseHostedIntegrationLockRequest,
  type ReleaseHostedIntegrationLockResult,
  type RenewHostedIntegrationLockRequest,
  type RenewHostedIntegrationLockResult,
} from "./locks.js";
import {
  type CancelHostedIntegrationJobRequest,
  type CompleteHostedIntegrationJobRequest,
  type FailHostedIntegrationJobRequest,
  type GetHostedIntegrationJobResultResult,
  type HostedIntegrationJobStore,
  type MarkHostedIntegrationJobRunningRequest,
  type MutateHostedIntegrationJobResult,
  type StartHostedIntegrationJobRequest,
  type StartHostedIntegrationJobResult,
  type UpdateHostedIntegrationJobProgressRequest,
} from "./jobs.js";
import {
  HOSTED_INTEGRATION_ENVIRONMENTS,
  FamilyManifestSchema,
  HostedIntegrationEnvironmentConfigSchema,
  HostedIntegrationEnvironmentSchema,
  HostedIntegrationHumanApprovalRecordSchema,
  HostedIntegrationIdempotencyRecordSchema,
  HostedIntegrationJobSchema,
  HostedIntegrationRunSchema,
  HostedIntegrationToolNameSchema,
  HostedIntegrationDraftSchema,
  HostedIntegrationFailureBucketSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationFamilyLockSchema,
  HostedIntegrationGenerationSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type HostedIntegrationDraft,
  type HostedIntegrationEnvironment,
  type HostedIntegrationEnvironmentConfig,
  type HostedIntegrationFailureBucket,
  type HostedIntegrationFamilyId,
  type HostedIntegrationFamilyLock,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
  type HostedIntegrationIdempotencyRecord,
  type HostedIntegrationJob,
  type HostedIntegrationRunStatus,
  type JsonObject,
  type JsonValue,
} from "./schemas.js";
import {
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationSecretMetadata,
  type HostedIntegrationSecretStore,
  type WriteHostedIntegrationHumanSecretsRequest,
  type WriteHostedIntegrationHumanSecretsResult,
  type GetHostedIntegrationSecretMetadataRequest,
  type ReadHostedIntegrationRuntimeSecretsRequest,
} from "./secrets.js";
import type {
  HostedIntegrationRetentionPolicy,
  HostedIntegrationRetentionSweepLog,
  HostedIntegrationRetentionSweepResult,
  HostedIntegrationRetentionSweeper,
} from "./retention.js";
import {
  type HostedIntegrationSourceFileStore,
  type ListHostedIntegrationSourceFilesResult,
  type ReadHostedIntegrationSourceFileRequest,
  type ReadHostedIntegrationSourceFileResult,
  type ReplaceHostedIntegrationSourceFilesRequest,
  type ReplaceHostedIntegrationSourceFilesResult,
} from "./source-files.js";

const MANIFEST_FILE = "family.yaml";
const DEFAULT_INLINE_RESULT_TOKEN_LIMIT = 8_000;

export interface HostedIntegrationSqlDatabase {
  prepare<P extends unknown[] = unknown[], R = unknown>(
    sql: string,
  ): {
    get(...params: P): R | undefined;
    all(...params: P): R[];
    run(...params: P): unknown;
  };
  transaction<T>(fn: () => T): () => T;
}

export interface DbHostedIntegrationStoreOptions {
  db: HostedIntegrationSqlDatabase;
  dataDir: string;
  now?: () => Date;
  createId?: () => string;
}

export function createDbHostedIntegrationLockStore(
  options: DbHostedIntegrationStoreOptions,
): HostedIntegrationLockStore {
  return new DbHostedIntegrationLockStore(options);
}

export function createDbHostedIntegrationSourceFileStore(
  options: DbHostedIntegrationStoreOptions,
): HostedIntegrationSourceFileStore {
  return new DbHostedIntegrationSourceFileStore(options);
}

export function createDbHostedIntegrationDraftStore(
  options: DbHostedIntegrationStoreOptions & {
    lockStore?: HostedIntegrationLockStore;
  },
): HostedIntegrationDraftStore {
  return new DbHostedIntegrationDraftStore(options);
}

export function createDbHostedIntegrationEnvironmentConfigStore(
  options: DbHostedIntegrationStoreOptions & {
    catalog: HostedIntegrationCatalog;
  },
): HostedIntegrationEnvironmentConfigStore {
  return new DbHostedIntegrationEnvironmentConfigStore(options);
}

export function createDbHostedIntegrationSecretStore(
  options: DbHostedIntegrationStoreOptions & {
    valueStore?: HostedIntegrationSecretStore;
  },
): HostedIntegrationSecretStore {
  return new DbHostedIntegrationSecretStore(options);
}

export function createDbHostedIntegrationApprovalStore(
  options: DbHostedIntegrationStoreOptions,
): HostedIntegrationApprovalStore {
  return new DbHostedIntegrationApprovalStore(options);
}

export function createDbHostedIntegrationDisablementStore(
  options: DbHostedIntegrationStoreOptions,
): HostedIntegrationDisablementStore {
  return new DbHostedIntegrationDisablementStore(options);
}

export function createDbHostedIntegrationGenerationStore(
  options: DbHostedIntegrationStoreOptions & {
    draftStore: HostedIntegrationDraftStore;
    onRegistryRefresh?: (
      event: HostedIntegrationRegistryRefreshEvent,
    ) => void | Promise<void>;
  },
): HostedIntegrationGenerationStore {
  return new DbHostedIntegrationGenerationStore(options);
}

export function createDbHostedIntegrationExecutionLogStore(
  options: Pick<DbHostedIntegrationStoreOptions, "db">,
): HostedIntegrationExecutionLogStore {
  return new DbHostedIntegrationExecutionLogStore(options.db);
}

export function createDbHostedIntegrationJobStore(
  options: DbHostedIntegrationStoreOptions,
): HostedIntegrationJobStore {
  return new DbHostedIntegrationJobStore(options);
}

export function createDbHostedIntegrationArtifactStore(
  options: DbHostedIntegrationStoreOptions & {
    inlineResultTokenLimit?: number;
  },
): HostedIntegrationArtifactStore {
  return new DbHostedIntegrationArtifactStore(options);
}

export function createDbHostedIntegrationRetentionSweeper(
  options: DbHostedIntegrationStoreOptions & {
    logger?: { info(entry: HostedIntegrationRetentionSweepLog): void };
  },
): HostedIntegrationRetentionSweeper {
  return new DbHostedIntegrationRetentionSweeper(options);
}

export function createDbHostedIntegrationFailureBucketStore(
  options: DbHostedIntegrationStoreOptions & {
    ownerActionableTimeouts?: boolean;
  },
): HostedIntegrationFailureBucketStore {
  return new DbHostedIntegrationFailureBucketStore(options);
}

export function createDbHostedIntegrationIdempotencyStore(
  options: Pick<DbHostedIntegrationStoreOptions, "db">,
): HostedIntegrationIdempotencyStore {
  return new DbHostedIntegrationIdempotencyStore(options.db);
}

class DbHostedIntegrationLockStore implements HostedIntegrationLockStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: DbHostedIntegrationStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `lock_${randomUUID()}`);
  }

  async getActiveLock(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyLock | null> {
    const parsed = HostedIntegrationFamilyIdSchema.safeParse(familyId);
    if (!parsed.success) return null;
    const row = this.db
      .prepare<
        [string],
        LockRow
      >("SELECT id, family_id, locked_by, draft_id, acquired_at, renewed_at, expires_at " + "FROM hosted_integration_locks " + "WHERE family_id = ? AND released_at IS NULL ORDER BY acquired_at DESC LIMIT 1")
      .get(parsed.data);
    if (!row) return null;
    const lock = lockFromRow(row);
    if (isExpired(lock, this.now())) return null;
    return lock;
  }

  async acquireLock(
    request: AcquireHostedIntegrationLockRequest,
  ): Promise<AcquireHostedIntegrationLockResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("lockedBy", request.lockedBy);
    assertPositiveTtl(request.ttlMs);
    const existing = await this.getActiveLock(familyId);
    if (existing) return { ok: false, reason: "locked", lock: existing };
    const now = this.now();
    const lock = HostedIntegrationFamilyLockSchema.parse({
      id: this.createId(),
      familyId,
      lockedBy: request.lockedBy,
      draftId: request.draftId,
      acquiredAt: now.toISOString(),
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    });
    this.db
      .prepare(
        "INSERT INTO hosted_integration_locks " +
          "(id, family_id, locked_by, draft_id, acquired_at, renewed_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        lock.id,
        lock.familyId,
        lock.lockedBy,
        lock.draftId ?? null,
        lock.acquiredAt,
        lock.renewedAt,
        lock.expiresAt,
      );
    return { ok: true, lock };
  }

  async renewLock(
    request: RenewHostedIntegrationLockRequest,
  ): Promise<RenewHostedIntegrationLockResult> {
    assertNonEmpty("lockId", request.lockId);
    assertNonEmpty("lockedBy", request.lockedBy);
    assertPositiveTtl(request.ttlMs);
    const existing = this.getLockById(request.lockId);
    if (!existing || isExpired(existing, this.now())) {
      return { ok: false, reason: "not_found" };
    }
    if (existing.lockedBy !== request.lockedBy) {
      return { ok: false, reason: "conflict", lock: existing };
    }
    const now = this.now();
    const renewed = HostedIntegrationFamilyLockSchema.parse({
      ...existing,
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    });
    this.db
      .prepare(
        "UPDATE hosted_integration_locks SET renewed_at = ?, expires_at = ? " +
          "WHERE id = ? AND released_at IS NULL",
      )
      .run(renewed.renewedAt, renewed.expiresAt, renewed.id);
    return { ok: true, lock: renewed };
  }

  async releaseLock(
    request: ReleaseHostedIntegrationLockRequest,
  ): Promise<ReleaseHostedIntegrationLockResult> {
    assertNonEmpty("lockId", request.lockId);
    assertNonEmpty("lockedBy", request.lockedBy);
    const existing = this.getLockById(request.lockId);
    if (!existing || isExpired(existing, this.now())) {
      return { ok: false, reason: "not_found" };
    }
    if (existing.lockedBy !== request.lockedBy) {
      return { ok: false, reason: "conflict", lock: existing };
    }
    this.db
      .prepare(
        "UPDATE hosted_integration_locks SET released_at = ? WHERE id = ?",
      )
      .run(this.now().toISOString(), existing.id);
    return { ok: true };
  }

  private getLockById(lockId: string): HostedIntegrationFamilyLock | null {
    const row = this.db
      .prepare<
        [string],
        LockRow
      >("SELECT id, family_id, locked_by, draft_id, acquired_at, renewed_at, expires_at " + "FROM hosted_integration_locks WHERE id = ? AND released_at IS NULL")
      .get(lockId);
    return row ? lockFromRow(row) : null;
  }
}

class DbHostedIntegrationSourceFileStore implements HostedIntegrationSourceFileStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: DbHostedIntegrationStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ?? (() => `source_${Date.now().toString(36)}`);
  }

  async getCurrentSourceRevisionId(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<string | null> {
    const parsed = HostedIntegrationFamilyIdSchema.safeParse(familyId);
    if (!parsed.success) return null;
    return (
      this.db
        .prepare<
          [string],
          { id: string }
        >("SELECT id FROM hosted_integration_source_revisions " + "WHERE family_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(parsed.data)?.id ?? null
    );
  }

  async listSourceFiles(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<ListHostedIntegrationSourceFilesResult> {
    const revisionId = await this.getCurrentSourceRevisionId(familyId);
    if (!revisionId) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      files: this.db
        .prepare<[string], FileEntryRow>(
          "SELECT path, size FROM hosted_integration_source_files " +
            "WHERE source_revision_id = ? ORDER BY path ASC",
        )
        .all(revisionId)
        .map(fileEntryFromRow),
    };
  }

  async readSourceFile(
    request: ReadHostedIntegrationSourceFileRequest,
  ): Promise<ReadHostedIntegrationSourceFileResult> {
    const revisionId = await this.getCurrentSourceRevisionId(request.familyId);
    if (!revisionId) return { ok: false, reason: "not_found" };
    assertSafeRelativePath(request.path);
    const row = this.db
      .prepare<
        [string, string],
        { content: string }
      >("SELECT content FROM hosted_integration_source_files " + "WHERE source_revision_id = ? AND path = ?")
      .get(revisionId, request.path);
    return row
      ? { ok: true, content: row.content }
      : { ok: false, reason: "not_found" };
  }

  async replaceSourceFiles(
    request: ReplaceHostedIntegrationSourceFilesRequest,
  ): Promise<ReplaceHostedIntegrationSourceFilesResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    if (!request.updatedBy) throw new Error("updatedBy is required");
    const sourceRevisionId = request.sourceRevisionId ?? this.createId();
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO hosted_integration_source_revisions " +
            "(id, family_id, created_at, created_by, provenance_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(sourceRevisionId, familyId, now, request.updatedBy, null);
      for (const [relPath, content] of Object.entries(request.files)) {
        assertSafeRelativePath(relPath);
        this.db
          .prepare(
            "INSERT INTO hosted_integration_source_files " +
              "(source_revision_id, path, content, sha256, size, media_type) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            sourceRevisionId,
            relPath,
            content,
            sha256(content),
            Buffer.byteLength(content, "utf-8"),
            mediaTypeForPath(relPath),
          );
      }
    })();
    return { ok: true, sourceRevisionId };
  }
}

class DbHostedIntegrationDraftStore implements HostedIntegrationDraftStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly lockStore: HostedIntegrationLockStore;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      lockStore?: HostedIntegrationLockStore;
    },
  ) {
    this.db = options.db;
    this.lockStore =
      options.lockStore ?? createDbHostedIntegrationLockStore(options);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `draft_${randomUUID()}`);
  }

  async createDraft(
    request: CreateHostedIntegrationDraftRequest,
  ): Promise<CreateHostedIntegrationDraftResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("lockId", request.lockId);
    assertNonEmpty("sourceRevisionId", request.sourceRevisionId);
    if (!(await this.hasActiveLock(familyId, request.lockId))) {
      return { ok: false, reason: "lock_required" };
    }
    const sourceFiles = this.db
      .prepare<
        [string],
        DraftSourceFileRow
      >("SELECT path, content FROM hosted_integration_source_files " + "WHERE source_revision_id = ? ORDER BY path ASC")
      .all(request.sourceRevisionId);
    if (sourceFiles.length === 0)
      return { ok: false, reason: "source_not_found" };
    return this.createDraftWithFiles({
      familyId,
      lockId: request.lockId,
      sourceRevisionId: request.sourceRevisionId,
      files: Object.fromEntries(
        sourceFiles.map((row) => [row.path, row.content]),
      ),
    });
  }

  async createDraftFromFiles(
    request: CreateHostedIntegrationDraftFromFilesRequest,
  ): Promise<CreateHostedIntegrationDraftResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    return this.createDraftWithFiles({ ...request, familyId });
  }

  async getDraft(draftId: string): Promise<HostedIntegrationDraft | null> {
    const row = this.db
      .prepare<
        [string],
        DraftRow
      >("SELECT id, family_id, source_revision_id, lock_id, status, created_at, updated_at " + "FROM hosted_integration_drafts WHERE id = ?")
      .get(draftId);
    return row ? draftFromRow(row) : null;
  }

  async listDraftFiles(
    draftId: string,
  ): Promise<ListHostedIntegrationDraftFilesResult> {
    const draft = await this.getDraft(draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      files: this.db
        .prepare<[string], FileEntryRow>(
          "SELECT path, size FROM hosted_integration_draft_files " +
            "WHERE draft_id = ? ORDER BY path ASC",
        )
        .all(draft.id)
        .map(fileEntryFromRow),
    };
  }

  async readDraftFile(
    request: ReadHostedIntegrationDraftFileRequest,
  ): Promise<ReadHostedIntegrationDraftFileResult> {
    const draft = await this.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    assertSafeRelativePath(request.path);
    const row = this.db
      .prepare<
        [string, string],
        { content: string }
      >("SELECT content FROM hosted_integration_draft_files WHERE draft_id = ? AND path = ?")
      .get(draft.id, request.path);
    return row
      ? { ok: true, content: row.content }
      : { ok: false, reason: "not_found" };
  }

  async writeDraftFile(
    request: WriteHostedIntegrationDraftFileRequest,
  ): Promise<WriteHostedIntegrationDraftFileResult> {
    const draft = await this.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    if (!(await this.hasActiveLock(draft.familyId, request.lockId, draft))) {
      return { ok: false, reason: "lock_required" };
    }
    assertSafeRelativePath(request.path);
    const now = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO hosted_integration_draft_files " +
          "(draft_id, path, content, sha256, size, media_type, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(draft_id, path) DO UPDATE SET " +
          "content = excluded.content, sha256 = excluded.sha256, size = excluded.size, " +
          "media_type = excluded.media_type, updated_at = excluded.updated_at",
      )
      .run(
        draft.id,
        request.path,
        request.content,
        sha256(request.content),
        Buffer.byteLength(request.content, "utf-8"),
        mediaTypeForPath(request.path),
        now,
      );
    this.touchDraft(draft, now);
    return { ok: true };
  }

  async deleteDraftFile(
    request: DeleteHostedIntegrationDraftFileRequest,
  ): Promise<DeleteHostedIntegrationDraftFileResult> {
    const draft = await this.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    if (!(await this.hasActiveLock(draft.familyId, request.lockId, draft))) {
      return { ok: false, reason: "lock_required" };
    }
    assertSafeRelativePath(request.path);
    const before = this.db
      .prepare<
        [string, string],
        { path: string }
      >("SELECT path FROM hosted_integration_draft_files WHERE draft_id = ? AND path = ?")
      .get(draft.id, request.path);
    if (!before) return { ok: false, reason: "not_found" };
    this.db
      .prepare(
        "DELETE FROM hosted_integration_draft_files WHERE draft_id = ? AND path = ?",
      )
      .run(draft.id, request.path);
    this.touchDraft(draft, this.now().toISOString());
    return { ok: true };
  }

  private async createDraftWithFiles(request: {
    familyId: HostedIntegrationFamilyId;
    lockId: string;
    sourceRevisionId: string;
    files: Record<string, string>;
  }): Promise<CreateHostedIntegrationDraftResult> {
    assertNonEmpty("lockId", request.lockId);
    assertNonEmpty("sourceRevisionId", request.sourceRevisionId);
    if (!(await this.hasActiveLock(request.familyId, request.lockId))) {
      return { ok: false, reason: "lock_required" };
    }
    const now = this.now().toISOString();
    const draft = HostedIntegrationDraftSchema.parse({
      id: this.createId(),
      familyId: request.familyId,
      sourceRevisionId: request.sourceRevisionId,
      lockId: request.lockId,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO hosted_integration_drafts " +
            "(id, family_id, source_revision_id, lock_id, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          draft.id,
          draft.familyId,
          draft.sourceRevisionId,
          draft.lockId,
          draft.status,
          draft.createdAt,
          draft.updatedAt,
        );
      for (const [relPath, content] of Object.entries(request.files)) {
        assertSafeRelativePath(relPath);
        this.db
          .prepare(
            "INSERT INTO hosted_integration_draft_files " +
              "(draft_id, path, content, sha256, size, media_type, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            draft.id,
            relPath,
            content,
            sha256(content),
            Buffer.byteLength(content, "utf-8"),
            mediaTypeForPath(relPath),
            now,
          );
      }
    })();
    return { ok: true, draft };
  }

  private async hasActiveLock(
    familyId: HostedIntegrationFamilyId,
    lockId: string,
    draft?: HostedIntegrationDraft,
  ): Promise<boolean> {
    if (draft && draft.lockId !== lockId) return false;
    const lock = await this.lockStore.getActiveLock(familyId);
    return lock?.id === lockId;
  }

  private touchDraft(draft: HostedIntegrationDraft, updatedAt: string): void {
    this.db
      .prepare(
        "UPDATE hosted_integration_drafts SET updated_at = ? WHERE id = ?",
      )
      .run(updatedAt, draft.id);
  }
}

class DbHostedIntegrationEnvironmentConfigStore implements HostedIntegrationEnvironmentConfigStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly catalog: HostedIntegrationCatalog;
  private readonly now: () => Date;

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      catalog: HostedIntegrationCatalog;
    },
  ) {
    this.db = options.db;
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date());
  }

  async listEnvironmentConfigs(): Promise<
    HostedIntegrationEnvironmentConfig[]
  > {
    return this.db
      .prepare<[], EnvironmentConfigRow>(
        "SELECT id, family_id, environment, revision, config_json, " +
          "secrets_metadata_json, updated_at, updated_by " +
          "FROM hosted_integration_environment_configs ORDER BY id ASC",
      )
      .all()
      .map(environmentConfigFromRow)
      .filter(
        (
          environmentConfig,
        ): environmentConfig is HostedIntegrationEnvironmentConfig =>
          environmentConfig !== null,
      );
  }

  async getEnvironmentConfig(
    familyId: string,
    environment: string,
  ): Promise<HostedIntegrationEnvironmentConfig | null> {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.parse(familyId);
    const parsedEnvironment =
      HostedIntegrationEnvironmentSchema.safeParse(environment);
    if (!parsedEnvironment.success) return null;
    const row = this.db
      .prepare<
        [string],
        EnvironmentConfigRow
      >("SELECT id, family_id, environment, revision, config_json, " + "secrets_metadata_json, updated_at, updated_by " + "FROM hosted_integration_environment_configs WHERE id = ?")
      .get(
        hostedIntegrationEnvironmentConfigId(
          parsedFamilyId,
          parsedEnvironment.data,
        ),
      );
    return row ? environmentConfigFromRow(row) : null;
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
      secrets: sanitizeDbSecretMetadata(request.secrets ?? existing?.secrets),
      updatedAt: this.now().toISOString(),
      updatedBy: request.updatedBy,
    });
    this.db
      .prepare(
        "INSERT INTO hosted_integration_environment_configs " +
          "(id, family_id, environment, revision, config_json, secrets_metadata_json, " +
          "updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET family_id = excluded.family_id, " +
          "environment = excluded.environment, revision = excluded.revision, " +
          "config_json = excluded.config_json, " +
          "secrets_metadata_json = excluded.secrets_metadata_json, " +
          "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      )
      .run(
        environmentConfig.id,
        environmentConfig.familyId,
        environmentConfig.environment,
        environmentConfig.revision,
        JSON.stringify(environmentConfig.config),
        JSON.stringify(environmentConfig.secrets),
        environmentConfig.updatedAt,
        environmentConfig.updatedBy,
      );
    return { ok: true, environmentConfig };
  }
}

class DbHostedIntegrationSecretStore implements HostedIntegrationSecretStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly valueStore: HostedIntegrationSecretStore;
  private readonly now: () => Date;

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      valueStore?: HostedIntegrationSecretStore;
    },
  ) {
    this.db = options.db;
    this.valueStore =
      options.valueStore ??
      createFileHostedIntegrationSecretStore({ dataDir: options.dataDir });
    this.now = options.now ?? (() => new Date());
  }

  async writeHumanOwnedSecrets(
    request: WriteHostedIntegrationHumanSecretsRequest,
  ): Promise<WriteHostedIntegrationHumanSecretsResult> {
    const result = await this.valueStore.writeHumanOwnedSecrets(request);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM hosted_integration_secret_metadata WHERE environment_config_id = ?",
        )
        .run(request.environmentConfigId);
      for (const [name, metadata] of Object.entries(result.metadata.secrets)) {
        this.db
          .prepare(
            "INSERT INTO hosted_integration_secret_metadata " +
              "(environment_config_id, name, configured, updated_at, updated_by) " +
              "VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            request.environmentConfigId,
            name,
            metadata.configured ? 1 : 0,
            now,
            request.updatedBy,
          );
      }
    })();
    return result;
  }

  async getSecretMetadata(
    request: GetHostedIntegrationSecretMetadataRequest,
  ): Promise<HostedIntegrationSecretMetadata> {
    const rows = this.db
      .prepare<
        [string],
        SecretMetadataRow
      >("SELECT environment_config_id, name, configured FROM hosted_integration_secret_metadata " + "WHERE environment_config_id = ? ORDER BY name ASC")
      .all(request.environmentConfigId);
    const dbMetadata = {
      environmentConfigId: request.environmentConfigId,
      secrets: Object.fromEntries(
        rows.map((row) => [row.name, { configured: Boolean(row.configured) }]),
      ),
    };
    if (request.secretNames) {
      return {
        environmentConfigId: request.environmentConfigId,
        secrets: Object.fromEntries(
          request.secretNames.map((name) => [
            name,
            {
              configured: dbMetadata.secrets[name]?.configured ?? false,
            },
          ]),
        ),
      };
    }
    return dbMetadata;
  }

  async readSecretsForRuntime(
    request: ReadHostedIntegrationRuntimeSecretsRequest,
  ): Promise<Record<string, string>> {
    return this.valueStore.readSecretsForRuntime(request);
  }
}

class DbHostedIntegrationApprovalStore implements HostedIntegrationApprovalStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: DbHostedIntegrationStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `approval_${randomUUID()}`);
  }

  async createApproval(
    request: CreateHostedIntegrationApprovalRequest,
  ): Promise<CreateHostedIntegrationApprovalResult> {
    if (request.actor.kind !== "human") {
      return { ok: false, reason: "human_actor_required" };
    }
    const target = request.target;
    const approval = HostedIntegrationHumanApprovalRecordSchema.parse({
      id: this.createId(),
      familyId: target.familyId,
      draftId: target.draftId,
      draftRevisionId: target.draftRevisionId,
      operation: target.operation,
      operationClass: target.operationClass,
      approvedBy: request.actor.id,
      approvedByEmail: request.actor.email,
      approvedAt: this.now().toISOString(),
      target: {
        toolNames: target.toolNames,
        destructiveToolNames: target.destructiveToolNames,
      },
    });
    this.db
      .prepare(
        "INSERT INTO hosted_integration_approvals " +
          "(id, family_id, target_json, actor_json, decision, reason, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        approval.id,
        approval.familyId,
        JSON.stringify(approval),
        JSON.stringify(request.actor),
        "approved",
        null,
        approval.approvedAt,
      );
    return { ok: true, approval };
  }

  async getApproval(
    approvalId: string,
  ): Promise<HostedIntegrationHumanApprovalRecord | null> {
    const row = this.db
      .prepare<
        [string],
        ApprovalRow
      >("SELECT target_json FROM hosted_integration_approvals WHERE id = ?")
      .get(approvalId);
    return row
      ? HostedIntegrationHumanApprovalRecordSchema.parse(
          JSON.parse(row.target_json),
        )
      : null;
  }
}

class DbHostedIntegrationDisablementStore implements HostedIntegrationDisablementStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly now: () => Date;

  constructor(options: DbHostedIntegrationStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  async listDisablements(): Promise<HostedIntegrationDisablement[]> {
    return this.db
      .prepare<
        [],
        DisablementRow
      >("SELECT id, target_json FROM hosted_integration_disablements ORDER BY id ASC")
      .all()
      .map(disablementFromRow);
  }

  async setDisabled(
    request: SetHostedIntegrationDisablementRequest,
  ): Promise<HostedIntegrationDisablement> {
    const target = HostedIntegrationDisableTargetSchema.parse(request.target);
    assertNonEmpty("updatedBy", request.updatedBy);
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
    const familyId = await this.familyIdForDisablementTarget(record);
    this.db
      .prepare(
        "INSERT INTO hosted_integration_disablements " +
          "(id, family_id, tool_name, target_json, reason, disabled_by, disabled_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET family_id = excluded.family_id, " +
          "tool_name = excluded.tool_name, target_json = excluded.target_json, " +
          "reason = excluded.reason, disabled_by = excluded.disabled_by, " +
          "disabled_at = excluded.disabled_at",
      )
      .run(
        record.key,
        familyId,
        record.target.level === "tool" ? record.target.toolName : null,
        JSON.stringify(record),
        record.reason ?? null,
        record.updatedBy,
        record.updatedAt,
      );
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
    if (request.environmentConfigId) {
      keys.push(
        disablementKey({
          level: "environment_config",
          environmentConfigId: request.environmentConfigId,
        }),
      );
    }
    for (const key of keys) {
      const row = this.db
        .prepare<
          [string],
          DisablementRow
        >("SELECT id, target_json FROM hosted_integration_disablements WHERE id = ?")
        .get(key);
      const record = row ? disablementFromRow(row) : null;
      if (record?.disabled) return record;
    }
    return null;
  }

  private async familyIdForDisablementTarget(
    record: HostedIntegrationDisablement,
  ): Promise<string> {
    switch (record.target.level) {
      case "family":
      case "tool":
        return record.target.familyId;
      case "generation":
        return (
          this.db
            .prepare<
              [string],
              { family_id: string }
            >("SELECT family_id FROM hosted_integration_generations WHERE id = ?")
            .get(record.target.generationId)?.family_id ?? "unknown"
        );
      case "environment_config":
        return (
          this.db
            .prepare<
              [string],
              { family_id: string }
            >("SELECT family_id FROM hosted_integration_environment_configs WHERE id = ?")
            .get(record.target.environmentConfigId)?.family_id ?? "unknown"
        );
    }
  }
}

class DbHostedIntegrationGenerationStore implements HostedIntegrationGenerationStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly dataDir: string;
  private readonly draftStore: HostedIntegrationDraftStore;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly onRegistryRefresh: (
    event: HostedIntegrationRegistryRefreshEvent,
  ) => void | Promise<void>;

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      draftStore: HostedIntegrationDraftStore;
      onRegistryRefresh?: (
        event: HostedIntegrationRegistryRefreshEvent,
      ) => void | Promise<void>;
    },
  ) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.draftStore = options.draftStore;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `gen_${randomUUID()}`);
    this.onRegistryRefresh = options.onRegistryRefresh ?? (() => {});
  }

  async promoteDraft(
    request: PromoteHostedIntegrationDraftRequest,
  ): Promise<PromoteHostedIntegrationDraftResult> {
    if (!request.validation.ok)
      return { ok: false, reason: "invalid_validation" };
    const draft = await this.draftStore.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "draft_not_found" };
    const listed = await this.draftStore.listDraftFiles(draft.id);
    if (!listed.ok) return { ok: false, reason: "draft_not_found" };
    const files: Record<string, string> = {};
    for (const file of listed.files) {
      const read = await this.draftStore.readDraftFile({
        draftId: draft.id,
        path: file.path,
      });
      if (!read.ok) return { ok: false, reason: "draft_not_found" };
      files[file.path] = read.content;
    }
    const manifest = manifestFromFiles(files);
    const dependencyResolution = manifest
      ? resolveHostedIntegrationPythonDependencies(manifest.runtime)
      : null;
    if (dependencyResolution && !dependencyResolution.ok) {
      return { ok: false, reason: "invalid_validation" };
    }
    const generationId = this.createId();
    const previousActive = await this.getActiveGeneration(draft.familyId);
    const now = this.now().toISOString();
    const generation = HostedIntegrationGenerationSchema.parse({
      id: generationId,
      familyId: draft.familyId,
      sourceRevisionId: request.sourceRevisionId ?? draft.sourceRevisionId,
      status: "active",
      promotedAt: now,
      promotedBy: request.promotedBy,
      runtime: manifest?.runtime,
      runtimeConfig: manifest?.runtimeConfig,
      tools: manifest?.tools,
      dependencyResolution: dependencyResolution?.dependencyResolution,
      provenance: buildHostedIntegrationGenerationProvenance({
        draftId: draft.id,
        draftRevisionId: request.draftRevisionId ?? draft.updatedAt,
        promotedBy: request.promotedBy,
        validation: request.validation,
        approval: request.approval,
        dependencyResolution: dependencyResolution?.dependencyResolution,
      }),
    });

    this.db.transaction(() => {
      this.insertGeneration(generation);
      for (const [relPath, content] of Object.entries(files)) {
        assertSafeRelativePath(relPath);
        this.db
          .prepare(
            "INSERT INTO hosted_integration_generation_files " +
              "(generation_id, path, content, sha256, size, media_type, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            generation.id,
            relPath,
            content,
            sha256(content),
            Buffer.byteLength(content, "utf-8"),
            mediaTypeForPath(relPath),
            now,
          );
      }
      if (previousActive && previousActive.id !== generation.id) {
        this.writeRetirementStatus(previousActive.id, request.promotedBy);
      }
      this.writeActivePointer({
        familyId: generation.familyId,
        generationId: generation.id,
        activatedAt: now,
        activatedBy: request.promotedBy,
        previousGenerationId: previousActive?.id ?? null,
      });
    })();
    await materializeGenerationFiles(this.dataDir, generation.id, files);
    await this.onRegistryRefresh({
      familyId: generation.familyId,
      generationId: generation.id,
      reason: "promote",
      toolNames: manifest?.tools.map((tool) => tool.name) ?? [],
    });
    return { ok: true, generation };
  }

  async listGenerations(
    request: ListHostedIntegrationGenerationsRequest = {},
  ): Promise<HostedIntegrationGeneration[]> {
    const familyId =
      request.familyId === undefined
        ? null
        : HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const rows = this.db
      .prepare<
        unknown[],
        GenerationRow
      >("SELECT id, family_id, source_revision_id, status, promoted_at, promoted_by, " + "manifest_json, validation_json, dependency_resolution_json, provenance_json " + "FROM hosted_integration_generations " + (familyId ? "WHERE family_id = ? " : "") + "ORDER BY promoted_at DESC, id DESC")
      .all(...(familyId ? [familyId] : []));
    return rows.map(generationFromRow);
  }

  async getGeneration(
    generationId: string,
  ): Promise<HostedIntegrationGeneration | null> {
    const row = this.db
      .prepare<
        [string],
        GenerationRow
      >("SELECT id, family_id, source_revision_id, status, promoted_at, promoted_by, " + "manifest_json, validation_json, dependency_resolution_json, provenance_json " + "FROM hosted_integration_generations WHERE id = ?")
      .get(generationId);
    return row ? generationFromRow(row) : null;
  }

  async getActiveGeneration(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationGeneration | null> {
    const parsed = HostedIntegrationFamilyIdSchema.parse(familyId);
    const row = this.db
      .prepare<
        [string],
        { generation_id: string }
      >("SELECT generation_id FROM hosted_integration_active_generations WHERE family_id = ?")
      .get(parsed);
    return row ? this.getGeneration(row.generation_id) : null;
  }

  async beginInvocation(
    request: BeginHostedIntegrationInvocationRequest,
  ): Promise<BeginHostedIntegrationInvocationResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const generation = request.generationId
      ? await this.getGeneration(request.generationId)
      : await this.getActiveGeneration(familyId);
    if (!generation) {
      return {
        ok: false,
        reason: request.generationId
          ? "generation_not_found"
          : "no_active_generation",
      };
    }
    if (
      generation.familyId !== familyId ||
      generation.status === "retired" ||
      generation.status === "disabled"
    ) {
      return { ok: false, reason: "stale_generation" };
    }
    const lease = {
      id: `lease_${randomUUID()}`,
      familyId,
      generationId: generation.id,
      startedAt: this.now().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO hosted_integration_generation_invocations " +
          "(lease_id, generation_id, family_id, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(lease.id, lease.generationId, lease.familyId, lease.startedAt);
    return { ok: true, lease };
  }

  async completeInvocation(
    request: CompleteHostedIntegrationInvocationRequest,
  ): Promise<void> {
    const completedAt = this.now().toISOString();
    const lease = this.db
      .prepare<
        [string],
        { generation_id: string }
      >("SELECT generation_id FROM hosted_integration_generation_invocations " + "WHERE lease_id = ? AND completed_at IS NULL")
      .get(request.leaseId);
    if (!lease) return;
    this.db
      .prepare(
        "UPDATE hosted_integration_generation_invocations SET completed_at = ? WHERE lease_id = ?",
      )
      .run(completedAt, request.leaseId);
    const openCount =
      this.db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM hosted_integration_generation_invocations " + "WHERE generation_id = ? AND completed_at IS NULL")
        .get(lease.generation_id)?.count ?? 0;
    const generation = await this.getGeneration(lease.generation_id);
    if (generation?.status === "draining" && openCount === 0) {
      this.db
        .prepare(
          "UPDATE hosted_integration_generations SET status = 'retired' WHERE id = ?",
        )
        .run(lease.generation_id);
    }
  }

  async hasInflightInvocations(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<boolean> {
    return (await this.getInflightInvocationCount(familyId)) > 0;
  }

  async getInflightInvocationCount(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<number> {
    const parsed = HostedIntegrationFamilyIdSchema.parse(familyId);
    return (
      this.db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM hosted_integration_generation_invocations " + "WHERE family_id = ? AND completed_at IS NULL")
        .get(parsed)?.count ?? 0
    );
  }

  async rollback(
    request: RollbackHostedIntegrationGenerationRequest,
  ): Promise<RollbackHostedIntegrationGenerationResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const generation = await this.getGeneration(request.generationId);
    if (!generation) return { ok: false, reason: "generation_not_found" };
    if (generation.familyId !== familyId) {
      return { ok: false, reason: "family_mismatch" };
    }
    const previousActive = await this.getActiveGeneration(familyId);
    const now = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE hosted_integration_generations SET status = 'active' WHERE id = ?",
        )
        .run(generation.id);
      if (previousActive && previousActive.id !== generation.id) {
        this.writeRetirementStatus(previousActive.id, request.rolledBackBy);
      }
      this.writeActivePointer({
        familyId,
        generationId: generation.id,
        activatedAt: now,
        activatedBy: request.rolledBackBy,
        previousGenerationId: previousActive?.id ?? null,
      });
    })();
    await this.onRegistryRefresh({
      familyId,
      generationId: generation.id,
      reason: "rollback",
      toolNames: generation.tools?.map((tool) => tool.name) ?? [],
    });
    return {
      ok: true,
      activeGeneration: (await this.getGeneration(generation.id)) ?? {
        ...generation,
        status: "active",
      },
    };
  }

  private insertGeneration(generation: HostedIntegrationGeneration): void {
    this.db
      .prepare(
        "INSERT INTO hosted_integration_generations " +
          "(id, family_id, source_revision_id, status, promoted_at, promoted_by, " +
          "manifest_json, tool_names_json, validation_json, dependency_resolution_json, " +
          "provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        generation.id,
        generation.familyId,
        generation.sourceRevisionId,
        generation.status,
        generation.promotedAt,
        generation.promotedBy,
        JSON.stringify({
          runtime: generation.runtime,
          runtimeConfig: generation.runtimeConfig,
          tools: generation.tools,
        }),
        JSON.stringify(generation.tools?.map((tool) => tool.name) ?? []),
        JSON.stringify(generation.provenance?.validation ?? {}),
        generation.dependencyResolution
          ? JSON.stringify(generation.dependencyResolution)
          : null,
        JSON.stringify(generation.provenance ?? {}),
      );
  }

  private writeRetirementStatus(generationId: string, updatedBy: string): void {
    const openCount =
      this.db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM hosted_integration_generation_invocations " + "WHERE generation_id = ? AND completed_at IS NULL")
        .get(generationId)?.count ?? 0;
    this.db
      .prepare(
        "UPDATE hosted_integration_generations SET status = ? WHERE id = ?",
      )
      .run(openCount > 0 ? "draining" : "retired", generationId);
    void updatedBy;
  }

  private writeActivePointer(input: {
    familyId: HostedIntegrationFamilyId;
    generationId: string;
    activatedAt: string;
    activatedBy: string;
    previousGenerationId: string | null;
  }): void {
    this.db
      .prepare(
        "INSERT INTO hosted_integration_active_generations " +
          "(family_id, generation_id, activated_at, activated_by, previous_generation_id) " +
          "VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(family_id) DO UPDATE SET generation_id = excluded.generation_id, " +
          "activated_at = excluded.activated_at, activated_by = excluded.activated_by, " +
          "previous_generation_id = excluded.previous_generation_id",
      )
      .run(
        input.familyId,
        input.generationId,
        input.activatedAt,
        input.activatedBy,
        input.previousGenerationId,
      );
  }
}

class DbHostedIntegrationExecutionLogStore implements HostedIntegrationExecutionLogStore {
  constructor(private readonly db: HostedIntegrationSqlDatabase) {}

  async startLog(entry: HostedIntegrationExecutionLogEntry): Promise<void> {
    const parsed = ExecutionLogEntrySchema.parse(entry);
    this.db
      .prepare(
        "INSERT INTO hosted_integration_execution_logs " +
          "(run_id, family_id, tool_name, generation_id, actor_json, status, started_at, " +
          "request_sanitized_json, result_envelope_ref_json, result_metadata_json, error_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        parsed.runId,
        parsed.familyId,
        parsed.toolName,
        parsed.generationId,
        JSON.stringify({
          actorId: parsed.actorId,
          environmentConfigId: parsed.environmentConfigId,
          configRevision: parsed.configRevision,
          executionPurpose: parsed.executionPurpose,
        }),
        parsed.status,
        parsed.startedAt,
        JSON.stringify(parsed.sanitizedArgs),
        parsed.resultEnvelopeRef ?? null,
        parsed.resultMetadata ? JSON.stringify(parsed.resultMetadata) : null,
        parsed.error ? JSON.stringify(parsed.error) : null,
      );
  }

  async finishLog(
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
  ): Promise<void> {
    const existing = await this.getRunLog(runId);
    if (!existing) throw new Error(`execution log ${runId} not found`);
    const next = ExecutionLogEntrySchema.parse({ ...existing, ...update });
    this.db
      .prepare(
        "UPDATE hosted_integration_execution_logs SET status = ?, ended_at = ?, " +
          "duration_ms = ?, result_envelope_ref_json = ?, result_metadata_json = ?, " +
          "error_json = ? WHERE run_id = ?",
      )
      .run(
        next.status,
        next.endedAt ?? null,
        next.durationMs ?? null,
        next.resultEnvelopeRef ?? null,
        next.resultMetadata ? JSON.stringify(next.resultMetadata) : null,
        next.error ? JSON.stringify(next.error) : null,
        next.runId,
      );
  }

  async getRunLog(
    runId: string,
  ): Promise<HostedIntegrationExecutionLogEntry | null> {
    const row = this.db
      .prepare<
        [string],
        ExecutionLogRow
      >("SELECT run_id, family_id, tool_name, generation_id, actor_json, status, " + "started_at, ended_at, duration_ms, request_sanitized_json, " + "result_envelope_ref_json, result_metadata_json, error_json " + "FROM hosted_integration_execution_logs WHERE run_id = ?")
      .get(runId);
    return row ? executionLogFromRow(row) : null;
  }

  async listRunLogs(
    request: ListHostedIntegrationExecutionLogsRequest = {},
  ): Promise<HostedIntegrationExecutionLogEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (request.familyId) {
      clauses.push("family_id = ?");
      params.push(request.familyId);
    }
    if (request.toolName) {
      clauses.push("tool_name = ?");
      params.push(request.toolName);
    }
    if (request.generationId) {
      clauses.push("generation_id = ?");
      params.push(request.generationId);
    }
    if (request.status) {
      clauses.push("status = ?");
      params.push(request.status);
    }
    const limit = normalizeExecutionLogLimit(request.limit);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare<
        unknown[],
        ExecutionLogRow
      >("SELECT run_id, family_id, tool_name, generation_id, actor_json, status, " + "started_at, ended_at, duration_ms, request_sanitized_json, " + "result_envelope_ref_json, result_metadata_json, error_json " + `FROM hosted_integration_execution_logs${where} ` + "ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?")
      .all(...params, limit);
    return rows.map(executionLogFromRow);
  }
}

class DbHostedIntegrationJobStore implements HostedIntegrationJobStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: DbHostedIntegrationStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `job_${randomUUID()}`);
  }

  async startJob(
    request: StartHostedIntegrationJobRequest,
  ): Promise<StartHostedIntegrationJobResult> {
    if (request.executionMode !== "async") {
      return { ok: false, reason: "sync_only" };
    }
    if (request.idempotencyKey) {
      const existing = this.getJobByIdempotencyKey(request.idempotencyKey);
      if (existing) {
        if (
          existing.requestFingerprint !== request.requestFingerprint ||
          !request.requestFingerprint
        ) {
          return { ok: false, reason: "idempotency_conflict" };
        }
        return { ok: true, replayed: true, job: existing };
      }
    }
    const now = this.now().toISOString();
    const job = HostedIntegrationJobSchema.parse({
      id: this.createId(),
      familyId: HostedIntegrationFamilyIdSchema.parse(request.familyId),
      toolName: HostedIntegrationToolNameSchema.parse(request.toolName),
      generationId: request.generationId,
      actorId: request.actorId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: request.requestFingerprint,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    this.writeJob(job);
    this.writeJobEvent(job.id, "job_queued", {}, now);
    return { ok: true, replayed: false, job };
  }

  async getJob(jobId: string): Promise<HostedIntegrationJob | null> {
    const row = this.db
      .prepare<
        [string],
        JobRow
      >("SELECT id, family_id, tool_name, generation_id, status, actor_json, " + "args_hash, result_json, error_json, created_at, started_at, ended_at, cancelled_at " + "FROM hosted_integration_jobs WHERE id = ?")
      .get(jobId);
    return row ? jobFromRow(row) : null;
  }

  async markRunning(
    request: MarkHostedIntegrationJobRunningRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    return this.mutateJob(request.jobId, (job) => {
      if (isTerminalJob(job.status)) return { ok: false, reason: "terminal" };
      return {
        ok: true,
        job: {
          ...job,
          runId: request.runId,
          status: "running",
          progress: request.progress ?? job.progress,
        },
      };
    });
  }

  async updateProgress(
    request: UpdateHostedIntegrationJobProgressRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    const progress = JsonObjectSchema.parse(request.progress);
    return this.mutateJob(request.jobId, (job) => {
      if (job.status !== "running") return { ok: false, reason: "not_running" };
      return { ok: true, job: { ...job, progress } };
    });
  }

  async completeJob(
    request: CompleteHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    return this.mutateJob(request.jobId, (job) => {
      if (job.status !== "running") return { ok: false, reason: "not_running" };
      return {
        ok: true,
        job: {
          ...job,
          status: "succeeded",
          resultEnvelopeRef: request.resultEnvelopeRef,
        },
      };
    });
  }

  async failJob(
    request: FailHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    const error = JsonObjectSchema.parse(request.error);
    return this.mutateJob(request.jobId, (job) => {
      if (isTerminalJob(job.status)) return { ok: false, reason: "terminal" };
      return { ok: true, job: { ...job, status: "failed", error } };
    });
  }

  async cancelJob(
    request: CancelHostedIntegrationJobRequest,
  ): Promise<MutateHostedIntegrationJobResult> {
    return this.mutateJob(request.jobId, (job) => {
      if (job.status !== "running") return { ok: false, reason: "not_running" };
      return {
        ok: true,
        job: {
          ...job,
          status: "cancelled",
          cancelledBy: request.cancelledBy,
        },
      };
    });
  }

  async getResult(jobId: string): Promise<GetHostedIntegrationJobResultResult> {
    const job = await this.getJob(jobId);
    if (!job) return { ok: false, reason: "not_found" };
    if (job.status === "failed") return { ok: false, reason: "failed" };
    if (job.status === "cancelled") return { ok: false, reason: "cancelled" };
    if (job.status !== "succeeded" || !job.resultEnvelopeRef) {
      return { ok: false, reason: "not_ready" };
    }
    return { ok: true, result_ref: job.resultEnvelopeRef };
  }

  private mutateJob(
    jobId: string,
    mutate: (job: HostedIntegrationJob) => MutateHostedIntegrationJobResult,
  ): MutateHostedIntegrationJobResult {
    const existingRow = this.db
      .prepare<
        [string],
        JobRow
      >("SELECT id, family_id, tool_name, generation_id, status, actor_json, " + "args_hash, result_json, error_json, created_at, started_at, ended_at, cancelled_at " + "FROM hosted_integration_jobs WHERE id = ?")
      .get(jobId);
    if (!existingRow) return { ok: false, reason: "not_found" };
    const existing = jobFromRow(existingRow);
    const result = mutate(existing);
    if (!result.ok) return result;
    const now = this.now().toISOString();
    const job = HostedIntegrationJobSchema.parse({
      ...result.job,
      updatedAt: now,
    });
    this.writeJob(job);
    this.writeJobEvent(job.id, `job_${job.status}`, jobEventPayload(job), now);
    return { ok: true, job };
  }

  private getJobByIdempotencyKey(
    idempotencyKey: string,
  ): HostedIntegrationJob | null {
    const rows = this.db
      .prepare<
        [],
        JobRow
      >("SELECT id, family_id, tool_name, generation_id, status, actor_json, " + "args_hash, result_json, error_json, created_at, started_at, ended_at, cancelled_at " + "FROM hosted_integration_jobs ORDER BY created_at DESC, id DESC")
      .all();
    return (
      rows
        .map(jobFromRow)
        .find((job) => job.idempotencyKey === idempotencyKey) ?? null
    );
  }

  private writeJob(job: HostedIntegrationJob): void {
    this.db
      .prepare(
        "INSERT INTO hosted_integration_jobs " +
          "(id, family_id, tool_name, generation_id, status, actor_json, args_hash, " +
          "result_json, error_json, created_at, started_at, ended_at, cancelled_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET status = excluded.status, " +
          "actor_json = excluded.actor_json, result_json = excluded.result_json, " +
          "error_json = excluded.error_json, started_at = excluded.started_at, " +
          "ended_at = excluded.ended_at, cancelled_at = excluded.cancelled_at",
      )
      .run(
        job.id,
        job.familyId,
        job.toolName,
        job.generationId,
        job.status,
        JSON.stringify({
          actorId: job.actorId,
          idempotencyKey: job.idempotencyKey,
          requestFingerprint: job.requestFingerprint,
          runId: job.runId,
          progress: job.progress,
          cancelledBy: job.cancelledBy,
          updatedAt: job.updatedAt,
        }),
        job.requestFingerprint ?? "",
        job.resultEnvelopeRef
          ? JSON.stringify({ resultEnvelopeRef: job.resultEnvelopeRef })
          : null,
        job.error ? JSON.stringify(job.error) : null,
        job.createdAt,
        job.status === "running" ? job.updatedAt : null,
        job.status === "succeeded" || job.status === "failed"
          ? job.updatedAt
          : null,
        job.status === "cancelled" ? job.updatedAt : null,
      );
  }

  private writeJobEvent(
    jobId: string,
    eventType: string,
    payload: JsonObject,
    createdAt: string,
  ): void {
    const sequence =
      (this.db
        .prepare<
          [string],
          { sequence: number }
        >("SELECT COALESCE(MAX(sequence), 0) AS sequence " + "FROM hosted_integration_job_events WHERE job_id = ?")
        .get(jobId)?.sequence ?? 0) + 1;
    this.db
      .prepare(
        "INSERT INTO hosted_integration_job_events " +
          "(id, job_id, sequence, event_type, payload_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `job_event_${randomUUID()}`,
        jobId,
        sequence,
        eventType,
        JSON.stringify(payload),
        createdAt,
      );
  }
}

class DbHostedIntegrationArtifactStore implements HostedIntegrationArtifactStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly dataDir: string;
  private readonly inlineResultTokenLimit: number;
  private readonly now: () => Date;
  private readonly createRunId: () => string;

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      inlineResultTokenLimit?: number;
    },
  ) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.inlineResultTokenLimit =
      options.inlineResultTokenLimit ?? DEFAULT_INLINE_RESULT_TOKEN_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.createRunId = options.createId ?? (() => `call_${randomUUID()}`);
  }

  async createRun(
    request: CreateHostedIntegrationRunRequest,
  ): Promise<CreateHostedIntegrationRunResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const toolName = HostedIntegrationToolNameSchema.parse(request.toolName);
    const input = JsonValueSchema.parse(request.input);
    const runId = this.createRunId();
    const now = this.now().toISOString();
    const run = HostedIntegrationRunSchema.parse({
      id: runId,
      familyId,
      toolName,
      generationId: request.generationId,
      status: "running",
      startedAt: now,
    });
    const familyHome = this.familyHome(familyId);
    const runDir = this.runDir(familyId, runId);

    await mkdir(path.join(runDir, "artifacts"), { recursive: true });
    await mkdir(familyHome, { recursive: true });
    this.db
      .prepare(
        "INSERT INTO hosted_integration_runs " +
          "(id, family_id, tool_name, generation_id, actor_json, purpose, status, " +
          "created_at, retention_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        run.id,
        run.familyId,
        run.toolName,
        run.generationId,
        JSON.stringify({ actorId: request.actorId }),
        "invoke",
        run.status,
        run.startedAt,
        "active",
      );
    await this.writeJsonArtifact(familyId, runId, "input.sanitized.json", {
      actorId: request.actorId,
      input,
      startedAt: now,
    });
    await this.writeJsonArtifact(familyId, runId, "metadata.json", run);
    return { run, familyHome, runDir };
  }

  async completeRunSuccess(
    request: CompleteHostedIntegrationRunSuccessRequest,
  ): Promise<HostedIntegrationSuccessEnvelope> {
    const result = JsonValueSchema.parse(request.result);
    const sanitized = sanitizeHostedIntegrationJsonValue(result);
    const artifact = await this.writeJsonArtifact(
      request.familyId,
      request.runId,
      "output.json",
      sanitized,
    );
    const limit = request.inlineResultTokenLimit ?? this.inlineResultTokenLimit;
    const inline = artifact.estimated_tokens <= limit;
    await this.updateRunStatus({
      familyId: request.familyId,
      runId: request.runId,
      status: "succeeded",
      resultEnvelopeRef: `${request.runId}/output.json`,
      resultMetadata: inline
        ? {
            envelopeRef: `${request.runId}/output.json`,
            responseMode: "inline",
          }
        : {
            envelopeRef: `${request.runId}/output.json`,
            responseMode: "artifact",
            artifact: {
              name: artifact.name,
              sizeBytes: artifact.size_bytes,
              estimatedTokens: artifact.estimated_tokens,
            },
          },
    });
    if (inline) {
      return { ok: true, result: sanitized };
    }
    return { ok: true, result_ref: artifact };
  }

  async completeRunError(
    request: CompleteHostedIntegrationRunErrorRequest,
  ): Promise<{ ok: false; error: JsonValue }> {
    const error = sanitizeHostedIntegrationJsonValue(
      JsonValueSchema.parse(request.error),
    );
    await this.writeJsonArtifact(
      request.familyId,
      request.runId,
      "error.json",
      error,
    );
    await this.updateRunStatus({
      familyId: request.familyId,
      runId: request.runId,
      status: "failed",
      error,
    });
    return { ok: false, error };
  }

  async writeDiagnostics(
    request: WriteHostedIntegrationDiagnosticsRequest,
  ): Promise<void> {
    await this.writeJsonArtifact(
      request.familyId,
      request.runId,
      "diagnostics.json",
      JsonValueSchema.parse(request.diagnostics),
    );
  }

  async readArtifact(
    request: ReadHostedIntegrationArtifactRequest,
  ): Promise<string> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    return readTextFileUnderRoot(
      this.runDir(familyId, request.runId),
      request.name,
      "run root",
    );
  }

  private async writeJsonArtifact(
    familyIdInput: HostedIntegrationFamilyId | string,
    runId: string,
    name: string,
    value: JsonValue,
  ): Promise<HostedIntegrationArtifactRef> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(familyIdInput);
    const content = `${JSON.stringify(
      sanitizeHostedIntegrationJsonValue(value),
      null,
      2,
    )}\n`;
    const resolved = resolveInsideRoot(
      this.runDir(familyId, runId),
      name,
      "run root",
    );
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf-8");
    const artifact = {
      type: "artifact" as const,
      run_id: runId,
      name,
      size_bytes: Buffer.byteLength(content, "utf-8"),
      estimated_tokens: estimateTokens(content),
    };
    this.db
      .prepare(
        "INSERT INTO hosted_integration_artifacts " +
          "(id, run_id, name, kind, media_type, size, sha256, storage_ref, " +
          "retention_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(run_id, name) DO UPDATE SET size = excluded.size, " +
          "sha256 = excluded.sha256, storage_ref = excluded.storage_ref",
      )
      .run(
        `${runId}:${name}`,
        runId,
        name,
        "json",
        "application/json",
        artifact.size_bytes,
        sha256(content),
        path.relative(this.dataDir, resolved),
        "active",
        this.now().toISOString(),
      );
    return artifact;
  }

  private async updateRunStatus(input: {
    familyId: HostedIntegrationFamilyId | string;
    runId: string;
    status: Extract<HostedIntegrationRunStatus, "succeeded" | "failed">;
    resultEnvelopeRef?: string;
    resultMetadata?: JsonObject;
    error?: JsonValue;
  }): Promise<void> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(input.familyId);
    const endedAt = this.now().toISOString();
    this.db
      .prepare(
        "UPDATE hosted_integration_runs SET status = ?, result_envelope_ref_json = ?, " +
          "result_metadata_json = ?, error_json = ?, ended_at = ? WHERE id = ?",
      )
      .run(
        input.status,
        input.resultEnvelopeRef ?? null,
        input.resultMetadata ? JSON.stringify(input.resultMetadata) : null,
        input.error ? JSON.stringify(input.error) : null,
        endedAt,
        input.runId,
      );
    const existing = this.db
      .prepare<
        [string],
        RunRow
      >("SELECT id, family_id, tool_name, generation_id, status, created_at, ended_at " + "FROM hosted_integration_runs WHERE id = ?")
      .get(input.runId);
    if (existing) {
      await this.writeJsonArtifact(familyId, input.runId, "metadata.json", {
        id: existing.id,
        familyId: existing.family_id,
        toolName: existing.tool_name,
        generationId: existing.generation_id,
        status: input.status,
        startedAt: existing.created_at,
        endedAt,
      });
    }
  }

  private familyHome(familyId: HostedIntegrationFamilyId): string {
    return path.join(this.familyWorkspace(familyId), "home");
  }

  private runDir(familyId: HostedIntegrationFamilyId, runId: string): string {
    return path.join(
      this.familyWorkspace(familyId),
      "runs",
      safePathSegment("runId", runId),
    );
  }

  private familyWorkspace(familyId: HostedIntegrationFamilyId): string {
    return path.join(
      this.dataDir,
      "hosted-integrations",
      "workspaces",
      familyId,
    );
  }
}

class DbHostedIntegrationRetentionSweeper implements HostedIntegrationRetentionSweeper {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly logger?: {
    info(entry: HostedIntegrationRetentionSweepLog): void;
  };

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      logger?: { info(entry: HostedIntegrationRetentionSweepLog): void };
    },
  ) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  async sweep(
    policy: HostedIntegrationRetentionPolicy,
  ): Promise<HostedIntegrationRetentionSweepResult> {
    assertRetentionPolicy(policy);
    const logs = this.db
      .prepare<[], ExecutionLogRow>(
        "SELECT run_id, family_id, tool_name, generation_id, actor_json, status, " +
          "started_at, ended_at, duration_ms, request_sanitized_json, " +
          "result_envelope_ref_json, result_metadata_json, error_json " +
          "FROM hosted_integration_execution_logs",
      )
      .all()
      .map(executionLogFromRow);
    const openBucketFingerprints = new Set(
      this.db
        .prepare<[], { fingerprint: string }>(
          "SELECT fingerprint FROM hosted_integration_failure_buckets WHERE status = 'open'",
        )
        .all()
        .map((row) => row.fingerprint),
    );
    const protectedRunIds = new Set(
      logs
        .filter(
          (log) =>
            log.status === "failed" &&
            log.error &&
            openBucketFingerprints.has(
              fingerprintHostedIntegrationFailure(log),
            ),
        )
        .map((log) => log.runId),
    );
    const result: HostedIntegrationRetentionSweepResult = {
      runsDeleted: 0,
      executionLogsDeleted: 0,
      failureBucketsDeleted: 0,
      bytesDeleted: 0,
    };

    await this.sweepRuns(policy, protectedRunIds, result);
    this.sweepExecutionLogs(policy, protectedRunIds, logs, result);
    this.sweepClosedBuckets(policy, result);
    this.logger?.info({
      event: "hosted_integration_retention_sweep",
      ...result,
    });
    return result;
  }

  private async sweepRuns(
    policy: HostedIntegrationRetentionPolicy,
    protectedRunIds: Set<string>,
    result: HostedIntegrationRetentionSweepResult,
  ): Promise<void> {
    const runs = this.db
      .prepare<
        [],
        RetentionRunRow
      >("SELECT id, family_id, status, created_at, ended_at, retention_state " + "FROM hosted_integration_runs WHERE retention_state = 'active'")
      .all();
    for (const run of runs) {
      if (run.status === "running") continue;
      if (protectedRunIds.has(run.id)) continue;
      const agePolicy =
        run.status === "succeeded"
          ? policy.successfulRunMaxAgeMs
          : policy.failedClosedRunMaxAgeMs;
      if (
        !isRetentionExpired(
          run.ended_at ?? run.created_at,
          agePolicy,
          this.now(),
        )
      ) {
        continue;
      }
      result.bytesDeleted += this.artifactBytesForRun(run.id);
      await rm(this.runDir(run.family_id, run.id), {
        recursive: true,
        force: true,
      });
      this.db
        .prepare(
          "UPDATE hosted_integration_runs SET retention_state = 'deleted' WHERE id = ?",
        )
        .run(run.id);
      this.db
        .prepare(
          "UPDATE hosted_integration_artifacts SET retention_state = 'deleted' WHERE run_id = ?",
        )
        .run(run.id);
      result.runsDeleted += 1;
    }
  }

  private sweepExecutionLogs(
    policy: HostedIntegrationRetentionPolicy,
    protectedRunIds: Set<string>,
    logs: HostedIntegrationExecutionLogEntry[],
    result: HostedIntegrationRetentionSweepResult,
  ): void {
    for (const log of logs) {
      if (log.status === "running") continue;
      if (protectedRunIds.has(log.runId)) continue;
      const agePolicy =
        log.status === "succeeded"
          ? policy.successfulRunMaxAgeMs
          : policy.failedClosedRunMaxAgeMs;
      if (
        !isRetentionExpired(log.endedAt ?? log.startedAt, agePolicy, this.now())
      ) {
        continue;
      }
      result.bytesDeleted += Buffer.byteLength(JSON.stringify(log), "utf-8");
      this.db
        .prepare(
          "DELETE FROM hosted_integration_execution_logs WHERE run_id = ?",
        )
        .run(log.runId);
      result.executionLogsDeleted += 1;
    }
  }

  private sweepClosedBuckets(
    policy: HostedIntegrationRetentionPolicy,
    result: HostedIntegrationRetentionSweepResult,
  ): void {
    const buckets = this.db
      .prepare<
        [],
        FailureBucketRow
      >("SELECT id, family_id, tool_name, generation_id, fingerprint, status, count, " + "latest_run_id, first_seen_at, latest_seen_at, assigned_to " + "FROM hosted_integration_failure_buckets WHERE status = 'closed'")
      .all();
    for (const row of buckets) {
      const bucket = failureBucketFromRow(row);
      if (
        !isRetentionExpired(
          bucket.latestSeenAt,
          policy.closedBucketMaxAgeMs,
          this.now(),
        )
      ) {
        continue;
      }
      result.bytesDeleted += Buffer.byteLength(JSON.stringify(bucket), "utf-8");
      this.db
        .prepare("DELETE FROM hosted_integration_failure_buckets WHERE id = ?")
        .run(bucket.id);
      result.failureBucketsDeleted += 1;
    }
  }

  private artifactBytesForRun(runId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { bytes: number | null }
        >("SELECT COALESCE(SUM(size), 0) AS bytes " + "FROM hosted_integration_artifacts WHERE run_id = ? AND retention_state = 'active'")
        .get(runId)?.bytes ?? 0
    );
  }

  private runDir(familyId: string, runId: string): string {
    return path.join(
      this.dataDir,
      "hosted-integrations",
      "workspaces",
      familyId,
      "runs",
      safePathSegment("runId", runId),
    );
  }
}

class DbHostedIntegrationFailureBucketStore implements HostedIntegrationFailureBucketStore {
  private readonly db: HostedIntegrationSqlDatabase;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly ownerActionableTimeouts: boolean;

  constructor(
    options: DbHostedIntegrationStoreOptions & {
      ownerActionableTimeouts?: boolean;
    },
  ) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `bucket_${randomUUID()}`);
    this.ownerActionableTimeouts = options.ownerActionableTimeouts ?? true;
  }

  async recordFailure(
    request: RecordHostedIntegrationFailureRequest,
  ): Promise<RecordHostedIntegrationFailureResult> {
    const classification = classifyHostedIntegrationFailure(
      request.log,
      this.ownerActionableTimeouts,
    );
    if (classification !== "owner_actionable") {
      return { ok: false, reason: "not_owner_actionable", classification };
    }
    const fingerprint = fingerprintHostedIntegrationFailure(request.log);
    const now = this.now().toISOString();
    const existing = this.getBucketByFingerprint(fingerprint);
    if (existing) {
      const bucket = HostedIntegrationFailureBucketSchema.parse({
        ...existing,
        count: existing.count + 1,
        latestSeenAt: now,
      });
      this.writeBucket(bucket);
      this.writeBucketEvent(
        bucket.id,
        "failure_recorded",
        request.log.runId,
        now,
      );
      return { ok: true, created: false, bucket };
    }
    const bucket = HostedIntegrationFailureBucketSchema.parse({
      id: this.createId(),
      familyId: request.log.familyId,
      toolName: request.log.toolName,
      generationId: request.log.generationId,
      fingerprint,
      status: "open",
      count: 1,
      firstSeenAt: now,
      latestSeenAt: now,
    });
    this.writeBucket(bucket);
    this.writeBucketEvent(
      bucket.id,
      "failure_recorded",
      request.log.runId,
      now,
    );
    return { ok: true, created: true, bucket };
  }

  async getBucket(
    bucketId: string,
  ): Promise<HostedIntegrationFailureBucket | null> {
    const row = this.db
      .prepare<
        [string],
        FailureBucketRow
      >("SELECT id, family_id, tool_name, generation_id, fingerprint, status, count, " + "latest_run_id, first_seen_at, latest_seen_at, assigned_to " + "FROM hosted_integration_failure_buckets " + "WHERE id = ?")
      .get(bucketId);
    return row ? failureBucketFromRow(row) : null;
  }

  async listBuckets(): Promise<HostedIntegrationFailureBucket[]> {
    return this.db
      .prepare<[], FailureBucketRow>(
        "SELECT id, family_id, tool_name, generation_id, fingerprint, status, count, " +
          "latest_run_id, first_seen_at, latest_seen_at, assigned_to " +
          "FROM hosted_integration_failure_buckets " +
          "ORDER BY latest_seen_at ASC",
      )
      .all()
      .map(failureBucketFromRow);
  }

  async assignBucket(request: {
    bucketId: string;
    assignedTo: string;
  }): Promise<
    | { ok: true; bucket: HostedIntegrationFailureBucket }
    | { ok: false; reason: "not_found" }
  > {
    const existing = await this.getBucket(request.bucketId);
    if (!existing) return { ok: false, reason: "not_found" };
    const bucket = HostedIntegrationFailureBucketSchema.parse({
      ...existing,
      assignedTo: request.assignedTo,
      latestSeenAt: this.now().toISOString(),
    });
    this.writeBucket(bucket);
    return { ok: true, bucket };
  }

  async closeBucket(request: {
    bucketId: string;
  }): Promise<
    | { ok: true; bucket: HostedIntegrationFailureBucket }
    | { ok: false; reason: "not_found" }
  > {
    const existing = await this.getBucket(request.bucketId);
    if (!existing) return { ok: false, reason: "not_found" };
    const bucket = HostedIntegrationFailureBucketSchema.parse({
      ...existing,
      status: "closed",
      latestSeenAt: this.now().toISOString(),
    });
    this.writeBucket(bucket);
    this.writeBucketEvent(
      bucket.id,
      "bucket_closed",
      null,
      bucket.latestSeenAt,
    );
    return { ok: true, bucket };
  }

  private getBucketByFingerprint(
    fingerprint: string,
  ): HostedIntegrationFailureBucket | null {
    const row = this.db
      .prepare<
        [string],
        FailureBucketRow
      >("SELECT id, family_id, tool_name, generation_id, fingerprint, status, count, " + "latest_run_id, first_seen_at, latest_seen_at, assigned_to " + "FROM hosted_integration_failure_buckets " + "WHERE fingerprint = ? AND status = 'open'")
      .get(fingerprint);
    return row ? failureBucketFromRow(row) : null;
  }

  private writeBucket(bucket: HostedIntegrationFailureBucket): void {
    this.db
      .prepare(
        "INSERT INTO hosted_integration_failure_buckets " +
          "(id, family_id, tool_name, generation_id, fingerprint, status, count, " +
          "latest_run_id, first_seen_at, latest_seen_at, assigned_to) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET status = excluded.status, count = excluded.count, " +
          "latest_seen_at = excluded.latest_seen_at, assigned_to = excluded.assigned_to",
      )
      .run(
        bucket.id,
        bucket.familyId,
        bucket.toolName,
        bucket.generationId,
        bucket.fingerprint,
        bucket.status,
        bucket.count,
        null,
        bucket.firstSeenAt,
        bucket.latestSeenAt,
        bucket.assignedTo ?? null,
      );
  }

  private writeBucketEvent(
    bucketId: string,
    eventType: string,
    runId: string | null,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO hosted_integration_failure_bucket_events " +
          "(id, bucket_id, event_type, run_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`event_${randomUUID()}`, bucketId, eventType, runId, createdAt);
  }
}

class DbHostedIntegrationIdempotencyStore implements HostedIntegrationIdempotencyStore {
  constructor(private readonly db: HostedIntegrationSqlDatabase) {}

  async reserve(
    request: ReserveHostedIntegrationIdempotencyRequest,
  ): Promise<ReserveHostedIntegrationIdempotencyResult> {
    const existing = this.getRecord(request.key);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint) {
        return { ok: false, reason: "fingerprint_mismatch" };
      }
      return { ok: true, status: "replay", record: existing };
    }
    this.db
      .prepare(
        "INSERT INTO hosted_integration_idempotency " +
          "(key, operation, actor_id, target_json, request_hash, status, " +
          "final_envelope_metadata_json, created_at, completed_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        request.key,
        "invoke",
        request.actorId,
        JSON.stringify({ target: request.target }),
        request.fingerprint,
        "pending",
        null,
        request.now,
        null,
        null,
      );
    return { ok: true, status: "new" };
  }

  async complete(
    request: CompleteHostedIntegrationIdempotencyRequest,
  ): Promise<void> {
    const existing = this.getRecord(request.key);
    if (!existing) return;
    this.db
      .prepare(
        "UPDATE hosted_integration_idempotency SET status = ?, " +
          "final_envelope_metadata_json = ?, completed_at = ? WHERE key = ?",
      )
      .run(
        "completed",
        JSON.stringify({ resultEnvelopeRef: request.resultEnvelopeRef }),
        request.now,
        request.key,
      );
  }

  private getRecord(key: string): HostedIntegrationIdempotencyRecord | null {
    const row = this.db
      .prepare<
        [string],
        IdempotencyRow
      >("SELECT key, operation, actor_id, target_json, request_hash, status, " + "final_envelope_metadata_json, created_at, completed_at " + "FROM hosted_integration_idempotency WHERE key = ?")
      .get(key);
    return row ? idempotencyFromRow(row) : null;
  }
}

const ExecutionLogEntrySchema: z.ZodType<HostedIntegrationExecutionLogEntry> = z
  .object({
    runId: z.string().min(1),
    familyId: HostedIntegrationFamilyIdSchema,
    toolName: z.string().min(1),
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

interface LockRow {
  id: string;
  family_id: string;
  locked_by: string;
  draft_id: string | null;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
}

interface DraftRow {
  id: string;
  family_id: string;
  source_revision_id: string;
  lock_id: string;
  status: "open" | "promoted" | "cancelled";
  created_at: string;
  updated_at: string;
}

interface DraftSourceFileRow {
  path: string;
  content: string;
}

interface FileEntryRow {
  path: string;
  size: number;
}

interface GenerationRow {
  id: string;
  family_id: string;
  source_revision_id: string;
  status: "active" | "draining" | "retired" | "disabled";
  promoted_at: string;
  promoted_by: string;
  manifest_json: string;
  validation_json: string;
  dependency_resolution_json: string | null;
  provenance_json: string;
}

interface EnvironmentConfigRow {
  id: string;
  family_id: string;
  environment: string;
  revision: number;
  config_json: string;
  secrets_metadata_json: string;
  updated_at: string;
  updated_by: string;
}

interface SecretMetadataRow {
  environment_config_id: string;
  name: string;
  configured: number;
}

interface ApprovalRow {
  target_json: string;
}

interface DisablementRow {
  id: string;
  target_json: string;
}

interface JobRow {
  id: string;
  family_id: string;
  tool_name: string;
  generation_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  actor_json: string;
  args_hash: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancelled_at: string | null;
}

interface RunRow {
  id: string;
  family_id: string;
  tool_name: string;
  generation_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  ended_at: string | null;
}

interface RetentionRunRow {
  id: string;
  family_id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  ended_at: string | null;
  retention_state: "active" | "deleted";
}

interface ExecutionLogRow {
  run_id: string;
  family_id: string;
  tool_name: string;
  generation_id: string;
  actor_json: string;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  request_sanitized_json: string;
  result_envelope_ref_json: string | null;
  result_metadata_json: string | null;
  error_json: string | null;
}

interface FailureBucketRow {
  id: string;
  family_id: string;
  tool_name: string;
  generation_id: string;
  fingerprint: string;
  status: "open" | "closed";
  count: number;
  latest_run_id: string | null;
  first_seen_at: string;
  latest_seen_at: string;
  assigned_to: string | null;
}

interface IdempotencyRow {
  key: string;
  operation: "invoke" | "async_start" | "promote" | "rollback" | "lock_change";
  actor_id: string;
  target_json: string;
  request_hash: string;
  status: "pending" | "completed" | "failed";
  final_envelope_metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
}

function lockFromRow(row: LockRow): HostedIntegrationFamilyLock {
  return HostedIntegrationFamilyLockSchema.parse({
    id: row.id,
    familyId: row.family_id,
    lockedBy: row.locked_by,
    draftId: row.draft_id ?? undefined,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
  });
}

function draftFromRow(row: DraftRow): HostedIntegrationDraft {
  return HostedIntegrationDraftSchema.parse({
    id: row.id,
    familyId: row.family_id,
    sourceRevisionId: row.source_revision_id,
    lockId: row.lock_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function fileEntryFromRow(row: FileEntryRow): HostedIntegrationFileEntry {
  return { path: row.path, size: row.size };
}

function generationFromRow(row: GenerationRow): HostedIntegrationGeneration {
  const manifest = JSON.parse(row.manifest_json) as {
    runtime?: unknown;
    runtimeConfig?: unknown;
    tools?: unknown;
  };
  return HostedIntegrationGenerationSchema.parse({
    id: row.id,
    familyId: row.family_id,
    sourceRevisionId: row.source_revision_id,
    status: row.status,
    promotedAt: row.promoted_at,
    promotedBy: row.promoted_by,
    runtime: manifest.runtime,
    runtimeConfig: manifest.runtimeConfig,
    tools: manifest.tools,
    dependencyResolution: row.dependency_resolution_json
      ? JSON.parse(row.dependency_resolution_json)
      : undefined,
    provenance: JSON.parse(row.provenance_json),
  });
}

function environmentConfigFromRow(
  row: EnvironmentConfigRow,
): HostedIntegrationEnvironmentConfig | null {
  const environment = HostedIntegrationEnvironmentSchema.safeParse(
    row.environment,
  );
  if (!environment.success) return null;
  const expectedId = hostedIntegrationEnvironmentConfigId(
    row.family_id,
    environment.data,
  );
  if (row.id !== expectedId) return null;
  return HostedIntegrationEnvironmentConfigSchema.parse({
    id: row.id,
    familyId: row.family_id,
    revision: row.revision,
    environment: environment.data,
    config: JSON.parse(row.config_json),
    secrets: sanitizeDbSecretMetadata(JSON.parse(row.secrets_metadata_json)),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });
}

function sanitizeDbSecretMetadata(rawSecrets: unknown) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function disablementFromRow(row: DisablementRow): HostedIntegrationDisablement {
  void row.id;
  return HostedIntegrationDisablementSchema.parse(JSON.parse(row.target_json));
}

function executionLogFromRow(
  row: ExecutionLogRow,
): HostedIntegrationExecutionLogEntry {
  const actor = JSON.parse(row.actor_json) as {
    actorId: string;
    environmentConfigId: string | null;
    configRevision: number | null;
    executionPurpose?: HostedIntegrationExecutionLogEntry["executionPurpose"];
  };
  return ExecutionLogEntrySchema.parse({
    runId: row.run_id,
    familyId: row.family_id,
    toolName: row.tool_name,
    generationId: row.generation_id,
    actorId: actor.actorId,
    environmentConfigId: actor.environmentConfigId,
    configRevision: actor.configRevision,
    executionPurpose: actor.executionPurpose ?? "consumer",
    sanitizedArgs: JSON.parse(row.request_sanitized_json),
    status: row.status,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    startedAt: row.started_at,
    resultEnvelopeRef: row.result_envelope_ref_json ?? undefined,
    resultMetadata: row.result_metadata_json
      ? JSON.parse(row.result_metadata_json)
      : undefined,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
  });
}

function normalizeExecutionLogLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 25;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function jobFromRow(row: JobRow): HostedIntegrationJob {
  const actor = JSON.parse(row.actor_json) as {
    actorId: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
    runId?: string;
    progress?: unknown;
    cancelledBy?: string;
    updatedAt?: string;
  };
  const result = row.result_json
    ? (JSON.parse(row.result_json) as { resultEnvelopeRef?: string })
    : {};
  return HostedIntegrationJobSchema.parse({
    id: row.id,
    familyId: row.family_id,
    toolName: row.tool_name,
    generationId: row.generation_id,
    actorId: actor.actorId,
    idempotencyKey: actor.idempotencyKey,
    requestFingerprint:
      (actor.requestFingerprint ?? row.args_hash) || undefined,
    runId: actor.runId,
    status: row.status,
    progress: actor.progress,
    resultEnvelopeRef: result.resultEnvelopeRef,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    cancelledBy: actor.cancelledBy,
    createdAt: row.created_at,
    updatedAt:
      actor.updatedAt ??
      row.cancelled_at ??
      row.ended_at ??
      row.started_at ??
      row.created_at,
  });
}

function jobEventPayload(job: HostedIntegrationJob): JsonObject {
  return JsonObjectSchema.parse({
    status: job.status,
    ...(job.runId ? { runId: job.runId } : {}),
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.resultEnvelopeRef
      ? { resultEnvelopeRef: job.resultEnvelopeRef }
      : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.cancelledBy ? { cancelledBy: job.cancelledBy } : {}),
  });
}

function isTerminalJob(status: HostedIntegrationJob["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

function failureBucketFromRow(
  row: FailureBucketRow,
): HostedIntegrationFailureBucket {
  return HostedIntegrationFailureBucketSchema.parse({
    id: row.id,
    familyId: row.family_id,
    toolName: row.tool_name,
    generationId: row.generation_id,
    fingerprint: row.fingerprint,
    status: row.status,
    count: row.count,
    firstSeenAt: row.first_seen_at,
    latestSeenAt: row.latest_seen_at,
    assignedTo: row.assigned_to ?? undefined,
  });
}

function idempotencyFromRow(
  row: IdempotencyRow,
): HostedIntegrationIdempotencyRecord {
  const target = JSON.parse(row.target_json) as { target?: string };
  const finalEnvelope = row.final_envelope_metadata_json
    ? (JSON.parse(row.final_envelope_metadata_json) as {
        resultEnvelopeRef?: string;
      })
    : {};
  return HostedIntegrationIdempotencyRecordSchema.parse({
    key: row.key,
    operation: row.operation,
    actorId: row.actor_id,
    target: target.target,
    fingerprint: row.request_hash,
    status: row.status,
    resultEnvelopeRef: finalEnvelope.resultEnvelopeRef,
    createdAt: row.created_at,
    updatedAt: row.completed_at ?? row.created_at,
  });
}

function manifestFromFiles(files: Record<string, string>) {
  const manifestFile = files[MANIFEST_FILE];
  if (!manifestFile) return null;
  return FamilyManifestSchema.parse(parseYaml(manifestFile));
}

async function materializeGenerationFiles(
  dataDir: string,
  generationId: string,
  files: Record<string, string>,
): Promise<void> {
  const root = path.join(
    dataDir,
    "hosted-integrations",
    "generations",
    safePathSegment("generationId", generationId),
    "files",
  );
  for (const [relPath, content] of Object.entries(files)) {
    assertSafeRelativePath(relPath);
    const out = path.resolve(root, relPath);
    const relative = path.relative(root, out);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error("path escapes generation files root");
    }
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, content, "utf-8");
  }
}

function isExpired(lock: HostedIntegrationFamilyLock, now: Date): boolean {
  return Date.parse(lock.expiresAt) <= now.getTime();
}

function assertNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive integer");
  }
}

function assertSafeRelativePath(relPath: string): void {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\0")) {
    throw new Error("path escapes hosted integration root");
  }
  const normalized = path.posix.normalize(relPath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    throw new Error("path escapes hosted integration root");
  }
}

function mediaTypeForPath(relPath: string): string | null {
  if (relPath.endsWith(".yaml") || relPath.endsWith(".yml")) return "text/yaml";
  if (relPath.endsWith(".py")) return "text/x-python";
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".md")) return "text/markdown";
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function isRetentionExpired(
  timestamp: string,
  maxAgeMs: number,
  now: Date,
): boolean {
  const then = Date.parse(timestamp);
  return Number.isFinite(then) && now.getTime() - then > maxAgeMs;
}

function assertRetentionPolicy(policy: HostedIntegrationRetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
}
