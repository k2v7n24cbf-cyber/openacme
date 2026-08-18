import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  readTextFileUnderRoot,
  resolveInsideRoot,
  safePathSegment,
} from "./file-access.js";
import {
  HostedIntegrationExampleSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  HostedParameterVocabularySchema,
  HostedToolContractDocumentSchema,
  hostedToolContractToToolSpecs,
  JsonObjectSchema,
  JsonValueSchema,
  type HostedIntegrationExample,
  type HostedIntegrationGeneration,
  type HostedIntegrationToolHelp,
  type HostedIntegrationToolName,
  type HostedIntegrationToolSpec,
  type HostedParameterVocabulary,
  type HostedParameterVocabularyEntry,
  type HostedParameterVocabularyInvalidAlias,
  type JsonObject,
  type JsonValue,
} from "./schemas.js";
import { HOSTED_TOOL_CONTRACT_FILE } from "./catalog.js";

const EXAMPLES_FILE = "examples.yaml";
const HELP_FILE_PATTERN =
  /^(?:help\/)?[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:md|txt|json)$/;

export const HostedIntegrationHelpDetailSchema = z.enum([
  "none",
  "summary",
  "full",
]);
export type HostedIntegrationHelpDetail = z.infer<
  typeof HostedIntegrationHelpDetailSchema
>;

export const HostedIntegrationParameterHelpRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe(
        "Parameter path to inspect, such as filter_body, filter_body.filters.field, or operation.",
      ),
    detail: z
      .enum(["summary", "full"])
      .default("summary")
      .describe(
        "Use full when the parameter is a filter/query/body/cursor DSL.",
      ),
    include_examples: z
      .boolean()
      .default(false)
      .describe("Whether to include examples attached to this parameter."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Search the parameter vocabulary when this parameter references one.",
      ),
    value: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Check an exact parameter vocabulary value or known invalid alias. If query is also supplied, query wins and this value is reported as ignored guidance.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum vocabulary matches to return for query requests."),
  })
  .strict();
export type HostedIntegrationParameterHelpRequest = z.infer<
  typeof HostedIntegrationParameterHelpRequestSchema
>;

export const HostedIntegrationToolHelpRequestSchema = z
  .object({
    tool_name: z
      .string()
      .min(1)
      .describe(
        "Hosted tool name, e.g. hosted_qualys__qualys_cloud_agent_hostasset_count.",
      ),
    tool_detail: HostedIntegrationHelpDetailSchema.default("summary").describe(
      "Use full when you need invocation details, filter/query syntax, or examples before calling a tool.",
    ),
    include_examples: z
      .boolean()
      .default(false)
      .describe("Whether to include tool-level examples."),
    parameters: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        z.array(HostedIntegrationParameterHelpRequestSchema).optional(),
      )
      .describe(
        "Optional parameter help requests. Omit or pass null to get documented parameters automatically; with tool_detail=full they are expanded with full detail.",
      ),
  })
  .strict();
export type HostedIntegrationToolHelpRequest = z.infer<
  typeof HostedIntegrationToolHelpRequestSchema
>;

const HostedIntegrationResolvedVocabularyHelpSchema = z
  .object({
    id: z.string().optional(),
    parameter_path: z.string().optional(),
    entry_count: z.number().int().nonnegative().optional(),
    invalid_alias_count: z.number().int().nonnegative().optional(),
    query: z.string().optional(),
    value: z.string().optional(),
    ignored_value: z.string().optional(),
    status: z
      .enum([
        "ok",
        "not_found",
        "no_vocabulary",
        "invalid_alias",
        "ambiguous_vocabulary",
      ])
      .optional(),
    truncated: z.boolean().optional(),
    warnings: z.array(z.string()).default([]),
    candidate_parameter_paths: z.array(z.string()).optional(),
    matches: z
      .array(
        z
          .object({
            value: z.string(),
            summary: z.string(),
            description: z.string().optional(),
            valueType: z.string().optional(),
            valueTypes: z.array(z.string()).default([]),
            enumValues: z.array(z.string()).default([]),
            operators: z.array(z.string()).default([]),
            aliases: z.array(z.string()).default([]),
            canonicalTokens: z.array(z.string()).default([]),
            examples: z.array(JsonValueSchema).default([]),
            section: z.string().optional(),
            sourceMode: z.string().optional(),
            apiFilterBodyUse: z.string().optional(),
            source: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    invalid_alias: z
      .object({
        value: z.string(),
        reason: z.string(),
        use: z.string().optional(),
        source: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const HostedIntegrationResolvedParameterHelpSchema = z
  .object({
    summary: z.string().optional(),
    full: z.string().optional(),
    shape: JsonObjectSchema.optional(),
    rules: z.array(z.string()).default([]),
    examples: z.array(JsonValueSchema).default([]),
    vocabulary: HostedIntegrationResolvedVocabularyHelpSchema.optional(),
  })
  .strict();
export type HostedIntegrationResolvedParameterHelp = z.infer<
  typeof HostedIntegrationResolvedParameterHelpSchema
>;

export const HostedIntegrationResolvedToolHelpSchema = z
  .object({
    tool_name: z.string().min(1),
    family_id: HostedIntegrationFamilyIdSchema,
    family_tool_name: HostedIntegrationToolNameSchema,
    generation_id: z.string().min(1),
    tool_help: z
      .object({
        summary: z.string().optional(),
        full: z.string().optional(),
        when_to_use: z.array(z.string()).default([]),
        when_not_to_use: z.array(z.string()).default([]),
        errors: z.array(z.string()).default([]),
        pagination: JsonObjectSchema.nullable().optional(),
        no_example_justification: z.string().optional(),
      })
      .strict(),
    parameters: z.record(
      z.string(),
      HostedIntegrationResolvedParameterHelpSchema,
    ),
    examples: z.array(JsonValueSchema).default([]),
  })
  .strict();
export type HostedIntegrationResolvedToolHelp = z.infer<
  typeof HostedIntegrationResolvedToolHelpSchema
>;

export type ResolveHostedIntegrationToolHelpResult =
  | { ok: true; help: HostedIntegrationResolvedToolHelp }
  | {
      ok: false;
      error: {
        code:
          | "family_not_found"
          | "tool_not_found"
          | "no_active_generation"
          | "generation_not_found"
          | "help_file_not_found"
          | "help_file_invalid";
        message: string;
      };
    };

export interface HostedIntegrationHelpGenerationStore {
  getActiveGeneration(
    familyId: string,
  ): Promise<HostedIntegrationGeneration | null>;
  getGeneration(
    generationId: string,
  ): Promise<HostedIntegrationGeneration | null>;
}

export interface ResolveHostedIntegrationToolHelpInput {
  dataDir: string;
  generations: HostedIntegrationHelpGenerationStore;
  hostedToolName: string;
  familyId: string;
  toolName: string;
  request: Omit<HostedIntegrationToolHelpRequest, "tool_name">;
  generationId?: string;
}

export async function resolveHostedIntegrationToolHelp(
  input: ResolveHostedIntegrationToolHelpInput,
): Promise<ResolveHostedIntegrationToolHelpResult> {
  const familyId = HostedIntegrationFamilyIdSchema.parse(input.familyId);
  const toolName = HostedIntegrationToolNameSchema.parse(input.toolName);
  const generation = input.generationId
    ? await input.generations.getGeneration(input.generationId)
    : await input.generations.getActiveGeneration(familyId);
  if (!generation) {
    return {
      ok: false,
      error: {
        code: input.generationId
          ? "generation_not_found"
          : "no_active_generation",
        message: input.generationId
          ? "hosted integration generation was not found"
          : "hosted integration family has no active generation",
      },
    };
  }
  if (generation.familyId !== familyId) {
    return {
      ok: false,
      error: {
        code: "generation_not_found",
        message:
          "hosted integration generation does not belong to requested family",
      },
    };
  }

  const filesRoot = generationFilesRoot(input.dataDir, generation.id);
  const toolContract = await readGenerationToolContract(filesRoot);
  if (toolContract.family.id !== familyId) {
    return {
      ok: false,
      error: {
        code: "family_not_found",
        message: "generation tool contract does not match requested family",
      },
    };
  }
  const tool = hostedToolContractToToolSpecs(toolContract).find(
    (candidate) => candidate.name === toolName,
  );
  if (!tool || tool.lifecycle === "removed") {
    return {
      ok: false,
      error: {
        code: "tool_not_found",
        message: "hosted integration tool was not found in active generation",
      },
    };
  }

  try {
    const examples = await readGenerationExamples(
      filesRoot,
      familyId,
      toolName,
    );
    return {
      ok: true,
      help: HostedIntegrationResolvedToolHelpSchema.parse({
        tool_name: input.hostedToolName,
        family_id: familyId,
        family_tool_name: toolName,
        generation_id: generation.id,
        tool_help: await resolveToolHelp(filesRoot, tool, input.request),
        parameters: await resolveParameterHelp(
          filesRoot,
          tool,
          input.request.parameters,
          input.request.tool_detail,
          input.request.include_examples,
        ),
        examples: input.request.include_examples
          ? [...(tool.help?.examples ?? []), ...examples.map(examplePayload)]
          : [],
      }),
    };
  } catch (error) {
    return helpFileError(error);
  }
}

export function generationFilesRoot(
  dataDir: string,
  generationId: string,
): string {
  return path.join(
    dataDir,
    "hosted-integrations",
    "generations",
    safePathSegment("generationId", generationId),
    "files",
  );
}

async function readGenerationToolContract(
  filesRoot: string,
): Promise<z.infer<typeof HostedToolContractDocumentSchema>> {
  const raw = await readFile(
    resolveInsideRoot(
      filesRoot,
      HOSTED_TOOL_CONTRACT_FILE,
      "generation files root",
    ),
    "utf-8",
  );
  return HostedToolContractDocumentSchema.parse(parseYaml(raw));
}

const ExamplesDocumentSchema = z
  .object({
    examples: z.array(HostedIntegrationExampleSchema).default([]),
  })
  .strict();

async function readGenerationExamples(
  filesRoot: string,
  familyId: string,
  toolName: HostedIntegrationToolName,
): Promise<HostedIntegrationExample[]> {
  try {
    const raw = await readTextFileUnderRoot(
      filesRoot,
      EXAMPLES_FILE,
      "generation files root",
    );
    return ExamplesDocumentSchema.parse(parseYaml(raw)).examples.filter(
      (example) =>
        example.familyId === familyId && example.toolName === toolName,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function resolveToolHelp(
  filesRoot: string,
  tool: HostedIntegrationToolSpec,
  request: Omit<HostedIntegrationToolHelpRequest, "tool_name">,
): Promise<HostedIntegrationResolvedToolHelp["tool_help"]> {
  const help = tool.help;
  const output: HostedIntegrationResolvedToolHelp["tool_help"] = {
    summary: help?.summary ?? tool.description,
    when_to_use: help?.whenToUse ?? [],
    when_not_to_use: help?.whenNotToUse ?? [],
    errors: tool.errors ?? [],
    ...(tool.pagination !== undefined ? { pagination: tool.pagination } : {}),
    ...(help?.noExampleJustification
      ? { no_example_justification: help.noExampleJustification }
      : {}),
  };
  if (request.tool_detail === "full") {
    output.full = help?.full
      ? await resolveHelpText(filesRoot, help.full)
      : fallbackFullToolHelp(tool);
  } else if (request.tool_detail === "none") {
    delete output.summary;
  }
  return output;
}

async function resolveParameterHelp(
  filesRoot: string,
  tool: HostedIntegrationToolSpec,
  requested: HostedIntegrationParameterHelpRequest[] | undefined,
  toolDetail: HostedIntegrationHelpDetail,
  includeToolExamples: boolean,
): Promise<Record<string, HostedIntegrationResolvedParameterHelp>> {
  const explicit = tool.help?.parameters ?? {};
  const selected: HostedIntegrationParameterHelpRequest[] =
    requested ??
    Object.keys(explicit).map((name) => ({
      name,
      detail: toolDetail === "full" ? ("full" as const) : ("summary" as const),
      include_examples: includeToolExamples,
      limit: 10,
    }));
  const result: Record<string, HostedIntegrationResolvedParameterHelp> = {};
  for (const parameter of selected) {
    const metadata =
      explicit[parameter.name] ??
      uniqueParameterSuffixMatch(explicit, parameter.name);
    const nestedVocabularyMatch = metadata?.vocabularyRef
      ? null
      : nestedVocabularyParameterMatch(explicit, parameter.name);
    const shape =
      metadata?.shape ?? schemaShapeForPath(tool.inputSchema, parameter.name);
    const summary =
      metadata?.summary ??
      (shape ? fallbackParameterSummary(parameter.name, shape) : undefined);
    const entry: HostedIntegrationResolvedParameterHelp = {
      ...(summary ? { summary } : {}),
      ...(shape ? { shape } : {}),
      rules: metadata?.rules ?? [],
      examples: parameter.include_examples ? (metadata?.examples ?? []) : [],
    };
    if (parameter.detail === "full") {
      entry.full = metadata?.full
        ? await resolveHelpText(filesRoot, metadata.full)
        : fallbackFullParameterHelp(parameter.name, shape);
    }
    const vocabulary =
      nestedVocabularyMatch?.type === "ambiguous" && (parameter.query || parameter.value)
        ? ambiguousVocabularyHelp(parameter, nestedVocabularyMatch.names)
        : await resolveVocabularyHelp(
            filesRoot,
            metadata?.vocabularyRef ??
              (nestedVocabularyMatch?.type === "single"
                ? nestedVocabularyMatch.metadata.vocabularyRef
                : undefined),
            parameter,
            nestedVocabularyMatch?.type === "single"
              ? nestedVocabularyMatch.name
              : undefined,
          );
    if (vocabulary) entry.vocabulary = vocabulary;
    result[parameter.name] =
      HostedIntegrationResolvedParameterHelpSchema.parse(entry);
  }
  return result;
}

async function resolveVocabularyHelp(
  filesRoot: string,
  vocabularyRef: string | undefined,
  parameter: HostedIntegrationParameterHelpRequest,
  inferredFromParameter?: string,
): Promise<HostedIntegrationResolvedParameterHelp["vocabulary"] | undefined> {
  const warnings = vocabularyRequestWarnings(parameter, inferredFromParameter);
  if (!vocabularyRef) {
    if (!parameter.query && !parameter.value) return undefined;
    return {
      query: parameter.query,
      ...(parameter.query
        ? { ignored_value: parameter.value }
        : { value: parameter.value }),
      status: "no_vocabulary",
      warnings,
      matches: [],
    };
  }

  const vocabulary = await readVocabulary(filesRoot, vocabularyRef);
  const base = {
    id: vocabulary.id,
    parameter_path: vocabulary.parameterPath,
    entry_count: vocabulary.entries.length,
    invalid_alias_count: vocabulary.invalidAliases.length,
  };

  if (parameter.value) {
    if (parameter.query) {
      return searchVocabulary(vocabulary, base, parameter, warnings);
    }
    const normalizedValue = normalizeVocabularySearchValue(parameter.value);
    const match = vocabulary.entries.find(
      (entry) =>
        normalizeVocabularySearchValue(entry.value) === normalizedValue,
    );
    if (match) {
      return {
        ...base,
        value: parameter.value,
        status: "ok",
        warnings,
        matches: [vocabularyEntryPayload(match)],
      };
    }
    const invalidAlias = vocabulary.invalidAliases.find(
      (alias) =>
        normalizeVocabularySearchValue(alias.value) === normalizedValue,
    );
    if (invalidAlias) {
      return {
        ...base,
        value: parameter.value,
        status: "invalid_alias",
        warnings,
        matches: [],
        invalid_alias: vocabularyInvalidAliasPayload(invalidAlias),
      };
    }
    return {
      ...base,
      value: parameter.value,
      status: "not_found",
      warnings,
      matches: [],
    };
  }

  if (parameter.query) {
    return searchVocabulary(vocabulary, base, parameter, warnings);
  }

  return { ...base, status: "ok", warnings, matches: [] };
}

function searchVocabulary(
  vocabulary: HostedParameterVocabulary,
  base: {
    id: string;
    parameter_path: string;
    entry_count: number;
    invalid_alias_count: number;
  },
  parameter: HostedIntegrationParameterHelpRequest,
  warnings: string[],
): HostedIntegrationResolvedParameterHelp["vocabulary"] {
  const query = normalizeVocabularySearchValue(parameter.query ?? "");
  const matches = vocabulary.entries.filter((entry) =>
    vocabularyEntrySearchText(entry).includes(query),
  );
  const selected = matches.slice(0, parameter.limit);
  return {
    ...base,
    query: parameter.query,
    ...(parameter.value ? { ignored_value: parameter.value } : {}),
    status: selected.length > 0 ? "ok" : "not_found",
    truncated: matches.length > selected.length,
    warnings,
    matches: selected.map(vocabularyEntryPayload),
  };
}

function vocabularyRequestWarnings(
  parameter: HostedIntegrationParameterHelpRequest,
  inferredFromParameter: string | undefined,
): string[] {
  const warnings: string[] = [];
  if (parameter.query && parameter.value) {
    warnings.push(
      "query and value were both supplied; query was used and value was ignored.",
    );
  }
  if (inferredFromParameter) {
    warnings.push(
      `vocabulary lookup was inferred from ${inferredFromParameter}; request that parameter path directly for precise help.`,
    );
  }
  return warnings;
}

function ambiguousVocabularyHelp(
  parameter: HostedIntegrationParameterHelpRequest,
  candidateParameterPaths: string[],
): HostedIntegrationResolvedParameterHelp["vocabulary"] {
  return {
    query: parameter.query,
    ...(parameter.query
      ? { ignored_value: parameter.value }
      : { value: parameter.value }),
    status: "ambiguous_vocabulary",
    candidate_parameter_paths: candidateParameterPaths,
    warnings: [
      ...vocabularyRequestWarnings(parameter, undefined),
      `vocabulary lookup for ${parameter.name} is ambiguous; request one precise parameter path.`,
    ],
    matches: [],
  };
}

async function readVocabulary(
  filesRoot: string,
  vocabularyRef: string,
): Promise<HostedParameterVocabulary> {
  let value: string;
  try {
    value = await readTextFileUnderRoot(
      filesRoot,
      vocabularyRef,
      "generation references root",
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new HostedIntegrationHelpFileError(
        "help_file_not_found",
        `vocabulary file ${vocabularyRef} was not found`,
      );
    }
    throw new HostedIntegrationHelpFileError(
      "help_file_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return HostedParameterVocabularySchema.parse(parseYaml(value));
  } catch (error) {
    throw new HostedIntegrationHelpFileError(
      "help_file_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function vocabularyEntryPayload(entry: HostedParameterVocabularyEntry) {
  return {
    value: entry.value,
    summary: entry.summary,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.valueType ? { valueType: entry.valueType } : {}),
    valueTypes: entry.valueTypes,
    enumValues: entry.enumValues,
    operators: entry.operators,
    aliases: entry.aliases,
    canonicalTokens: entry.canonicalTokens,
    examples: entry.examples,
    ...(entry.section ? { section: entry.section } : {}),
    ...(entry.sourceMode ? { sourceMode: entry.sourceMode } : {}),
    ...(entry.apiFilterBodyUse
      ? { apiFilterBodyUse: entry.apiFilterBodyUse }
      : {}),
    ...(entry.source ? { source: entry.source } : {}),
  };
}

function vocabularyInvalidAliasPayload(
  alias: HostedParameterVocabularyInvalidAlias,
) {
  return {
    value: alias.value,
    reason: alias.reason,
    ...(alias.use ? { use: alias.use } : {}),
    ...(alias.source ? { source: alias.source } : {}),
  };
}

function vocabularyEntrySearchText(
  entry: HostedParameterVocabularyEntry,
): string {
  return [
    entry.value,
    entry.summary,
    entry.description,
    entry.valueType,
    entry.source,
    ...entry.aliases,
  ]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeVocabularySearchValue)
    .join("\n");
}

function normalizeVocabularySearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueParameterSuffixMatch(
  explicit: Record<string, HostedIntegrationToolHelp["parameters"][string]>,
  requestedName: string,
): HostedIntegrationToolHelp["parameters"][string] | undefined {
  if (requestedName.includes(".")) return undefined;
  const suffix = `.${requestedName}`;
  const matches = Object.entries(explicit).filter(([name]) =>
    name.endsWith(suffix),
  );
  return matches.length === 1 ? matches[0]![1] : undefined;
}

function nestedVocabularyParameterMatch(
  explicit: Record<string, HostedIntegrationToolHelp["parameters"][string]>,
  requestedName: string,
):
  | {
      type: "single";
      name: string;
      metadata: HostedIntegrationToolHelp["parameters"][string] & {
        vocabularyRef: string;
      };
    }
  | { type: "ambiguous"; names: string[] }
  | null {
  const prefix = `${requestedName}.`;
  const matches = Object.entries(explicit).filter(
    ([name, metadata]) =>
      name.startsWith(prefix) && typeof metadata.vocabularyRef === "string",
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { type: "ambiguous", names: matches.map(([name]) => name) };
  }
  const [name, metadata] = matches[0]!;
  return {
    type: "single",
    name,
    metadata: metadata as HostedIntegrationToolHelp["parameters"][string] & {
      vocabularyRef: string;
    },
  };
}

async function resolveHelpText(
  filesRoot: string,
  value: string,
): Promise<string> {
  if (!isHostedIntegrationHelpFileReference(value)) return value;
  try {
    return await readTextFileUnderRoot(
      filesRoot,
      value,
      "generation help root",
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new HostedIntegrationHelpFileError(
        "help_file_not_found",
        `help file ${value} was not found`,
      );
    }
    throw new HostedIntegrationHelpFileError(
      "help_file_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function isHostedIntegrationHelpFileReference(value: string): boolean {
  return HELP_FILE_PATTERN.test(value) || value.startsWith("help/");
}

function fallbackFullToolHelp(tool: HostedIntegrationToolSpec): string {
  return [
    tool.description,
    `Operation: ${tool.classification.operation}.`,
    `Freshness: ${tool.classification.freshness}.`,
    `Execution: ${tool.classification.execution}.`,
    `Approval: ${tool.classification.approval}.`,
  ].join("\n");
}

function fallbackParameterSummary(name: string, shape: JsonObject): string {
  const type = typeof shape.type === "string" ? shape.type : "value";
  return `${name} accepts a ${type} matching the tool input schema.`;
}

function fallbackFullParameterHelp(
  name: string,
  shape: JsonObject | undefined,
): string {
  if (!shape) return `No explicit help metadata is registered for ${name}.`;
  return `Schema for ${name}: ${JSON.stringify(shape)}`;
}

function schemaShapeForPath(
  schema: JsonObject,
  parameterPath: string,
): JsonObject | undefined {
  const parts = parameterPath.split(".");
  let current: JsonObject | undefined = schema;
  for (const part of parts) {
    const properties = current?.properties;
    if (!isRecord(properties)) return undefined;
    const next = properties[part];
    if (!isRecord(next)) return undefined;
    current = next as JsonObject;
  }
  return current;
}

function examplePayload(example: HostedIntegrationExample): JsonValue {
  return {
    id: example.id,
    category: example.category,
    args: example.args,
    ...(example.expected === undefined ? {} : { expected: example.expected }),
  };
}

class HostedIntegrationHelpFileError extends Error {
  constructor(
    readonly code: "help_file_not_found" | "help_file_invalid",
    message: string,
  ) {
    super(message);
  }
}

function helpFileError(error: unknown): ResolveHostedIntegrationToolHelpResult {
  if (error instanceof HostedIntegrationHelpFileError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
