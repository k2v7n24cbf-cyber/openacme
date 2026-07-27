import { createHash } from "node:crypto";
import { streamText } from "ai";
import {
  buildEvidenceLocatorAttributes,
  createEvidenceRecorder,
  getActiveTraceContext,
  getProviderRequestCountForRun,
  setAiObservationContext,
  startOpenAcmeSpan,
} from "@openacme/llm-provider";
import type { SessionTimelineEventInput, UsageKind } from "@openacme/db";
import type { AgentConfig, UsageReport } from "./types.js";
import { extractErrorText } from "./error-classifier.js";
import { buildAiTelemetrySettings } from "./telemetry.js";

type StreamTextOptions = Parameters<typeof streamText>[0];
type StreamTextFinishEvent = Parameters<
  NonNullable<StreamTextOptions["onFinish"]>
>[0];
type StreamTextErrorEvent = Parameters<
  NonNullable<StreamTextOptions["onError"]>
>[0];

export interface AgentRunObservationArgs {
  agentId: string;
  sessionId: string;
  taskId?: string;
  messageId?: string;
  usageKind: UsageKind;
  usageModel: AgentConfig["model"];
  functionId: string;
  maxOutputTokens?: number;
  system: string;
  messages: unknown;
  tools: Record<string, unknown>;
  reportTimelineEvent(event: SessionTimelineEventInput): void;
  reportUsage(report: UsageReport): void;
}

export function createAgentRunObservation(args: AgentRunObservationArgs) {
  const telemetry = buildAiTelemetrySettings({
    functionId: args.functionId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    taskId: args.taskId,
    messageId: args.messageId,
    kind: args.usageKind,
    model: args.usageModel,
  });
  const authMode =
    args.usageModel.provider === "ollama"
      ? "local"
      : (args.usageModel.auth ?? "api_key");
  const observationContext = {
    forensicRunId: telemetry.forensicRunId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    taskId: args.taskId,
    messageId: args.messageId,
    kind: args.usageKind,
    provider: args.usageModel.provider,
    model: args.usageModel.model,
    authMode,
  };
  const turnSpan = startOpenAcmeSpan(
    "openacme.agent.turn",
    agentTurnSpanAttributes({
      functionId: telemetry.settings.functionId,
      forensicRunId: telemetry.forensicRunId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      taskId: args.taskId,
      messageId: args.messageId,
      kind: args.usageKind,
      provider: args.usageModel.provider,
      model: args.usageModel.model,
      authMode,
    }),
  );
  const startedAt = Date.now();
  let evidenceRecorder: ReturnType<typeof createEvidenceRecorder> | null = null;
  let sawStreamError = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const recorder = () => {
    if (!evidenceRecorder) {
      evidenceRecorder = createEvidenceRecorder({
        context: observationContext,
      });
    }
    return evidenceRecorder;
  };
  const closeSpan = () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    turnSpan.end();
  };
  const scheduleErrorClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(closeSpan, 5_000);
    const maybeUnref = closeTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    maybeUnref.unref?.();
  };
  const recordStart = () => {
    const toolCount = Object.keys(args.tools).length;
    safeEvidenceWrite(() => {
      recorder().recordEvent("agent.run.start", {
        functionId: telemetry.settings.functionId,
        maxOutputTokens: args.maxOutputTokens,
        toolCount,
        traceId: turnSpan.traceId,
        spanId: turnSpan.spanId,
      });
    });
    args.reportTimelineEvent({
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskId: args.taskId ?? null,
      messageId: args.messageId ?? null,
      eventType: "session.turn.started",
      source: "agent",
      status: "running",
      traceId: turnSpan.traceId,
      spanId: turnSpan.spanId,
      forensicRunId: telemetry.forensicRunId,
      payload: {
        functionId: telemetry.settings.functionId,
        kind: args.usageKind,
        provider: args.usageModel.provider,
        model: args.usageModel.model,
        authMode,
        maxOutputTokens: args.maxOutputTokens,
        toolCount,
      },
    });
    recordModelInputSnapshot();
  };
  const recordModelInputSnapshot = () => {
    const evidenceRecorder = recorder();
    if (!evidenceRecorder.captureRaw) return;
    const maxRawFileBytes = evidenceRecorder.maxRawFileBytes ?? 0;
    const messagesJson = stringifyJsonForEvidence(
      args.messages,
      maxRawFileBytes,
    );
    const toolsJson = stringifyJsonForEvidence(
      Object.keys(args.tools).sort(),
      maxRawFileBytes,
    );
    if (messagesJson === null || toolsJson === null) {
      safeEvidenceWrite(() => {
        evidenceRecorder.recordEvent("agent.model_input.snapshot.skipped", {
          reason: "max_raw_file_bytes",
          maxRawFileBytes,
        });
      });
      args.reportTimelineEvent({
        sessionId: args.sessionId,
        agentId: args.agentId,
        taskId: args.taskId ?? null,
        messageId: args.messageId ?? null,
        eventType: "session.prompt.snapshot.skipped",
        source: "agent",
        status: "skipped",
        traceId: turnSpan.traceId,
        spanId: turnSpan.spanId,
        forensicRunId: telemetry.forensicRunId,
        payload: {
          reason: "max_raw_file_bytes",
          maxRawFileBytes,
        },
      });
      return;
    }
    const systemBytes = Buffer.byteLength(args.system, "utf-8");
    const messagesBytes = Buffer.byteLength(messagesJson, "utf-8");
    const toolsBytes = Buffer.byteLength(toolsJson, "utf-8");
    safeEvidenceWrite(() => {
      evidenceRecorder.writeRawFile(
        "agent/model-input.system.txt",
        args.system,
      );
      evidenceRecorder.writeRawFile(
        "agent/model-input.messages.json",
        messagesJson,
      );
      evidenceRecorder.writeRawFile("agent/model-input.tools.json", toolsJson);
      evidenceRecorder.recordEvent("agent.model_input.snapshot", {
        systemBytes,
        systemSha256: sha256Text(args.system),
        messagesBytes,
        messagesSha256: sha256Text(messagesJson),
        toolsBytes,
        toolsSha256: sha256Text(toolsJson),
      });
    });
    args.reportTimelineEvent({
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskId: args.taskId ?? null,
      messageId: args.messageId ?? null,
      eventType: "session.prompt.snapshot.created",
      source: "agent",
      status: "ok",
      traceId: turnSpan.traceId,
      spanId: turnSpan.spanId,
      forensicRunId: telemetry.forensicRunId,
      payload: {
        systemBytes,
        systemSha256: sha256Text(args.system),
        messagesBytes,
        messagesSha256: sha256Text(messagesJson),
        toolsBytes,
        toolsSha256: sha256Text(toolsJson),
      },
    });
  };
  const recordFailure = (err: unknown) => {
    const errorText =
      err instanceof Error ? err.message : extractErrorText(err);
    safeEvidenceWrite(() => {
      recorder().recordEvent("agent.run.error", {
        error: errorText,
        traceId: turnSpan.traceId,
        spanId: turnSpan.spanId,
      });
    });
    turnSpan.recordException(err);
    turnSpan.setStatusError(err);
    args.reportTimelineEvent({
      sessionId: args.sessionId,
      agentId: args.agentId,
      taskId: args.taskId ?? null,
      messageId: args.messageId ?? null,
      eventType: "session.turn.failed",
      source: "agent",
      status: "error",
      traceId: turnSpan.traceId,
      spanId: turnSpan.spanId,
      forensicRunId: telemetry.forensicRunId,
      durationMs: Date.now() - startedAt,
      payload: {
        kind: args.usageKind,
        error: errorText,
      },
    });
  };

  return {
    telemetry,
    run<T>(fn: () => T): T {
      return turnSpan.run(() => {
        setAiObservationContext(observationContext);
        recorder();
        recordStart();
        return fn();
      });
    },
    finish(event: StreamTextFinishEvent): void {
      const u = event.totalUsage;
      if (!u) {
        if (!sawStreamError) turnSpan.setStatusOk();
        closeSpan();
        return;
      }
      const durationMs = Date.now() - startedAt;
      safeEvidenceWrite(() => {
        recorder().recordEvent("agent.run.finish", {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
          cachedInputTokens: u.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
          reasoningTokens: u.outputTokenDetails?.reasoningTokens,
          steps: event.steps?.length,
          durationMs,
          traceId: turnSpan.traceId,
          spanId: turnSpan.spanId,
        });
      });
      turnSpan.setAttributes({
        "openacme.duration_ms": durationMs,
        "openacme.usage.input_tokens": u.inputTokens,
        "openacme.usage.output_tokens": u.outputTokens,
        "openacme.usage.total_tokens": u.totalTokens,
        "openacme.usage.cached_input_tokens":
          u.inputTokenDetails?.cacheReadTokens,
        "openacme.usage.cache_write_tokens":
          u.inputTokenDetails?.cacheWriteTokens,
        "openacme.usage.reasoning_tokens":
          u.outputTokenDetails?.reasoningTokens,
        "openacme.ai.steps": event.steps?.length,
      });
      turnSpan.addEvent("openacme.agent.finish", {
        "openacme.duration_ms": durationMs,
        "openacme.usage.total_tokens": u.totalTokens,
      });
      if (!sawStreamError) turnSpan.setStatusOk();
      const activeTrace = getActiveTraceContext();
      const providerRequestCount = getProviderRequestCountForRun(
        telemetry.forensicRunId,
      );
      args.reportTimelineEvent({
        sessionId: args.sessionId,
        agentId: args.agentId,
        taskId: args.taskId ?? null,
        messageId: args.messageId ?? null,
        eventType: "session.turn.finished",
        source: "agent",
        status: "ok",
        traceId: turnSpan.traceId ?? activeTrace?.traceId,
        spanId: turnSpan.spanId ?? activeTrace?.spanId,
        forensicRunId: telemetry.forensicRunId,
        durationMs,
        payload: {
          kind: args.usageKind,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
          cachedInputTokens: u.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
          reasoningTokens: u.outputTokenDetails?.reasoningTokens,
          steps: event.steps?.length,
          providerRequestCount,
        },
      });
      args.reportUsage({
        agentId: args.agentId,
        sessionId: args.sessionId,
        kind: args.usageKind,
        model: args.usageModel,
        taskId: args.taskId,
        messageId: args.messageId,
        tokens: {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
          cachedInputTokens: u.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens,
          reasoningTokens: u.outputTokenDetails?.reasoningTokens,
        },
        providerCostUsd: sumProviderReportedCost(event.steps ?? []),
        steps: event.steps?.length,
        durationMs,
        traceId: turnSpan.traceId ?? activeTrace?.traceId,
        spanId: turnSpan.spanId ?? activeTrace?.spanId,
        forensicRunId: telemetry.forensicRunId,
        forensicPath: recorder().runDir,
        providerRequestCount,
      });
      closeSpan();
    },
    streamError(event: StreamTextErrorEvent): void {
      sawStreamError = true;
      const errorText =
        event instanceof Error
          ? event.message
          : typeof event === "string"
            ? event
            : extractErrorText(event);
      safeEvidenceWrite(() => {
        recorder().recordEvent("agent.run.error", {
          error: errorText,
          traceId: turnSpan.traceId,
          spanId: turnSpan.spanId,
        });
      });
      turnSpan.recordException(event);
      turnSpan.setStatusError(event);
      turnSpan.addEvent("openacme.agent.error", {
        "openacme.error.message": errorText,
      });
      args.reportTimelineEvent({
        sessionId: args.sessionId,
        agentId: args.agentId,
        taskId: args.taskId ?? null,
        messageId: args.messageId ?? null,
        eventType: "session.turn.failed",
        source: "agent",
        status: "error",
        traceId: turnSpan.traceId,
        spanId: turnSpan.spanId,
        forensicRunId: telemetry.forensicRunId,
        durationMs: Date.now() - startedAt,
        payload: {
          kind: args.usageKind,
          error: errorText,
        },
      });
      scheduleErrorClose();
    },
    syncError(err: unknown): void {
      recordFailure(err);
      closeSpan();
    },
  };
}

function sumProviderReportedCost(
  steps: ReadonlyArray<{ usage: { raw?: unknown } }>,
): number | undefined {
  let sum = 0;
  let found = false;
  for (const step of steps) {
    const raw = step.usage.raw as { cost?: unknown } | undefined;
    if (raw && typeof raw.cost === "number" && Number.isFinite(raw.cost)) {
      sum += raw.cost;
      found = true;
    }
  }
  return found ? sum : undefined;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringifyJsonForEvidence(
  value: unknown,
  maxBytes: number,
): string | null {
  if (maxBytes > 0 && estimateJsonBytes(value, maxBytes) > maxBytes) {
    return null;
  }
  const json = JSON.stringify(value, null, 2);
  if (maxBytes > 0 && Buffer.byteLength(json, "utf-8") > maxBytes) {
    return null;
  }
  return json;
}

function estimateJsonBytes(
  value: unknown,
  limit: number,
  seen = new WeakSet<object>(),
): number {
  const visit = (child: unknown): number =>
    estimateJsonBytes(child, limit, seen);
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf-8") + 2;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).length;
  }
  if (typeof value !== "object") return 2;
  if (seen.has(value)) return limit + 1;
  seen.add(value);
  let total = 2;
  if (Array.isArray(value)) {
    for (const item of value) {
      total += visit(item) + 1;
      if (total > limit) return total;
    }
    return total;
  }
  for (const [key, child] of Object.entries(value)) {
    total += Buffer.byteLength(key, "utf-8") + 3 + visit(child) + 1;
    if (total > limit) return total;
  }
  return total;
}

function safeEvidenceWrite(fn: () => void): void {
  try {
    fn();
  } catch {
    // Local evidence recording is best-effort telemetry.
  }
}

function agentTurnSpanAttributes(args: {
  functionId?: string;
  forensicRunId: string;
  agentId: string;
  sessionId: string;
  taskId?: string;
  messageId?: string;
  kind: UsageKind;
  provider?: string;
  model?: string;
  authMode: string;
}): Record<string, unknown> {
  const locatorAttributes = buildEvidenceLocatorAttributes({
    forensicRunId: args.forensicRunId,
    sessionId: args.sessionId,
    eventType: "agent.run",
    eventSelector: "type=agent.run.start",
  });
  return {
    "openacme.span.type": "agent_turn",
    "openacme.ai.function_id": args.functionId,
    "openacme.forensic.run_id": args.forensicRunId,
    "openacme.agent.id": args.agentId,
    "openacme.session.id": args.sessionId,
    "openacme.task.id": args.taskId,
    "openacme.message.id": args.messageId,
    "openacme.usage.kind": args.kind,
    "openacme.provider": args.provider,
    "openacme.model": args.model,
    "openacme.auth_mode": args.authMode,
    ...locatorAttributes,
  };
}
