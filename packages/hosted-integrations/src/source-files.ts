import path from "node:path";
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

export type ReadHostedIntegrationSourceFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: "not_found" };

export interface HostedIntegrationSourceFileStore {
  listSourceFiles(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<ListHostedIntegrationSourceFilesResult>;
  readSourceFile(
    request: ReadHostedIntegrationSourceFileRequest,
  ): Promise<ReadHostedIntegrationSourceFileResult>;
}

export function createFileHostedIntegrationSourceFileStore(
  options: FileHostedIntegrationSourceFileStoreOptions,
): HostedIntegrationSourceFileStore {
  return new FileHostedIntegrationSourceFileStore(options.dataDir);
}

class FileHostedIntegrationSourceFileStore
  implements HostedIntegrationSourceFileStore
{
  private readonly familiesDir: string;

  constructor(dataDir: string) {
    this.familiesDir = path.join(
      dataDir,
      "hosted-integrations",
      "source",
      "families",
    );
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
        content: await readTextFileUnderRoot(
          root,
          request.path,
          "source root",
        ),
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "not_found" };
      }
      throw error;
    }
  }

  private familyRoot(familyId: HostedIntegrationFamilyId | string): string {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.parse(familyId);
    return path.join(
      this.familiesDir,
      safePathSegment("familyId", parsedFamilyId),
    );
  }
}
