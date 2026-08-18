import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  createFileHostedIntegrationCatalog,
  type HostedIntegrationCatalog,
} from "./catalog.js";
import {
  createFileHostedIntegrationDraftStore,
  type HostedIntegrationDraftStore,
} from "./drafts.js";
import {
  createFileHostedIntegrationLockStore,
  type HostedIntegrationLockStore,
} from "./locks.js";
import {
  FamilyManifestSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  HostedToolContractDocumentSchema,
  type HostedIntegrationDraft,
  type HostedIntegrationFamilyId,
  type HostedIntegrationFamilyLock,
  type HostedIntegrationToolName,
} from "./schemas.js";
import { buildHostedToolName } from "./naming.js";
import { isNodeError, safePathSegment } from "./file-access.js";

const PROPOSED_SOURCE_REVISION_ID = "proposed_initial";

export interface HostedIntegrationProposedFamilySummary {
  id: HostedIntegrationFamilyId;
  name: string;
  version: number;
  toolNames: HostedIntegrationToolName[];
  status: "proposed";
  draftId: string;
  lockId: string;
  sourceRevisionId: string;
}

export interface CreateHostedIntegrationProposedFamilyRequest {
  familyId: HostedIntegrationFamilyId | string;
  name: string;
  toolName: HostedIntegrationToolName | string;
  lockedBy: string;
  ttlMs: number;
}

export interface CreateHostedIntegrationProposedFamilyFromFilesRequest {
  familyId: HostedIntegrationFamilyId | string;
  name: string;
  version: number;
  toolNames: Array<HostedIntegrationToolName | string>;
  files: Record<string, string>;
  lockedBy: string;
  ttlMs: number;
  sourceRevisionId?: string;
}

export type CreateHostedIntegrationProposedFamilyResult =
  | {
      ok: true;
      family: HostedIntegrationProposedFamilySummary;
      lock: HostedIntegrationFamilyLock;
      draft: HostedIntegrationDraft;
      sourceRevisionId: string;
    }
  | { ok: false; reason: "duplicate_family" | "lock_required" };

export interface HostedIntegrationProposedFamilyManager {
  listProposedFamilies(): Promise<HostedIntegrationProposedFamilySummary[]>;
  getProposedFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationProposedFamilySummary | null>;
  createProposedFamily(
    request: CreateHostedIntegrationProposedFamilyRequest,
  ): Promise<CreateHostedIntegrationProposedFamilyResult>;
  createProposedFamilyFromFiles(
    request: CreateHostedIntegrationProposedFamilyFromFilesRequest,
  ): Promise<CreateHostedIntegrationProposedFamilyResult>;
}

export interface FileHostedIntegrationProposedFamilyManagerOptions {
  dataDir: string;
  catalog?: HostedIntegrationCatalog;
  lockStore?: HostedIntegrationLockStore;
  draftStore?: HostedIntegrationDraftStore;
  now?: () => Date;
  createLockId?: () => string;
  createDraftId?: () => string;
}

export function createFileHostedIntegrationProposedFamilyManager(
  options: FileHostedIntegrationProposedFamilyManagerOptions,
): HostedIntegrationProposedFamilyManager {
  const catalog =
    options.catalog ?? createFileHostedIntegrationCatalog(options);
  const lockStore =
    options.lockStore ??
    createFileHostedIntegrationLockStore({
      dataDir: options.dataDir,
      now: options.now,
      createId: options.createLockId,
    });
  const draftStore =
    options.draftStore ??
    createFileHostedIntegrationDraftStore({
      dataDir: options.dataDir,
      lockStore,
      now: options.now,
      createId: options.createDraftId,
    });
  return new FileHostedIntegrationProposedFamilyManager({
    dataDir: options.dataDir,
    catalog,
    lockStore,
    draftStore,
  });
}

class FileHostedIntegrationProposedFamilyManager
  implements HostedIntegrationProposedFamilyManager
{
  private readonly proposedDir: string;
  private readonly catalog: HostedIntegrationCatalog;
  private readonly lockStore: HostedIntegrationLockStore;
  private readonly draftStore: HostedIntegrationDraftStore;

  constructor(parts: {
    dataDir: string;
    catalog: HostedIntegrationCatalog;
    lockStore: HostedIntegrationLockStore;
    draftStore: HostedIntegrationDraftStore;
  }) {
    this.proposedDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "proposed-families",
    );
    this.catalog = parts.catalog;
    this.lockStore = parts.lockStore;
    this.draftStore = parts.draftStore;
  }

  async listProposedFamilies(): Promise<
    HostedIntegrationProposedFamilySummary[]
  > {
    let entries;
    try {
      entries = await readdir(this.proposedDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const families: HostedIntegrationProposedFamilySummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await readFile(
        path.join(this.proposedDir, entry.name),
        "utf-8",
      );
      families.push(JSON.parse(raw) as HostedIntegrationProposedFamilySummary);
    }
    families.sort((a, b) => a.id.localeCompare(b.id));
    return families;
  }

  async getProposedFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationProposedFamilySummary | null> {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.safeParse(familyId);
    if (!parsedFamilyId.success) return null;
    try {
      const raw = await readFile(
        this.proposedPath(parsedFamilyId.data),
        "utf-8",
      );
      return JSON.parse(raw) as HostedIntegrationProposedFamilySummary;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async createProposedFamily(
    request: CreateHostedIntegrationProposedFamilyRequest,
  ): Promise<CreateHostedIntegrationProposedFamilyResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    const toolName = HostedIntegrationToolNameSchema.parse(request.toolName);
    assertNonEmpty("name", request.name);
    assertNonEmpty("lockedBy", request.lockedBy);
    assertPositiveTtl(request.ttlMs);

    if (
      (await this.catalog.getFamily(familyId)) ||
      (await this.getProposedFamily(familyId))
    ) {
      return { ok: false, reason: "duplicate_family" };
    }

    const lockResult = await this.lockStore.acquireLock({
      familyId,
      lockedBy: request.lockedBy,
      ttlMs: request.ttlMs,
    });
    if (!lockResult.ok) return { ok: false, reason: "lock_required" };

    const draftResult = await this.draftStore.createDraftFromFiles({
      familyId,
      lockId: lockResult.lock.id,
      sourceRevisionId: PROPOSED_SOURCE_REVISION_ID,
      files: proposedFamilyFiles({
        familyId,
        name: request.name,
        toolName,
      }),
    });
    if (!draftResult.ok) {
      await this.lockStore.releaseLock({
        lockId: lockResult.lock.id,
        lockedBy: request.lockedBy,
      });
      return { ok: false, reason: "lock_required" };
    }

    const family: HostedIntegrationProposedFamilySummary = {
      id: familyId,
      name: request.name,
      version: 1,
      toolNames: [toolName],
      status: "proposed",
      draftId: draftResult.draft.id,
      lockId: lockResult.lock.id,
      sourceRevisionId: PROPOSED_SOURCE_REVISION_ID,
    };
    await this.writeProposedFamily(family);
    return {
      ok: true,
      family,
      lock: lockResult.lock,
      draft: draftResult.draft,
      sourceRevisionId: PROPOSED_SOURCE_REVISION_ID,
    };
  }

  async createProposedFamilyFromFiles(
    request: CreateHostedIntegrationProposedFamilyFromFilesRequest,
  ): Promise<CreateHostedIntegrationProposedFamilyResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("name", request.name);
    assertNonEmpty("lockedBy", request.lockedBy);
    assertPositiveTtl(request.ttlMs);
    const toolNames = request.toolNames.map((toolName) =>
      HostedIntegrationToolNameSchema.parse(toolName),
    );
    if (toolNames.length === 0) {
      throw new Error("toolNames must contain at least one tool");
    }
    const sourceRevisionId =
      request.sourceRevisionId ?? PROPOSED_SOURCE_REVISION_ID;

    if (
      (await this.catalog.getFamily(familyId)) ||
      (await this.getProposedFamily(familyId))
    ) {
      return { ok: false, reason: "duplicate_family" };
    }

    const lockResult = await this.lockStore.acquireLock({
      familyId,
      lockedBy: request.lockedBy,
      ttlMs: request.ttlMs,
    });
    if (!lockResult.ok) return { ok: false, reason: "lock_required" };

    const draftResult = await this.draftStore.createDraftFromFiles({
      familyId,
      lockId: lockResult.lock.id,
      sourceRevisionId,
      files: request.files,
    });
    if (!draftResult.ok) {
      await this.lockStore.releaseLock({
        lockId: lockResult.lock.id,
        lockedBy: request.lockedBy,
      });
      return { ok: false, reason: "lock_required" };
    }

    const family: HostedIntegrationProposedFamilySummary = {
      id: familyId,
      name: request.name,
      version: request.version,
      toolNames,
      status: "proposed",
      draftId: draftResult.draft.id,
      lockId: lockResult.lock.id,
      sourceRevisionId,
    };
    await this.writeProposedFamily(family);
    return {
      ok: true,
      family,
      lock: lockResult.lock,
      draft: draftResult.draft,
      sourceRevisionId,
    };
  }

  private async writeProposedFamily(
    family: HostedIntegrationProposedFamilySummary,
  ): Promise<void> {
    await mkdir(this.proposedDir, { recursive: true });
    await writeFile(
      this.proposedPath(family.id),
      `${JSON.stringify(family, null, 2)}\n`,
      "utf-8",
    );
  }

  private proposedPath(familyId: HostedIntegrationFamilyId): string {
    return path.join(
      this.proposedDir,
      `${safePathSegment("familyId", familyId)}.json`,
    );
  }
}

function proposedFamilyFiles(input: {
  familyId: HostedIntegrationFamilyId;
  name: string;
  toolName: HostedIntegrationToolName;
}): Record<string, string> {
  const manifest = FamilyManifestSchema.parse({
    id: input.familyId,
    name: input.name,
    version: 1,
    runtime: {
      language: "python",
      entrypoint: `${input.familyId}.py`,
      defaultTimeoutMs: 30000,
      inlineResultTokenLimit: 8000,
      maxConcurrency: 1,
      runtimePolicy: {
        filesystem: "run_dir_and_family_home",
        processEnv: "tool_context_only",
        subprocess: "denied",
        network: "denied",
      },
      dependencyPolicy: {
        installDuringInvocation: false,
        allowedPackages: [],
      },
    },
    hookJustifications: {
      authenticate:
        "Initial proposed tool does not authenticate until implementation config is added.",
      before_tool_call:
        "Initial proposed tool has no shared request normalization yet.",
      after_tool_call:
        "Initial proposed tool has no shared response normalization yet.",
    },
  });
  const toolContract = HostedToolContractDocumentSchema.parse({
    kind: "openacme.hostedToolFamily",
    version: 1,
    family: { id: input.familyId },
    tools: [
      {
        mcp: {
          name: buildHostedToolName({
            familyId: input.familyId,
            toolName: input.toolName,
          }),
          title: input.name,
          description: `Initial proposed ${input.name} hosted integration tool.`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            additionalProperties: true,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        openacme: {
          toolName: input.toolName,
          function: `tool_${input.toolName}`,
          lifecycle: "active",
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
          selectWhen: [
            `Use for the initial ${input.name} hosted integration smoke behavior.`,
          ],
          doNotSelectWhen: [
            "Do not use for provider-specific production behavior before implementation evidence exists.",
          ],
          prerequisites: [],
          parameterHelp: {},
          examples: [],
          noExampleJustification:
            "Initial proposed tool has no stable request example until implementation is completed.",
          errors: [
            "bad_arguments means the initial proposed tool input is unsupported; fix the request before retrying.",
            "tool_bug means the proposed implementation is incomplete and should be repaired before promotion.",
            "EVIDENCE_REQUIRED means provider behavior is not yet sourced; stop and gather official or imported evidence before implementing production behavior.",
          ],
        },
      },
    ],
  });

  return {
    "family.yaml": stringifyYaml(manifest),
    "tools.yaml": stringifyYaml(toolContract),
    [`${input.familyId}.py`]: [
      `def tool_${input.toolName}(args, context):`,
      `    return {"ok": True, "tool": "${input.toolName}", "args": args}`,
      "",
    ].join("\n"),
  };
}

function assertNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive integer");
  }
}
