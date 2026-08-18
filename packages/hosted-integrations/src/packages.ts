import { createHash } from "node:crypto";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  HOSTED_INTEGRATION_MANIFEST_FILE,
  HOSTED_TOOL_CONTRACT_FILE,
  type HostedIntegrationCatalog,
} from "./catalog.js";
import type {
  CreateHostedIntegrationDraftRequest,
  CreateHostedIntegrationDraftResult,
  CreateHostedIntegrationDraftFromFilesRequest,
  DeleteHostedIntegrationDraftFileRequest,
  DeleteHostedIntegrationDraftFileResult,
  HostedIntegrationDraftStore,
  ListHostedIntegrationDraftFilesResult,
  ReadHostedIntegrationDraftFileRequest,
  ReadHostedIntegrationDraftFileResult,
  WriteHostedIntegrationDraftFileRequest,
  WriteHostedIntegrationDraftFileResult,
} from "./drafts.js";
import type { HostedIntegrationLockStore } from "./locks.js";
import type {
  HostedIntegrationProposedFamilyManager,
  HostedIntegrationProposedFamilySummary,
} from "./proposed-family.js";
import type { HostedIntegrationGenerationStore } from "./generations.js";
import type { HostedIntegrationSourceFileStore } from "./source-files.js";
import {
  createFileHostedIntegrationDraftValidator,
  type HostedIntegrationValidationDiagnostic,
  type HostedIntegrationValidationResult,
} from "./validation.js";
import {
  FamilyManifestSchema,
  HostedIntegrationDraftSchema,
  HostedIntegrationExampleSchema,
  HostedIntegrationFamilyIdSchema,
  HostedToolContractDocumentSchema,
  type HostedIntegrationDraft,
  type HostedIntegrationFamilyId,
  type HostedIntegrationFamilyLock,
} from "./schemas.js";

export const HOSTED_FAMILY_PACKAGE_KIND = "openacme.hostedFamilyPackage";
export const HOSTED_FAMILY_PACKAGE_VERSION = 1;
export const HOSTED_FAMILY_PACKAGE_DEFAULT_MAX_FILE_BYTES = 256 * 1024;
export const HOSTED_FAMILY_PACKAGE_DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const EXAMPLES_FILE = "examples.yaml";

const ExamplesDocumentSchema = z
  .object({
    examples: z.array(HostedIntegrationExampleSchema).default([]),
  })
  .strict();

export const HostedFamilyPackageFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();
export type HostedFamilyPackageFile = z.infer<
  typeof HostedFamilyPackageFileSchema
>;

export const HostedFamilyPackageMetadataSchema = z
  .object({
    familyId: HostedIntegrationFamilyIdSchema.optional(),
    sourceRevisionId: z.string().min(1).optional(),
    sourceGenerationId: z.string().min(1).optional(),
    sourceDraftId: z.string().min(1).optional(),
    exportedBy: z.string().min(1).optional(),
    exportedAt: z.string().min(1).optional(),
    digest: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export type HostedFamilyPackageMetadata = z.infer<
  typeof HostedFamilyPackageMetadataSchema
>;

export const HostedFamilyPackageDocumentSchema = z
  .object({
    kind: z.literal(HOSTED_FAMILY_PACKAGE_KIND),
    version: z.literal(HOSTED_FAMILY_PACKAGE_VERSION),
    metadata: HostedFamilyPackageMetadataSchema,
    files: z.array(HostedFamilyPackageFileSchema).min(1),
  })
  .strict();
export type HostedFamilyPackageDocument = z.infer<
  typeof HostedFamilyPackageDocumentSchema
>;

export interface NormalizedHostedFamilyPackage {
  kind: typeof HOSTED_FAMILY_PACKAGE_KIND;
  version: typeof HOSTED_FAMILY_PACKAGE_VERSION;
  metadata: HostedFamilyPackageMetadata;
  files: Record<string, string>;
  fileEntries: HostedFamilyPackageFile[];
  digest: string;
}

export interface HostedFamilyPackageValidationOptions {
  targetFamilyId?: HostedIntegrationFamilyId | string;
  catalog?: HostedIntegrationCatalog;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  helpQualityMode?: "warning" | "error";
}

export interface HostedFamilyPackageValidationResult
  extends HostedIntegrationValidationResult {
  package?: NormalizedHostedFamilyPackage;
}

export interface ImportHostedFamilyPackageRequest {
  mode: "create" | "update";
  packageDocument: unknown;
  importedBy: string;
  targetFamilyId?: HostedIntegrationFamilyId | string;
  lockId?: string;
  ttlMs?: number;
  sourceRevisionId?: string;
}

export interface ValidateHostedFamilyPackageRequest {
  packageDocument: unknown;
  targetFamilyId?: HostedIntegrationFamilyId | string;
}

export type ImportHostedFamilyPackageResult =
  | {
      ok: true;
      mode: "create" | "update";
      family: HostedIntegrationProposedFamilySummary | null;
      lock: HostedIntegrationFamilyLock | null;
      draft: HostedIntegrationDraft;
      sourceRevisionId: string;
      validation: HostedIntegrationValidationResult;
      importedFiles: string[];
      importedExamples: string[];
      digest: string;
      nextAction: "fix_validation" | "run_examples";
    }
  | {
      ok: false;
      error: {
        code:
          | "invalid_package"
          | "duplicate_family"
          | "lock_required"
          | "lock_conflict"
          | "family_not_found"
          | "package_target_family_mismatch";
        message?: string;
      };
      diagnostics?: HostedIntegrationValidationDiagnostic[];
      lock?: HostedIntegrationFamilyLock;
    };

export interface HostedFamilyPackageManager {
  validatePackage(
    request: ValidateHostedFamilyPackageRequest,
  ): Promise<HostedFamilyPackageValidationResult>;
  importPackage(
    request: ImportHostedFamilyPackageRequest,
  ): Promise<ImportHostedFamilyPackageResult>;
  exportPackage(
    request: ExportHostedFamilyPackageRequest,
  ): Promise<ExportHostedFamilyPackageResult>;
}

export interface HostedFamilyPackageManagerOptions {
  catalog: HostedIntegrationCatalog;
  locks: HostedIntegrationLockStore;
  drafts: HostedIntegrationDraftStore;
  sourceFiles: HostedIntegrationSourceFileStore;
  generations: HostedIntegrationGenerationStore;
  validator: {
    validateDraft(draftId: string): Promise<HostedIntegrationValidationResult>;
  };
  proposedFamilies: HostedIntegrationProposedFamilyManager;
  now?: () => Date;
}

export type ExportHostedFamilyPackageSource =
  | { type: "active_generation"; familyId: HostedIntegrationFamilyId | string }
  | { type: "generation"; generationId: string }
  | { type: "draft"; draftId: string }
  | { type: "current_source"; familyId: HostedIntegrationFamilyId | string };

export interface ExportHostedFamilyPackageRequest {
  source: ExportHostedFamilyPackageSource;
  exportedBy: string;
  includeExamples?: boolean;
}

export type ExportHostedFamilyPackageResult =
  | {
      ok: true;
      packageDocument: HostedFamilyPackageDocument;
      source: ExportHostedFamilyPackageSource;
      exportedFiles: string[];
      digest: string;
    }
  | {
      ok: false;
      error: {
        code:
          | "family_not_found"
          | "generation_not_found"
          | "draft_not_found"
          | "source_not_found"
          | "invalid_package";
        message?: string;
      };
      diagnostics?: HostedIntegrationValidationDiagnostic[];
    };

export function parseHostedFamilyPackageDocument(
  input: unknown,
): HostedFamilyPackageDocument {
  return HostedFamilyPackageDocumentSchema.parse(input);
}

export function createHostedFamilyPackageManager(
  options: HostedFamilyPackageManagerOptions,
): HostedFamilyPackageManager {
  return new DefaultHostedFamilyPackageManager(options);
}

export async function validateHostedFamilyPackage(
  input: unknown,
  options: HostedFamilyPackageValidationOptions = {},
): Promise<HostedFamilyPackageValidationResult> {
  const normalized = normalizeHostedFamilyPackage(input, options);
  if (!normalized.ok) return normalized;
  const packageDocument = normalized.package;
  if (!packageDocument) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic(
          "package_invalid",
          "$",
          "package normalization did not produce a package document",
        ),
      ],
    };
  }

  const diagnostics = [...normalized.diagnostics];
  const packageFamilyId = packageFamilyIdFromFiles(packageDocument.files);
  if (packageFamilyId) {
    if (
      packageDocument.metadata.familyId &&
      packageDocument.metadata.familyId !== packageFamilyId.manifestFamilyId
    ) {
      diagnostics.push(
        errorDiagnostic(
          "package_family_mismatch",
          "$.metadata.familyId",
          `package metadata family ${packageDocument.metadata.familyId} does not match manifest ${packageFamilyId.manifestFamilyId}`,
        ),
      );
    }
    if (packageFamilyId.toolContractFamilyId !== packageFamilyId.manifestFamilyId) {
      diagnostics.push(
        errorDiagnostic(
          "package_family_mismatch",
          `$.files.${HOSTED_TOOL_CONTRACT_FILE}.family.id`,
          `${HOSTED_TOOL_CONTRACT_FILE} family ${packageFamilyId.toolContractFamilyId} does not match manifest ${packageFamilyId.manifestFamilyId}`,
        ),
      );
    }
    const targetFamilyId = options.targetFamilyId
      ? HostedIntegrationFamilyIdSchema.safeParse(options.targetFamilyId)
      : null;
    if (
      targetFamilyId?.success &&
      targetFamilyId.data !== packageFamilyId.manifestFamilyId
    ) {
      diagnostics.push(
        errorDiagnostic(
          "package_target_family_mismatch",
          "$.targetFamilyId",
          `target family ${targetFamilyId.data} does not match package family ${packageFamilyId.manifestFamilyId}`,
        ),
      );
    }
  }

  const familyId =
    packageFamilyId?.manifestFamilyId ??
    packageDocument.metadata.familyId ??
    "package";
  const validator = createFileHostedIntegrationDraftValidator({
    draftStore: new InMemoryPackageDraftStore(familyId, packageDocument.files),
    catalog: options.catalog ?? EMPTY_HOSTED_INTEGRATION_CATALOG,
    helpQualityMode: options.helpQualityMode ?? "warning",
  });
  const draftValidation = await validator.validateDraft(PACKAGE_DRAFT_ID);
  diagnostics.push(...draftValidation.diagnostics);

  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    package: packageDocument,
  };
}

export function normalizeHostedFamilyPackage(
  input: unknown,
  options: HostedFamilyPackageValidationOptions,
): HostedFamilyPackageValidationResult {
  const diagnostics: HostedIntegrationValidationDiagnostic[] = [];
  const parsed = HostedFamilyPackageDocumentSchema.safeParse(input);
  if (!parsed.success) {
    diagnostics.push(...zodDiagnostics("package_invalid", parsed.error));
    return { ok: false, diagnostics };
  }

  const maxFileBytes =
    options.maxFileBytes ?? HOSTED_FAMILY_PACKAGE_DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes =
    options.maxTotalBytes ?? HOSTED_FAMILY_PACKAGE_DEFAULT_MAX_TOTAL_BYTES;
  const files = new Map<string, string>();
  let totalBytes = 0;

  parsed.data.files.forEach((file, index) => {
    const normalizedPath = normalizePackagePath(file.path);
    if (!normalizedPath.ok) {
      diagnostics.push(
        errorDiagnostic(
          normalizedPath.code,
          `$.files.${index}.path`,
          normalizedPath.message,
        ),
      );
      return;
    }
    const size = Buffer.byteLength(file.content, "utf-8");
    totalBytes += size;
    if (size > maxFileBytes) {
      diagnostics.push(
        errorDiagnostic(
          "package_file_too_large",
          `$.files.${index}.content`,
          `file ${normalizedPath.path} exceeds ${maxFileBytes} bytes`,
        ),
      );
    }
    if (containsUnsupportedText(file.content)) {
      diagnostics.push(
        errorDiagnostic(
          "package_file_binary",
          `$.files.${index}.content`,
          `file ${normalizedPath.path} contains unsupported binary content`,
        ),
      );
    }
    if (files.has(normalizedPath.path)) {
      diagnostics.push(
        errorDiagnostic(
          "package_file_duplicate",
          `$.files.${index}.path`,
          `file path ${normalizedPath.path} is duplicated after normalization`,
        ),
      );
      return;
    }
    files.set(normalizedPath.path, file.content);
  });

  if (totalBytes > maxTotalBytes) {
    diagnostics.push(
      errorDiagnostic(
        "package_too_large",
        "$.files",
        `package exceeds ${maxTotalBytes} bytes`,
      ),
    );
  }
  for (const requiredPath of [
    HOSTED_INTEGRATION_MANIFEST_FILE,
    HOSTED_TOOL_CONTRACT_FILE,
  ]) {
    if (!files.has(requiredPath)) {
      diagnostics.push(
        errorDiagnostic(
          "package_required_file_missing",
          `$.files.${requiredPath}`,
          `${requiredPath} is required`,
        ),
      );
    }
  }

  const manifest = parseRequiredYamlFile(
    files,
    HOSTED_INTEGRATION_MANIFEST_FILE,
    FamilyManifestSchema,
    "package_manifest",
    diagnostics,
  );
  parseRequiredYamlFile(
    files,
    HOSTED_TOOL_CONTRACT_FILE,
    HostedToolContractDocumentSchema,
    "package_tool_contract",
    diagnostics,
  );
  parseOptionalYamlFile(
    files,
    EXAMPLES_FILE,
    ExamplesDocumentSchema,
    "package_examples",
    diagnostics,
  );
  if (manifest && !files.has(manifest.runtime.entrypoint)) {
    diagnostics.push(
      errorDiagnostic(
        "package_required_file_missing",
        `$.files.${manifest.runtime.entrypoint}`,
        `runtime entrypoint ${manifest.runtime.entrypoint} is required`,
      ),
    );
  }

  const normalizedFiles = Object.fromEntries(
    [...files.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const fileEntries = Object.entries(normalizedFiles).map(([filePath, content]) => ({
    path: filePath,
    content,
  }));
  const normalizedPackage: NormalizedHostedFamilyPackage = {
    kind: HOSTED_FAMILY_PACKAGE_KIND,
    version: HOSTED_FAMILY_PACKAGE_VERSION,
    metadata: parsed.data.metadata,
    files: normalizedFiles,
    fileEntries,
    digest: buildHostedFamilyPackageDigest(normalizedFiles),
  };

  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    package: normalizedPackage,
  };
}

class DefaultHostedFamilyPackageManager implements HostedFamilyPackageManager {
  constructor(private readonly options: HostedFamilyPackageManagerOptions) {}

  validatePackage(
    request: ValidateHostedFamilyPackageRequest,
  ): Promise<HostedFamilyPackageValidationResult> {
    return validateHostedFamilyPackage(request.packageDocument, {
      targetFamilyId: request.targetFamilyId,
      catalog: this.options.catalog,
    });
  }

  async importPackage(
    request: ImportHostedFamilyPackageRequest,
  ): Promise<ImportHostedFamilyPackageResult> {
    const normalized = normalizeHostedFamilyPackage(request.packageDocument, {
      targetFamilyId: request.targetFamilyId,
      catalog: this.options.catalog,
    });
    if (!normalized.ok || !normalized.package) {
      return {
        ok: false,
        error: { code: "invalid_package" },
        diagnostics: normalized.diagnostics,
      };
    }

    const summary = packageSummary(normalized.package);
    if (!summary.ok) {
      return {
        ok: false,
        error: { code: "invalid_package" },
        diagnostics: summary.diagnostics,
      };
    }
    if (
      request.targetFamilyId &&
      request.targetFamilyId !== summary.familyId
    ) {
      return {
        ok: false,
        error: { code: "package_target_family_mismatch" },
        diagnostics: [
          errorDiagnostic(
            "package_target_family_mismatch",
            "$.targetFamilyId",
            `target family ${request.targetFamilyId} does not match package family ${summary.familyId}`,
          ),
        ],
      };
    }

    if (request.mode === "create") {
      return this.importNewFamily(request, normalized.package, summary);
    }
    return this.importExistingFamily(request, normalized.package, summary);
  }

  async exportPackage(
    request: ExportHostedFamilyPackageRequest,
  ): Promise<ExportHostedFamilyPackageResult> {
    const sourceFiles = await this.readExportSourceFiles(request.source);
    if (!sourceFiles.ok) {
      return { ok: false, error: { code: sourceFiles.reason } };
    }
    const files =
      request.includeExamples === false
        ? withoutExamples(sourceFiles.files)
        : sourceFiles.files;
    const normalized = normalizeHostedFamilyPackage(
      {
        kind: HOSTED_FAMILY_PACKAGE_KIND,
        version: HOSTED_FAMILY_PACKAGE_VERSION,
        metadata: {},
        files: Object.entries(files).map(([filePath, content]) => ({
          path: filePath,
          content,
        })),
      },
      {},
    );
    if (!normalized.ok || !normalized.package) {
      return {
        ok: false,
        error: { code: "invalid_package" },
        diagnostics: normalized.diagnostics,
      };
    }
    const summary = packageSummary(normalized.package);
    if (!summary.ok) {
      return {
        ok: false,
        error: { code: "invalid_package" },
        diagnostics: summary.diagnostics,
      };
    }
    const packageDocument: HostedFamilyPackageDocument = {
      kind: HOSTED_FAMILY_PACKAGE_KIND,
      version: HOSTED_FAMILY_PACKAGE_VERSION,
      metadata: {
        familyId: summary.familyId,
        exportedBy: request.exportedBy,
        exportedAt: (this.options.now ?? (() => new Date()))().toISOString(),
        digest: normalized.package.digest,
        ...sourceMetadata(sourceFiles),
      },
      files: normalized.package.fileEntries,
    };
    return {
      ok: true,
      packageDocument,
      source: request.source,
      exportedFiles: normalized.package.fileEntries.map((file) => file.path),
      digest: normalized.package.digest,
    };
  }

  private async importNewFamily(
    request: ImportHostedFamilyPackageRequest,
    normalizedPackage: NormalizedHostedFamilyPackage,
    summary: HostedFamilyPackageSummary,
  ): Promise<ImportHostedFamilyPackageResult> {
    const created =
      await this.options.proposedFamilies.createProposedFamilyFromFiles({
        familyId: summary.familyId,
        name: summary.name,
        version: summary.version,
        toolNames: summary.toolNames,
        files: normalizedPackage.files,
        lockedBy: request.importedBy,
        ttlMs: request.ttlMs ?? 30 * 60 * 1000,
        sourceRevisionId:
          request.sourceRevisionId ??
          normalizedPackage.metadata.sourceRevisionId ??
          "package_import_initial",
      });
    if (!created.ok) {
      return {
        ok: false,
        error: {
          code:
            created.reason === "duplicate_family"
              ? "duplicate_family"
              : "lock_required",
        },
      };
    }
    const validation = await this.options.validator.validateDraft(
      created.draft.id,
    );
    return packageImportSuccess({
      mode: "create",
      family: created.family,
      lock: created.lock,
      draft: created.draft,
      sourceRevisionId: created.sourceRevisionId,
      validation,
      normalizedPackage,
    });
  }

  private async importExistingFamily(
    request: ImportHostedFamilyPackageRequest,
    normalizedPackage: NormalizedHostedFamilyPackage,
    summary: HostedFamilyPackageSummary,
  ): Promise<ImportHostedFamilyPackageResult> {
    const familyId = summary.familyId;
    const existingFamily = await this.options.catalog.getFamily(familyId);
    const activeGeneration = existingFamily
      ? null
      : (await this.options.generations.listGenerations()).find(
          (generation) =>
            generation.familyId === familyId && generation.status === "active",
        );
    if (!existingFamily && !activeGeneration) {
      return { ok: false, error: { code: "family_not_found" } };
    }
    const activeLock = await this.options.locks.getActiveLock(familyId);
    if (!activeLock || !request.lockId || activeLock.id !== request.lockId) {
      return {
        ok: false,
        error: { code: "lock_required" },
        lock: activeLock ?? undefined,
      };
    }
    if (activeLock.lockedBy !== request.importedBy) {
      return {
        ok: false,
        error: { code: "lock_conflict" },
        lock: activeLock,
      };
    }

    const sourceRevisionId =
      request.sourceRevisionId ??
      normalizedPackage.metadata.sourceRevisionId ??
      activeGeneration?.sourceRevisionId ??
      `package_import_from_${familyId}`;
    const draftResult = await this.options.drafts.createDraftFromFiles({
      familyId,
      lockId: activeLock.id,
      sourceRevisionId,
      files: normalizedPackage.files,
    });
    if (!draftResult.ok) {
      return {
        ok: false,
        error: { code: "lock_required" },
        lock: activeLock,
      };
    }
    const validation = await this.options.validator.validateDraft(
      draftResult.draft.id,
    );
    return packageImportSuccess({
      mode: "update",
      family: null,
      lock: activeLock,
      draft: draftResult.draft,
      sourceRevisionId,
      validation,
      normalizedPackage,
    });
  }

  private async readExportSourceFiles(
    source: ExportHostedFamilyPackageSource,
  ): Promise<
    | {
        ok: true;
        files: Record<string, string>;
        sourceRevisionId?: string;
        sourceGenerationId?: string;
        sourceDraftId?: string;
      }
    | {
        ok: false;
        reason:
          | "family_not_found"
          | "generation_not_found"
          | "draft_not_found"
          | "source_not_found";
      }
  > {
    if (source.type === "draft") {
      const listed = await this.options.drafts.listDraftFiles(source.draftId);
      if (!listed.ok) return { ok: false, reason: "draft_not_found" };
      const files: Record<string, string> = {};
      for (const file of listed.files) {
        const read = await this.options.drafts.readDraftFile({
          draftId: source.draftId,
          path: file.path,
        });
        if (!read.ok) return { ok: false, reason: "draft_not_found" };
        files[file.path] = read.content;
      }
      return { ok: true, files, sourceDraftId: source.draftId };
    }
    if (source.type === "current_source") {
      return this.readCurrentSourceFiles(source.familyId);
    }
    const generation =
      source.type === "active_generation"
        ? await this.options.generations.getActiveGeneration(source.familyId)
        : await this.options.generations.getGeneration(source.generationId);
    if (!generation) return { ok: false, reason: "generation_not_found" };
    const files = await this.options.generations.readGenerationFiles(
      generation.id,
    );
    if (!files.ok) return { ok: false, reason: "generation_not_found" };
    return {
      ok: true,
      files: files.files,
      sourceGenerationId: generation.id,
      sourceRevisionId: generation.sourceRevisionId,
    };
  }

  private async readCurrentSourceFiles(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<
    | { ok: true; files: Record<string, string>; sourceRevisionId?: string }
    | { ok: false; reason: "family_not_found" | "source_not_found" }
  > {
    const family = await this.options.catalog.getFamily(familyId);
    if (!family) return { ok: false, reason: "family_not_found" };
    const listed = await this.options.sourceFiles.listSourceFiles(
      family.summary.id,
    );
    if (!listed.ok) return { ok: false, reason: "source_not_found" };
    const files: Record<string, string> = {};
    for (const file of listed.files) {
      const read = await this.options.sourceFiles.readSourceFile({
        familyId: family.summary.id,
        path: file.path,
      });
      if (!read.ok) return { ok: false, reason: "source_not_found" };
      files[file.path] = read.content;
    }
    return {
      ok: true,
      files,
      sourceRevisionId:
        (await this.options.sourceFiles.getCurrentSourceRevisionId(
          family.summary.id,
        )) ?? undefined,
    };
  }
}

interface HostedFamilyPackageSummary {
  familyId: HostedIntegrationFamilyId;
  name: string;
  version: number;
  toolNames: string[];
}

function packageSummary(
  normalizedPackage: NormalizedHostedFamilyPackage,
):
  | ({ ok: true } & HostedFamilyPackageSummary)
  | { ok: false; diagnostics: HostedIntegrationValidationDiagnostic[] } {
  const fileMap = new Map(Object.entries(normalizedPackage.files));
  const diagnostics: HostedIntegrationValidationDiagnostic[] = [];
  const manifest = parseRequiredYamlFile(
    fileMap,
    HOSTED_INTEGRATION_MANIFEST_FILE,
    FamilyManifestSchema,
    "package_manifest",
    diagnostics,
  );
  const contract = parseRequiredYamlFile(
    fileMap,
    HOSTED_TOOL_CONTRACT_FILE,
    HostedToolContractDocumentSchema,
    "package_tool_contract",
    diagnostics,
  );
  if (!manifest || !contract) {
    return {
      ok: false,
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [
              errorDiagnostic(
                "package_invalid",
                "$",
                "package summary requires valid family.yaml and tools.yaml",
              ),
            ],
    };
  }
  return {
    ok: true,
    familyId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    toolNames: contract.tools.map((tool) => tool.openacme.toolName),
  };
}

function packageImportSuccess(input: {
  mode: "create" | "update";
  family: HostedIntegrationProposedFamilySummary | null;
  lock: HostedIntegrationFamilyLock | null;
  draft: HostedIntegrationDraft;
  sourceRevisionId: string;
  validation: HostedIntegrationValidationResult;
  normalizedPackage: NormalizedHostedFamilyPackage;
}): ImportHostedFamilyPackageResult {
  return {
    ok: true,
    mode: input.mode,
    family: input.family,
    lock: input.lock,
    draft: input.draft,
    sourceRevisionId: input.sourceRevisionId,
    validation: input.validation,
    importedFiles: Object.keys(input.normalizedPackage.files).sort(),
    importedExamples:
      input.normalizedPackage.files[EXAMPLES_FILE] === undefined
        ? []
        : [EXAMPLES_FILE],
    digest: input.normalizedPackage.digest,
    nextAction: input.validation.ok ? "run_examples" : "fix_validation",
  };
}

function withoutExamples(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).filter(([filePath]) => filePath !== EXAMPLES_FILE),
  );
}

function sourceMetadata(input: {
  sourceRevisionId?: string;
  sourceGenerationId?: string;
  sourceDraftId?: string;
}): Partial<HostedFamilyPackageMetadata> {
  return {
    ...(input.sourceRevisionId ? { sourceRevisionId: input.sourceRevisionId } : {}),
    ...(input.sourceGenerationId
      ? { sourceGenerationId: input.sourceGenerationId }
      : {}),
    ...(input.sourceDraftId ? { sourceDraftId: input.sourceDraftId } : {}),
  };
}

export function buildHostedFamilyPackageDigest(
  files: Record<string, string>,
): string {
  const normalizedFiles = Object.entries(files)
    .map(([filePath, content]) => {
      const normalizedPath = normalizePackagePath(filePath);
      if (!normalizedPath.ok) {
        throw new Error(normalizedPath.message);
      }
      return [normalizedPath.path, content] as const;
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      kind: HOSTED_FAMILY_PACKAGE_KIND,
      version: HOSTED_FAMILY_PACKAGE_VERSION,
      files: normalizedFiles,
    }),
  );
  return `sha256:${hash.digest("hex")}`;
}

function normalizePackagePath(
  input: string,
):
  | { ok: true; path: string }
  | { ok: false; code: string; message: string } {
  if (!input || path.isAbsolute(input) || input.includes("\\")) {
    return {
      ok: false,
      code: "package_file_path_invalid",
      message: `package file path ${input || "<empty>"} must be a relative POSIX path`,
    };
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized)
  ) {
    return {
      ok: false,
      code: "package_file_path_invalid",
      message: `package file path ${input} escapes the package root`,
    };
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return {
      ok: false,
      code: "package_file_path_invalid",
      message: `package file path ${input} escapes the package root`,
    };
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return {
      ok: false,
      code: "package_file_path_hidden",
      message: `package file path ${input} targets a hidden host file`,
    };
  }
  const operationalRoot = operationalPackagePathRoot(segments);
  if (operationalRoot) {
    return {
      ok: false,
      code: "package_file_path_operational",
      message: `package file path ${input} targets operational ${operationalRoot} data, not hosted source`,
    };
  }
  return { ok: true, path: normalized };
}

function operationalPackagePathRoot(segments: string[]): string | null {
  const [root] = segments;
  if (!root) return null;
  return [
    "artifacts",
    "execution-logs",
    "failure-buckets",
    "logs",
    "run-artifacts",
    "runs",
    "tmp",
    "workspace",
  ].includes(root)
    ? root
    : null;
}

function containsUnsupportedText(content: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content);
}

function parseOptionalYamlFile<T>(
  files: Map<string, string>,
  filePath: string,
  schema: z.ZodType<T>,
  codePrefix: string,
  diagnostics: HostedIntegrationValidationDiagnostic[],
): T | null {
  if (!files.has(filePath)) return null;
  return parseRequiredYamlFile(files, filePath, schema, codePrefix, diagnostics);
}

function parseRequiredYamlFile<T>(
  files: Map<string, string>,
  filePath: string,
  schema: z.ZodType<T>,
  codePrefix: string,
  diagnostics: HostedIntegrationValidationDiagnostic[],
): T | null {
  const content = files.get(filePath);
  if (content === undefined) return null;
  const parsedYaml = parseStrictYaml(content, filePath, codePrefix, diagnostics);
  if (parsedYaml === null) {
    return null;
  }
  const parsed = schema.safeParse(parsedYaml);
  if (!parsed.success) {
    diagnostics.push(
      ...zodDiagnostics(`${codePrefix}_invalid`, parsed.error).map(
        (diagnostic) => ({
          ...diagnostic,
          path: `$.files.${filePath}${diagnostic.path.slice(1)}`,
        }),
      ),
    );
    return null;
  }
  return parsed.data;
}

function parseStrictYaml(
  content: string,
  filePath: string,
  codePrefix: string,
  diagnostics: HostedIntegrationValidationDiagnostic[],
): unknown | null {
  try {
    const document = parseDocument(content, { uniqueKeys: true });
    const errors = document.errors.map((error) => error.message);
    if (errors.length > 0) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}_yaml_invalid`,
          `$.files.${filePath}`,
          errors.join("; "),
        ),
      );
      return null;
    }
    return document.toJSON();
  } catch (error) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}_yaml_invalid`,
        `$.files.${filePath}`,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return null;
  }
}

function packageFamilyIdFromFiles(files: Record<string, string>):
  | {
      manifestFamilyId: HostedIntegrationFamilyId;
      toolContractFamilyId: HostedIntegrationFamilyId;
    }
  | null {
  let manifest: unknown;
  let toolContract: unknown;
  try {
    const diagnostics: HostedIntegrationValidationDiagnostic[] = [];
    manifest = parseStrictYaml(
      files[HOSTED_INTEGRATION_MANIFEST_FILE] ?? "",
      HOSTED_INTEGRATION_MANIFEST_FILE,
      "package_manifest",
      diagnostics,
    );
    toolContract = parseStrictYaml(
      files[HOSTED_TOOL_CONTRACT_FILE] ?? "",
      HOSTED_TOOL_CONTRACT_FILE,
      "package_tool_contract",
      diagnostics,
    );
    if (diagnostics.length > 0) return null;
  } catch {
    return null;
  }
  const parsedManifest = FamilyManifestSchema.safeParse(manifest);
  const parsedToolContract =
    HostedToolContractDocumentSchema.safeParse(toolContract);
  if (!parsedManifest.success || !parsedToolContract.success) return null;
  return {
    manifestFamilyId: parsedManifest.data.id,
    toolContractFamilyId: parsedToolContract.data.family.id,
  };
}

const PACKAGE_DRAFT_ID = "package_draft";

class InMemoryPackageDraftStore implements HostedIntegrationDraftStore {
  private readonly draft: HostedIntegrationDraft;

  constructor(
    familyId: HostedIntegrationFamilyId | string,
    private readonly files: Record<string, string>,
  ) {
    this.draft = HostedIntegrationDraftSchema.parse({
      id: PACKAGE_DRAFT_ID,
      familyId,
      sourceRevisionId: "package_source",
      lockId: "package_lock",
      status: "open",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    });
  }

  async createDraft(
    _request: CreateHostedIntegrationDraftRequest,
  ): Promise<CreateHostedIntegrationDraftResult> {
    throw new Error("package validation draft store is read-only");
  }

  async createDraftFromFiles(
    _request: CreateHostedIntegrationDraftFromFilesRequest,
  ): Promise<CreateHostedIntegrationDraftResult> {
    throw new Error("package validation draft store is read-only");
  }

  async getDraft(draftId: string): Promise<HostedIntegrationDraft | null> {
    return draftId === PACKAGE_DRAFT_ID ? this.draft : null;
  }

  async listDraftFiles(
    draftId: string,
  ): Promise<ListHostedIntegrationDraftFilesResult> {
    if (draftId !== PACKAGE_DRAFT_ID) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      files: Object.entries(this.files)
        .map(([filePath, content]) => ({
          path: filePath,
          size: Buffer.byteLength(content, "utf-8"),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  async readDraftFile(
    request: ReadHostedIntegrationDraftFileRequest,
  ): Promise<ReadHostedIntegrationDraftFileResult> {
    if (request.draftId !== PACKAGE_DRAFT_ID) {
      return { ok: false, reason: "not_found" };
    }
    const normalizedPath = normalizePackagePath(request.path);
    if (!normalizedPath.ok) return { ok: false, reason: "not_found" };
    const content = this.files[normalizedPath.path];
    return content === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, content };
  }

  async writeDraftFile(
    _request: WriteHostedIntegrationDraftFileRequest,
  ): Promise<WriteHostedIntegrationDraftFileResult> {
    throw new Error("package validation draft store is read-only");
  }

  async deleteDraftFile(
    _request: DeleteHostedIntegrationDraftFileRequest,
  ): Promise<DeleteHostedIntegrationDraftFileResult> {
    throw new Error("package validation draft store is read-only");
  }
}

const EMPTY_HOSTED_INTEGRATION_CATALOG: HostedIntegrationCatalog = {
  async listFamilies() {
    return [];
  },
  async getFamily() {
    return null;
  },
  async getDiagnostics() {
    return [];
  },
};

function zodDiagnostics(
  code: string,
  error: z.ZodError,
): HostedIntegrationValidationDiagnostic[] {
  return error.issues.map((issue) =>
    errorDiagnostic(code, pathFromZodIssue(issue), issue.message),
  );
}

function pathFromZodIssue(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
}

function errorDiagnostic(
  code: string,
  pathValue: string,
  message: string,
): HostedIntegrationValidationDiagnostic {
  return { severity: "error", code, path: pathValue, message };
}
