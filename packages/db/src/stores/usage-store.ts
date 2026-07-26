import type { WasmDatabase } from "../wasm/adapter.js";
import { drizzle } from "../wasm/drizzle.js";
import { randomUUID } from "node:crypto";
import { usageEvents, type UsageEventRow } from "../schema.js";
import type {
  UsageKind,
  UsageAuthMode,
  UsageCostSource,
} from "../usage-kinds.js";

export type { UsageEventRow } from "../schema.js";

export interface UsageEventInput {
  agentId: string;
  sessionId: string;
  messageId?: string | null;
  taskId?: string | null;
  kind: UsageKind;
  provider: string;
  model: string;
  authMode: UsageAuthMode;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number;
  costUsd?: number | null;
  costUsdEquivalent?: number | null;
  costSource: UsageCostSource;
  steps?: number | null;
  durationMs?: number | null;
  traceId?: string | null;
  spanId?: string | null;
  forensicRunId?: string | null;
  forensicPath?: string | null;
  providerRequestCount?: number | null;
  id?: string;
  /** Epoch-seconds override, tests only. */
  createdAt?: number;
}

/** Shared filter applied by every aggregate query. Epoch seconds. */
export interface UsageFilter {
  from?: number;
  to?: number;
  agentId?: string;
  sessionId?: string;
  model?: string;
  kind?: UsageKind;
  taskId?: string;
}

export interface UsageTotals {
  costUsd: number;
  costUsdEquivalent: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  events: number;
  /** Spend split by auth mode so the UI can label subscription vs paid. */
  costUsdByAuthMode: Record<string, number>;
  eventsByKind: Record<string, number>;
}

export interface UsageSeriesRow {
  /** Bucket start, epoch seconds (UTC bucketing). */
  t: number;
  /** Group key (agent id, model id, or kind). */
  key: string;
  costUsd: number;
  costUsdEquivalent: number;
  totalTokens: number;
  events: number;
}

export interface UsageBreakdownRow {
  key: string;
  costUsd: number;
  costUsdEquivalent: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  events: number;
  lastAt: number;
}

export interface DailyAgentCost {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  agentId: string;
  costUsd: number;
  costUsdEquivalent: number;
  totalTokens: number;
  events: number;
}

export interface AgentHourCell {
  agentId: string;
  /** 0–23 (UTC). */
  hour: number;
  costUsd: number;
  costUsdEquivalent: number;
  events: number;
}

function buildWhere(filter: UsageFilter): {
  clause: string;
  params: Record<string, unknown>;
} {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.from !== undefined) {
    conds.push("created_at >= @from");
    params.from = filter.from;
  }
  if (filter.to !== undefined) {
    conds.push("created_at < @to");
    params.to = filter.to;
  }
  if (filter.agentId) {
    conds.push("agent_id = @agentId");
    params.agentId = filter.agentId;
  }
  if (filter.sessionId) {
    conds.push("session_id = @sessionId");
    params.sessionId = filter.sessionId;
  }
  if (filter.model) {
    conds.push("model = @model");
    params.model = filter.model;
  }
  if (filter.kind) {
    conds.push("kind = @kind");
    params.kind = filter.kind;
  }
  if (filter.taskId) {
    conds.push("task_id = @taskId");
    params.taskId = filter.taskId;
  }
  return {
    clause: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
}

const GROUP_COLS = {
  agent: "agent_id",
  model: "model",
  kind: "kind",
  task: "task_id",
} as const;

export type UsageGroupBy = keyof typeof GROUP_COLS;

/**
 * Usage ledger store. Aggregates are raw SQL (the queries are GROUP BYs
 * over indexed columns; drizzle adds nothing here) — the
 * `unresolvedPingsBySession` precedent in event-store.ts. All bucketing
 * is UTC: budgets and the calendar heatmap reset at UTC midnight.
 */
export function createUsageStore(db: WasmDatabase) {
  const orm = drizzle(db);

  return {
    record(input: UsageEventInput): UsageEventRow {
      return orm
        .insert(usageEvents)
        .values({
          id: input.id ?? randomUUID(),
          ...(input.createdAt !== undefined
            ? { createdAt: input.createdAt }
            : {}),
          agentId: input.agentId,
          sessionId: input.sessionId,
          messageId: input.messageId ?? null,
          taskId: input.taskId ?? null,
          kind: input.kind,
          provider: input.provider,
          model: input.model,
          authMode: input.authMode,
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          cachedInputTokens: input.cachedInputTokens ?? 0,
          cacheWriteTokens: input.cacheWriteTokens ?? null,
          reasoningTokens: input.reasoningTokens ?? null,
          totalTokens: input.totalTokens ?? 0,
          costUsd: input.costUsd ?? null,
          costUsdEquivalent: input.costUsdEquivalent ?? null,
          costSource: input.costSource,
          steps: input.steps ?? null,
          durationMs: input.durationMs ?? null,
          traceId: input.traceId ?? null,
          spanId: input.spanId ?? null,
          forensicRunId: input.forensicRunId ?? null,
          forensicPath: input.forensicPath ?? null,
          providerRequestCount: input.providerRequestCount ?? null,
        })
        .returning()
        .get();
    },

    totals(filter: UsageFilter): UsageTotals {
      const { clause, params } = buildWhere(filter);
      const row = db
        .prepare<
          [Record<string, unknown>],
          {
            cost_usd: number | null;
            cost_usd_equivalent: number | null;
            input_tokens: number | null;
            output_tokens: number | null;
            cached_input_tokens: number | null;
            cache_write_tokens: number | null;
            total_tokens: number | null;
            events: number;
          }
        >(
          `SELECT
             SUM(cost_usd) AS cost_usd,
             SUM(cost_usd_equivalent) AS cost_usd_equivalent,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cached_input_tokens) AS cached_input_tokens,
             SUM(cache_write_tokens) AS cache_write_tokens,
             SUM(total_tokens) AS total_tokens,
             COUNT(*) AS events
           FROM usage_events ${clause}`
        )
        .get(params);
      const byAuth = db
        .prepare<
          [Record<string, unknown>],
          { auth_mode: string; cost_usd: number | null }
        >(
          `SELECT auth_mode, SUM(cost_usd) AS cost_usd
           FROM usage_events ${clause} GROUP BY auth_mode`
        )
        .all(params);
      const byKind = db
        .prepare<[Record<string, unknown>], { kind: string; events: number }>(
          `SELECT kind, COUNT(*) AS events
           FROM usage_events ${clause} GROUP BY kind`
        )
        .all(params);
      return {
        costUsd: row?.cost_usd ?? 0,
        costUsdEquivalent: row?.cost_usd_equivalent ?? 0,
        inputTokens: row?.input_tokens ?? 0,
        outputTokens: row?.output_tokens ?? 0,
        cachedInputTokens: row?.cached_input_tokens ?? 0,
        cacheWriteTokens: row?.cache_write_tokens ?? 0,
        totalTokens: row?.total_tokens ?? 0,
        events: row?.events ?? 0,
        costUsdByAuthMode: Object.fromEntries(
          byAuth.map((r) => [r.auth_mode, r.cost_usd ?? 0])
        ),
        eventsByKind: Object.fromEntries(
          byKind.map((r) => [r.kind, r.events])
        ),
      };
    },

    series(
      filter: UsageFilter,
      bucket: "hour" | "day",
      groupBy: Exclude<UsageGroupBy, "task">
    ): UsageSeriesRow[] {
      const { clause, params } = buildWhere(filter);
      const col = GROUP_COLS[groupBy];
      // unixepoch(...) of the bucket-truncated timestamp keeps `t`
      // numeric for the client; strftime is UTC by default.
      const expr =
        bucket === "hour"
          ? `unixepoch(strftime('%Y-%m-%dT%H:00:00', created_at, 'unixepoch'))`
          : `unixepoch(date(created_at, 'unixepoch'))`;
      return db
        .prepare<
          [Record<string, unknown>],
          {
            t: number;
            key: string;
            cost_usd: number | null;
            cost_usd_equivalent: number | null;
            total_tokens: number | null;
            events: number;
          }
        >(
          `SELECT ${expr} AS t, ${col} AS key,
             SUM(cost_usd) AS cost_usd,
             SUM(cost_usd_equivalent) AS cost_usd_equivalent,
             SUM(total_tokens) AS total_tokens,
             COUNT(*) AS events
           FROM usage_events ${clause}
           GROUP BY t, key ORDER BY t ASC`
        )
        .all(params)
        .map((r) => ({
          t: r.t,
          key: r.key,
          costUsd: r.cost_usd ?? 0,
          costUsdEquivalent: r.cost_usd_equivalent ?? 0,
          totalTokens: r.total_tokens ?? 0,
          events: r.events,
        }));
    },

    breakdown(filter: UsageFilter, by: UsageGroupBy): UsageBreakdownRow[] {
      const { clause, params } = buildWhere(filter);
      const col = GROUP_COLS[by];
      // task grouping drops rows with no task binding (overhead kinds).
      const extra =
        by === "task"
          ? clause
            ? `${clause} AND task_id IS NOT NULL`
            : "WHERE task_id IS NOT NULL"
          : clause;
      return db
        .prepare<
          [Record<string, unknown>],
          {
            key: string;
            cost_usd: number | null;
            cost_usd_equivalent: number | null;
            input_tokens: number | null;
            output_tokens: number | null;
            cached_input_tokens: number | null;
            cache_write_tokens: number | null;
            total_tokens: number | null;
            events: number;
            last_at: number;
          }
        >(
          `SELECT ${col} AS key,
             SUM(cost_usd) AS cost_usd,
             SUM(cost_usd_equivalent) AS cost_usd_equivalent,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cached_input_tokens) AS cached_input_tokens,
             SUM(cache_write_tokens) AS cache_write_tokens,
             SUM(total_tokens) AS total_tokens,
             COUNT(*) AS events,
             MAX(created_at) AS last_at
           FROM usage_events ${extra}
           GROUP BY key
           ORDER BY COALESCE(SUM(cost_usd_equivalent), 0) DESC, events DESC`
        )
        .all(params)
        .map((r) => ({
          key: r.key,
          costUsd: r.cost_usd ?? 0,
          costUsdEquivalent: r.cost_usd_equivalent ?? 0,
          inputTokens: r.input_tokens ?? 0,
          outputTokens: r.output_tokens ?? 0,
          cachedInputTokens: r.cached_input_tokens ?? 0,
          cacheWriteTokens: r.cache_write_tokens ?? 0,
          totalTokens: r.total_tokens ?? 0,
          events: r.events,
          lastAt: r.last_at,
        }));
    },

    /**
     * Newest-first page of raw ledger rows. Keyset pagination on
     * `(created_at DESC, rowid DESC)` — the same-second tie-break idiom
     * used everywhere in this package. `before` is the cursor returned
     * by the previous page.
     */
    listEvents(
      filter: UsageFilter,
      opts: { limit?: number; before?: { createdAt: number; rowid: number } } = {}
    ): { events: UsageEventRow[]; nextCursor: { createdAt: number; rowid: number } | null } {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const { clause, params } = buildWhere(filter);
      let where = clause;
      if (opts.before) {
        const cursorCond =
          "(created_at < @curTs OR (created_at = @curTs AND rowid < @curRow))";
        where = where ? `${where} AND ${cursorCond}` : `WHERE ${cursorCond}`;
        params.curTs = opts.before.createdAt;
        params.curRow = opts.before.rowid;
      }
      const rows = db
        .prepare<[Record<string, unknown>], UsageEventRawRow>(
          `SELECT rowid AS rowid_, * FROM usage_events ${where}
           ORDER BY created_at DESC, rowid DESC LIMIT ${limit + 1}`
        )
        .all(params);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        events: page.map(toEventRow),
        nextCursor:
          rows.length > limit && last
            ? { createdAt: last.created_at, rowid: last.rowid_ }
            : null,
      };
    },

    /**
     * Daily cost per agent since `sinceTs`, optionally narrowed by the
     * non-time filter dimensions. Feeds the anomaly check, the
     * forecast, and the calendar heatmap — one query shape for all.
     */
    dailyCostByAgent(
      sinceTs: number,
      dims: Omit<UsageFilter, "from" | "to"> = {}
    ): DailyAgentCost[] {
      const { clause, params } = buildWhere({ ...dims, from: sinceTs });
      return db
        .prepare<
          [Record<string, unknown>],
          {
            day: string;
            agent_id: string;
            cost_usd: number | null;
            cost_usd_equivalent: number | null;
            total_tokens: number | null;
            events: number;
          }
        >(
          `SELECT date(created_at, 'unixepoch') AS day, agent_id,
             SUM(cost_usd) AS cost_usd,
             SUM(cost_usd_equivalent) AS cost_usd_equivalent,
             SUM(total_tokens) AS total_tokens,
             COUNT(*) AS events
           FROM usage_events ${clause}
           GROUP BY day, agent_id ORDER BY day ASC`
        )
        .all(params)
        .map((r) => ({
          day: r.day,
          agentId: r.agent_id,
          costUsd: r.cost_usd ?? 0,
          costUsdEquivalent: r.cost_usd_equivalent ?? 0,
          totalTokens: r.total_tokens ?? 0,
          events: r.events,
        }));
    },

    /** Agent × hour-of-day matrix for the punch card. */
    agentHourMatrix(filter: UsageFilter): AgentHourCell[] {
      const { clause, params } = buildWhere(filter);
      return db
        .prepare<
          [Record<string, unknown>],
          {
            agent_id: string;
            hour: number;
            cost_usd: number | null;
            cost_usd_equivalent: number | null;
            events: number;
          }
        >(
          `SELECT agent_id,
             CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS hour,
             SUM(cost_usd) AS cost_usd,
             SUM(cost_usd_equivalent) AS cost_usd_equivalent,
             COUNT(*) AS events
           FROM usage_events ${clause}
           GROUP BY agent_id, hour`
        )
        .all(params)
        .map((r) => ({
          agentId: r.agent_id,
          hour: r.hour,
          costUsd: r.cost_usd ?? 0,
          costUsdEquivalent: r.cost_usd_equivalent ?? 0,
          events: r.events,
        }));
    },
  };
}

interface UsageEventRawRow {
  rowid_: number;
  id: string;
  created_at: number;
  agent_id: string;
  session_id: string;
  message_id: string | null;
  task_id: string | null;
  kind: string;
  provider: string;
  model: string;
  auth_mode: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number;
  cost_usd: number | null;
  cost_usd_equivalent: number | null;
  cost_source: string;
  steps: number | null;
  duration_ms: number | null;
  trace_id: string | null;
  span_id: string | null;
  forensic_run_id: string | null;
  forensic_path: string | null;
  provider_request_count: number | null;
}

function toEventRow(r: UsageEventRawRow): UsageEventRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    agentId: r.agent_id,
    sessionId: r.session_id,
    messageId: r.message_id,
    taskId: r.task_id,
    kind: r.kind as UsageEventRow["kind"],
    provider: r.provider,
    model: r.model,
    authMode: r.auth_mode as UsageEventRow["authMode"],
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedInputTokens: r.cached_input_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    totalTokens: r.total_tokens,
    costUsd: r.cost_usd,
    costUsdEquivalent: r.cost_usd_equivalent,
    costSource: r.cost_source as UsageEventRow["costSource"],
    steps: r.steps,
    durationMs: r.duration_ms,
    traceId: r.trace_id,
    spanId: r.span_id,
    forensicRunId: r.forensic_run_id,
    forensicPath: r.forensic_path,
    providerRequestCount: r.provider_request_count,
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;
