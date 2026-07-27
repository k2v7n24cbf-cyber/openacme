import * as fs from "node:fs";
import * as path from "node:path";
import type { Hono } from "hono";
import type { AgentManager } from "../agent-manager.js";
import type {
  SessionTimelineCursor,
  SessionTimelineEvent,
  SessionTimelineFilter,
  UsageEventRow,
} from "@openacme/db";

const FORENSIC_EVENT_TYPES = new Set([
  "agent.run.start",
  "agent.model_input.snapshot",
  "provider.request",
  "provider.response",
  "provider.error",
  "tool.start",
  "tool.finish",
  "tool.error",
  "agent.run.finish",
  "agent.run.error",
  "compression.memory_flush.start",
  "compression.memory_flush.finish",
  "compression.memory_flush.error",
  "compression.summarizer.start",
  "compression.summarizer.finish",
  "compression.summarizer.error",
]);

export function registerSessionTimelineRoutes(
  app: Hono,
  manager: AgentManager,
): void {
  app.get("/api/sessions/:id/timeline", (c) => {
    const sessionId = c.req.param("id");
    const limit = clampInt(c.req.query("limit"), 200, 1, 1000);
    const includeForensics = c.req.query("includeForensics") !== "0";
    const source = c.req.query("source") || undefined;
    const filter: SessionTimelineFilter = {
      sessionId,
      ...(source ? { source } : {}),
      ...(c.req.query("traceId") ? { traceId: c.req.query("traceId") } : {}),
      ...(c.req.query("forensicRunId")
        ? { forensicRunId: c.req.query("forensicRunId") }
        : {}),
      ...(c.req.query("usageEventId")
        ? { usageEventId: c.req.query("usageEventId") }
        : {}),
    };
    const after = parseCursor(c.req.query("after"));
    if (c.req.query("after") && !after) {
      return c.json({ error: "invalid cursor" }, 400);
    }

    const dbPage = manager.sessionTimelineStore.list(filter, {
      limit,
      ...(after ? { after } : {}),
    });
    const events = [...dbPage.events];
    if (includeForensics && (!source || source === "forensic")) {
      const usageRows = manager.usageStore.listEvents(
        { sessionId },
        { limit: 200 },
      ).events;
      events.push(...readForensicTimelineEvents(usageRows, filter));
    }
    events.sort(compareTimelineEvents);

    return c.json({
      events: events.slice(0, limit),
      nextCursor: dbPage.nextCursor ? formatCursor(dbPage.nextCursor) : null,
    });
  });
}

function readForensicTimelineEvents(
  usageRows: UsageEventRow[],
  filter: SessionTimelineFilter,
): SessionTimelineEvent[] {
  const out: SessionTimelineEvent[] = [];
  for (const usage of usageRows) {
    if (!usage.forensicPath || !usage.forensicRunId) continue;
    const eventsPath = path.join(usage.forensicPath, "events.jsonl");
    if (!fs.existsSync(eventsPath)) continue;
    const lines = safeReadLines(eventsPath);
    for (let index = 0; index < lines.length; index += 1) {
      const row = parseJson(lines[index]);
      if (!isForensicRow(row)) continue;
      if (!FORENSIC_EVENT_TYPES.has(row.type)) continue;
      const event = forensicRowToTimelineEvent(row, usage, index);
      if (matchesFilter(event, filter)) out.push(event);
    }
  }
  return out;
}

interface ForensicRow {
  timestamp?: string;
  type: string;
  forensicRunId?: string;
  traceId?: string;
  spanId?: string;
  context?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function forensicRowToTimelineEvent(
  row: ForensicRow,
  usage: UsageEventRow,
  index: number,
): SessionTimelineEvent {
  const context = row.context ?? {};
  const createdAtMs = parseTimestamp(row.timestamp) ?? usage.createdAt * 1000;
  const data = row.data ?? {};
  const forensicRunId = row.forensicRunId ?? usage.forensicRunId ?? null;
  return {
    id: `forensic:${usage.forensicRunId}:${index}:${row.type}`,
    createdAtMs,
    sessionId: usage.sessionId,
    agentId: stringValue(context.agentId) ?? usage.agentId,
    messageId: stringValue(context.messageId) ?? usage.messageId,
    taskId: stringValue(context.taskId) ?? usage.taskId,
    eventType: row.type,
    source: "forensic",
    status: inferStatus(row.type, data),
    traceId: row.traceId ?? usage.traceId,
    spanId: row.spanId ?? usage.spanId,
    forensicRunId,
    usageEventId: usage.id,
    durationMs: numberValue(data.durationMs),
    payload: withOperatorTimelineLocator(
      sanitizeForensicPayload(data),
      usage.sessionId,
      forensicRunId,
    ),
  };
}

function withOperatorTimelineLocator(
  payload: unknown,
  sessionId: string,
  forensicRunId: string | null,
): unknown {
  const timelineLocator = buildSessionTimelineLocator({
    sessionId,
    forensicRunId,
  });
  if (!timelineLocator || !payload || typeof payload !== "object") {
    return payload;
  }
  if (Array.isArray(payload)) return payload;
  return { ...payload, timelineLocator };
}

function buildSessionTimelineLocator(args: {
  sessionId?: string | null;
  forensicRunId?: string | null;
}): string | undefined {
  const sessionId = cleanString(args.sessionId);
  if (!sessionId) return undefined;
  const params = new URLSearchParams({ includeForensics: "1" });
  const forensicRunId = cleanString(args.forensicRunId);
  if (forensicRunId) params.set("forensicRunId", forensicRunId);
  return `/api/sessions/${encodeURIComponent(sessionId)}/timeline?${params.toString()}`;
}

function sanitizeForensicPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForensicPayload);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("raw") ||
      lower.includes("file") ||
      lower.includes("path")
    ) {
      continue;
    }
    out[key] = sanitizeForensicPayload(child);
  }
  return out;
}

function matchesFilter(
  event: SessionTimelineEvent,
  filter: SessionTimelineFilter,
): boolean {
  if (event.sessionId !== filter.sessionId) return false;
  if (filter.source && event.source !== filter.source) return false;
  if (filter.traceId && event.traceId !== filter.traceId) return false;
  if (filter.forensicRunId && event.forensicRunId !== filter.forensicRunId) {
    return false;
  }
  if (filter.usageEventId && event.usageEventId !== filter.usageEventId) {
    return false;
  }
  return true;
}

function compareTimelineEvents(
  a: SessionTimelineEvent,
  b: SessionTimelineEvent,
): number {
  return a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id);
}

function parseCursor(value: string | undefined): SessionTimelineCursor | null {
  if (!value) return null;
  const match = /^(\d+)_(\d+)$/.exec(value);
  if (!match) return null;
  return { createdAtMs: Number(match[1]), rowid: Number(match[2]) };
}

function formatCursor(cursor: SessionTimelineCursor): string {
  return `${cursor.createdAtMs}_${cursor.rowid}`;
}

function clampInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function safeReadLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isForensicRow(value: unknown): value is ForensicRow {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cleanString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inferStatus(
  type: string,
  data: Record<string, unknown>,
): string | null {
  if (type === "tool.finish") {
    const resultStatus = stringValue(data.resultStatus);
    if (resultStatus === "success") return "ok";
    if (resultStatus === "failure") return "error";
    if (
      resultStatus === "partial" ||
      resultStatus === "running" ||
      resultStatus === "unknown"
    ) {
      return resultStatus;
    }
  }
  if (type.endsWith(".error")) return "error";
  if (type.endsWith(".finish") || type.endsWith(".response")) return "ok";
  return null;
}
