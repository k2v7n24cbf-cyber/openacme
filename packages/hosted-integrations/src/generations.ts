import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { buildHostedIntegrationGenerationProvenance } from "./approvals.js";
import {
  createFileHostedIntegrationDraftStore,
  type HostedIntegrationDraftStore,
} from "./drafts.js";
import { resolveHostedIntegrationPythonDependencies } from "./dependencies.js";
import {
  isNodeError,
  listFilesUnderRoot,
  readTextFileUnderRoot,
  resolveInsideRoot,
  safePathSegment,
} from "./file-access.js";
import {
  HOSTED_INTEGRATION_MANIFEST_FILE,
  HOSTED_TOOL_CONTRACT_FILE,
} from "./catalog.js";
import {
  FamilyManifestSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationGenerationSchema,
  HostedToolContractDocumentSchema,
  hostedToolContractToToolSpecs,
  type HostedIntegrationFamilyId,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
} from "./schemas.js";
import type { HostedIntegrationValidationResult } from "./validation.js";

const ActiveGenerationPointerSchema = z
  .object({
    familyId: HostedIntegrationFamilyIdSchema,
    generationId: z.string().min(1),
    updatedAt: z.string().datetime({ offset: true }),
    updatedBy: z.string().min(1),
  })
  .strict();
const GenerationStatusStateSchema = z
  .object({
    generationId: z.string().min(1),
    status: z.enum(["active", "draining", "retired", "disabled"]),
    updatedAt: z.string().datetime({ offset: true }),
    updatedBy: z.string().min(1),
  })
  .strict();

export type HostedIntegrationRegistryRefreshEvent =
  | {
      familyId: HostedIntegrationFamilyId;
      generationId: string;
      reason: "promote" | "rollback";
      toolNames: string[];
    }
  | {
      familyId: HostedIntegrationFamilyId;
      reason: "delete";
      toolNames: string[];
    };

export interface FileHostedIntegrationGenerationStoreOptions {
  dataDir: string;
  draftStore?: HostedIntegrationDraftStore;
  now?: () => Date;
  createId?: () => string;
  onRegistryRefresh?: (
    event: HostedIntegrationRegistryRefreshEvent,
  ) => void | Promise<void>;
}

export interface PromoteHostedIntegrationDraftRequest {
  draftId: string;
  promotedBy: string;
  validation: HostedIntegrationValidationResult;
  sourceRevisionId?: string;
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

export interface BeginHostedIntegrationInvocationRequest {
  familyId: HostedIntegrationFamilyId | string;
  generationId?: string;
}

export interface HostedIntegrationInvocationLease {
  id: string;
  familyId: HostedIntegrationFamilyId;
  generationId: string;
  startedAt: string;
}

export type BeginHostedIntegrationInvocationResult =
  | { ok: true; lease: HostedIntegrationInvocationLease }
  | {
      ok: false;
      reason:
        | "no_active_generation"
        | "generation_not_found"
        | "stale_generation";
    };

export interface CompleteHostedIntegrationInvocationRequest {
  leaseId: string;
}

export type ReadHostedIntegrationGenerationFilesResult =
  | { ok: true; files: Record<string, string> }
  | { ok: false; reason: "generation_not_found" };

export interface ListHostedIntegrationGenerationsRequest {
  familyId?: HostedIntegrationFamilyId | string;
}

export interface HostedIntegrationGenerationStore {
  promoteDraft(
    request: PromoteHostedIntegrationDraftRequest,
  ): Promise<PromoteHostedIntegrationDraftResult>;
  listGenerations(
    request?: ListHostedIntegrationGenerationsRequest,
  ): Promise<HostedIntegrationGeneration[]>;
  getGeneration(
    generationId: string,
  ): Promise<HostedIntegrationGeneration | null>;
  readGenerationFiles(
    generationId: string,
  ): Promise<ReadHostedIntegrationGenerationFilesResult>;
  getActiveGeneration(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationGeneration | null>;
  disableActiveGeneration(
    familyId: HostedIntegrationFamilyId | string,
    updatedBy: string,
  ): Promise<HostedIntegrationGeneration | null>;
  beginInvocation(
    request: BeginHostedIntegrationInvocationRequest,
  ): Promise<BeginHostedIntegrationInvocationResult>;
  completeInvocation(
    request: CompleteHostedIntegrationInvocationRequest,
  ): Promise<void>;
  getInflightInvocationCount(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<number>;
  hasInflightInvocations(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<boolean>;
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
    onRegistryRefresh: options.onRegistryRefresh ?? (() => {}),
  });
}

class FileHostedIntegrationGenerationStore implements HostedIntegrationGenerationStore {
  private readonly generationsDir: string;
  private readonly activeDir: string;
  private readonly draftStore: HostedIntegrationDraftStore;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly onRegistryRefresh: (
    event: HostedIntegrationRegistryRefreshEvent,
  ) => void | Promise<void>;
  private readonly inflightByGeneration = new Map<string, number>();
  private readonly leaseToGeneration = new Map<string, string>();

  constructor(parts: {
    dataDir: string;
    draftStore: HostedIntegrationDraftStore;
    now: () => Date;
    createId: () => string;
    onRegistryRefresh: (
      event: HostedIntegrationRegistryRefreshEvent,
    ) => void | Promise<void>;
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
    this.onRegistryRefresh = parts.onRegistryRefresh;
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
    const previousActive = await this.getActiveGeneration(draft.familyId);
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
      const toolContract = await readToolContractFromDraft(
        this.draftStore,
        draft.id,
      );
      if (!manifest || !toolContract) {
        await rm(tmpRoot, { recursive: true, force: true });
        return { ok: false, reason: "invalid_validation" };
      }
      const tools = hostedToolContractToToolSpecs(toolContract);
      const dependencyResolution = resolveHostedIntegrationPythonDependencies(
        manifest.runtime,
      );
      if (dependencyResolution && !dependencyResolution.ok) {
        await rm(tmpRoot, { recursive: true, force: true });
        return { ok: false, reason: "invalid_validation" };
      }
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
        tools,
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

      await writeFile(
        path.join(tmpRoot, "metadata.json"),
        `${JSON.stringify(generation, null, 2)}\n`,
        "utf-8",
      );
      await mkdir(this.generationsDir, { recursive: true });
      await rename(tmpRoot, finalRoot);
      await this.writeGenerationStatus({
        generationId: generation.id,
        status: "active",
        updatedAt: now,
        updatedBy: request.promotedBy,
      });
      if (previousActive && previousActive.id !== generation.id) {
        await this.writeRetirementStatus(previousActive.id, request.promotedBy);
      }
      await this.writeActivePointer({
        familyId: generation.familyId,
        generationId: generation.id,
        updatedAt: now,
        updatedBy: request.promotedBy,
      });
      await this.onRegistryRefresh({
        familyId: generation.familyId,
        generationId: generation.id,
        reason: "promote",
        toolNames: tools.map((tool) => tool.name),
      });
      return { ok: true, generation };
    } catch (error) {
      await rm(tmpRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async listGenerations(
    request: ListHostedIntegrationGenerationsRequest = {},
  ): Promise<HostedIntegrationGeneration[]> {
    const familyId =
      request.familyId === undefined
        ? null
        : HostedIntegrationFamilyIdSchema.parse(request.familyId);
    let entries;
    try {
      entries = await readdir(this.generationsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const generations: HostedIntegrationGeneration[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === "active" ||
        entry.name === "state" ||
        entry.name.endsWith(".tmp")
      ) {
        continue;
      }
      const generation = await this.getGeneration(entry.name);
      if (!generation) continue;
      if (familyId && generation.familyId !== familyId) continue;
      generations.push(generation);
    }

    return generations.sort((a, b) => {
      const byPromotedAt = b.promotedAt.localeCompare(a.promotedAt);
      return byPromotedAt === 0 ? b.id.localeCompare(a.id) : byPromotedAt;
    });
  }

  async getGeneration(
    generationId: string,
  ): Promise<HostedIntegrationGeneration | null> {
    try {
      const generation = HostedIntegrationGenerationSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.generationRoot(generationId), "metadata.json"),
            "utf-8",
          ),
        ),
      );
      const status = await this.readGenerationStatus(generation.id);
      return status ? { ...generation, status: status.status } : generation;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async readGenerationFiles(
    generationId: string,
  ): Promise<ReadHostedIntegrationGenerationFilesResult> {
    const generation = await this.getGeneration(generationId);
    if (!generation) return { ok: false, reason: "generation_not_found" };
    const filesRoot = path.join(this.generationRoot(generation.id), "files");
    try {
      const entries = await listFilesUnderRoot(filesRoot);
      const files: Record<string, string> = {};
      for (const entry of entries) {
        files[entry.path] = await readTextFileUnderRoot(
          filesRoot,
          entry.path,
          "generation files root",
        );
      }
      return { ok: true, files };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { ok: false, reason: "generation_not_found" };
      }
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

  async disableActiveGeneration(
    familyId: HostedIntegrationFamilyId | string,
    updatedBy: string,
  ): Promise<HostedIntegrationGeneration | null> {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.parse(familyId);
    const generation = await this.getActiveGeneration(parsedFamilyId);
    if (!generation) return null;
    await this.writeGenerationStatus({
      generationId: generation.id,
      status: "disabled",
      updatedAt: this.now().toISOString(),
      updatedBy,
    });
    await rm(this.activePointerPath(parsedFamilyId), { force: true });
    return (await this.getGeneration(generation.id)) ?? {
      ...generation,
      status: "disabled",
    };
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

    const lease: HostedIntegrationInvocationLease = {
      id: `lease_${randomUUID()}`,
      familyId,
      generationId: generation.id,
      startedAt: this.now().toISOString(),
    };
    this.leaseToGeneration.set(lease.id, lease.generationId);
    this.inflightByGeneration.set(
      lease.generationId,
      (this.inflightByGeneration.get(lease.generationId) ?? 0) + 1,
    );
    return { ok: true, lease };
  }

  async completeInvocation(
    request: CompleteHostedIntegrationInvocationRequest,
  ): Promise<void> {
    const generationId = this.leaseToGeneration.get(request.leaseId);
    if (!generationId) return;
    this.leaseToGeneration.delete(request.leaseId);
    const nextCount = Math.max(
      0,
      (this.inflightByGeneration.get(generationId) ?? 0) - 1,
    );
    if (nextCount === 0) {
      this.inflightByGeneration.delete(generationId);
      const state = await this.readGenerationStatus(generationId);
      if (state?.status === "draining") {
        await this.writeGenerationStatus({
          generationId,
          status: "retired",
          updatedAt: this.now().toISOString(),
          updatedBy: "system:draining",
        });
      }
      return;
    }
    this.inflightByGeneration.set(generationId, nextCount);
  }

  async hasInflightInvocations(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<boolean> {
    return (await this.getInflightInvocationCount(familyId)) > 0;
  }

  async getInflightInvocationCount(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<number> {
    const generations = await this.listGenerations({ familyId });
    return generations.reduce(
      (count, generation) =>
        count + (this.inflightByGeneration.get(generation.id) ?? 0),
      0,
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
    await this.writeGenerationStatus({
      generationId: generation.id,
      status: "active",
      updatedAt: now,
      updatedBy: request.rolledBackBy,
    });
    if (previousActive && previousActive.id !== generation.id) {
      await this.writeRetirementStatus(previousActive.id, request.rolledBackBy);
    }
    await this.writeActivePointer({
      familyId,
      generationId: generation.id,
      updatedAt: now,
      updatedBy: request.rolledBackBy,
    });
    await this.onRegistryRefresh({
      familyId,
      generationId: generation.id,
      reason: "rollback",
      toolNames: await this.readGenerationToolNames(generation.id),
    });
    return {
      ok: true,
      activeGeneration: (await this.getGeneration(generation.id)) ?? {
        ...generation,
        status: "active",
      },
    };
  }

  private async writeRetirementStatus(
    generationId: string,
    updatedBy: string,
  ): Promise<void> {
    await this.writeGenerationStatus({
      generationId,
      status:
        (this.inflightByGeneration.get(generationId) ?? 0) > 0
          ? "draining"
          : "retired",
      updatedAt: this.now().toISOString(),
      updatedBy,
    });
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

  private async writeGenerationStatus(
    state: z.infer<typeof GenerationStatusStateSchema>,
  ): Promise<void> {
    const parsed = GenerationStatusStateSchema.parse(state);
    await mkdir(this.stateDir(), { recursive: true });
    const filePath = this.generationStatusPath(parsed.generationId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private async readGenerationStatus(generationId: string) {
    try {
      return GenerationStatusStateSchema.parse(
        JSON.parse(
          await readFile(this.generationStatusPath(generationId), "utf-8"),
        ),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async readGenerationToolNames(
    generationId: string,
  ): Promise<string[]> {
    const manifestFile = await readFile(
      resolveInsideRoot(
        path.join(this.generationRoot(generationId), "files"),
        HOSTED_TOOL_CONTRACT_FILE,
        "generation files root",
      ),
      "utf-8",
    );
    return hostedToolContractToToolSpecs(
      HostedToolContractDocumentSchema.parse(parseYaml(manifestFile)),
    ).map(
      (tool) => tool.name,
    );
  }

  private stateDir(): string {
    return path.join(this.generationsDir, "state");
  }

  private generationStatusPath(generationId: string): string {
    return path.join(
      this.stateDir(),
      `${safePathSegment("generationId", generationId)}.json`,
    );
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
    path: HOSTED_INTEGRATION_MANIFEST_FILE,
  });
  if (!manifestFile.ok) return null;
  return FamilyManifestSchema.parse(parseYaml(manifestFile.content));
}

async function readToolContractFromDraft(
  draftStore: HostedIntegrationDraftStore,
  draftId: string,
) {
  const toolContractFile = await draftStore.readDraftFile({
    draftId,
    path: HOSTED_TOOL_CONTRACT_FILE,
  });
  if (!toolContractFile.ok) return null;
  return HostedToolContractDocumentSchema.parse(parseYaml(toolContractFile.content));
}
