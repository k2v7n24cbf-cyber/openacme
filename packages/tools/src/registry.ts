import { z } from "zod";
import { createLogger } from "@openacme/config/logger";
import type {
  ToolEntry,
  ToolDefinition,
  ToolInfo,
  ToolExecutionStatus,
  ToolResultClassification,
} from "./types.js";
import { SYSTEM_TOOLS } from "./system.js";
import { maybeSpillWithMetadata, type SpillOutcome } from "./spill.js";
import { toolCallContext } from "./session-context.js";
import { getToolHostDispatcher } from "./tool-host-binding.js";
import { classifyToolResult } from "./outcome.js";
import {
  getToolObservationLocatorAttributes,
  rawRecordPath,
  recordToolObservationEvent,
  safeObservationSegment,
  sha256ObservationText,
  stringifyObservation,
  toolObservationLocatorPayload,
  type ToolObservationSpan,
  withToolObservationSpan,
  writeToolObservationRawFile,
} from "./observation.js";

const log = createLogger("tools.registry");

const SYSTEM_TOOL_SET = new Set<string>(SYSTEM_TOOLS);

function runtimeLabel(entry: ToolEntry): "daemon" | "worker" {
  return entry.runtime ?? "daemon";
}

function toolObservationDir(entry: ToolEntry, toolCallId?: string): string {
  return `tool-calls/${safeObservationSegment(toolCallId ?? `unknown-${entry.name}`)}`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function exceptionClassification(error: unknown): ToolResultClassification {
  return {
    resultStatus: "failure",
    resultClassifier: "exception",
    failureKind: "handler_exception",
    failureMessage: error instanceof Error ? error.message : String(error),
    parsedJson: false,
  };
}

function classificationPayload(
  executionStatus: ToolExecutionStatus,
  classification: ToolResultClassification
): Record<string, unknown> {
  return {
    executionStatus,
    resultStatus: classification.resultStatus,
    resultClassifier: classification.resultClassifier,
    failureKind: classification.failureKind,
    failureMessage: classification.failureMessage,
    exitCode: classification.exitCode,
    processStatus: classification.processStatus,
    successFlag: classification.successFlag,
    okFlag: classification.okFlag,
    parsedJson: classification.parsedJson,
    outcomeAttributes: classification.outcomeAttributes,
  };
}

function classificationSpanAttributes(
  executionStatus: ToolExecutionStatus,
  classification: ToolResultClassification
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    "openacme.tool.execution_status": executionStatus,
    "openacme.tool.result_status": classification.resultStatus,
    "openacme.tool.result_classifier": classification.resultClassifier,
    "openacme.tool.failure_kind": classification.failureKind,
    "openacme.tool.failure_message": classification.failureMessage,
    "openacme.tool.exit_code": classification.exitCode,
    "openacme.tool.process_status": classification.processStatus,
    "openacme.tool.success_flag": classification.successFlag,
    "openacme.tool.ok_flag": classification.okFlag,
    "openacme.tool.parsed_json": classification.parsedJson,
  };
  for (const [key, value] of Object.entries(
    classification.outcomeAttributes ?? {}
  )) {
    attrs[`openacme.tool.outcome.${key}`] = value;
  }
  return attrs;
}

function applyClassificationToSpan(
  span: ToolObservationSpan | undefined,
  executionStatus: ToolExecutionStatus,
  classification: ToolResultClassification
): void {
  span?.setAttributes?.(
    classificationSpanAttributes(executionStatus, classification)
  );
  if (classification.resultStatus === "failure") {
    span?.addEvent?.("openacme.tool.logical_failure", {
      "openacme.tool.failure_kind": classification.failureKind,
      "openacme.tool.failure_message": classification.failureMessage,
    });
    span?.setStatusError?.(
      new Error(
        classification.failureMessage ??
          classification.failureKind ??
          "tool result failure"
      )
    );
    return;
  }
  span?.setStatusOk?.();
}

function recordToolStart(
  entry: ToolEntry,
  args: Record<string, unknown>,
  toolCallId?: string,
  span?: ToolObservationSpan
): void {
  const dir = toolObservationDir(entry, toolCallId);
  const locator = getToolLocator("tool.start", toolCallId, dir);
  const argsJson = stringifyObservation(args);
  const raw = writeToolObservationRawFile(`${dir}/args.json`, argsJson);
  recordToolObservationEvent("tool.start", {
    toolName: entry.name,
    toolset: entry.toolset,
    toolCallId,
    runtime: runtimeLabel(entry),
    traceId: span?.traceId,
    spanId: span?.spanId,
    argsBytes: byteLength(argsJson),
    argsSha256: sha256ObservationText(argsJson),
    rawArgsFile: rawRecordPath(raw),
    ...toolObservationLocatorPayload(locator),
  });
}

function recordToolFinish(args: {
  entry: ToolEntry;
  toolArgs: Record<string, unknown>;
  toolCallId?: string;
  startedAt: number;
  workerDispatched: boolean;
  preSpillResult?: string;
  output: string;
  spill?: SpillOutcome;
  span?: ToolObservationSpan;
}): void {
  const dir = toolObservationDir(args.entry, args.toolCallId);
  const locator = getToolLocator("tool.finish", args.toolCallId, dir);
  const preRaw =
    args.preSpillResult === undefined
      ? null
      : writeToolObservationRawFile(
          `${dir}/result.pre-spill.txt`,
          args.preSpillResult
        );
  const postRaw = writeToolObservationRawFile(
    `${dir}/result.post-spill.txt`,
    args.output
  );
  const classification = classifyToolResult(
    args.entry,
    args.toolArgs,
    args.preSpillResult ?? args.output
  );
  recordToolObservationEvent("tool.finish", {
    toolName: args.entry.name,
    toolset: args.entry.toolset,
    toolCallId: args.toolCallId,
    runtime: runtimeLabel(args.entry),
    traceId: args.span?.traceId,
    spanId: args.span?.spanId,
    workerDispatched: args.workerDispatched,
    durationMs: Date.now() - args.startedAt,
    spilled: args.spill?.spilled ?? false,
    spillPath: args.spill?.spillPath,
    resultPreSpillBytes:
      args.preSpillResult === undefined
        ? undefined
        : byteLength(args.preSpillResult),
    resultPreSpillSha256:
      args.preSpillResult === undefined
        ? undefined
        : sha256ObservationText(args.preSpillResult),
    resultPostSpillBytes: byteLength(args.output),
    resultPostSpillSha256: sha256ObservationText(args.output),
    rawPreSpillFile: rawRecordPath(preRaw),
    rawPostSpillFile: rawRecordPath(postRaw),
    ...classificationPayload("ok", classification),
    ...toolObservationLocatorPayload(locator),
  });
  args.span?.setAttributes?.({
    "openacme.tool.result_pre_spill_bytes":
      args.preSpillResult === undefined
        ? undefined
        : byteLength(args.preSpillResult),
    "openacme.tool.result_post_spill_bytes": byteLength(args.output),
    "openacme.tool.spilled": args.spill?.spilled ?? false,
    "openacme.tool.spill_path": args.spill?.spillPath,
    "openacme.tool.worker_dispatched": args.workerDispatched,
  });
  applyClassificationToSpan(args.span, "ok", classification);
}

function recordToolError(args: {
  entry: ToolEntry;
  toolCallId?: string;
  startedAt: number;
  error: unknown;
  span?: ToolObservationSpan;
}): void {
  const classification = exceptionClassification(args.error);
  recordToolObservationEvent("tool.error", {
    toolName: args.entry.name,
    toolset: args.entry.toolset,
    toolCallId: args.toolCallId,
    runtime: runtimeLabel(args.entry),
    traceId: args.span?.traceId,
    spanId: args.span?.spanId,
    durationMs: Date.now() - args.startedAt,
    errorName:
      args.error instanceof Error ? args.error.name : typeof args.error,
    errorMessage:
      args.error instanceof Error ? args.error.message : String(args.error),
    ...classificationPayload("error", classification),
  });
  args.span?.setAttributes?.(
    classificationSpanAttributes("error", classification)
  );
  args.span?.recordException?.(args.error);
  args.span?.setStatusError?.(args.error);
}

function toolSpanAttributes(
  entry: ToolEntry,
  toolCallId?: string
): Record<string, unknown> {
  const dir = toolObservationDir(entry, toolCallId);
  return {
    "openacme.span.type": "tool_execute",
    "openacme.tool.name": entry.name,
    "openacme.toolset": entry.toolset,
    "openacme.tool.call_id": toolCallId,
    "openacme.tool.runtime": runtimeLabel(entry),
    ...getToolLocator("tool.execute", toolCallId, dir),
  };
}

function getToolLocator(
  eventType: string,
  toolCallId: string | undefined,
  relativeEvidenceDir: string
): Record<string, unknown> {
  const store = toolCallContext.getStore();
  return getToolObservationLocatorAttributes({
    eventType,
    toolCallId,
    sessionId: store?.sessionId,
    relativeEvidenceDir,
  });
}

/**
 * Singleton tool registry — mirrors Hermes tools/registry.py ToolRegistry.
 *
 * Tools self-register via `registry.register()`. MCP tools are dynamically
 * added/removed. The registry provides definitions for the LLM API and
 * dispatches tool calls to their handlers.
 */
export class ToolRegistry {
  private _tools = new Map<string, ToolEntry>();
  private _generation = 0;

  /**
   * Register a tool. Called at initialization time or dynamically for MCP tools.
   */
  register(entry: ToolEntry): void {
    const existing = this._tools.get(entry.name);
    if (existing && existing.toolset !== entry.toolset) {
      // Prevent shadowing unless both are MCP tools (legitimate: server refresh)
      const bothMcp =
        existing.toolset.startsWith("mcp-") && entry.toolset.startsWith("mcp-");
      if (!bothMcp) {
        log.error(
          {
            tool: entry.name,
            toolset: entry.toolset,
            existingToolset: existing.toolset,
          },
          "tool registration rejected: would shadow existing tool"
        );
        return;
      }
    }
    this._tools.set(entry.name, entry);
    this._generation++;
  }

  /**
   * Remove a tool from the registry. Used by MCP dynamic tool discovery.
   */
  deregister(name: string): void {
    if (this._tools.delete(name)) {
      this._generation++;
    }
  }

  /**
   * Get a tool entry by name.
   */
  get(name: string): ToolEntry | undefined {
    return this._tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getAllToolNames(): string[] {
    return [...this._tools.keys()].sort();
  }

  /**
   * Serializable description of every registered tool — used by API clients
   * (web UI, etc.) to render tool pickers without leaking handler internals.
   */
  getInfo(): ToolInfo[] {
    return [...this._tools.values()]
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        toolset: entry.toolset,
        emoji: entry.emoji,
        system: SYSTEM_TOOL_SET.has(entry.name) || undefined,
      }))
      .sort((a, b) =>
        a.toolset === b.toolset
          ? a.name.localeCompare(b.name)
          : a.toolset.localeCompare(b.toolset)
      );
  }

  /**
   * Model-facing emission order. Map iteration is insertion order and MCP
   * servers connect in parallel, so the raw order can shuffle across
   * restarts — which reorders the serialized `tools` block and invalidates
   * the provider-side prompt cache for the entire prefix. Name-sorted is
   * byte-stable.
   */
  private sortedEntries(): ToolEntry[] {
    return [...this._tools.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  /**
   * Get tool definitions in the format expected by the Vercel AI SDK.
   * Only includes tools whose checkFn() passes (or have no checkFn).
   */
  getDefinitions(toolNames?: Set<string>): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const entry of this.sortedEntries()) {
      if (toolNames && !toolNames.has(entry.name)) continue;
      if (entry.checkFn && !entry.checkFn()) continue;

      result.push({
        type: "function",
        function: {
          name: entry.name,
          description: entry.description,
          parameters: z.toJSONSchema(entry.parameters, { target: "draft-07" }),
        },
      });
    }
    return result;
  }

  /**
   * Get tools as a Vercel AI SDK `tools` object for generateText/streamText.
   */
  getVercelTools(toolNames?: Set<string>): Record<string, unknown> {
    const tools: Record<string, unknown> = {};
    for (const entry of this.sortedEntries()) {
      if (toolNames && !toolNames.has(entry.name)) continue;
      if (entry.checkFn && !entry.checkFn()) continue;

      const toolDef: Record<string, unknown> = {
        description: entry.description,
        inputSchema: entry.parameters,
        execute: async (
          args: Record<string, unknown>,
          opts: { toolCallId?: string } = {}
        ) => {
          // Thread the per-call id into the ALS context so handlers
          // (read_file image/PDF, browser_take_screenshot) can namespace
          // their tool-files-dir copies without changing tool signatures.
          const store = toolCallContext.getStore();
          const previousToolCallId = store?.toolCallId;
          if (store && opts.toolCallId) {
            store.toolCallId = opts.toolCallId;
          }
          const toolCallId = opts.toolCallId ?? store?.toolCallId;
          const startedAt = Date.now();
          return withToolObservationSpan(
            "openacme.tool.execute",
            toolSpanAttributes(entry, toolCallId),
            async (span) => {
              recordToolStart(entry, args, toolCallId, span);
              try {
                // Worker-runtime tools route to the per-agent sandboxed tool
                // host when one is bound. The worker re-enters the context,
                // runs the same handler module, and applies spill — so no
                // daemon-side maybeSpill here (the spill dir is only writable
                // by the worker). Unbound (tests, scripts) → local fallback.
                if (entry.runtime === "worker" && store) {
                  const dispatcher = getToolHostDispatcher();
                  if (dispatcher) {
                    const output = await dispatcher.dispatch(entry.name, args, {
                      ...store,
                    });
                    recordToolFinish({
                      entry,
                      toolArgs: args,
                      toolCallId,
                      startedAt,
                      workerDispatched: true,
                      output,
                      span,
                    });
                    return output;
                  }
                }
                const result = await entry.handler(args);
                const spill = await maybeSpillWithMetadata(result, entry);
                recordToolFinish({
                  entry,
                  toolArgs: args,
                  toolCallId,
                  startedAt,
                  workerDispatched: false,
                  preSpillResult: result,
                  output: spill.output,
                  spill,
                  span,
                });
                return spill.output;
              } catch (error) {
                recordToolError({ entry, toolCallId, startedAt, error, span });
                throw error;
              } finally {
                if (store) store.toolCallId = previousToolCallId;
              }
            }
          );
        },
      };
      if (entry.toModelOutput) {
        toolDef.toModelOutput = entry.toModelOutput;
      }
      tools[entry.name] = toolDef;
    }
    return tools;
  }

  /**
   * Dispatch a tool call by name.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const entry = this._tools.get(name);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    // Validate + apply schema defaults, mirroring what the AI SDK does
    // before `execute`. Without this, optional-with-default params (e.g.
    // shell's `timeout`) arrive undefined on the dispatch path — the
    // tool-host worker routes every call through here.
    const parsed = entry.parameters.safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({
        error: `Invalid arguments for ${name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
    }
    const toolCallId = toolCallContext.getStore()?.toolCallId;
    const startedAt = Date.now();
    return withToolObservationSpan(
      "openacme.tool.execute",
      toolSpanAttributes(entry, toolCallId),
      async (span) => {
        try {
          recordToolStart(
            entry,
            parsed.data as Record<string, unknown>,
            toolCallId,
            span
          );
          const result = await entry.handler(
            parsed.data as Record<string, unknown>
          );
          const spill = await maybeSpillWithMetadata(result, entry);
          recordToolFinish({
            entry,
            toolArgs: parsed.data as Record<string, unknown>,
            toolCallId,
            startedAt,
            workerDispatched: false,
            preSpillResult: result,
            output: spill.output,
            spill,
            span,
          });
          return spill.output;
        } catch (error) {
          recordToolError({
            entry,
            toolCallId,
            startedAt,
            error,
            span,
          });
          const message =
            error instanceof Error ? error.message : String(error);
          return JSON.stringify({ error: `Tool execution failed: ${message}` });
        }
      }
    );
  }

  /**
   * Current generation counter. Consumers can cache against this.
   */
  get generation(): number {
    return this._generation;
  }

  /**
   * Get unique toolset names.
   */
  getToolsets(): string[] {
    const sets = new Set<string>();
    for (const entry of this._tools.values()) {
      sets.add(entry.toolset);
    }
    return [...sets].sort();
  }
}

/** Module-level singleton */
export const registry = new ToolRegistry();
