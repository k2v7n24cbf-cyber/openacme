import { createHash } from "node:crypto";
import { createLogger } from "@openacme/config/logger";

const log = createLogger("tools.forensics");

export interface ToolForensicsSink {
  recordEvent(type: string, data?: Record<string, unknown>): void;
  writeRawFile(relativePath: string, data: string | Buffer): unknown;
}

export interface ToolForensicsSpan {
  traceId?: string;
  spanId?: string;
  setAttributes?(attributes: Record<string, unknown>): void;
  addEvent?(name: string, attributes?: Record<string, unknown>): void;
  recordException?(error: unknown): void;
  setStatusOk?(): void;
  setStatusError?(error: unknown): void;
}

export interface ToolForensicsBinding {
  getSink(): ToolForensicsSink | null | undefined;
  locatorAttributes?(args: ToolForensicLocatorArgs): Record<string, unknown>;
  withSpan?<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: ToolForensicsSpan) => Promise<T> | T
  ): Promise<T> | T;
}

export interface ToolForensicLocatorArgs {
  eventType: string;
  toolCallId?: string;
  sessionId?: string;
  relativeEvidenceDir?: string;
}

let binding: ToolForensicsBinding | null = null;

export function bindToolForensics(next: ToolForensicsBinding | null): void {
  binding = next;
}

export function withToolForensicSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: ToolForensicsSpan) => Promise<T> | T
): Promise<T> | T {
  const current = binding;
  if (!current?.withSpan) return fn({});
  return current.withSpan(name, attributes, fn);
}

export function recordToolForensicEvent(
  type: string,
  data?: Record<string, unknown>
): void {
  const sink = getSink();
  if (!sink) return;
  try {
    sink.recordEvent(type, data);
  } catch (err) {
    log.warn({ err, type }, "tool forensic event write failed");
  }
}

export function getToolForensicLocatorAttributes(
  args: ToolForensicLocatorArgs
): Record<string, unknown> {
  const current = binding;
  if (!current?.locatorAttributes) return {};
  try {
    return current.locatorAttributes(args);
  } catch (err) {
    log.warn({ err, eventType: args.eventType }, "tool forensic locator failed");
    return {};
  }
}

export function toolForensicLocatorPayload(
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

export function writeToolForensicRawFile(
  relativePath: string,
  data: string | Buffer
): unknown {
  const sink = getSink();
  if (!sink) return null;
  try {
    return sink.writeRawFile(relativePath, data);
  } catch (err) {
    log.warn({ err, relativePath }, "tool forensic raw write failed");
    return null;
  }
}

export function sha256ForensicText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeForensicSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe.length > 0 ? safe.slice(0, 160) : "unknown";
}

export function stringifyForensics(value: unknown): string {
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

function getSink(): ToolForensicsSink | null {
  if (!binding) return null;
  try {
    return binding.getSink() ?? null;
  } catch (err) {
    log.warn({ err }, "tool forensic sink resolution failed");
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
