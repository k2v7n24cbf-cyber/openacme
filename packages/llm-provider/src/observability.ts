import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { createLogger } from "@openacme/config/logger";

const log = createLogger("llm-provider.observability");

const TRACER_NAME = "openacme.ai";
const MAX_ATTRIBUTE_STRING_CHARS = 4096;
const MAX_ATTRIBUTE_ARRAY_LENGTH = 64;
const RESERVED_ATTRIBUTE_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SENSITIVE_ATTRIBUTE_KEY_PARTS = [
  "authorization",
  "api-key",
  "api_key",
  "secret",
  "token",
  "cookie",
  "password",
];
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

export type OpenAcmeSpanKind = "internal" | "client";
export type OpenAcmeSpanAttributes = Record<string, unknown>;

export interface OpenAcmeSpanHandle {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly sampled?: boolean;
  setAttributes(attributes: OpenAcmeSpanAttributes): void;
  addEvent(name: string, attributes?: OpenAcmeSpanAttributes): void;
  recordException(error: unknown): void;
  setStatusOk(): void;
  setStatusError(error: unknown): void;
  end(): void;
  run<T>(fn: () => T): T;
}

export interface StartOpenAcmeSpanOptions {
  kind?: OpenAcmeSpanKind;
}

export function startOpenAcmeSpan(
  name: string,
  attributes: OpenAcmeSpanAttributes = {},
  opts: StartOpenAcmeSpanOptions = {}
): OpenAcmeSpanHandle {
  try {
    const safeAttributes = sanitizeSpanAttributes(attributes);
    const span = trace.getTracer(TRACER_NAME).startSpan(name, {
      kind: resolveSpanKind(opts.kind),
      attributes: safeAttributes,
    });
    return new RecordingSpanHandle(span, safeAttributes);
  } catch (err) {
    warnTelemetryFailure(err, "failed to start OpenAcme span");
    return new NoopSpanHandle();
  }
}

export async function withOpenAcmeSpan<T>(
  name: string,
  attributes: OpenAcmeSpanAttributes,
  fn: (span: OpenAcmeSpanHandle) => Promise<T> | T,
  opts: StartOpenAcmeSpanOptions = {}
): Promise<T> {
  const span = startOpenAcmeSpan(name, attributes, opts);
  try {
    const result = await span.run(() => fn(span));
    span.setStatusOk();
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatusError(err);
    throw err;
  } finally {
    span.end();
  }
}

export function sanitizeSpanAttributes(
  attributes: OpenAcmeSpanAttributes
): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isSafeAttributeKey(key)) continue;
    const sanitized = sanitizeAttributeValue(key, value);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

class RecordingSpanHandle implements OpenAcmeSpanHandle {
  private readonly activeContext: Context;
  private closed = false;

  constructor(
    private readonly span: Span,
    attributes: Attributes
  ) {
    this.activeContext = addOpenAcmeBaggage(
      trace.setSpan(context.active(), span),
      attributes
    );
  }

  get traceId(): string | undefined {
    const ctx = this.safeSpanContext();
    return ctx?.traceId;
  }

  get spanId(): string | undefined {
    const ctx = this.safeSpanContext();
    return ctx?.spanId;
  }

  get sampled(): boolean | undefined {
    const ctx = this.safeSpanContext();
    return ctx ? (ctx.traceFlags & 1) === 1 : undefined;
  }

  setAttributes(attributes: OpenAcmeSpanAttributes): void {
    try {
      this.span.setAttributes(sanitizeSpanAttributes(attributes));
    } catch (err) {
      warnTelemetryFailure(err, "failed to set OpenAcme span attributes");
    }
  }

  addEvent(name: string, attributes: OpenAcmeSpanAttributes = {}): void {
    try {
      this.span.addEvent(name, sanitizeSpanAttributes(attributes));
    } catch (err) {
      warnTelemetryFailure(err, "failed to add OpenAcme span event");
    }
  }

  recordException(error: unknown): void {
    try {
      this.span.recordException(toRecordableException(error));
    } catch (err) {
      warnTelemetryFailure(err, "failed to record OpenAcme span exception");
    }
  }

  setStatusOk(): void {
    try {
      this.span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      warnTelemetryFailure(err, "failed to set OpenAcme span OK status");
    }
  }

  setStatusError(error: unknown): void {
    try {
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage(error),
      });
    } catch (err) {
      warnTelemetryFailure(err, "failed to set OpenAcme span error status");
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.span.end();
    } catch (err) {
      warnTelemetryFailure(err, "failed to end OpenAcme span");
    }
  }

  run<T>(fn: () => T): T {
    let appCodeStarted = false;
    try {
      return context.with(this.activeContext, () => {
        appCodeStarted = true;
        return fn();
      });
    } catch (err) {
      if (!appCodeStarted) {
        warnTelemetryFailure(
          err,
          "failed to activate OpenAcme span context; running without active span"
        );
        return fn();
      }
      throw err;
    }
  }

  private safeSpanContext() {
    try {
      const ctx = this.span.spanContext();
      if (!ctx || isInvalidTraceId(ctx.traceId) || isInvalidSpanId(ctx.spanId)) {
        return undefined;
      }
      return ctx;
    } catch (err) {
      warnTelemetryFailure(err, "failed to read OpenAcme span context");
      return undefined;
    }
  }
}

class NoopSpanHandle implements OpenAcmeSpanHandle {
  readonly traceId = undefined;
  readonly spanId = undefined;
  readonly sampled = undefined;

  setAttributes(): void {
    // no-op
  }

  addEvent(): void {
    // no-op
  }

  recordException(): void {
    // no-op
  }

  setStatusOk(): void {
    // no-op
  }

  setStatusError(): void {
    // no-op
  }

  end(): void {
    // no-op
  }

  run<T>(fn: () => T): T {
    return fn();
  }
}

function resolveSpanKind(kind: OpenAcmeSpanKind | undefined): SpanKind {
  return kind === "client" ? SpanKind.CLIENT : SpanKind.INTERNAL;
}

function addOpenAcmeBaggage(ctx: Context, attributes: Attributes): Context {
  try {
    const entries: Parameters<typeof propagation.createBaggage>[0] = {};
    const existing = propagation.getBaggage(ctx);
    if (existing) {
      for (const [key, entry] of existing.getAllEntries()) {
        entries[key] = entry;
      }
    }
    let found = false;
    for (const [key, value] of Object.entries(attributes)) {
      if (!isSafeOpenAcmeBaggageKey(key)) continue;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        continue;
      }
      entries[key] = { value: String(value) };
      found = true;
    }
    return found
      ? propagation.setBaggage(ctx, propagation.createBaggage(entries))
      : ctx;
  } catch (err) {
    warnTelemetryFailure(err, "failed to attach OpenAcme baggage");
    return ctx;
  }
}

function isSafeOpenAcmeBaggageKey(key: string): boolean {
  return SAFE_OPENACME_BAGGAGE_KEYS.has(key) && !isSensitiveAttributeKey(key);
}

function sanitizeAttributeValue(
  key: string,
  value: unknown
): Attributes[string] | undefined {
  if (value === undefined || value === null) return undefined;
  if (isSensitiveAttributeKey(key)) return "[redacted]";
  if (typeof value === "string") return truncateAttributeString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) return sanitizeAttributeArray(value);
  return undefined;
}

function sanitizeAttributeArray(value: unknown[]): Attributes[string] | undefined {
  const truncated = value.slice(0, MAX_ATTRIBUTE_ARRAY_LENGTH);
  if (truncated.length === 0) return [];
  if (truncated.every((v) => typeof v === "string")) {
    return truncated.map((v) => truncateAttributeString(v as string));
  }
  if (
    truncated.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return truncated as number[];
  }
  if (truncated.every((v) => typeof v === "boolean")) {
    return truncated as boolean[];
  }
  return undefined;
}

function truncateAttributeString(value: string): string {
  return value.length > MAX_ATTRIBUTE_STRING_CHARS
    ? value.slice(0, MAX_ATTRIBUTE_STRING_CHARS)
    : value;
}

function isSafeAttributeKey(key: string): boolean {
  if (!key.trim()) return false;
  return !key
    .split(".")
    .some((segment) => RESERVED_ATTRIBUTE_SEGMENTS.has(segment));
}

function isSensitiveAttributeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_ATTRIBUTE_KEY_PARTS.some((part) =>
    normalized.includes(part)
  );
}

function toRecordableException(error: unknown): Error | string {
  return error instanceof Error ? error : errorMessage(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function isInvalidTraceId(traceId: string): boolean {
  return !traceId || /^0+$/.test(traceId);
}

function isInvalidSpanId(spanId: string): boolean {
  return !spanId || /^0+$/.test(spanId);
}

function warnTelemetryFailure(err: unknown, msg: string): void {
  try {
    log.warn({ err }, msg);
  } catch {
    // Telemetry failure reporting must not become another app failure path.
  }
}
