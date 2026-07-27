import { createHash } from "node:crypto";
import { createLogger } from "@openacme/config/logger";

const log = createLogger("tools.observation");

export interface ToolObservationSink {
  recordEvent(type: string, data?: Record<string, unknown>): void;
  writeRawFile(relativePath: string, data: string | Buffer): unknown;
}

export interface ToolObservationSpan {
  traceId?: string;
  spanId?: string;
  setAttributes?(attributes: Record<string, unknown>): void;
  addEvent?(name: string, attributes?: Record<string, unknown>): void;
  recordException?(error: unknown): void;
  setStatusOk?(): void;
  setStatusError?(error: unknown): void;
}

export interface ToolObservationBinding {
  getSink(): ToolObservationSink | null | undefined;
  locatorAttributes?(args: ToolObservationLocatorArgs): Record<string, unknown>;
  withSpan?<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: ToolObservationSpan) => Promise<T> | T
  ): Promise<T> | T;
}

export interface ToolObservationLocatorArgs {
  eventType: string;
  toolCallId?: string;
  sessionId?: string;
  relativeEvidenceDir?: string;
}

let binding: ToolObservationBinding | null = null;

export function bindToolObservation(next: ToolObservationBinding | null): void {
  binding = next;
}

export function withToolObservationSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: ToolObservationSpan) => Promise<T> | T
): Promise<T> | T {
  const current = binding;
  if (!current?.withSpan) return fn({});
  return current.withSpan(name, attributes, fn);
}

export function recordToolObservationEvent(
  type: string,
  data?: Record<string, unknown>
): void {
  const sink = getSink();
  if (!sink) return;
  try {
    sink.recordEvent(type, data);
  } catch (err) {
    log.warn({ err, type }, "tool observation event write failed");
  }
}

export function getToolObservationLocatorAttributes(
  args: ToolObservationLocatorArgs
): Record<string, unknown> {
  const current = binding;
  if (!current?.locatorAttributes) return {};
  try {
    return current.locatorAttributes(args);
  } catch (err) {
    log.warn(
      { err, eventType: args.eventType },
      "tool observation locator failed"
    );
    return {};
  }
}

export function toolObservationLocatorPayload(
  attributes: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  copyString(
    attributes,
    out,
    "openacme.forensic.evidence_ref",
    "evidenceRef"
  );
  copyString(
    attributes,
    out,
    "openacme.forensic.event_selector",
    "eventSelector"
  );
  copyString(
    attributes,
    out,
    "openacme.forensic.relative_evidence_dir",
    "relativeEvidenceDir"
  );
  copyString(
    attributes,
    out,
    "openacme.session.timeline_locator",
    "timelineLocator"
  );
  return out;
}

export function writeToolObservationRawFile(
  relativePath: string,
  data: string | Buffer
): unknown {
  const sink = getSink();
  if (!sink) return null;
  try {
    return sink.writeRawFile(relativePath, data);
  } catch (err) {
    log.warn({ err, relativePath }, "tool observation raw write failed");
    return null;
  }
}

export function sha256ObservationText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeObservationSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe.length > 0 ? safe.slice(0, 160) : "unknown";
}

export function stringifyObservation(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch (err) {
    return JSON.stringify({
      unavailable: true,
      reason: "json_stringify_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function rawRecordPath(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as { relativePath?: unknown }).relativePath;
  return typeof value === "string" ? value : undefined;
}

function getSink(): ToolObservationSink | null {
  if (!binding) return null;
  try {
    return binding.getSink() ?? null;
  } catch (err) {
    log.warn({ err }, "tool observation sink resolution failed");
    return null;
  }
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, string>,
  sourceKey: string,
  targetKey: string
): void {
  const value = source[sourceKey];
  if (typeof value === "string" && value.length > 0) target[targetKey] = value;
}
