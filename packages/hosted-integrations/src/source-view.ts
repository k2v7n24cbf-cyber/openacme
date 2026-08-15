import { spawn } from "node:child_process";
import { z } from "zod";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  type FamilyManifest,
  type HostedIntegrationFamilyId,
  type HostedIntegrationToolName,
  type HostedIntegrationToolSpec,
} from "./schemas.js";

const PYTHON_BIN =
  process.env["OPENACME_PYTHON"] ?? process.env["PYTHON"] ?? "python3";
const DEFAULT_HELPER_DEPTH_LIMIT = 2;
const DEFAULT_MAX_HELPER_SNIPPETS = 20;
const DEFAULT_MAX_SOURCE_CHARS = 100_000;
const STANDARD_HOOK_NAMES = [
  "authenticate",
  "before_tool_call",
  "after_tool_call",
] as const;
const BUILTIN_CALL_NAMES = new Set([
  "bool",
  "dict",
  "float",
  "int",
  "len",
  "list",
  "max",
  "min",
  "print",
  "range",
  "set",
  "str",
  "sum",
  "tuple",
]);

const PYTHON_SOURCE_ANALYZER = String.raw`
import ast
import builtins
import json
import sys
import traceback

class CallVisitor(ast.NodeVisitor):
    def __init__(self):
        self.calls = set()

    def visit_Call(self, node):
        func = node.func
        if isinstance(func, ast.Name):
            self.calls.add(func.id)
        self.generic_visit(node)

try:
    source = sys.stdin.read()
    tree = ast.parse(source)
    imported = set()
    local_symbols = set()
    functions = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add((alias.asname or alias.name.split(".")[0]))
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imported.add((alias.asname or alias.name))
        elif isinstance(node, ast.ClassDef):
            local_symbols.add(node.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            local_symbols.add(node.name)
            visitor = CallVisitor()
            visitor.visit(node)
            functions.append({
                "name": node.name,
                "startLine": node.lineno,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "isAsync": isinstance(node, ast.AsyncFunctionDef),
                "calls": sorted(visitor.calls),
            })
    print(json.dumps({
        "ok": True,
        "functions": functions,
        "imports": sorted(imported),
        "localSymbols": sorted(local_symbols),
        "builtins": sorted(name for name in dir(builtins) if not name.startswith("_")),
    }))
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

export interface HostedIntegrationFocusedSourceViewOptions {
  includeSharedHelpers?: boolean;
  includeHooks?: boolean;
  includeAllTools?: boolean;
  helperDepthLimit?: number;
  maxHelperSnippets?: number;
  maxSourceChars?: number;
}

export interface BuildHostedIntegrationFocusedSourceViewInput {
  familyId: HostedIntegrationFamilyId | string;
  generationId: string;
  manifest: FamilyManifest;
  entrypointPath: string;
  source: string;
  toolName: HostedIntegrationToolName | string;
  options?: HostedIntegrationFocusedSourceViewOptions;
}

export interface HostedIntegrationSourceSnippet {
  name: string;
  startLine: number;
  endLine: number;
  source: string;
  truncated: boolean;
  includedBecause?:
    | "selected_handler"
    | "requested_hook"
    | "referenced_by_selected_handler"
    | "referenced_by_hook"
    | "referenced_by_helper";
}

export interface HostedIntegrationCollapsedToolHandler {
  toolName: HostedIntegrationToolName;
  functionName: string;
  startLine: number;
  endLine: number;
  source: string;
}

export interface HostedIntegrationFocusedSourceViewDiagnostic {
  severity: "warning" | "error";
  code:
    | "selected_handler_missing"
    | "python_source_invalid"
    | "python_source_analysis_failed"
    | "unresolved_helper_reference"
    | "helper_depth_limit_reached"
    | "helper_snippet_limit_reached"
    | "source_view_truncated";
  message: string;
  functionName?: string;
  reference?: string;
}

export interface HostedIntegrationFocusedSourceView {
  familyId: HostedIntegrationFamilyId;
  generationId: string;
  toolName: HostedIntegrationToolName;
  entrypointPath: string;
  mode: "focused" | "full_family";
  manifest: {
    runtime: Pick<FamilyManifest["runtime"], "entrypoint" | "handlerDispatch">;
    tool: HostedIntegrationToolSpec;
  };
  source: {
    fullSource?: string;
    selectedHandler?: HostedIntegrationSourceSnippet;
    hooks: HostedIntegrationSourceSnippet[];
    helpers: HostedIntegrationSourceSnippet[];
    collapsedToolHandlers: HostedIntegrationCollapsedToolHandler[];
  };
  diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[];
  limits: {
    helperDepthLimit: number;
    maxHelperSnippets: number;
    maxSourceChars: number;
    includedSourceChars: number;
    truncated: boolean;
  };
}

type PythonFunctionAnalysis = {
  name: string;
  startLine: number;
  endLine: number;
  isAsync: boolean;
  calls: string[];
};

type PythonSourceAnalysis = {
  ok: true;
  functions: PythonFunctionAnalysis[];
  imports: string[];
  localSymbols: string[];
  builtins: string[];
};

const PythonSourceAnalyzerResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      functions: z.array(
        z
          .object({
            name: z.string(),
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            isAsync: z.boolean(),
            calls: z.array(z.string()),
          })
          .strict(),
      ),
      imports: z.array(z.string()),
      localSymbols: z.array(z.string()),
      builtins: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["python_source_invalid", "python_source_analysis_failed"]),
      message: z.string(),
    })
    .strict(),
]);

export async function buildHostedIntegrationFocusedSourceView(
  input: BuildHostedIntegrationFocusedSourceViewInput,
): Promise<HostedIntegrationFocusedSourceView> {
  const familyId = HostedIntegrationFamilyIdSchema.parse(input.familyId);
  const toolName = HostedIntegrationToolNameSchema.parse(input.toolName);
  const tool = input.manifest.tools.find(
    (candidate) => candidate.name === toolName,
  );
  if (!tool || tool.lifecycle === "removed") {
    throw new Error(`hosted integration tool ${toolName} was not found`);
  }

  const options = normalizeOptions(input.options);
  if (options.includeAllTools) {
    return {
      familyId,
      generationId: input.generationId,
      toolName,
      entrypointPath: input.entrypointPath,
      mode: "full_family",
      manifest: manifestExcerpt(input.manifest, tool),
      source: {
        fullSource: input.source,
        hooks: [],
        helpers: [],
        collapsedToolHandlers: [],
      },
      diagnostics: [],
      limits: {
        helperDepthLimit: options.helperDepthLimit,
        maxHelperSnippets: options.maxHelperSnippets,
        maxSourceChars: options.maxSourceChars,
        includedSourceChars: input.source.length,
        truncated: false,
      },
    };
  }

  const analysis = await analyzePythonSource(input.source);
  const lines = input.source.split(/\r?\n/);
  if (!analysis.ok) {
    return baseFocusedView({
      input,
      familyId,
      toolName,
      tool,
      options,
      diagnostics: [
        {
          severity: "error",
          code: analysis.code,
          message: analysis.message,
        },
      ],
    });
  }

  const functionByName = new Map(
    analysis.functions.map((fn) => [fn.name, fn] as const),
  );
  const selectedHandlerName = `tool_${toolName}`;
  const selectedHandler = functionByName.get(selectedHandlerName);
  const diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[] = [];
  if (!selectedHandler) {
    diagnostics.push({
      severity: "error",
      code: "selected_handler_missing",
      message: `Python handler ${selectedHandlerName}(args, context) was not found`,
      functionName: selectedHandlerName,
    });
  }

  const selectedSnippet = selectedHandler
    ? snippetFromFunction(selectedHandler, lines, "selected_handler")
    : undefined;
  const hookFunctions = options.includeHooks
    ? STANDARD_HOOK_NAMES.map((hook) => functionByName.get(hook)).filter(
        (hook): hook is PythonFunctionAnalysis => Boolean(hook),
      )
    : [];
  const hooks = hookFunctions.map((hook) =>
    snippetFromFunction(hook, lines, "requested_hook"),
  );

  const helperPlan =
    options.includeSharedHelpers && selectedHandler
      ? resolveHelperPlan({
          analysis,
          roots: [
            { fn: selectedHandler, reason: "referenced_by_selected_handler" },
            ...hookFunctions.map((fn) => ({
              fn,
              reason: "referenced_by_hook" as const,
            })),
          ],
          helperDepthLimit: options.helperDepthLimit,
          maxHelperSnippets: options.maxHelperSnippets,
        })
      : { helpers: [], diagnostics: [] };
  diagnostics.push(...helperPlan.diagnostics);
  const helpers = enforceSourceLimit({
    mandatoryChars: snippetChars([selectedSnippet, ...hooks]),
    snippets: helperPlan.helpers.map((helper) =>
      snippetFromFunction(helper.fn, lines, helper.reason),
    ),
    maxSourceChars: options.maxSourceChars,
    diagnostics,
  });

  return {
    familyId,
    generationId: input.generationId,
    toolName,
    entrypointPath: input.entrypointPath,
    mode: "focused",
    manifest: manifestExcerpt(input.manifest, tool),
    source: {
      selectedHandler: selectedSnippet,
      hooks,
      helpers,
      collapsedToolHandlers: collapsedToolHandlers({
        manifest: input.manifest,
        selectedToolName: toolName,
        functionByName,
      }),
    },
    diagnostics,
    limits: {
      helperDepthLimit: options.helperDepthLimit,
      maxHelperSnippets: options.maxHelperSnippets,
      maxSourceChars: options.maxSourceChars,
      includedSourceChars: snippetChars([
        selectedSnippet,
        ...hooks,
        ...helpers,
      ]),
      truncated: diagnostics.some(
        (diagnostic) => diagnostic.code === "source_view_truncated",
      ),
    },
  };
}

function normalizeOptions(
  options: HostedIntegrationFocusedSourceViewOptions | undefined,
): Required<HostedIntegrationFocusedSourceViewOptions> {
  return {
    includeSharedHelpers: options?.includeSharedHelpers ?? false,
    includeHooks: options?.includeHooks ?? false,
    includeAllTools: options?.includeAllTools ?? false,
    helperDepthLimit: options?.helperDepthLimit ?? DEFAULT_HELPER_DEPTH_LIMIT,
    maxHelperSnippets:
      options?.maxHelperSnippets ?? DEFAULT_MAX_HELPER_SNIPPETS,
    maxSourceChars: options?.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS,
  };
}

function manifestExcerpt(
  manifest: FamilyManifest,
  tool: HostedIntegrationToolSpec,
): HostedIntegrationFocusedSourceView["manifest"] {
  return {
    runtime: {
      entrypoint: manifest.runtime.entrypoint,
      handlerDispatch: manifest.runtime.handlerDispatch,
    },
    tool,
  };
}

function baseFocusedView(args: {
  input: BuildHostedIntegrationFocusedSourceViewInput;
  familyId: HostedIntegrationFamilyId;
  toolName: HostedIntegrationToolName;
  tool: HostedIntegrationToolSpec;
  options: Required<HostedIntegrationFocusedSourceViewOptions>;
  diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[];
}): HostedIntegrationFocusedSourceView {
  return {
    familyId: args.familyId,
    generationId: args.input.generationId,
    toolName: args.toolName,
    entrypointPath: args.input.entrypointPath,
    mode: "focused",
    manifest: manifestExcerpt(args.input.manifest, args.tool),
    source: {
      hooks: [],
      helpers: [],
      collapsedToolHandlers: [],
    },
    diagnostics: args.diagnostics,
    limits: {
      helperDepthLimit: args.options.helperDepthLimit,
      maxHelperSnippets: args.options.maxHelperSnippets,
      maxSourceChars: args.options.maxSourceChars,
      includedSourceChars: 0,
      truncated: false,
    },
  };
}

function resolveHelperPlan(args: {
  analysis: PythonSourceAnalysis;
  roots: Array<{
    fn: PythonFunctionAnalysis;
    reason: "referenced_by_selected_handler" | "referenced_by_hook";
  }>;
  helperDepthLimit: number;
  maxHelperSnippets: number;
}): {
  helpers: Array<{
    fn: PythonFunctionAnalysis;
    reason:
      | "referenced_by_selected_handler"
      | "referenced_by_hook"
      | "referenced_by_helper";
  }>;
  diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[];
} {
  const imported = new Set(args.analysis.imports);
  const localSymbols = new Set(args.analysis.localSymbols);
  const builtins = new Set([...args.analysis.builtins, ...BUILTIN_CALL_NAMES]);
  const functionByName = new Map(
    args.analysis.functions.map((fn) => [fn.name, fn] as const),
  );
  const helperByName = new Map(
    args.analysis.functions
      .filter((fn) => isHelperFunction(fn.name))
      .map((fn) => [fn.name, fn] as const),
  );
  const included = new Map<
    string,
    {
      fn: PythonFunctionAnalysis;
      reason:
        | "referenced_by_selected_handler"
        | "referenced_by_hook"
        | "referenced_by_helper";
    }
  >();
  const diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[] = [];
  const queue: Array<{
    fn: PythonFunctionAnalysis;
    depth: number;
    reason: "referenced_by_selected_handler" | "referenced_by_hook";
  }> = args.roots.map((root) => ({ ...root, depth: 0 }));

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const call of current.fn.calls) {
      const helper = helperByName.get(call);
      if (helper) {
        if (current.depth >= args.helperDepthLimit) {
          diagnostics.push({
            severity: "warning",
            code: "helper_depth_limit_reached",
            message: `Helper ${call} was referenced beyond the helper depth limit.`,
            functionName: current.fn.name,
            reference: call,
          });
          continue;
        }
        if (!included.has(call)) {
          if (included.size >= args.maxHelperSnippets) {
            diagnostics.push({
              severity: "warning",
              code: "helper_snippet_limit_reached",
              message: "The helper snippet limit was reached.",
              functionName: current.fn.name,
              reference: call,
            });
            continue;
          }
          included.set(call, {
            fn: helper,
            reason:
              current.depth === 0 ? current.reason : "referenced_by_helper",
          });
          queue.push({
            fn: helper,
            depth: current.depth + 1,
            reason: current.reason,
          });
        }
        continue;
      }
      if (
        !functionByName.has(call) &&
        !localSymbols.has(call) &&
        !imported.has(call) &&
        !builtins.has(call)
      ) {
        diagnostics.push({
          severity: "warning",
          code: "unresolved_helper_reference",
          message: `Reference ${call} could not be resolved as a family-local helper.`,
          functionName: current.fn.name,
          reference: call,
        });
      }
    }
  }

  return {
    helpers: [...included.values()].sort(
      (left, right) => left.fn.startLine - right.fn.startLine,
    ),
    diagnostics: stableDiagnostics(diagnostics),
  };
}

function isHelperFunction(name: string): boolean {
  return (
    !name.startsWith("tool_") && !STANDARD_HOOK_NAMES.includes(name as never)
  );
}

function enforceSourceLimit(args: {
  mandatoryChars: number;
  snippets: HostedIntegrationSourceSnippet[];
  maxSourceChars: number;
  diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[];
}): HostedIntegrationSourceSnippet[] {
  const included: HostedIntegrationSourceSnippet[] = [];
  let used = args.mandatoryChars;
  for (const snippet of args.snippets) {
    if (used + snippet.source.length > args.maxSourceChars) {
      args.diagnostics.push({
        severity: "warning",
        code: "source_view_truncated",
        message: `Source view omitted ${snippet.name} because maxSourceChars was reached.`,
        functionName: snippet.name,
      });
      continue;
    }
    included.push(snippet);
    used += snippet.source.length;
  }
  return included;
}

function collapsedToolHandlers(args: {
  manifest: FamilyManifest;
  selectedToolName: HostedIntegrationToolName;
  functionByName: Map<string, PythonFunctionAnalysis>;
}): HostedIntegrationCollapsedToolHandler[] {
  return args.manifest.tools
    .filter(
      (tool) =>
        tool.lifecycle !== "removed" && tool.name !== args.selectedToolName,
    )
    .map((tool) => ({
      toolName: tool.name,
      functionName: `tool_${tool.name}`,
      fn: args.functionByName.get(`tool_${tool.name}`),
    }))
    .filter(
      (
        entry,
      ): entry is {
        toolName: HostedIntegrationToolName;
        functionName: string;
        fn: PythonFunctionAnalysis;
      } => Boolean(entry.fn),
    )
    .map((entry) => ({
      toolName: entry.toolName,
      functionName: entry.functionName,
      startLine: entry.fn.startLine,
      endLine: entry.fn.endLine,
      source: `def ${entry.functionName}(...):\n    # collapsed: unrelated hosted integration tool handler`,
    }));
}

function snippetFromFunction(
  fn: PythonFunctionAnalysis,
  lines: string[],
  includedBecause: HostedIntegrationSourceSnippet["includedBecause"],
): HostedIntegrationSourceSnippet {
  return {
    name: fn.name,
    startLine: fn.startLine,
    endLine: fn.endLine,
    source: lines.slice(fn.startLine - 1, fn.endLine).join("\n"),
    truncated: false,
    includedBecause,
  };
}

function snippetChars(
  snippets: Array<HostedIntegrationSourceSnippet | undefined>,
): number {
  return snippets.reduce(
    (sum, snippet) => sum + (snippet ? snippet.source.length : 0),
    0,
  );
}

function stableDiagnostics(
  diagnostics: HostedIntegrationFocusedSourceViewDiagnostic[],
): HostedIntegrationFocusedSourceViewDiagnostic[] {
  return diagnostics.sort((left, right) => {
    const leftKey = `${left.functionName ?? ""}\0${left.code}\0${left.reference ?? ""}`;
    const rightKey = `${right.functionName ?? ""}\0${right.code}\0${right.reference ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
}

async function analyzePythonSource(source: string): Promise<
  | PythonSourceAnalysis
  | {
      ok: false;
      code: "python_source_invalid" | "python_source_analysis_failed";
      message: string;
    }
> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, ["-u", "-c", PYTHON_SOURCE_ANALYZER], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        code: "python_source_analysis_failed",
        message: error.message,
      });
    });
    child.on("close", () => {
      try {
        const parsed = PythonSourceAnalyzerResultSchema.parse(
          JSON.parse(stdout),
        );
        resolve(parsed);
      } catch {
        resolve({
          ok: false,
          code: "python_source_analysis_failed",
          message:
            stderr || stdout || "Python source analyzer produced no output",
        });
      }
    });
    child.stdin.end(source);
  });
}
