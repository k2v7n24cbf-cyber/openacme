import {
  propagation,
  type Context,
  type SpanAttributeValue,
} from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const MAX_BAGGAGE_VALUE_CHARS = 4096;
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "api-key",
  "api_key",
  "secret",
  "token",
  "cookie",
  "password",
];
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_OPENACME_BAGGAGE_KEYS = new Set([
  "openacme.span.type",
  "openacme.ai.function_id",
  "openacme.forensic.run_id",
  "openacme.forensic.parent_run_id",
  "openacme.forensic.lookup",
  "openacme.forensic.evidence_ref",
  "openacme.forensic.event_selector",
  "openacme.forensic.relative_evidence_dir",
  "openacme.session.id",
  "openacme.session.timeline_locator",
  "openacme.agent.id",
  "openacme.task.id",
  "openacme.message.id",
  "openacme.usage.kind",
  "openacme.provider",
  "openacme.model",
  "openacme.auth_mode",
  "openacme.tool.name",
  "openacme.toolset",
  "openacme.tool.call_id",
  "openacme.tool.runtime",
]);

export class OpenAcmeBaggageSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    try {
      const baggage = propagation.getBaggage(parentContext);
      if (!baggage) return;
      const existing = getSpanAttributes(span);
      for (const [key, entry] of baggage.getAllEntries()) {
        if (!isSafeOpenAcmeBaggageKey(key)) continue;
        if (existing && Object.prototype.hasOwnProperty.call(existing, key)) {
          continue;
        }
        span.setAttribute(key, truncate(entry.value));
      }
    } catch {
      // Span processors must never break application span creation.
    }
  }

  onEnd(_span: ReadableSpan): void {
    // no-op
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function isSafeOpenAcmeBaggageKey(key: string): boolean {
  if (!SAFE_OPENACME_BAGGAGE_KEYS.has(key)) return false;
  if (isSensitiveKey(key)) return false;
  return !key
    .split(".")
    .some((segment) => RESERVED_SEGMENTS.has(segment));
}

function getSpanAttributes(
  span: Span | ReadableSpan
): Record<string, SpanAttributeValue> | undefined {
  const attrs = (span as { attributes?: unknown }).attributes;
  return attrs && typeof attrs === "object"
    ? (attrs as Record<string, SpanAttributeValue>)
    : undefined;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function truncate(value: string): string {
  return value.length > MAX_BAGGAGE_VALUE_CHARS
    ? value.slice(0, MAX_BAGGAGE_VALUE_CHARS)
    : value;
}
