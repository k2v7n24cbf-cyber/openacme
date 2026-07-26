import { randomUUID } from "node:crypto";
import type { WasmDatabase } from "../wasm/adapter.js";
import { drizzle } from "../wasm/drizzle.js";
import {
  sessionTimelineEvents,
  type SessionTimelineEventRow as RawSessionTimelineEventRow,
} from "../schema.js";

export type SessionTimelineSource =
  | "server"
  | "agent"
  | "usage"
  | "forensic";

export interface SessionTimelineEventInput {
  id?: string;
  createdAtMs?: number;
  sessionId: string;
  agentId?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  eventType: string;
  source: SessionTimelineSource | string;
  status?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  forensicRunId?: string | null;
  usageEventId?: string | null;
  durationMs?: number | null;
  payload?: unknown;
}

export interface SessionTimelineEvent {
  id: string;
  createdAtMs: number;
  sessionId: string;
  agentId: string | null;
  messageId: string | null;
  taskId: string | null;
  eventType: string;
  source: string;
  status: string | null;
  traceId: string | null;
  spanId: string | null;
  forensicRunId: string | null;
  usageEventId: string | null;
  durationMs: number | null;
  payload: unknown;
}

export interface SessionTimelineFilter {
  sessionId: string;
  source?: string;
  traceId?: string;
  forensicRunId?: string;
  usageEventId?: string;
}

export interface SessionTimelineCursor {
  createdAtMs: number;
  rowid: number;
}

export interface SessionTimelinePage {
  events: SessionTimelineEvent[];
  nextCursor: SessionTimelineCursor | null;
}

export function createSessionTimelineStore(db: WasmDatabase) {
  const orm = drizzle(db);

  return {
    record(input: SessionTimelineEventInput): SessionTimelineEvent {
      const row = orm
        .insert(sessionTimelineEvents)
        .values({
          id: input.id ?? randomUUID(),
          createdAtMs: input.createdAtMs ?? Date.now(),
          sessionId: input.sessionId,
          agentId: input.agentId ?? null,
          messageId: input.messageId ?? null,
          taskId: input.taskId ?? null,
          eventType: input.eventType,
          source: input.source,
          status: input.status ?? null,
          traceId: input.traceId ?? null,
          spanId: input.spanId ?? null,
          forensicRunId: input.forensicRunId ?? null,
          usageEventId: input.usageEventId ?? null,
          durationMs: input.durationMs ?? null,
          payload:
            input.payload === undefined ? null : safeStringify(input.payload),
        })
        .returning()
        .get();
      return toTimelineEvent(row);
    },

    list(
      filter: SessionTimelineFilter,
      opts: {
        limit?: number;
        after?: SessionTimelineCursor;
      } = {}
    ): SessionTimelinePage {
      const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
      const { clause, params } = buildWhere(filter, opts.after);
      const rows = db
        .prepare<[Record<string, unknown>], SessionTimelineRawRow>(
          `SELECT rowid AS rowid_, * FROM session_timeline_events ${clause}
           ORDER BY created_at_ms ASC, rowid ASC LIMIT ${limit + 1}`
        )
        .all(params);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        events: page.map(toTimelineEventFromRaw),
        nextCursor:
          rows.length > limit && last
            ? { createdAtMs: last.created_at_ms, rowid: last.rowid_ }
            : null,
      };
    },
  };
}

function buildWhere(
  filter: SessionTimelineFilter,
  after?: SessionTimelineCursor
): { clause: string; params: Record<string, unknown> } {
  const conds = ["session_id = @sessionId"];
  const params: Record<string, unknown> = { sessionId: filter.sessionId };
  if (filter.source) {
    conds.push("source = @source");
    params.source = filter.source;
  }
  if (filter.traceId) {
    conds.push("trace_id = @traceId");
    params.traceId = filter.traceId;
  }
  if (filter.forensicRunId) {
    conds.push("forensic_run_id = @forensicRunId");
    params.forensicRunId = filter.forensicRunId;
  }
  if (filter.usageEventId) {
    conds.push("usage_event_id = @usageEventId");
    params.usageEventId = filter.usageEventId;
  }
  if (after) {
    conds.push(
      "(created_at_ms > @afterCreatedAtMs OR (created_at_ms = @afterCreatedAtMs AND rowid > @afterRowid))"
    );
    params.afterCreatedAtMs = after.createdAtMs;
    params.afterRowid = after.rowid;
  }
  return { clause: `WHERE ${conds.join(" AND ")}`, params };
}

interface SessionTimelineRawRow {
  rowid_: number;
  id: string;
  created_at_ms: number;
  session_id: string;
  agent_id: string | null;
  message_id: string | null;
  task_id: string | null;
  event_type: string;
  source: string;
  status: string | null;
  trace_id: string | null;
  span_id: string | null;
  forensic_run_id: string | null;
  usage_event_id: string | null;
  duration_ms: number | null;
  payload: string | null;
}

function toTimelineEvent(
  row: RawSessionTimelineEventRow
): SessionTimelineEvent {
  return {
    id: row.id,
    createdAtMs: row.createdAtMs,
    sessionId: row.sessionId,
    agentId: row.agentId,
    messageId: row.messageId,
    taskId: row.taskId,
    eventType: row.eventType,
    source: row.source,
    status: row.status,
    traceId: row.traceId,
    spanId: row.spanId,
    forensicRunId: row.forensicRunId,
    usageEventId: row.usageEventId,
    durationMs: row.durationMs,
    payload: parsePayload(row.payload),
  };
}

function toTimelineEventFromRaw(
  row: SessionTimelineRawRow
): SessionTimelineEvent {
  return {
    id: row.id,
    createdAtMs: row.created_at_ms,
    sessionId: row.session_id,
    agentId: row.agent_id,
    messageId: row.message_id,
    taskId: row.task_id,
    eventType: row.event_type,
    source: row.source,
    status: row.status,
    traceId: row.trace_id,
    spanId: row.span_id,
    forensicRunId: row.forensic_run_id,
    usageEventId: row.usage_event_id,
    durationMs: row.duration_ms,
    payload: parsePayload(row.payload),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch (err) {
    return JSON.stringify({
      unavailable: true,
      reason: "json_stringify_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parsePayload(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return {
      unavailable: true,
      reason: "json_parse_failed",
    };
  }
}

export type SessionTimelineStore = ReturnType<
  typeof createSessionTimelineStore
>;
