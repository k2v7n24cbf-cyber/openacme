import { spawn } from "node:child_process";
import { parse as parseYaml, parseDocument } from "yaml";
import { z } from "zod";
import {
  HOSTED_INTEGRATION_MANIFEST_FILE,
  HOSTED_TOOL_CONTRACT_FILE,
  type HostedIntegrationCatalog,
} from "./catalog.js";
import { buildHostedToolName } from "./naming.js";
import {
  FamilyManifestSchema,
  HostedIntegrationExampleSchema,
  HostedParameterVocabularySchema,
  HostedToolContractDocumentSchema,
  hostedToolContractToToolSpecs,
  type FamilyManifest,
  type HostedIntegrationExample,
  type HostedIntegrationToolSpec,
  type HostedToolContractDocument,
  type HostedToolContractTool,
} from "./schemas.js";
import { resolveHostedIntegrationCachePath } from "./cache.js";
import { resolveHostedIntegrationPythonDependencies } from "./dependencies.js";
import type { HostedIntegrationDraftStore } from "./drafts.js";
import { isHostedIntegrationHelpFileReference } from "./help.js";

const EXAMPLES_FILE = "examples.yaml";
const PYTHON_BIN =
  process.env["OPENACME_PYTHON"] ?? process.env["PYTHON"] ?? "python3";

const PYTHON_HANDLER_ANALYZER = String.raw`
import ast
import json
import sys
import traceback

try:
    source = sys.stdin.read()
    tree = ast.parse(source)
    functions = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            positional = [arg.arg for arg in [*node.args.posonlyargs, *node.args.args]]
            functions.append({
                "name": node.name,
                "positionalArgs": positional,
                "vararg": node.args.vararg.arg if node.args.vararg else None,
                "kwarg": node.args.kwarg.arg if node.args.kwarg else None,
                "isAsync": isinstance(node, ast.AsyncFunctionDef),
            })
    print(json.dumps({"ok": True, "functions": functions}))
except SyntaxError as exc:
    print(json.dumps({
        "ok": False,
        "code": "python_source_invalid",
        "message": str(exc),
    }))
except BaseException:
    print(json.dumps({
        "ok": False,
        "code": "python_source_analysis_failed",
        "message": traceback.format_exc(),
    }))
`;

const STANDARD_PYTHON_HOOKS = [
  { name: "authenticate", positionalArgs: ["ctx"] },
  {
    name: "before_tool_call",
    positionalArgs: ["tool_name", "args", "ctx", "auth"],
  },
  {
    name: "after_tool_call",
    positionalArgs: ["tool_name", "args", "ctx", "result", "auth"],
  },
] as const;

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
  helpQualityMode?: "warning" | "error";
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
    options.helpQualityMode ?? "warning",
  );
}

class FileHostedIntegrationDraftValidator implements HostedIntegrationDraftValidator {
  constructor(
    private readonly draftStore: HostedIntegrationDraftStore,
    private readonly catalog: HostedIntegrationCatalog,
    private readonly helpQualityMode: "warning" | "error",
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
    const toolContract = await this.readToolContract(draftId, diagnostics);
    if (!toolContract) return resultFromDiagnostics(diagnostics);

    if (manifest.id !== draft.familyId) {
      diagnostics.push(
        errorDiagnostic(
          "family_mismatch",
          "$.id",
          `draft family ${draft.familyId} does not match manifest ${manifest.id}`,
        ),
      );
    }
    if (toolContract.family.id !== manifest.id) {
      diagnostics.push(
        errorDiagnostic(
          "tool_contract_family_mismatch",
          "$.family.id",
          `${HOSTED_TOOL_CONTRACT_FILE} family ${toolContract.family.id} does not match manifest ${manifest.id}`,
        ),
      );
    }

    this.validateToolContract(toolContract, diagnostics);
    const tools = hostedToolContractToToolSpecs(toolContract);
    this.validateUniqueToolNames(tools, diagnostics);
    this.validateCacheContract(tools, diagnostics);
    const entrypoint = await this.validateRequiredFiles(
      draftId,
      manifest,
      diagnostics,
    );
    if (entrypoint) {
      await this.validatePythonHandlerContract(
        manifest,
        tools,
        entrypoint,
        diagnostics,
      );
    }
    await this.validateHelpReferences(draftId, tools, diagnostics);
    await this.validateVocabularyReferences(draftId, toolContract, diagnostics);
    await this.validateProviderReferences(draftId, toolContract, diagnostics);
    this.validateDependencyPolicy(manifest, diagnostics);
    await this.validateBreakingToolRemoval(manifest, tools, diagnostics);
    const examples = await this.validateExamples(
      draftId,
      manifest,
      tools,
      diagnostics,
    );
    this.validateHelpQuality(tools, examples, diagnostics);

    return resultFromDiagnostics(diagnostics);
  }

  private async readManifest(
    draftId: string,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<FamilyManifest | null> {
    const manifestFile = await this.draftStore.readDraftFile({
      draftId,
      path: HOSTED_INTEGRATION_MANIFEST_FILE,
    });
    if (!manifestFile.ok) {
      diagnostics.push(
        errorDiagnostic(
          "required_file_missing",
          `$.files.${HOSTED_INTEGRATION_MANIFEST_FILE}`,
          `${HOSTED_INTEGRATION_MANIFEST_FILE} is required`,
        ),
      );
      return null;
    }

    const parsedYaml = parseStrictYaml(
      manifestFile.content,
      "manifest_yaml_invalid",
      "$",
      diagnostics,
    );
    if (parsedYaml === null) {
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

  private async readToolContract(
    draftId: string,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<HostedToolContractDocument | null> {
    const toolContractFile = await this.draftStore.readDraftFile({
      draftId,
      path: HOSTED_TOOL_CONTRACT_FILE,
    });
    if (!toolContractFile.ok) {
      diagnostics.push(
        errorDiagnostic(
          "required_file_missing",
          `$.files.${HOSTED_TOOL_CONTRACT_FILE}`,
          `${HOSTED_TOOL_CONTRACT_FILE} is required`,
        ),
      );
      return null;
    }

    const parsedYaml = parseStrictYaml(
      toolContractFile.content,
      "tool_contract_yaml_invalid",
      "$",
      diagnostics,
    );
    if (parsedYaml === null) {
      return null;
    }
    const parsedToolContract =
      HostedToolContractDocumentSchema.safeParse(parsedYaml);
    if (!parsedToolContract.success) {
      diagnostics.push(
        ...zodDiagnostics("tool_contract_invalid", parsedToolContract.error),
      );
      return null;
    }
    return parsedToolContract.data;
  }

  private validateToolContract(
    contract: HostedToolContractDocument,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    contract.tools.forEach((tool, index) => {
      const expectedHostedName = buildHostedToolName({
        familyId: contract.family.id,
        toolName: tool.openacme.toolName,
      });
      if (tool.mcp.name !== expectedHostedName) {
        diagnostics.push(
          errorDiagnostic(
            "mcp_name_mismatch",
            `$.tools.${index}.mcp.name`,
            `mcp.name must be ${expectedHostedName}`,
          ),
        );
      }
      const expectedFunction = `tool_${tool.openacme.toolName}`;
      if (tool.openacme.function !== expectedFunction) {
        diagnostics.push(
          errorDiagnostic(
            "tool_function_mismatch",
            `$.tools.${index}.openacme.function`,
            `openacme.function must be ${expectedFunction}`,
          ),
        );
      }
      this.validateMcpAnnotations(tool, index, diagnostics);
    });
  }

  private validateMcpAnnotations(
    tool: HostedToolContractTool,
    index: number,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    const operation = tool.openacme.classification.operation;
    const annotations = tool.mcp.annotations;
    if (operation === "read" && annotations.readOnlyHint !== true) {
      diagnostics.push(
        errorDiagnostic(
          "mcp_annotation_read_only_mismatch",
          `$.tools.${index}.mcp.annotations.readOnlyHint`,
          `read tool ${tool.openacme.toolName} requires readOnlyHint: true`,
        ),
      );
    }
    if (operation === "destructive" && annotations.destructiveHint !== true) {
      diagnostics.push(
        errorDiagnostic(
          "mcp_annotation_destructive_mismatch",
          `$.tools.${index}.mcp.annotations.destructiveHint`,
          `destructive tool ${tool.openacme.toolName} requires destructiveHint: true`,
        ),
      );
    }
    if (
      tool.openacme.classification.idempotency === "idempotent" &&
      annotations.idempotentHint !== true
    ) {
      diagnostics.push(
        errorDiagnostic(
          "mcp_annotation_idempotency_mismatch",
          `$.tools.${index}.mcp.annotations.idempotentHint`,
          `idempotent tool ${tool.openacme.toolName} requires idempotentHint: true`,
        ),
      );
    }
  }

  private validateUniqueToolNames(
    tools: HostedIntegrationToolSpec[],
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    const seen = new Set<string>();
    tools.forEach((tool, index) => {
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
  ): Promise<string | null> {
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
      return null;
    }
    return entrypoint.content;
  }

  private async validatePythonHandlerContract(
    manifest: FamilyManifest,
    tools: HostedIntegrationToolSpec[],
    source: string,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    const analysis = await analyzePythonEntrypoint(source);
    if (!analysis.ok) {
      diagnostics.push(
        errorDiagnostic(
          analysis.code,
          "$.runtime.entrypoint",
          analysis.message,
        ),
      );
      return;
    }

    const functions = new Map(
      analysis.functions.map((entry) => [entry.name, entry]),
    );
    const activeTools = tools
      .map((tool, index) => ({ tool, index }))
      .filter(({ tool }) => tool.lifecycle !== "removed");
    for (const { tool, index } of activeTools) {
      const handlerName = derivedPythonHandlerName(tool.name);
      const handler = functions.get(handlerName);
      if (!handler) {
        diagnostics.push(
          errorDiagnostic(
            "python_handler_missing",
            `$.tools.${index}.name`,
            `tool ${tool.name} requires Python handler ${handlerName}(args, context)`,
          ),
        );
        continue;
      }
      if (!hasValidDerivedHandlerSignature(handler)) {
        diagnostics.push(
          errorDiagnostic(
            "python_handler_signature_invalid",
            `$.tools.${index}.name`,
            `handler ${handlerName} must be defined as ${handlerName}(args, context)`,
          ),
        );
      }
    }
    this.validateStandardPythonHooks(manifest, functions, diagnostics);
  }

  private validateStandardPythonHooks(
    manifest: FamilyManifest,
    functions: Map<string, PythonEntrypointFunction>,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    for (const hook of STANDARD_PYTHON_HOOKS) {
      const fn = functions.get(hook.name);
      if (!fn) {
        const justification = manifest.hookJustifications[hook.name];
        if (justification && justification.trim().length > 0) continue;
        diagnostics.push(
          errorDiagnostic(
            "python_hook_missing",
            `$.hookJustifications.${hook.name}`,
            `standard hook ${hook.name} is missing; define ${hook.name}(${hook.positionalArgs.join(
              ", ",
            )}) or add hookJustifications.${hook.name}`,
          ),
        );
        continue;
      }
      if (!hasValidPythonSignature(fn, hook.positionalArgs)) {
        diagnostics.push(
          errorDiagnostic(
            "python_hook_signature_invalid",
            `$.runtime.entrypoint.${hook.name}`,
            `standard hook ${hook.name} must be defined as ${hook.name}(${hook.positionalArgs.join(
              ", ",
            )})`,
          ),
        );
      }
    }
  }

  private async validateHelpReferences(
    draftId: string,
    tools: HostedIntegrationToolSpec[],
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    for (const [toolIndex, tool] of tools.entries()) {
      const refs: Array<{ path: string; value: string }> = [];
      if (tool.help?.full) {
        refs.push({
          path: `$.tools.${toolIndex}.help.full`,
          value: tool.help.full,
        });
      }
      for (const [parameterName, parameter] of Object.entries(
        tool.help?.parameters ?? {},
      )) {
        if (!parameter.full) continue;
        refs.push({
          path: `$.tools.${toolIndex}.help.parameters.${parameterName}.full`,
          value: parameter.full,
        });
      }
      for (const ref of refs) {
        if (!isHostedIntegrationHelpFileReference(ref.value)) continue;
        if (isUnsafeHelpReference(ref.value)) {
          diagnostics.push(
            errorDiagnostic(
              "help_file_path_invalid",
              ref.path,
              `help reference ${ref.value} must stay inside family help files`,
            ),
          );
          continue;
        }
        const read = await this.draftStore.readDraftFile({
          draftId,
          path: ref.value,
        });
        if (!read.ok) {
          diagnostics.push(
            errorDiagnostic(
              "help_file_missing",
              ref.path,
              `help reference ${ref.value} is missing`,
            ),
          );
        }
      }
    }
  }

  private async validateVocabularyReferences(
    draftId: string,
    contract: HostedToolContractDocument,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    for (const [toolIndex, tool] of contract.tools.entries()) {
      for (const [parameterName, parameter] of Object.entries(
        tool.openacme.parameterHelp,
      )) {
        const vocabularyRef = parameter.vocabularyRef;
        if (!vocabularyRef) continue;
        const diagnosticPath = `$.tools.${toolIndex}.openacme.parameterHelp.${parameterName}.vocabularyRef`;
        if (!isHostedIntegrationVocabularyReference(vocabularyRef)) {
          diagnostics.push(
            errorDiagnostic(
              "vocabulary_ref_invalid",
              diagnosticPath,
              `vocabulary reference ${vocabularyRef} must be a references/*.yaml, references/*.yml, or references/*.json file`,
            ),
          );
          continue;
        }
        if (isUnsafeHelpReference(vocabularyRef)) {
          diagnostics.push(
            errorDiagnostic(
              "vocabulary_ref_invalid",
              diagnosticPath,
              `vocabulary reference ${vocabularyRef} must stay inside family reference files`,
            ),
          );
          continue;
        }
        const read = await this.draftStore.readDraftFile({
          draftId,
          path: vocabularyRef,
        });
        if (!read.ok) {
          diagnostics.push(
            errorDiagnostic(
              "vocabulary_ref_missing",
              diagnosticPath,
              `vocabulary reference ${vocabularyRef} is missing`,
            ),
          );
          continue;
        }
        let parsed: unknown;
        try {
          parsed = parseYaml(read.content);
        } catch (error) {
          diagnostics.push(
            errorDiagnostic(
              "vocabulary_ref_invalid",
              diagnosticPath,
              error instanceof Error ? error.message : String(error),
            ),
          );
          continue;
        }
        const vocabulary = HostedParameterVocabularySchema.safeParse(parsed);
        if (!vocabulary.success) {
          diagnostics.push(
            ...zodDiagnostics("vocabulary_ref_invalid", vocabulary.error).map(
              (diagnostic) => ({
                ...diagnostic,
                path: `${diagnosticPath}${diagnostic.path === "$" ? "" : diagnostic.path.slice(1)}`,
              }),
            ),
          );
          continue;
        }
        if (vocabulary.data.familyId !== contract.family.id) {
          diagnostics.push(
            errorDiagnostic(
              "vocabulary_family_mismatch",
              diagnosticPath,
              `vocabulary family ${vocabulary.data.familyId} does not match contract family ${contract.family.id}`,
            ),
          );
        }
        if (vocabulary.data.parameterPath !== parameterName) {
          diagnostics.push(
            errorDiagnostic(
              "vocabulary_parameter_path_mismatch",
              diagnosticPath,
              `vocabulary parameterPath ${vocabulary.data.parameterPath} does not match parameter help path ${parameterName}`,
            ),
          );
        }
      }
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

  private async validateProviderReferences(
    draftId: string,
    contract: HostedToolContractDocument,
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    for (const [toolIndex, tool] of contract.tools.entries()) {
      const providerRef = tool.openacme.providerRef;
      if (!providerRef) continue;
      const read = await this.draftStore.readDraftFile({
        draftId,
        path: providerRef.path,
      });
      if (!read.ok) {
        diagnostics.push(
          errorDiagnostic(
            "provider_ref_missing",
            `$.tools.${toolIndex}.openacme.providerRef.path`,
            `provider reference ${providerRef.path} is missing`,
          ),
        );
      }
    }
  }

  private validateCacheContract(
    tools: HostedIntegrationToolSpec[],
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    tools.forEach((tool, index) => {
      const path = `$.tools.${index}.cache`;
      const freshness = tool.classification.freshness;
      if (freshness === "live" && tool.cache) {
        diagnostics.push(
          errorDiagnostic(
            "cache_not_allowed",
            path,
            "live tools cannot declare cache metadata",
          ),
        );
      }
      if ((freshness === "cached" || freshness === "sync") && !tool.cache) {
        diagnostics.push(
          errorDiagnostic(
            "cache_metadata_required",
            path,
            `${freshness} tools must declare family-home cache metadata`,
          ),
        );
      }
      if (!tool.cache) return;
      try {
        resolveHostedIntegrationCachePath({
          familyHome: "/family-home",
          cache: tool.cache,
        });
      } catch (error) {
        diagnostics.push(
          errorDiagnostic(
            "cache_path_invalid",
            `${path}.path`,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    });
  }

  private async validateBreakingToolRemoval(
    manifest: FamilyManifest,
    tools: HostedIntegrationToolSpec[],
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<void> {
    const source = await this.catalog.getFamily(manifest.id);
    if (!source) return;

    const nextToolNames = new Set(tools.map((tool) => tool.name));
    for (const sourceTool of source.tools) {
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
    tools: HostedIntegrationToolSpec[],
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): Promise<HostedIntegrationExample[]> {
    const examplesFile = await this.draftStore.readDraftFile({
      draftId,
      path: EXAMPLES_FILE,
    });
    if (!examplesFile.ok) return [];

    let parsedExamples: z.infer<typeof ExamplesDocumentSchema>;
    try {
      const parsedYaml = parseStrictYaml(
        examplesFile.content,
        "examples_invalid",
        "$.examples",
        diagnostics,
      );
      if (parsedYaml === null) return [];
      parsedExamples = ExamplesDocumentSchema.parse(
        parsedYaml,
      );
    } catch (error) {
      diagnostics.push(
        errorDiagnostic(
          "examples_invalid",
          "$.examples",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return [];
    }

    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
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
      const tool = toolsByName.get(example.toolName);
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
    return parsedExamples.examples;
  }

  private validateHelpQuality(
    tools: HostedIntegrationToolSpec[],
    examples: HostedIntegrationExample[],
    diagnostics: HostedIntegrationValidationDiagnostic[],
  ): void {
    const examplesByTool = new Map<string, HostedIntegrationExample[]>();
    for (const example of examples) {
      const existing = examplesByTool.get(example.toolName) ?? [];
      existing.push(example);
      examplesByTool.set(example.toolName, existing);
    }

    tools.forEach((tool, toolIndex) => {
      if (tool.lifecycle === "removed") return;
      const toolPath = `$.tools.${toolIndex}`;
      this.requireHelpField(
        diagnostics,
        tool.help?.summary,
        "help_summary_missing",
        `${toolPath}.help.summary`,
        `tool ${tool.name} requires help.summary for autonomous use`,
      );
      if ((tool.errors?.length ?? 0) === 0) {
        diagnostics.push(
          this.helpQualityDiagnostic(
            "help_errors_missing",
            `${toolPath}.openacme.errors`,
            `tool ${tool.name} requires actionable error guidance for autonomous recovery`,
          ),
        );
      }
      if (requiresPaginationContract(tool) && !tool.pagination) {
        diagnostics.push(
          this.helpQualityDiagnostic(
            "help_pagination_missing",
            `${toolPath}.openacme.pagination`,
            `tool ${tool.name} has pagination or truncation inputs and requires pagination guidance`,
          ),
        );
      }

      const publicParameters = publicInputParameters(tool);
      const publicParameterRoots = new Set(publicParameters);
      for (const parameterName of Object.keys(tool.help?.parameters ?? {})) {
        const rootName = parameterName.split(".")[0] ?? parameterName;
        if (publicParameterRoots.has(rootName)) continue;
        diagnostics.push(
          this.helpQualityDiagnostic(
            "help_parameter_unknown",
            `${toolPath}.help.parameters.${parameterName}`,
            `help parameter ${parameterName} does not match a public input parameter`,
          ),
        );
      }
      for (const parameterName of publicParameters) {
        const parameterHelp = tool.help?.parameters[parameterName];
        this.requireHelpField(
          diagnostics,
          parameterHelp?.summary,
          "help_parameter_summary_missing",
          `${toolPath}.help.parameters.${parameterName}.summary`,
          `parameter ${parameterName} requires short help`,
        );
        if (isComplexParameter(parameterName, tool)) {
          this.requireHelpField(
            diagnostics,
            parameterHelp?.full,
            "help_parameter_full_missing",
            `${toolPath}.help.parameters.${parameterName}.full`,
            `complex parameter ${parameterName} requires full help`,
          );
          if (requiresNestedVocabularyHelp(parameterName, tool)) {
            const nestedFieldHelp =
              tool.help?.parameters[`${parameterName}.filters.field`];
            if (!nestedFieldHelp?.summary || !nestedFieldHelp.vocabularyRef) {
              diagnostics.push(
                this.helpQualityDiagnostic(
                  "help_parameter_vocabulary_missing",
                  `${toolPath}.help.parameters.${parameterName}.filters.field`,
                  `complex filter parameter ${parameterName} requires nested field help with a vocabularyRef`,
                ),
              );
            }
          }
        }
      }

      const hasToolExample = (tool.help?.examples?.length ?? 0) > 0;
      const hasRegisteredExample =
        (examplesByTool.get(tool.name)?.length ?? 0) > 0;
      const hasNoExampleJustification =
        (tool.help?.noExampleJustification?.trim().length ?? 0) > 0;
      if (
        !hasToolExample &&
        !hasRegisteredExample &&
        !hasNoExampleJustification
      ) {
        diagnostics.push(
          this.helpQualityDiagnostic(
            "help_example_missing",
            `${toolPath}.help.examples`,
            `tool ${tool.name} requires at least one help or registered example`,
          ),
        );
      }

      if (tool.classification.operation === "destructive") {
        const joinedHelp = [
          tool.help?.summary,
          tool.help?.full,
          ...Object.values(tool.help?.parameters ?? {}).flatMap((parameter) => [
            parameter.summary,
            parameter.full,
            ...parameter.rules,
          ]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!joinedHelp.includes("approval") && !joinedHelp.includes("risk")) {
          diagnostics.push(
            this.helpQualityDiagnostic(
              "destructive_help_risk_missing",
              `${toolPath}.help`,
              `destructive tool ${tool.name} help must mention approval or risk`,
            ),
          );
        }
      }
    });
  }

  private requireHelpField(
    diagnostics: HostedIntegrationValidationDiagnostic[],
    value: string | undefined,
    code: string,
    path: string,
    message: string,
  ): void {
    if (value && value.trim().length > 0) return;
    diagnostics.push(this.helpQualityDiagnostic(code, path, message));
  }

  private helpQualityDiagnostic(
    code: string,
    path: string,
    message: string,
  ): HostedIntegrationValidationDiagnostic {
    return {
      severity: this.helpQualityMode,
      code,
      path,
      message,
    };
  }
}

function parseStrictYaml(
  content: string,
  code: string,
  path: string,
  diagnostics: HostedIntegrationValidationDiagnostic[],
): unknown | null {
  try {
    const document = parseDocument(content, { uniqueKeys: true });
    const errors = document.errors.map((error) => error.message);
    if (errors.length > 0) {
      diagnostics.push(errorDiagnostic(code, path, errors.join("; ")));
      return null;
    }
    return document.toJSON();
  } catch (error) {
    diagnostics.push(
      errorDiagnostic(
        code,
        path,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return null;
  }
}

function publicInputParameters(tool: HostedIntegrationToolSpec): string[] {
  const properties = tool.inputSchema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return [];
  }
  return Object.keys(properties);
}

function isComplexParameter(
  parameterName: string,
  tool: HostedIntegrationToolSpec,
): boolean {
  const lowerName = parameterName.toLowerCase();
  if (
    lowerName.includes("filter") ||
    lowerName.includes("query") ||
    lowerName.includes("body") ||
    lowerName.includes("cursor") ||
    lowerName.includes("pagination") ||
    lowerName.includes("page") ||
    lowerName.includes("cache") ||
    lowerName.includes("artifact") ||
    lowerName.includes("file")
  ) {
    return true;
  }
  const properties = tool.inputSchema.properties;
  const schema =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)[parameterName]
      : undefined;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const typedSchema = schema as Record<string, unknown>;
  return (
    typedSchema.type === "object" ||
    typedSchema.type === "array" ||
    Array.isArray(typedSchema.enum) ||
    typeof typedSchema.$ref === "string"
  );
}

function requiresNestedVocabularyHelp(
  parameterName: string,
  tool: HostedIntegrationToolSpec,
): boolean {
  const properties = tool.inputSchema.properties;
  const schema =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)[parameterName]
      : undefined;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const typedSchema = schema as Record<string, unknown>;
  if (parameterName === "filter_body" || parameterName.endsWith("_filter_body")) {
    return typedSchema.type === "object" || typedSchema.type === "array";
  }
  return schemaHasFiltersFieldCatalog(typedSchema);
}

function schemaHasFiltersFieldCatalog(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return false;
  }
  const filters = (properties as Record<string, unknown>).filters;
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    return false;
  }
  const filterSchema = filters as Record<string, unknown>;
  const itemSchema =
    filterSchema.items &&
    typeof filterSchema.items === "object" &&
    !Array.isArray(filterSchema.items)
      ? (filterSchema.items as Record<string, unknown>)
      : filterSchema;
  const filterProperties = itemSchema.properties;
  return (
    !!filterProperties &&
    typeof filterProperties === "object" &&
    !Array.isArray(filterProperties) &&
    typeof (filterProperties as Record<string, unknown>).field === "object"
  );
}

function requiresPaginationContract(tool: HostedIntegrationToolSpec): boolean {
  return publicInputParameters(tool).some((parameterName) => {
    const lowerName = parameterName.toLowerCase();
    return (
      lowerName.includes("page") ||
      lowerName.includes("cursor") ||
      lowerName.includes("continuation") ||
      lowerName.includes("truncation") ||
      lowerName === "limit" ||
      lowerName.endsWith("_limit")
    );
  });
}

interface PythonEntrypointFunction {
  name: string;
  positionalArgs: string[];
  vararg: string | null;
  kwarg: string | null;
  isAsync: boolean;
}

type PythonEntrypointAnalysis =
  | { ok: true; functions: PythonEntrypointFunction[] }
  | {
      ok: false;
      code: "python_source_invalid" | "python_source_analysis_failed";
      message: string;
    };

const PythonEntrypointFunctionSchema = z
  .object({
    name: z.string(),
    positionalArgs: z.array(z.string()),
    vararg: z.string().nullable(),
    kwarg: z.string().nullable(),
    isAsync: z.boolean(),
  })
  .strict();

const PythonEntrypointAnalysisSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    functions: z.array(PythonEntrypointFunctionSchema),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["python_source_invalid", "python_source_analysis_failed"]),
    message: z.string(),
  }),
]);

function analyzePythonEntrypoint(
  source: string,
): Promise<PythonEntrypointAnalysis> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, ["-u", "-c", PYTHON_HANDLER_ANALYZER], {
      env: {
        PATH: process.env["PATH"] ?? "",
        PYTHONNOUSERSITE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        code: "python_source_analysis_failed",
        message: error.message,
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          code: "python_source_analysis_failed",
          message:
            stderr || `Python analyzer exited with code ${code ?? "unknown"}`,
        });
        return;
      }
      try {
        resolve(
          PythonEntrypointAnalysisSchema.parse(
            JSON.parse(stdout.trim()),
          ) as PythonEntrypointAnalysis,
        );
      } catch (error) {
        resolve({
          ok: false,
          code: "python_source_analysis_failed",
          message:
            error instanceof Error
              ? error.message
              : "Python analyzer returned invalid JSON",
        });
      }
    });
    child.stdin.end(source);
  });
}

function derivedPythonHandlerName(toolName: string): string {
  return `tool_${toolName}`;
}

function hasValidDerivedHandlerSignature(
  handler: PythonEntrypointFunction,
): boolean {
  return hasValidPythonSignature(handler, ["args", "context"]);
}

function hasValidPythonSignature(
  fn: PythonEntrypointFunction,
  positionalArgs: readonly string[],
): boolean {
  return (
    !fn.isAsync &&
    fn.vararg === null &&
    fn.kwarg === null &&
    fn.positionalArgs.length === positionalArgs.length &&
    fn.positionalArgs.every((arg, index) => arg === positionalArgs[index])
  );
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

function isUnsafeHelpReference(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isHostedIntegrationVocabularyReference(value: string): boolean {
  return /^references\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:ya?ml|json)$/.test(
    value,
  );
}

function resultFromDiagnostics(
  diagnostics: HostedIntegrationValidationDiagnostic[],
): HostedIntegrationValidationResult {
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
  };
}
