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
  FamilyManifestSchema,
  HostedIntegrationExampleSchema,
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type FamilyManifest,
  type HostedIntegrationExample,
  type HostedIntegrationGeneration,
  type HostedIntegrationToolHelp,
  type HostedIntegrationToolName,
  type HostedIntegrationToolSpec,
  type JsonObject,
  type JsonValue,
} from "./schemas.js";

const MANIFEST_FILE = "family.yaml";
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

export const HostedIntegrationResolvedParameterHelpSchema = z
  .object({
    summary: z.string().optional(),
    full: z.string().optional(),
    shape: JsonObjectSchema.optional(),
    rules: z.array(z.string()).default([]),
    examples: z.array(JsonValueSchema).default([]),
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
  const manifest = await readGenerationManifest(filesRoot);
  if (manifest.id !== familyId) {
    return {
      ok: false,
      error: {
        code: "family_not_found",
        message: "generation manifest does not match requested family",
      },
    };
  }
  const tool = manifest.tools.find((candidate) => candidate.name === toolName);
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

async function readGenerationManifest(
  filesRoot: string,
): Promise<FamilyManifest> {
  const raw = await readFile(
    resolveInsideRoot(filesRoot, MANIFEST_FILE, "generation files root"),
    "utf-8",
  );
  return FamilyManifestSchema.parse(parseYaml(raw));
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
  const selected =
    requested ??
    Object.keys(explicit).map((name) => ({
      name,
      detail: toolDetail === "full" ? ("full" as const) : ("summary" as const),
      include_examples: includeToolExamples,
    }));
  const result: Record<string, HostedIntegrationResolvedParameterHelp> = {};
  for (const parameter of selected) {
    const metadata =
      explicit[parameter.name] ??
      uniqueParameterSuffixMatch(explicit, parameter.name);
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
    result[parameter.name] =
      HostedIntegrationResolvedParameterHelpSchema.parse(entry);
  }
  return result;
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
