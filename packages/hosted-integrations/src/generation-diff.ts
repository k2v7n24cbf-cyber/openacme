import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { buildHostedIntegrationFocusedSourceView } from "./source-view.js";
import {
  FamilyManifestSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  type FamilyManifest,
  type HostedIntegrationFamilyId,
  type HostedIntegrationToolName,
  type HostedIntegrationToolSpec,
} from "./schemas.js";

const MANIFEST_FILE = "family.yaml";
const SENSITIVE_KEY_PATTERN =
  /(?:secret|token|password|passwd|pwd|credential|api[_-]?key|authorization)/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+|raw-token[^\s'",}]*)/gi;
const REDACTED = "[REDACTED]";

export const HostedIntegrationGenerationDiffModeSchema = z.enum([
  "summary",
  "unified",
  "manifest",
  "tool_focused",
]);
export type HostedIntegrationGenerationDiffMode = z.infer<
  typeof HostedIntegrationGenerationDiffModeSchema
>;

export interface HostedIntegrationGenerationDiffSnapshot {
  generationId: string;
  familyId: HostedIntegrationFamilyId | string;
  files: Record<string, string>;
}

export interface HostedIntegrationGenerationDiffOptions {
  mode?: HostedIntegrationGenerationDiffMode;
  path?: string;
  toolName?: HostedIntegrationToolName | string;
  includeSharedHelpers?: boolean;
  includeHooks?: boolean;
}

export type BuildHostedIntegrationGenerationDiffResult =
  | { ok: true; diff: HostedIntegrationGenerationDiff }
  | {
      ok: false;
      error: {
        code:
          | "family_mismatch"
          | "manifest_missing"
          | "manifest_invalid"
          | "tool_name_required"
          | "entrypoint_missing";
        message: string;
      };
    };

export interface HostedIntegrationGenerationDiff {
  familyId: HostedIntegrationFamilyId;
  baseGenerationId: string;
  compareGenerationId: string;
  mode: HostedIntegrationGenerationDiffMode;
  summary?: HostedIntegrationGenerationDiffSummary;
  files?: HostedIntegrationFileDiff[];
  manifest?: HostedIntegrationManifestDiff;
  toolName?: HostedIntegrationToolName;
  toolFocused?: {
    base: Awaited<ReturnType<typeof buildHostedIntegrationFocusedSourceView>>;
    compare: Awaited<ReturnType<typeof buildHostedIntegrationFocusedSourceView>>;
    handlerPatch: string;
  };
}

export interface HostedIntegrationGenerationDiffSummary {
  changedFiles: Array<{
    path: string;
    changeType: HostedIntegrationFileChangeType;
  }>;
  changedTools: HostedIntegrationToolDiffSummary[];
  runtimeChanged: boolean;
  dependencyPolicyChanged: boolean;
}

export interface HostedIntegrationManifestDiff {
  changedTools: HostedIntegrationToolDiffSummary[];
  runtimeChanged: boolean;
  dependencyPolicyChanged: boolean;
}

export type HostedIntegrationFileChangeType =
  | "added"
  | "removed"
  | "modified";

export interface HostedIntegrationFileDiff {
  path: string;
  changeType: HostedIntegrationFileChangeType;
  unifiedPatch: string;
}

export interface HostedIntegrationToolDiffSummary {
  name: HostedIntegrationToolName;
  changeType: "added" | "removed" | "modified";
  changedFields: string[];
}

export async function buildHostedIntegrationGenerationDiff(input: {
  base: HostedIntegrationGenerationDiffSnapshot;
  compare: HostedIntegrationGenerationDiffSnapshot;
  options?: HostedIntegrationGenerationDiffOptions;
}): Promise<BuildHostedIntegrationGenerationDiffResult> {
  const baseFamilyId = HostedIntegrationFamilyIdSchema.parse(
    input.base.familyId,
  );
  const compareFamilyId = HostedIntegrationFamilyIdSchema.parse(
    input.compare.familyId,
  );
  if (baseFamilyId !== compareFamilyId) {
    return {
      ok: false,
      error: {
        code: "family_mismatch",
        message:
          "generation diff requires both generations to belong to the same family",
      },
    };
  }

  const manifests = parseManifests(input.base.files, input.compare.files);
  if (!manifests.ok) return manifests;

  const mode = input.options?.mode ?? "summary";
  const base = sanitizeFiles(input.base.files);
  const compare = sanitizeFiles(input.compare.files);
  const summary = buildSummary({
    base: input.base.files,
    compare: input.compare.files,
    baseManifest: manifests.baseManifest,
    compareManifest: manifests.compareManifest,
    pathFilter: input.options?.path,
  });

  if (mode === "summary") {
    return {
      ok: true,
      diff: baseDiff(input, baseFamilyId, mode, { summary }),
    };
  }

  if (mode === "manifest") {
    return {
      ok: true,
      diff: baseDiff(input, baseFamilyId, mode, {
        manifest: {
          changedTools: summary.changedTools,
          runtimeChanged: summary.runtimeChanged,
          dependencyPolicyChanged: summary.dependencyPolicyChanged,
        },
      }),
    };
  }

  if (mode === "unified") {
    return {
      ok: true,
      diff: baseDiff(input, baseFamilyId, mode, {
        files: buildFileDiffs({
          rawBase: input.base.files,
          rawCompare: input.compare.files,
          sanitizedBase: base,
          sanitizedCompare: compare,
          pathFilter: input.options?.path,
        }),
      }),
    };
  }

  const toolName = input.options?.toolName
    ? HostedIntegrationToolNameSchema.parse(input.options.toolName)
    : null;
  if (!toolName) {
    return {
      ok: false,
      error: {
        code: "tool_name_required",
        message: "tool_focused generation diff requires toolName",
      },
    };
  }
  const entrypoint = manifests.compareManifest.runtime.entrypoint;
  if (!base[entrypoint] || !compare[entrypoint]) {
    return {
      ok: false,
      error: {
        code: "entrypoint_missing",
        message: "tool-focused diff requires both generation entrypoint files",
      },
    };
  }

  const baseView = await buildHostedIntegrationFocusedSourceView({
    familyId: baseFamilyId,
    generationId: input.base.generationId,
    manifest: manifests.baseManifest,
    entrypointPath: manifests.baseManifest.runtime.entrypoint,
    source: base[manifests.baseManifest.runtime.entrypoint]!,
    toolName,
    options: {
      includeHooks: input.options?.includeHooks ?? false,
      includeSharedHelpers: input.options?.includeSharedHelpers ?? false,
    },
  });
  const compareView = await buildHostedIntegrationFocusedSourceView({
    familyId: baseFamilyId,
    generationId: input.compare.generationId,
    manifest: manifests.compareManifest,
    entrypointPath: manifests.compareManifest.runtime.entrypoint,
    source: compare[manifests.compareManifest.runtime.entrypoint]!,
    toolName,
    options: {
      includeHooks: input.options?.includeHooks ?? false,
      includeSharedHelpers: input.options?.includeSharedHelpers ?? false,
    },
  });

  return {
    ok: true,
    diff: baseDiff(input, baseFamilyId, mode, {
      toolName,
      toolFocused: {
        base: baseView,
        compare: compareView,
        handlerPatch: unifiedPatch({
          path: `${toolName}.handler.py`,
          before: baseView.source.selectedHandler?.source ?? "",
          after: compareView.source.selectedHandler?.source ?? "",
        }),
      },
    }),
  };
}

function baseDiff(
  input: {
    base: HostedIntegrationGenerationDiffSnapshot;
    compare: HostedIntegrationGenerationDiffSnapshot;
  },
  familyId: HostedIntegrationFamilyId,
  mode: HostedIntegrationGenerationDiffMode,
  fields: Partial<HostedIntegrationGenerationDiff>,
): HostedIntegrationGenerationDiff {
  return {
    familyId,
    baseGenerationId: input.base.generationId,
    compareGenerationId: input.compare.generationId,
    mode,
    ...fields,
  };
}

function parseManifests(
  baseFiles: Record<string, string>,
  compareFiles: Record<string, string>,
):
  | { ok: true; baseManifest: FamilyManifest; compareManifest: FamilyManifest }
  | {
      ok: false;
      error: {
        code: "manifest_missing" | "manifest_invalid";
        message: string;
      };
    } {
  if (!baseFiles[MANIFEST_FILE] || !compareFiles[MANIFEST_FILE]) {
    return {
      ok: false,
      error: {
        code: "manifest_missing",
        message: "generation diff requires family.yaml in both generations",
      },
    };
  }
  try {
    return {
      ok: true,
      baseManifest: FamilyManifestSchema.parse(
        parseYaml(baseFiles[MANIFEST_FILE]),
      ),
      compareManifest: FamilyManifestSchema.parse(
        parseYaml(compareFiles[MANIFEST_FILE]),
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function buildSummary(args: {
  base: Record<string, string>;
  compare: Record<string, string>;
  baseManifest: FamilyManifest;
  compareManifest: FamilyManifest;
  pathFilter?: string;
}): HostedIntegrationGenerationDiffSummary {
  return {
    changedFiles: buildFileChanges(args.base, args.compare, args.pathFilter),
    changedTools: buildToolChanges(args.baseManifest, args.compareManifest),
    runtimeChanged:
      stableJson(args.baseManifest.runtime) !==
      stableJson(args.compareManifest.runtime),
    dependencyPolicyChanged:
      stableJson(args.baseManifest.runtime.dependencyPolicy) !==
      stableJson(args.compareManifest.runtime.dependencyPolicy),
  };
}

function buildToolChanges(
  baseManifest: FamilyManifest,
  compareManifest: FamilyManifest,
): HostedIntegrationToolDiffSummary[] {
  const baseByName = new Map(baseManifest.tools.map((tool) => [tool.name, tool]));
  const compareByName = new Map(
    compareManifest.tools.map((tool) => [tool.name, tool]),
  );
  const names = [...new Set([...baseByName.keys(), ...compareByName.keys()])].sort();
  const changes: HostedIntegrationToolDiffSummary[] = [];
  for (const name of names) {
    const base = baseByName.get(name);
    const compare = compareByName.get(name);
    if (!base && compare) {
      changes.push({ name, changeType: "added", changedFields: [] });
      continue;
    }
    if (base && !compare) {
      changes.push({ name, changeType: "removed", changedFields: [] });
      continue;
    }
    if (!base || !compare) continue;
    const changedFields = changedToolFields(base, compare);
    if (changedFields.length > 0) {
      changes.push({ name, changeType: "modified", changedFields });
    }
  }
  return changes;
}

function changedToolFields(
  base: HostedIntegrationToolSpec,
  compare: HostedIntegrationToolSpec,
): string[] {
  return [
    "title",
    "description",
    "lifecycle",
    "inputSchema",
    "help",
    "classification",
    "cache",
    "runtime",
  ].filter(
    (field) =>
      stableJson(base[field as keyof HostedIntegrationToolSpec]) !==
      stableJson(compare[field as keyof HostedIntegrationToolSpec]),
  );
}

function buildFileDiffs(args: {
  rawBase: Record<string, string>;
  rawCompare: Record<string, string>;
  sanitizedBase: Record<string, string>;
  sanitizedCompare: Record<string, string>;
  pathFilter?: string;
}): HostedIntegrationFileDiff[] {
  return buildFileChanges(args.rawBase, args.rawCompare, args.pathFilter).map((change) => ({
    ...change,
    unifiedPatch: unifiedPatch({
      path: change.path,
      before: args.sanitizedBase[change.path] ?? "",
      after: args.sanitizedCompare[change.path] ?? "",
    }),
  }));
}

function buildFileChanges(
  base: Record<string, string>,
  compare: Record<string, string>,
  pathFilter?: string,
): Array<{ path: string; changeType: HostedIntegrationFileChangeType }> {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(compare)])]
    .filter((path) => !pathFilter || path === pathFilter)
    .sort();
  const changes: Array<{
    path: string;
    changeType: HostedIntegrationFileChangeType;
  }> = [];
  for (const path of paths) {
    if (!(path in base)) {
      changes.push({ path, changeType: "added" });
      continue;
    }
    if (!(path in compare)) {
      changes.push({ path, changeType: "removed" });
      continue;
    }
    if (base[path] !== compare[path]) {
      changes.push({ path, changeType: "modified" });
    }
  }
  return changes;
}

function unifiedPatch(args: {
  path: string;
  before: string;
  after: string;
}): string {
  const beforeLines = args.before.split(/\r?\n/);
  const afterLines = args.after.split(/\r?\n/);
  const lines = [`--- a/${args.path}`, `+++ b/${args.path}`];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max; index += 1) {
    const before = beforeLines[index];
    const after = afterLines[index];
    if (before === after) {
      if (before !== undefined && before.length > 0) lines.push(` ${before}`);
      continue;
    }
    if (before !== undefined && before.length > 0) lines.push(`-${before}`);
    if (after !== undefined && after.length > 0) lines.push(`+${after}`);
  }
  return sanitizeText(`${lines.join("\n")}\n`);
}

function sanitizeFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      sanitizeTextByPath(path, content),
    ]),
  );
}

function sanitizeTextByPath(path: string, content: string): string {
  if (SENSITIVE_KEY_PATTERN.test(path)) return REDACTED;
  return sanitizeText(content);
}

function sanitizeText(content: string): string {
  return content.replace(SENSITIVE_VALUE_PATTERN, REDACTED);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
