export const FORENSIC_LOOKUP_KEY = "usage_events.forensic_run_id";

export interface ForensicEvidenceRefArgs {
  forensicRunId?: string | null;
  eventType: string;
  selector?: string | number | null;
}

interface ForensicCorrelationArgs {
  sessionId?: string | null;
  forensicRunId?: string | null;
}

export interface ForensicLocatorArgs
  extends ForensicEvidenceRefArgs, ForensicCorrelationArgs {
  eventSelector?: string | null;
  relativeEvidenceDir?: string | null;
}

export function buildForensicEvidenceRef(
  args: ForensicEvidenceRefArgs,
): string | undefined {
  const forensicRunId = clean(args.forensicRunId);
  const eventType = clean(args.eventType);
  if (!forensicRunId || !eventType) return undefined;
  const selector = clean(
    args.selector === undefined || args.selector === null
      ? undefined
      : String(args.selector),
  );
  const fragment = selector
    ? `${encodeURIComponent(eventType)}:${encodeURIComponent(selector)}`
    : encodeURIComponent(eventType);
  return `openacme://forensics/${encodeURIComponent(forensicRunId)}#${fragment}`;
}

export function buildForensicEventSelector(
  eventType: string,
  fields: Record<string, string | number | undefined | null> = {},
): string {
  const parts = [`type=${eventType}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    parts.push(`${key}=${text}`);
  }
  return parts.join(" ");
}

export function buildForensicLocatorAttributes(
  args: ForensicLocatorArgs,
): Record<string, string> {
  const evidenceRef = buildForensicEvidenceRef(args);
  if (!evidenceRef) return {};
  const out: Record<string, string> = {
    "openacme.forensic.lookup": FORENSIC_LOOKUP_KEY,
    "openacme.forensic.evidence_ref": evidenceRef,
  };
  const eventSelector = clean(args.eventSelector);
  if (eventSelector) out["openacme.forensic.event_selector"] = eventSelector;
  const relativeEvidenceDir = sanitizeRelativeEvidenceDir(
    args.relativeEvidenceDir,
  );
  if (relativeEvidenceDir) {
    out["openacme.forensic.relative_evidence_dir"] = relativeEvidenceDir;
  }
  return out;
}

export function buildForensicLocatorPayload(
  args: ForensicLocatorArgs,
): Record<string, string> {
  const attrs = buildForensicLocatorAttributes(args);
  const out: Record<string, string> = {};
  copy(attrs, out, "openacme.forensic.evidence_ref", "evidenceRef");
  copy(attrs, out, "openacme.forensic.event_selector", "eventSelector");
  copy(
    attrs,
    out,
    "openacme.forensic.relative_evidence_dir",
    "relativeEvidenceDir",
  );
  return out;
}

function copy(
  source: Record<string, string>,
  target: Record<string, string>,
  sourceKey: string,
  targetKey: string,
): void {
  const value = source[sourceKey];
  if (value) target[targetKey] = value;
}

function clean(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeRelativeEvidenceDir(
  value: string | null | undefined,
): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  const parts = cleaned
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    return undefined;
  }
  return parts.join("/");
}
