import path from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  HostedIntegrationFamilyIdSchema,
  type HostedIntegrationFamilyId,
} from "./schemas.js";
import {
  isNodeError,
  listFilesUnderRoot,
  readTextFileUnderRoot,
  safePathSegment,
  type HostedIntegrationFileEntry,
} from "./file-access.js";

export interface FileHostedIntegrationSourceFileStoreOptions {
  dataDir: string;
}

export type ListHostedIntegrationSourceFilesResult =
  | { ok: true; files: HostedIntegrationFileEntry[] }
  | { ok: false; reason: "not_found" };

export interface ReadHostedIntegrationSourceFileRequest {
  familyId: HostedIntegrationFamilyId | string;
  path: string;
}

export interface ReplaceHostedIntegrationSourceFilesRequest {
  familyId: HostedIntegrationFamilyId | string;
  files: Record<string, string>;
  updatedBy: string;
  sourceRevisionId?: string;
}

export type ReplaceHostedIntegrationSourceFilesResult = {
  ok: true;
  sourceRevisionId: string;
};

export type ReadHostedIntegrationSourceFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: "not_found" };

export interface HostedIntegrationSourceFileStore {
  getCurrentSourceRevisionId(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<string | null>;
  listSourceFiles(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<ListHostedIntegrationSourceFilesResult>;
  readSourceFile(
    request: ReadHostedIntegrationSourceFileRequest,
  ): Promise<ReadHostedIntegrationSourceFileResult>;
  replaceSourceFiles(
    request: ReplaceHostedIntegrationSourceFilesRequest,
  ): Promise<ReplaceHostedIntegrationSourceFilesResult>;
}

export function createFileHostedIntegrationSourceFileStore(
  options: FileHostedIntegrationSourceFileStoreOptions,
): HostedIntegrationSourceFileStore {
  return new FileHostedIntegrationSourceFileStore(options.dataDir);
}

class FileHostedIntegrationSourceFileStore implements HostedIntegrationSourceFileStore {
  private readonly familiesDir: string;
  private readonly revisionsDir: string;

  constructor(dataDir: string) {
    this.familiesDir = path.join(
      dataDir,
      "hosted-integrations",
      "source",
      "families",
    );
    this.revisionsDir = path.join(
      dataDir,
      "hosted-integrations",
      "source",
      "revisions",
    );
  }

  async getCurrentSourceRevisionId(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<string | null> {
    try {
      const raw: unknown = JSON.parse(
        await readTextFileUnderRoot(
          this.revisionsDir,
          `${safePathSegment(
            "familyId",
            HostedIntegrationFamilyIdSchema.parse(familyId),
          )}.json`,
          "source revisions root",
        ),
      );
      return isRecord(raw) && typeof raw.sourceRevisionId === "string"
        ? raw.sourceRevisionId
        : null;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async listSourceFiles(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<ListHostedIntegrationSourceFilesResult> {
    const root = this.familyRoot(familyId);
    try {
      return { ok: true, files: await listFilesUnderRoot(root) };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "not_found" };
      }
      throw error;
    }
  }

  async readSourceFile(
    request: ReadHostedIntegrationSourceFileRequest,
  ): Promise<ReadHostedIntegrationSourceFileResult> {
    const root = this.familyRoot(request.familyId);
    try {
      return {
        ok: true,
        content: await readTextFileUnderRoot(root, request.path, "source root"),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "not_found" };
      }
      throw error;
    }
  }

  async replaceSourceFiles(
    request: ReplaceHostedIntegrationSourceFilesRequest,
  ): Promise<ReplaceHostedIntegrationSourceFilesResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    if (!request.updatedBy) throw new Error("updatedBy is required");
    const sourceRevisionId =
      request.sourceRevisionId ?? `source_${Date.now().toString(36)}`;
    const familyRoot = this.familyRoot(familyId);
    const tmpRoot = `${familyRoot}.${process.pid}.${Date.now()}.tmp`;
    const oldRoot = `${familyRoot}.${process.pid}.${Date.now()}.old`;
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
    for (const [relPath, content] of Object.entries(request.files)) {
      const resolved = path.resolve(tmpRoot, relPath);
      const relative = path.relative(tmpRoot, resolved);
      if (
        relative === "" ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        throw new Error("path escapes source root");
      }
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
    }
    await rm(oldRoot, { recursive: true, force: true });
    try {
      await rename(familyRoot, oldRoot);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    try {
      await mkdir(path.dirname(familyRoot), { recursive: true });
      await rename(tmpRoot, familyRoot);
      await this.writeSourceRevision({
        familyId,
        sourceRevisionId,
        updatedBy: request.updatedBy,
      });
      await rm(oldRoot, { recursive: true, force: true });
    } catch (error) {
      await rm(familyRoot, { recursive: true, force: true });
      try {
        await rename(oldRoot, familyRoot);
      } catch {
        // Best-effort rollback; keep original error.
      }
      throw error;
    }
    return { ok: true, sourceRevisionId };
  }

  private async writeSourceRevision(record: {
    familyId: HostedIntegrationFamilyId;
    sourceRevisionId: string;
    updatedBy: string;
  }): Promise<void> {
    await mkdir(this.revisionsDir, { recursive: true });
    await writeFile(
      path.join(
        this.revisionsDir,
        `${safePathSegment("familyId", record.familyId)}.json`,
      ),
      `${JSON.stringify(
        { ...record, updatedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }

  private familyRoot(familyId: HostedIntegrationFamilyId | string): string {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.parse(familyId);
    return path.join(
      this.familiesDir,
      safePathSegment("familyId", parsedFamilyId),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
