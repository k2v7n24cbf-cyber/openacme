import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  FamilyManifestSchema,
  HostedIntegrationExampleSchema,
  type FamilyManifest,
} from "./schemas.js";
import type { HostedIntegrationCatalog } from "./catalog.js";
import { resolveHostedIntegrationPythonDependencies } from "./dependencies.js";
import type { HostedIntegrationDraftStore } from "./drafts.js";

const MANIFEST_FILE = "family.yaml";
const EXAMPLES_FILE = "examples.yaml";

const ExamplesDocumentSchema = z
  .object({
    examples: z.array(HostedIntegrationExampleSchema).default([]),
  })
  .strict();

export interface HostedIntegrationValidationDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface HostedIntegrationValidationResult {
  ok: boolean;
  diagnostics: HostedIntegrationValidationDiagnostic[];
}

export interface HostedIntegrationDraftValidatorOptions {
  draftStore: HostedIntegrationDraftStore;
  catalog: HostedIntegrationCatalog;
}

export interface HostedIntegrationDraftValidator {
  validateDraft(draftId: string): Promise<HostedIntegrationValidationResult>;
}

export function createFileHostedIntegrationDraftValidator(
  options: HostedIntegrationDraftValidatorOptions,
): HostedIntegrationDraftValidator {
  return new FileHostedIntegrationDraftValidator(
    options.draftStore,
    options.catalog,
  );
}

class FileHostedIntegrationDraftValidator implements HostedIntegrationDraftValidator {
  constructor(
    private readonly draftStore: HostedIntegrationDraftStore,
    private readonly catalog: HostedIntegrationCatalog,
  ) {}

  async validateDraft(
    draftId: string,
  ): Promise<HostedIntegrationValidationResult> {
    const diagnostics: HostedIntegrationValidationDiagnostic[] = [];
    const draft = await this.draftStore.getDraft(draftId);
    if (!draft) {
      diagnostics.push(
        errorDiagnostic("draft_not_found", "$", "draft not found"),
      );
      return resultFromDiagnostics(diagnostics);
    }

    const manifest = await this.readManifest(draftId, diagnostics);
    if (!manifest) return resultFromDiagnostics(diagnostics);

    if (manifest.id !== draft.familyId) {
      diagnostics.push(
        errorDiagnostic(
          "family_mismatch",
          "$.id",
          `draft family ${draft.familyId} does not match manifest ${manifest.id}`,
        ),
      );
    }

    this.validateUniqueToolNames(manifest, diagnostics);
    await this.validateRequiredFiles(draftId, manifest, diagnostics);
    this.validateDependencyPolicy(manifest, diagnostics);
    await this.validateBreakingToolRemoval(manifest, diagnostics);
    await this.validateExamples(draftId, manifest, diagnostics);

    return resultFromDiagnostics(diagnostics);
  }

  private async readManifest(
    draftId: string,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<FamilyManifest | null> {
    const manifestFile = await this.draftStore.readDraftFile({
      draftId,
      path: MANIFEST_FILE,
    });
    if (!manifestFile.ok) {
      diagnostics.push(
        errorDiagnostic(
          "required_file_missing",
          `$.files.${MANIFEST_FILE}`,
          "family.yaml is required",
        ),
      );
      return null;
    }

    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(manifestFile.content);
    } catch (error) {
      diagnostics.push(
        errorDiagnostic(
          "manifest_yaml_invalid",
          "$",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return null;
    }

    const parsedManifest = FamilyManifestSchema.safeParse(parsedYaml);
    if (!parsedManifest.success) {
      diagnostics.push(
        ...zodDiagnostics("manifest_invalid", parsedManifest.error),
      );
      return null;
    }
    return parsedManifest.data;
  }

  private validateUniqueToolNames(
    manifest: FamilyManifest,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    const seen = new Set<string>();
    manifest.tools.forEach((tool, index) => {
      if (seen.has(tool.name)) {
        diagnostics.push(
          errorDiagnostic(
            "duplicate_tool_name",
            `$.tools.${index}.name`,
            `tool name ${tool.name} is duplicated`,
          ),
        );
      }
      seen.add(tool.name);
    });
  }

  private async validateRequiredFiles(
    draftId: string,
    manifest: FamilyManifest,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    const entrypoint = await this.draftStore.readDraftFile({
      draftId,
      path: manifest.runtime.entrypoint,
    });
    if (!entrypoint.ok) {
      diagnostics.push(
        errorDiagnostic(
          "required_file_missing",
          `$.runtime.entrypoint`,
          `runtime entrypoint ${manifest.runtime.entrypoint} is missing`,
        ),
      );
    }
  }

  private validateDependencyPolicy(
    manifest: FamilyManifest,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    const resolved = resolveHostedIntegrationPythonDependencies(
      manifest.runtime,
    );
    if (!resolved.ok) diagnostics.push(...resolved.diagnostics);
  }

  private async validateBreakingToolRemoval(
    manifest: FamilyManifest,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    const source = await this.catalog.getFamily(manifest.id);
    if (!source) return;

    const nextToolNames = new Set(manifest.tools.map((tool) => tool.name));
    for (const sourceTool of source.manifest.tools) {
      if (sourceTool.lifecycle === "removed") continue;
      if (nextToolNames.has(sourceTool.name)) continue;
      diagnostics.push(
        errorDiagnostic(
          "breaking_tool_removal",
          "$.tools",
          `tool ${sourceTool.name} exists in source and cannot be removed directly`,
        ),
      );
    }
  }

  private async validateExamples(
    draftId: string,
    manifest: FamilyManifest,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    const examplesFile = await this.draftStore.readDraftFile({
      draftId,
      path: EXAMPLES_FILE,
    });
    if (!examplesFile.ok) return;

    let parsedExamples: z.infer<typeof ExamplesDocumentSchema>;
    try {
      parsedExamples = ExamplesDocumentSchema.parse(
        parseYaml(examplesFile.content),
      );
    } catch (error) {
      diagnostics.push(
        errorDiagnostic(
          "examples_invalid",
          "$.examples",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    parsedExamples.examples.forEach((example, index) => {
      if (example.familyId !== manifest.id) {
        diagnostics.push(
          errorDiagnostic(
            "example_family_mismatch",
            `$.examples.${index}.familyId`,
            `example family ${example.familyId} does not match manifest ${manifest.id}`,
          ),
        );
      }
      const tool = tools.get(example.toolName);
      if (!tool) {
        diagnostics.push(
          errorDiagnostic(
            "example_tool_not_found",
            `$.examples.${index}.toolName`,
            `example references unknown tool ${example.toolName}`,
          ),
        );
      } else if (
        tool.classification.operation === "destructive" &&
        example.category !== "destructive_requires_human"
      ) {
        diagnostics.push(
          errorDiagnostic(
            "destructive_example_requires_human",
            `$.examples.${index}.category`,
            `destructive tool example ${example.id} requires destructive_requires_human`,
          ),
        );
      }
    });
  }
}

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
  path: string,
  message: string,
): HostedIntegrationValidationDiagnostic {
  return { severity: "error", code, path, message };
}

function resultFromDiagnostics(
  diagnostics: HostedIntegrationValidationDiagnostic[],
): HostedIntegrationValidationResult {
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
  };
}
