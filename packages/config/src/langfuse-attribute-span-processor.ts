import {
  propagation,
  type Attributes,
  type Context,
  type SpanAttributeValue,
} from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { isSafeOpenAcmeBaggageKey } from "./openacme-baggage-span-processor.js";

const MAX_METADATA_CHARS = 4096;

const TRACE_METADATA_MAPPINGS: Array<[string, string]> = [
  ["openacme.forensic.run_id", "forensic_run_id"],
  ["openacme.forensic.parent_run_id", "parent_forensic_run_id"],
  ["openacme.agent.id", "agent_id"],
  ["openacme.task.id", "task_id"],
  ["openacme.message.id", "message_id"],
  ["openacme.usage.kind", "kind"],
  ["openacme.provider", "provider"],
  ["openacme.model", "model"],
  ["openacme.auth_mode", "auth_mode"],
];

const OBSERVATION_METADATA_MAPPINGS: Array<[string, string]> = [
  ["openacme.span.type", "span_type"],
  ["openacme.ai.function_id", "function_id"],
  ["openacme.forensic.lookup", "forensic_lookup"],
  ["openacme.forensic.evidence_ref", "evidence_ref"],
  ["openacme.forensic.event_selector", "event_selector"],
  ["openacme.forensic.relative_evidence_dir", "relative_evidence_dir"],
  ["openacme.session.timeline_locator", "timeline_locator"],
  ["openacme.tool.name", "tool_name"],
  ["openacme.toolset", "toolset"],
  ["openacme.tool.call_id", "tool_call_id"],
  ["openacme.tool.runtime", "tool_runtime"],
  ["openacme.tool.execution_status", "tool_execution_status"],
  ["openacme.tool.result_status", "tool_result_status"],
  ["openacme.tool.result_classifier", "tool_result_classifier"],
  ["openacme.tool.failure_kind", "tool_failure_kind"],
  ["openacme.tool.failure_message", "tool_failure_message"],
  ["openacme.tool.exit_code", "tool_exit_code"],
  ["openacme.tool.process_status", "tool_process_status"],
  ["openacme.tool.success_flag", "tool_success_flag"],
  ["openacme.tool.ok_flag", "tool_ok_flag"],
  ["openacme.tool.parsed_json", "tool_parsed_json"],
  ["openacme.tool.spilled", "tool_spilled"],
  ["openacme.tool.worker_dispatched", "tool_worker_dispatched"],
];

export class LangfuseAttributeSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    try {
      const source = collectSourceAttributes(span, parentContext);
      const mapped = mapOpenAcmeToLangfuseAttributes(source);
      for (const [key, value] of Object.entries(mapped)) {
        span.setAttribute(key, value);
      }
    } catch {
      // Backend-specific metadata mapping must not affect app execution.
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const attrs = getMutableSpanAttributes(span);
      if (!attrs) return;
      const mapped = mapOpenAcmeToLangfuseAttributes(attrs);
      for (const [key, value] of Object.entries(mapped)) {
        if (value === undefined) continue;
        attrs[key] = value;
      }
    } catch {
      // Export-time enrichment is best-effort.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function mapOpenAcmeToLangfuseAttributes(source: Attributes): Attributes {
  const out: Attributes = {};
  const sessionId = metadataValue(source["openacme.session.id"]);
  if (sessionId) out["langfuse.session.id"] = sessionId;

  for (const [sourceKey, metadataKey] of TRACE_METADATA_MAPPINGS) {
    const value = metadataValue(source[sourceKey]);
    if (value) out[`langfuse.trace.metadata.${metadataKey}`] = value;
  }

  for (const [sourceKey, metadataKey] of OBSERVATION_METADATA_MAPPINGS) {
    const value = metadataValue(source[sourceKey]);
    if (value) out[`langfuse.observation.metadata.${metadataKey}`] = value;
  }

  return out;
}

function collectSourceAttributes(span: Span, parentContext: Context): Attributes {
  const source: Attributes = { ...(getMutableSpanAttributes(span) ?? {}) };
  const baggage = propagation.getBaggage(parentContext);
  if (!baggage) return source;
  for (const [key, entry] of baggage.getAllEntries()) {
    if (!isSafeOpenAcmeBaggageKey(key)) continue;
    if (source[key] !== undefined) continue;
    source[key] = entry.value;
  }
  return source;
}

function getMutableSpanAttributes(
  span: Span | ReadableSpan
): Record<string, SpanAttributeValue> | undefined {
  const attrs = (span as { attributes?: unknown }).attributes;
  return attrs && typeof attrs === "object"
    ? (attrs as Record<string, SpanAttributeValue>)
    : undefined;
}

function metadataValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function truncate(value: string): string {
  return value.length > MAX_METADATA_CHARS
    ? value.slice(0, MAX_METADATA_CHARS)
    : value;
}
