import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { buildHostedIntegrationGenerationProvenance } from "./approvals.js";
import {
  createFileHostedIntegrationDraftStore,
  type HostedIntegrationDraftStore,
} from "./drafts.js";
import {
  isNodeError,
  resolveInsideRoot,
  safePathSegment,
} from "./file-access.js";
import {
  FamilyManifestSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationGenerationSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
} from "./schemas.js";
import type { HostedIntegrationValidationResult } from "./validation.js";

const MANIFEST_FILE = "family.yaml";

const ActiveGenerationPointerSchema = z
  .object({
    familyId: HostedIntegrationFamilyIdSchema,
    generationId: z.string().min(1),
    updatedAt: z.string().datetime({ offset: true }),
    updatedBy: z.string().min(1),
  })
  .strict();

export interface FileHostedIntegrationGenerationStoreOptions {
  dataDir: string;
  draftStore?: HostedIntegrationDraftStore;
  now?: () => Date;
  createId?: () => string;
}

export interface PromoteHostedIntegrationDraftRequest {
  draftId: string;
  promotedBy: string;
  validation: HostedIntegrationValidationResult;
  draftRevisionId?: string;
  approval?: HostedIntegrationHumanApprovalRecord;
}

export type PromoteHostedIntegrationDraftResult =
  | { ok: true; generation: HostedIntegrationGeneration }
  | { ok: false; reason: "draft_not_found" | "invalid_validation" };

export interface RollbackHostedIntegrationGenerationRequest {
  familyId: HostedIntegrationFamilyId | string;
  generationId: string;
  rolledBackBy: string;
}

export type RollbackHostedIntegrationGenerationResult =
  | { ok: true; activeGeneration: HostedIntegrationGeneration }
  | { ok: false; reason: "generation_not_found" | "family_mismatch" };

export interface HostedIntegrationGenerationStore {
  promoteDraft(
    request: PromoteHostedIntegrationDraftRequest,
  ): Promise<PromoteHostedIntegrationDraftResult>;
  getGeneration(
    generationId: string,
  ): Promise<HostedIntegrationGeneration | null>;
  getActiveGeneration(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationGeneration | null>;
  rollback(
    request: RollbackHostedIntegrationGenerationRequest,
  ): Promise<RollbackHostedIntegrationGenerationResult>;
}

export function createFileHostedIntegrationGenerationStore(
  options: FileHostedIntegrationGenerationStoreOptions,
): HostedIntegrationGenerationStore {
  return new FileHostedIntegrationGenerationStore({
    dataDir: options.dataDir,
    draftStore:
      options.draftStore ??
      createFileHostedIntegrationDraftStore({ dataDir: options.dataDir }),
    now: options.now ?? (() => new Date()),
    createId: options.createId ?? (() => `gen_${randomUUID()}`),
  });
}

class FileHostedIntegrationGenerationStore
  implements HostedIntegrationGenerationStore
{
  private readonly generationsDir: string;
  private readonly activeDir: string;
  private readonly draftStore: HostedIntegrationDraftStore;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(parts: {
    dataDir: string;
    draftStore: HostedIntegrationDraftStore;
    now: () => Date;
    createId: () => string;
  }) {
    this.generationsDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "generations",
    );
    this.activeDir = path.join(this.generationsDir, "active");
    this.draftStore = parts.draftStore;
    this.now = parts.now;
    this.createId = parts.createId;
  }

  async promoteDraft(
    request: PromoteHostedIntegrationDraftRequest,
  ): Promise<PromoteHostedIntegrationDraftResult> {
    if (!request.validation.ok) {
      return { ok: false, reason: "invalid_validation" };
    }
    const draft = await this.draftStore.getDraft(request.draftId);
    if (!draft) return { ok: false, reason: "draft_not_found" };

    const generationId = this.createId();
    const finalRoot = this.generationRoot(generationId);
    const tmpRoot = `${finalRoot}.${process.pid}.${Date.now()}.tmp`;
    const filesRoot = path.join(tmpRoot, "files");
    await rm(tmpRoot, { recursive: true, force: true });

    try {
      await mkdir(filesRoot, { recursive: true });
      const listed = await this.draftStore.listDraftFiles(draft.id);
      if (!listed.ok) {
        await rm(tmpRoot, { recursive: true, force: true });
        return { ok: false, reason: "draft_not_found" };
      }

      for (const file of listed.files) {
        const read = await this.draftStore.readDraftFile({
          draftId: draft.id,
          path: file.path,
        });
        if (!read.ok) {
          await rm(tmpRoot, { recursive: true, force: true });
          return { ok: false, reason: "draft_not_found" };
        }
        const outputPath = resolveInsideRoot(
          filesRoot,
          file.path,
          "generation files root",
        );
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, read.content, "utf-8");
      }

      const manifest = await readManifestFromDraft(this.draftStore, draft.id);
      const now = this.now().toISOString();
      const generation = HostedIntegrationGenerationSchema.parse({
        id: generationId,
        familyId: draft.familyId,
        sourceRevisionId: draft.sourceRevisionId,
        status: "active",
        promotedAt: now,
        promotedBy: request.promotedBy,
        runtime: manifest?.runtime,
        provenance: buildHostedIntegrationGenerationProvenance({
          draftId: draft.id,
          draftRevisionId: request.draftRevisionId ?? draft.updatedAt,
          promotedBy: request.promotedBy,
          validation: request.validation,
          approval: request.approval,
        }),
      });

      await writeFile(
        path.join(tmpRoot, "metadata.json"),
        `${JSON.stringify(generation, null, 2)}\n`,
        "utf-8",
      );
      await mkdir(this.generationsDir, { recursive: true });
      await rename(tmpRoot, finalRoot);
      await this.writeActivePointer({
        familyId: generation.familyId,
        generationId: generation.id,
        updatedAt: now,
        updatedBy: request.promotedBy,
      });
      return { ok: true, generation };
    } catch (error) {
      await rm(tmpRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async getGeneration(
    generationId: string,
  ): Promise<HostedIntegrationGeneration | null> {
    try {
      return HostedIntegrationGenerationSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.generationRoot(generationId), "metadata.json"),
            "utf-8",
          ),
        ),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async getActiveGeneration(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationGeneration | null> {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.parse(familyId);
    try {
      const pointer = ActiveGenerationPointerSchema.parse(
        JSON.parse(
          await readFile(this.activePointerPath(parsedFamilyId), "utf-8"),
        ),
      );
      return this.getGeneration(pointer.generationId);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
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
    await this.writeActivePointer({
      familyId,
      generationId: generation.id,
      updatedAt: this.now().toISOString(),
      updatedBy: request.rolledBackBy,
    });
    return { ok: true, activeGeneration: generation };
  }

  private async writeActivePointer(
    pointer: z.infer<typeof ActiveGenerationPointerSchema>,
  ) {
    const parsed = ActiveGenerationPointerSchema.parse(pointer);
    await mkdir(this.activeDir, { recursive: true });
    const filePath = this.activePointerPath(parsed.familyId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private generationRoot(generationId: string): string {
    return path.join(
      this.generationsDir,
      safePathSegment("generationId", generationId),
    );
  }

  private activePointerPath(familyId: HostedIntegrationFamilyId): string {
    return path.join(
      this.activeDir,
      `${safePathSegment("familyId", familyId)}.json`,
    );
  }
}

async function readManifestFromDraft(
  draftStore: HostedIntegrationDraftStore,
  draftId: string,
) {
  const manifestFile = await draftStore.readDraftFile({
    draftId,
    path: MANIFEST_FILE,
  });
  if (!manifestFile.ok) return null;
  return FamilyManifestSchema.parse(parseYaml(manifestFile.content));
}
