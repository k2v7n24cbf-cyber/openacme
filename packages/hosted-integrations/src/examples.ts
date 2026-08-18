import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  FamilyManifestSchema,
  HostedIntegrationExampleSchema,
  HostedToolContractDocumentSchema,
  hostedToolContractToToolSpecs,
  type FamilyManifest,
  type HostedIntegrationExample,
  type HostedIntegrationToolSpec,
  type JsonObject,
  type JsonValue,
} from "./schemas.js";
import type { HostedIntegrationDraftStore } from "./drafts.js";
import {
  HOSTED_INTEGRATION_MANIFEST_FILE,
  HOSTED_TOOL_CONTRACT_FILE,
} from "./catalog.js";

const EXAMPLES_FILE = "examples.yaml";

const ExamplesDocumentSchema = z
  .object({
    examples: z.array(HostedIntegrationExampleSchema).default([]),
  })
  .strict();

export interface HostedIntegrationExampleRegistryOptions {
  draftStore: HostedIntegrationDraftStore;
}

export interface UpsertHostedIntegrationExampleRequest {
  draftId: string;
  lockId: string;
  example: HostedIntegrationExample;
}

export type UpsertHostedIntegrationExampleResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "lock_required" }
  | { ok: false; reason: "family_mismatch" | "tool_not_found" }
  | {
      ok: false;
      reason: "invalid_args";
      message: string;
    }
  | { ok: false; reason: "destructive_example_requires_human" };

export interface HostedIntegrationExampleRegistry {
  listExamples(draftId: string): Promise<HostedIntegrationExample[]>;
  upsertExample(
    request: UpsertHostedIntegrationExampleRequest,
  ): Promise<UpsertHostedIntegrationExampleResult>;
}

export function createFileHostedIntegrationExampleRegistry(
  options: HostedIntegrationExampleRegistryOptions,
): HostedIntegrationExampleRegistry {
  return new FileHostedIntegrationExampleRegistry(options.draftStore);
}

class FileHostedIntegrationExampleRegistry implements HostedIntegrationExampleRegistry {
  constructor(private readonly draftStore: HostedIntegrationDraftStore) {}

  async listExamples(draftId: string): Promise<HostedIntegrationExample[]> {
    return this.readExamples(draftId);
  }

  async upsertExample(
    request: UpsertHostedIntegrationExampleRequest,
  ): Promise<UpsertHostedIntegrationExampleResult> {
    const manifest = await this.readManifest(request.draftId);
    if (!manifest) return { ok: false, reason: "not_found" };

    const parsedExample = HostedIntegrationExampleSchema.parse(request.example);
    if (parsedExample.familyId !== manifest.id) {
      return { ok: false, reason: "family_mismatch" };
    }

    const tools = await this.readTools(request.draftId);
    if (!tools) return { ok: false, reason: "not_found" };
    const tool = tools.find(
      (candidate) => candidate.name === parsedExample.toolName,
    );
    if (!tool) return { ok: false, reason: "tool_not_found" };

    if (
      tool.classification.operation === "destructive" &&
      parsedExample.category !== "destructive_requires_human"
    ) {
      return { ok: false, reason: "destructive_example_requires_human" };
    }

    if (parsedExample.category !== "discovery_required") {
      const argsIssue = validateJsonSchemaValue(
        tool.inputSchema,
        parsedExample.args,
        "$",
      );
      if (argsIssue) {
        return { ok: false, reason: "invalid_args", message: argsIssue };
      }
    }

    const examples = await this.readExamples(request.draftId);
    const existingIndex = examples.findIndex(
      (example) => example.id === parsedExample.id,
    );
    const nextExamples =
      existingIndex === -1
        ? [...examples, parsedExample]
        : examples.map((example, index) =>
            index === existingIndex ? parsedExample : example,
          );

    const writeResult = await this.draftStore.writeDraftFile({
      draftId: request.draftId,
      lockId: request.lockId,
      path: EXAMPLES_FILE,
      content: stringifyYaml({ examples: nextExamples }),
    });
    if (!writeResult.ok) return writeResult;
    return { ok: true };
  }

  private async readManifest(draftId: string): Promise<FamilyManifest | null> {
    const result = await this.draftStore.readDraftFile({
      draftId,
      path: HOSTED_INTEGRATION_MANIFEST_FILE,
    });
    if (!result.ok) return null;
    return FamilyManifestSchema.parse(parseYaml(result.content));
  }

  private async readTools(
    draftId: string,
  ): Promise<HostedIntegrationToolSpec[] | null> {
    const result = await this.draftStore.readDraftFile({
      draftId,
      path: HOSTED_TOOL_CONTRACT_FILE,
    });
    if (!result.ok) return null;
    const contract = HostedToolContractDocumentSchema.parse(
      parseYaml(result.content),
    );
    return hostedToolContractToToolSpecs(contract);
  }

  private async readExamples(
    draftId: string,
  ): Promise<HostedIntegrationExample[]> {
    const result = await this.draftStore.readDraftFile({
      draftId,
      path: EXAMPLES_FILE,
    });
    if (!result.ok) return [];
    return ExamplesDocumentSchema.parse(parseYaml(result.content)).examples;
  }
}

function validateJsonSchemaValue(
  schema: JsonObject,
  value: JsonValue,
  path: string,
): string | null {
  if ("const" in schema && !jsonEquals(value, schema.const)) {
    return `${path} must equal ${JSON.stringify(schema.const)}`;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => jsonEquals(value, item))
  ) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}`;
  }

  const typeIssue = validateJsonSchemaType(schema.type, value, path);
  if (typeIssue) return typeIssue;

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      return `${path} must have length >= ${schema.minLength}`;
    }
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const key of required) {
      if (!(key in value)) return `${path}.${key} is required`;
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isJsonSchemaObject(childSchema)) continue;
      const issue = validateJsonSchemaValue(
        childSchema,
        value[key] as JsonValue,
        `${path}.${key}`,
      );
      if (issue) return issue;
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      const extra = Object.keys(value).find((key) => !allowed.has(key));
      if (extra) return `${path}.${extra} is not allowed`;
    }
  }

  return null;
}

function validateJsonSchemaType(
  type: JsonValue | undefined,
  value: JsonValue,
  path: string,
): string | null {
  if (type === undefined) return null;
  const allowed = Array.isArray(type)
    ? type.filter(isJsonSchemaType)
    : isJsonSchemaType(type)
      ? [type]
      : [];
  if (allowed.length === 0) return null;
  return allowed.some((item) => jsonSchemaTypeMatches(item, value))
    ? null
    : `${path} must be ${allowed.join(" or ")}`;
}

function jsonSchemaTypeMatches(
  type: JsonSchemaType,
  value: JsonValue,
): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number";
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
  }
}

type JsonSchemaType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

function isJsonSchemaType(value: unknown): value is JsonSchemaType {
  return (
    value === "array" ||
    value === "boolean" ||
    value === "integer" ||
    value === "null" ||
    value === "number" ||
    value === "object" ||
    value === "string"
  );
}

function isJsonSchemaObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
