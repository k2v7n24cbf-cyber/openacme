import { cp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  HostedIntegrationDraftSchema,
  HostedIntegrationFamilyIdSchema,
  type HostedIntegrationDraft,
  type HostedIntegrationFamilyId,
} from "./schemas.js";
import {
  createFileHostedIntegrationLockStore,
  type HostedIntegrationLockStore,
} from "./locks.js";

export interface FileHostedIntegrationDraftStoreOptions {
  dataDir: string;
  lockStore?: HostedIntegrationLockStore;
  now?: () => Date;
  createId?: () => string;
}

export interface CreateHostedIntegrationDraftRequest {
  familyId: HostedIntegrationFamilyId | string;
  lockId: string;
  sourceRevisionId: string;
}

export type CreateHostedIntegrationDraftResult =
  | { ok: true; draft: HostedIntegrationDraft }
  | { ok: false; reason: "lock_required" | "source_not_found" };

export interface ReadHostedIntegrationDraftFileRequest {
  draftId: string;
  path: string;
}

export type ReadHostedIntegrationDraftFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: "not_found" };

export interface WriteHostedIntegrationDraftFileRequest {
  draftId: string;
  lockId: string;
  path: string;
  content: string;
}

export type WriteHostedIntegrationDraftFileResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "lock_required" };

export interface DeleteHostedIntegrationDraftFileRequest {
  draftId: string;
  lockId: string;
  path: string;
}

export type DeleteHostedIntegrationDraftFileResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "lock_required" };

export interface HostedIntegrationDraftStore {
  createDraft(
    request: CreateHostedIntegrationDraftRequest,
  ): Promise<CreateHostedIntegrationDraftResult>;
  getDraft(draftId: string): Promise<HostedIntegrationDraft | null>;
  readDraftFile(
    request: ReadHostedIntegrationDraftFileRequest,
  ): Promise<ReadHostedIntegrationDraftFileResult>;
  writeDraftFile(
    request: WriteHostedIntegrationDraftFileRequest,
  ): Promise<WriteHostedIntegrationDraftFileResult>;
  deleteDraftFile(
    request: DeleteHostedIntegrationDraftFileRequest,
  ): Promise<DeleteHostedIntegrationDraftFileResult>;
}

export function createFileHostedIntegrationDraftStore(
  options: FileHostedIntegrationDraftStoreOptions,
): HostedIntegrationDraftStore {
  return new FileHostedIntegrationDraftStore(options);
}

class FileHostedIntegrationDraftStore implements HostedIntegrationDraftStore {
  private readonly sourceFamiliesDir: string;
  private readonly draftsDir: string;
  private readonly lockStore: HostedIntegrationLockStore;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: FileHostedIntegrationDraftStoreOptions) {
    this.sourceFamiliesDir = path.join(
      options.dataDir,
      "hosted-integrations",
      "source",
      "families",
    );
    this.draftsDir = path.join(
      options.dataDir,
      "hosted-integrations",
      "drafts",
    );
    this.lockStore =
      options.lockStore ??
      createFileHostedIntegrationLockStore({ dataDir: options.dataDir });
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

    const now = this.now().toISOString();
    const draft = HostedIntegrationDraftSchema.parse({
      id: this.createId(),
      familyId,
      sourceRevisionId: request.sourceRevisionId,
      lockId: request.lockId,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });

    const draftRoot = this.draftRoot(draft.id);
    await rm(draftRoot, { recursive: true, force: true });
    try {
      await mkdir(draftRoot, { recursive: true });
      await cp(this.sourceFamilyRoot(familyId), this.draftFilesRoot(draft.id), {
        recursive: true,
      });
      await this.writeDraftMetadata(draft);
    } catch (error) {
      await rm(draftRoot, { recursive: true, force: true });
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "source_not_found" };
      }
      throw error;
    }

    return { ok: true, draft };
  }

  async getDraft(draftId: string): Promise<HostedIntegrationDraft | null> {
    const metadataPath = this.draftMetadataPath(draftId);
    let raw: string;
    try {
      raw = await readFile(metadataPath, "utf-8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    return HostedIntegrationDraftSchema.parse(JSON.parse(raw));
  }

  async readDraftFile(
    request: ReadHostedIntegrationDraftFileRequest,
  ): Promise<ReadHostedIntegrationDraftFileResult> {
    const draft = await this.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "not_found" };

    const resolved = resolveInsideRoot(
      this.draftFilesRoot(draft.id),
      request.path,
    );
    try {
      return { ok: true, content: await readFile(resolved, "utf-8") };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "not_found" };
      }
      throw error;
    }
  }

  async writeDraftFile(
    request: WriteHostedIntegrationDraftFileRequest,
  ): Promise<WriteHostedIntegrationDraftFileResult> {
    const draft = await this.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    if (!(await this.hasActiveLock(draft.familyId, request.lockId, draft))) {
      return { ok: false, reason: "lock_required" };
    }

    const resolved = resolveInsideRoot(
      this.draftFilesRoot(draft.id),
      request.path,
    );
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, request.content, "utf-8");
    await this.touchDraft(draft);
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

    const resolved = resolveInsideRoot(
      this.draftFilesRoot(draft.id),
      request.path,
    );
    try {
      await unlink(resolved);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "not_found" };
      }
      throw error;
    }
    await this.touchDraft(draft);
    return { ok: true };
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

  private async touchDraft(draft: HostedIntegrationDraft): Promise<void> {
    await this.writeDraftMetadata(
      HostedIntegrationDraftSchema.parse({
        ...draft,
        updatedAt: this.now().toISOString(),
      }),
    );
  }

  private async writeDraftMetadata(
    draft: HostedIntegrationDraft,
  ): Promise<void> {
    await mkdir(this.draftRoot(draft.id), { recursive: true });
    await writeFile(
      this.draftMetadataPath(draft.id),
      `${JSON.stringify(draft, null, 2)}\n`,
      "utf-8",
    );
  }

  private sourceFamilyRoot(familyId: HostedIntegrationFamilyId): string {
    return path.join(this.sourceFamiliesDir, familyId);
  }

  private draftRoot(draftId: string): string {
    return path.join(this.draftsDir, safePathSegment("draftId", draftId));
  }

  private draftFilesRoot(draftId: string): string {
    return path.join(this.draftRoot(draftId), "files");
  }

  private draftMetadataPath(draftId: string): string {
    return path.join(this.draftRoot(draftId), "metadata.json");
  }
}

function resolveInsideRoot(root: string, requestedPath: string): string {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error("path escapes draft root");
  }
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, requestedPath);
  const relative = path.relative(absoluteRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("path escapes draft root");
  }
  return resolved;
}

function safePathSegment(name: string, value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${name} must be a safe path segment`);
  }
  return value;
}

function assertNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
