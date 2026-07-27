/**
 * Subagent primitive. Two modes:
 *   forked     — multi-turn loop sharing the parent's prompt + tools
 *                (optional toolFilter). Used by the extractor.
 *   structured — one-shot generateObject with custom system + JSON
 *                schema. Used by the recall selector.
 * Both bound execution via timeoutMs + abortSignal, never throw,
 * return a discriminated `SubagentStatus`. Telemetry tags split
 * subagent vs main-turn usage when OPENACME_TELEMETRY=1.
 */

import {
  generateObject,
  readUIMessageStream,
  stepCountIs,
  streamObject,
  type LanguageModelUsage,
  type StopCondition,
  type ToolSet,
  type UIMessage,
} from "ai";
import { randomUUID } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { resolveSubagentModel } from "@openacme/llm-provider";
import type { UsageKind } from "@openacme/db";
import type { Agent } from "./agent.js";
import { extractErrorText } from "./error-classifier.js";
import { createAiHelperObservation } from "./helper-observation.js";
import type { TokenUsage } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FORKED_STEP_CAP = 10;
const TIMELINE_ERROR_MAX_CHARS = 4096;

function truncateTimelineError(value: string | undefined): string | null {
  if (!value) return null;
  return value.length > TIMELINE_ERROR_MAX_CHARS
    ? value.slice(0, TIMELINE_ERROR_MAX_CHARS)
    : value;
}

export type SubagentStatus = "completed" | "timeout" | "aborted" | "failed";

interface CommonArgs {
  parent: Agent;
  /** Wall-clock cap. Default 120_000ms. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface ForkedSubagentArgs extends CommonArgs {
  mode: "forked";
  /** Session id for cache + ALS context. Fork's work is NOT persisted here. */
  parentSessionId: string;
  /** User-shape text seed appended to the fork's history. */
  initialMessage: string;
  /** Prepended before the seed so prompts referring to "messages above"
   *  resolve. Identical bytes across turns share the prompt cache. */
  contextMessages?: readonly UIMessage[];
  stopWhen?: StopCondition<ToolSet>;
  /** Subset of parent's tools. Omit to inherit all. */
  toolFilter?: ReadonlySet<string>;
  /** Telemetry tag override. Default uses parent's tag. */
  telemetryFunctionId?: string;
  /** Usage-ledger kind for the fork's LLM call (e.g. "extractor").
   *  Forwarded into the parent's runStream seam — the fork itself
   *  never records. */
  usageKind?: UsageKind;
}

export interface StructuredSubagentArgs<
  S extends ZodTypeAny,
> extends CommonArgs {
  mode: "structured";
  /** Side-query system prompt (does NOT see the parent's system). */
  system: string;
  user: string;
  /** Output schema — validation failure → `status: "failed"`. */
  schema: S;
  maxOutputTokens?: number;
  /** Usage-ledger attribution. generateObject bypasses the runStream
   *  seam, so structured calls record via `parent.reportUsage` — but
   *  only when the caller supplies this (the ledger needs a session). */
  usage?: { kind: UsageKind; sessionId: string; taskId?: string };
}

export type SubagentArgs<S extends ZodTypeAny = ZodTypeAny> =
  | ForkedSubagentArgs
  | StructuredSubagentArgs<S>;

export interface ForkedSubagentResult {
  mode: "forked";
  status: SubagentStatus;
  /** Last assembled assistant UIMessage from the fork. May be null on
   *  early failure / immediate timeout. */
  message: UIMessage | null;
  usage?: TokenUsage;
  error?: string;
}

export interface StructuredSubagentResult<T> {
  mode: "structured";
  status: SubagentStatus;
  /** Parsed object validated against the schema. Null on any non-
   *  completed status. */
  object: T | null;
  usage?: TokenUsage;
  error?: string;
}

export type SubagentResult<T = unknown> =
  | ForkedSubagentResult
  | StructuredSubagentResult<T>;

// Overloads preserve the per-mode return type.
export function runSubagent(
  args: ForkedSubagentArgs,
): Promise<ForkedSubagentResult>;
export function runSubagent<S extends ZodTypeAny>(
  args: StructuredSubagentArgs<S>,
): Promise<StructuredSubagentResult<z.infer<S>>>;
export async function runSubagent<S extends ZodTypeAny>(
  args: SubagentArgs<S>,
): Promise<SubagentResult<z.infer<S>>> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  const signals: AbortSignal[] = [timeoutCtrl.signal];
  if (args.abortSignal) signals.push(args.abortSignal);
  const combined =
    signals.length === 1 ? signals[0]! : combineAbortSignals(signals);

  try {
    if (args.mode === "forked") {
      return await runForked(args, combined, timeoutCtrl.signal, timeoutMs);
    }
    return await runStructured(args, combined, timeoutCtrl.signal, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function runForked(
  args: ForkedSubagentArgs,
  combined: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): Promise<ForkedSubagentResult> {
  const startedAt = Date.now();
  const report = (
    eventType: string,
    status: string,
    payload: Record<string, unknown>,
    durationMs?: number,
  ) => {
    args.parent.reportTimelineEvent({
      sessionId: args.parentSessionId,
      agentId: args.parent.config.id,
      eventType,
      source: "agent",
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
      payload,
    });
  };
  report("session.subagent.started", "running", {
    mode: "forked",
    usageKind: args.usageKind ?? null,
    telemetryFunctionId: args.telemetryFunctionId ?? null,
    timeoutMs,
    contextMessageCount: args.contextMessages?.length ?? 0,
    toolFilterCount: args.toolFilter?.size ?? null,
  });

  const seedMsg: UIMessage = {
    id: `fork_${randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: args.initialMessage }],
  };

  const history: UIMessage[] = args.contextMessages
    ? [...args.contextMessages, seedMsg]
    : [seedMsg];

  let assembled: UIMessage | null = null;
  let usage: TokenUsage | undefined;

  try {
    const result = await args.parent.runStream({
      sessionId: args.parentSessionId,
      history,
      signal: combined,
      stopWhen: args.stopWhen ?? stepCountIs(DEFAULT_FORKED_STEP_CAP),
      toolFilter: args.toolFilter,
      telemetryFunctionId: args.telemetryFunctionId,
      modelOverride: resolveSubagentModel(args.parent.config.model),
      ...(args.usageKind ? { usage: { kind: args.usageKind } } : {}),
    });

    const stream = result.toUIMessageStream({ sendStart: false });
    for await (const m of readUIMessageStream<UIMessage>({ stream })) {
      assembled = m;
      if (combined.aborted) break;
    }

    if (combined.aborted) {
      const status = timeoutSignal.aborted ? "timeout" : "aborted";
      report(
        "session.subagent.failed",
        status,
        {
          mode: "forked",
          usageKind: args.usageKind ?? null,
          subagentStatus: status,
          totalTokens: usage?.totalTokens,
        },
        Date.now() - startedAt,
      );
      return {
        mode: "forked",
        status,
        message: assembled,
      };
    }

    try {
      const u = await result.usage;
      usage = {
        inputTokens: u?.inputTokens,
        outputTokens: u?.outputTokens,
        totalTokens: u?.totalTokens,
      };
    } catch {
      // usage is optional; downstream loggers tolerate undefined.
    }
    report(
      "session.subagent.finished",
      "ok",
      {
        mode: "forked",
        usageKind: args.usageKind ?? null,
        telemetryFunctionId: args.telemetryFunctionId ?? null,
        subagentStatus: "completed",
        totalTokens: usage?.totalTokens,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      },
      Date.now() - startedAt,
    );
    return {
      mode: "forked",
      status: "completed",
      message: assembled,
      usage,
    };
  } catch (e) {
    if (combined.aborted) {
      const status = timeoutSignal.aborted ? "timeout" : "aborted";
      report(
        "session.subagent.failed",
        status,
        {
          mode: "forked",
          usageKind: args.usageKind ?? null,
          subagentStatus: status,
        },
        Date.now() - startedAt,
      );
      return {
        mode: "forked",
        status,
        message: assembled,
      };
    }
    report(
      "session.subagent.failed",
      "error",
      {
        mode: "forked",
        usageKind: args.usageKind ?? null,
        subagentStatus: "failed",
        error: truncateTimelineError(extractErrorText(e)),
      },
      Date.now() - startedAt,
    );
    return {
      mode: "forked",
      status: "failed",
      message: assembled,
      error: extractErrorText(e),
    };
  }
}

// Polyfill: `AbortSignal.any` landed in Node 19.13.
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const native = (
    AbortSignal as unknown as {
      any?: (s: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof native === "function") return native(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

async function runStructured<S extends ZodTypeAny>(
  args: StructuredSubagentArgs<S>,
  combined: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): Promise<StructuredSubagentResult<z.infer<S>>> {
  const startedAt = Date.now();
  let provider: string | undefined;
  let model: string | undefined;
  let forensicRunId: string | undefined;
  const report = (
    eventType: string,
    status: string,
    payload: Record<string, unknown>,
    durationMs?: number,
    ids: { traceId?: string; spanId?: string } = {},
  ) => {
    if (!args.usage?.sessionId) return;
    args.parent.reportTimelineEvent({
      sessionId: args.usage.sessionId,
      agentId: args.parent.config.id,
      taskId: args.usage.taskId ?? null,
      eventType,
      source: "agent",
      status,
      traceId: ids.traceId ?? null,
      spanId: ids.spanId ?? null,
      forensicRunId: forensicRunId ?? null,
      ...(durationMs !== undefined ? { durationMs } : {}),
      payload,
    });
  };
  try {
    const subagentModel = resolveSubagentModel(args.parent.config.model);
    provider = subagentModel.provider;
    model = subagentModel.model;
    const observation = createAiHelperObservation({
      functionId: `${args.parent.config.id}:subagent.structured`,
      agentId: args.parent.config.id,
      sessionId: args.usage?.sessionId,
      taskId: args.usage?.taskId,
      kind: args.usage?.kind,
      model: subagentModel,
      profile: "subagent.structured",
    });
    forensicRunId = observation.forensicRunId;
    report("session.subagent.started", "running", {
      mode: "structured",
      usageKind: args.usage?.kind ?? null,
      timeoutMs,
      maxOutputTokens: args.maxOutputTokens ?? null,
      provider,
      model,
    });
    let object: z.infer<S>;
    let usage: LanguageModelUsage | undefined;
    let traceId: string | undefined;
    let spanId: string | undefined;

    const helper = await observation.run(async (span) => {
      let object: z.infer<S>;
      let usage: LanguageModelUsage | undefined;
      if (usesStreamingStructuredOutput(subagentModel)) {
            const result = streamObject({
              model: args.parent.resolveModel(subagentModel),
              system: args.system,
              schema: args.schema,
              messages: [{ role: "user", content: args.user }],
              maxOutputTokens: args.maxOutputTokens,
              abortSignal: combined,
              experimental_telemetry: observation.telemetry.settings,
            });
            const streamFinished = drainStream(result.fullStream);
            try {
              object = (await result.object) as z.infer<S>;
            } finally {
              await streamFinished.catch(() => {
                // The object promise carries the meaningful failure for callers.
              });
            }
            try {
              usage = await result.usage;
            } catch {
              // Structured result is authoritative; usage is best-effort metadata.
            }
          } else {
            const result = await generateObject({
              model: args.parent.resolveModel(subagentModel),
              system: args.system,
              schema: args.schema,
              messages: [{ role: "user", content: args.user }],
              maxOutputTokens: args.maxOutputTokens,
              abortSignal: combined,
              experimental_telemetry: observation.telemetry.settings,
            });
            object = result.object as z.infer<S>;
            usage = result.usage;
          }
      return { object, usage, traceId: span.traceId, spanId: span.spanId };
    });
    object = helper.object;
    usage = helper.usage;
    traceId = helper.traceId;
    spanId = helper.spanId;

    if (args.usage && usage) {
      args.parent.reportUsage({
        agentId: args.parent.config.id,
        sessionId: args.usage.sessionId,
        kind: args.usage.kind,
        model: subagentModel,
        taskId: args.usage.taskId,
        tokens: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        },
        steps: 1,
        durationMs: Date.now() - startedAt,
        traceId,
        spanId,
        forensicRunId: observation.forensicRunId,
        providerRequestCount: observation.providerRequestCount(),
      });
    }
    report(
      "session.subagent.finished",
      "ok",
      {
        mode: "structured",
        usageKind: args.usage?.kind ?? null,
        subagentStatus: "completed",
        provider,
        model,
        totalTokens: usage?.totalTokens,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      },
      Date.now() - startedAt,
      { traceId, spanId },
    );
    return {
      mode: "structured",
      status: "completed",
      object,
      usage: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
    };
  } catch (e) {
    if (combined.aborted) {
      const status = timeoutSignal.aborted ? "timeout" : "aborted";
      report(
        "session.subagent.failed",
        status,
        {
          mode: "structured",
          usageKind: args.usage?.kind ?? null,
          subagentStatus: status,
          provider,
          model,
        },
        Date.now() - startedAt,
      );
      return {
        mode: "structured",
        status,
        object: null,
      };
    }
    report(
      "session.subagent.failed",
      "error",
      {
        mode: "structured",
        usageKind: args.usage?.kind ?? null,
        subagentStatus: "failed",
        provider,
        model,
        error: truncateTimelineError(extractErrorText(e)),
      },
      Date.now() - startedAt,
    );
    return {
      mode: "structured",
      status: "failed",
      object: null,
      error: extractErrorText(e),
    };
  }
}

function usesStreamingStructuredOutput(model: {
  provider?: string;
  auth?: string;
}): boolean {
  return model.provider === "openai" && model.auth === "oauth";
}

async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // Draining drives the SDK stream pipeline so final object/usage promises resolve.
  }
}
