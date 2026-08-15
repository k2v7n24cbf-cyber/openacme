import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationRunSchema,
  HostedIntegrationToolNameSchema,
  JsonValueSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationRun,
  type HostedIntegrationToolName,
  type JsonValue,
} from "./schemas.js";
import {
  readTextFileUnderRoot,
  resolveInsideRoot,
  safePathSegment,
} from "./file-access.js";

const DEFAULT_INLINE_RESULT_TOKEN_LIMIT = 8_000;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|passwd|pwd|credential|api[_-]?key|authorization)/i;
const SENSITIVE_VALUE_PATTERN = new RegExp(
  [
    String.raw`bearer\s+[a-z0-9._~+/-]+`,
    String.raw`eyJ[a-z0-9_-]{20,}(?:\.[a-z0-9_-]{20,}){0,2}`,
    String.raw`raw-token`,
    String.raw`super-secret[^\s",}]*`,
  ].join("|"),
  "gi",
);

export interface FileHostedIntegrationArtifactStoreOptions {
  dataDir: string;
  inlineResultTokenLimit?: number;
  now?: () => Date;
  createRunId?: () => string;
}

export interface CreateHostedIntegrationRunRequest {
  familyId: HostedIntegrationFamilyId | string;
  toolName: HostedIntegrationToolName | string;
  generationId: string;
  actorId: string;
  input: JsonValue;
}

export interface CreateHostedIntegrationRunResult {
  run: HostedIntegrationRun;
  familyHome: string;
  runDir: string;
}

export interface CompleteHostedIntegrationRunSuccessRequest {
  runId: string;
  familyId: HostedIntegrationFamilyId | string;
  result: JsonValue;
  inlineResultTokenLimit?: number;
}

export interface CompleteHostedIntegrationRunErrorRequest {
  runId: string;
  familyId: HostedIntegrationFamilyId | string;
  error: JsonValue;
}

export interface WriteHostedIntegrationDiagnosticsRequest {
  runId: string;
  familyId: HostedIntegrationFamilyId | string;
  diagnostics: JsonValue;
}

export interface ReadHostedIntegrationArtifactRequest {
  runId: string;
  familyId: HostedIntegrationFamilyId | string;
  name: string;
}

export interface HostedIntegrationArtifactRef {
  type: "artifact";
  run_id: string;
  name: string;
  size_bytes: number;
  estimated_tokens: number;
}

export type HostedIntegrationSuccessEnvelope =
  | { ok: true; result: JsonValue }
  | { ok: true; result_ref: HostedIntegrationArtifactRef };

export interface HostedIntegrationArtifactStore {
  createRun(
    request: CreateHostedIntegrationRunRequest,
  ): Promise<CreateHostedIntegrationRunResult>;
  completeRunSuccess(
    request: CompleteHostedIntegrationRunSuccessRequest,
  ): Promise<HostedIntegrationSuccessEnvelope>;
  completeRunError(
    request: CompleteHostedIntegrationRunErrorRequest,
  ): Promise<{ ok: false; error: JsonValue }>;
  writeDiagnostics(
    request: WriteHostedIntegrationDiagnosticsRequest,
  ): Promise<void>;
  readArtifact(request: ReadHostedIntegrationArtifactRequest): Promise<string>;
}

export function createFileHostedIntegrationArtifactStore(
  options: FileHostedIntegrationArtifactStoreOptions,
): HostedIntegrationArtifactStore {
  return new FileHostedIntegrationArtifactStore({
    dataDir: options.dataDir,
    inlineResultTokenLimit:
      options.inlineResultTokenLimit ?? DEFAULT_INLINE_RESULT_TOKEN_LIMIT,
    now: options.now ?? (() => new Date()),
    createRunId: options.createRunId ?? (() => `call_${randomUUID()}`),
  });
}

class FileHostedIntegrationArtifactStore
  implements HostedIntegrationArtifactStore
{
  private readonly workspacesDir: string;
  private readonly inlineResultTokenLimit: number;
  private readonly now: () => Date;
  private readonly createRunId: () => string;

  constructor(parts: {
    dataDir: string;
    inlineResultTokenLimit: number;
    now: () => Date;
    createRunId: () => string;
  }) {
    this.workspacesDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "workspaces",
    );
    this.inlineResultTokenLimit = parts.inlineResultTokenLimit;
    this.now = parts.now;
    this.createRunId = parts.createRunId;
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
    const limit =
      request.inlineResultTokenLimit ?? this.inlineResultTokenLimit;
    if (artifact.estimated_tokens <= limit) {
      await this.updateRunStatus(request.familyId, request.runId, "succeeded");
      return { ok: true, result: sanitized };
    }
    await this.updateRunStatus(request.familyId, request.runId, "succeeded");
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
    await this.updateRunStatus(request.familyId, request.runId, "failed");
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
    return {
      type: "artifact",
      run_id: runId,
      name,
      size_bytes: Buffer.byteLength(content, "utf-8"),
      estimated_tokens: estimateTokens(content),
    };
  }

  private async updateRunStatus(
    familyIdInput: HostedIntegrationFamilyId | string,
    runId: string,
    status: "succeeded" | "failed",
  ): Promise<void> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(familyIdInput);
    const metadataPath = resolveInsideRoot(
      this.runDir(familyId, runId),
      "metadata.json",
      "run root",
    );
    const run = HostedIntegrationRunSchema.parse(
      JSON.parse(await readFile(metadataPath, "utf-8")),
    );
    await this.writeJsonArtifact(familyId, runId, "metadata.json", {
      ...run,
      status,
      endedAt: this.now().toISOString(),
    });
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
    return path.join(this.workspacesDir, familyId);
  }
}

export function sanitizeHostedIntegrationJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeHostedIntegrationJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key)
          ? REDACTED
          : sanitizeHostedIntegrationJsonValue(child),
      ]),
    );
  }
  if (typeof value === "string") {
    return value.replace(SENSITIVE_VALUE_PATTERN, REDACTED);
  }
  return value;
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
