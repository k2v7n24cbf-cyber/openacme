import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import {
  COMMENT_KINDS,
  EVENT_KINDS,
  INBOX_KINDS,
  INBOX_SOURCES,
  TASK_STATUSES,
} from "@openacme/tasks";
import {
  USAGE_KINDS,
  USAGE_AUTH_MODES,
  USAGE_COST_SOURCES,
} from "./usage-kinds.js";

export const OBJECTIVE_STATUSES = [
  "active",
  "waiting_on_tasks",
  "ready_for_closeout",
  "completed",
  "failed",
  "canceled",
] as const;

/**
 * Drizzle schema definitions. Source of truth for the structured tables;
 * `drizzle-kit generate` reads this file to produce SQL migrations under
 * `packages/db/drizzle/`. Never write `ALTER TABLE` by hand — change the
 * schema here, regenerate, and a new migration appears.
 *
 * FTS5 virtual tables and their sync triggers are NOT modeled here
 * (drizzle-kit doesn't know about them). They live in the dedicated
 * `*_fts.sql` migration alongside the auto-generated ones.
 *
 * Note on `agent_id`: agents themselves live as YAML files under
 * `<dataDir>/agents/<id>/AGENT.md` — the field here is just a label, no
 * foreign key to a `agents` table.
 */

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    title: text("title"),
    systemPrompt: text("system_prompt"),
    parentSessionId: text("parent_session_id"),
    kind: text("kind", { enum: ["chat", "task"] })
      .notNull()
      .default("chat"),
    turnsBlockedReason: text("turns_blocked_reason"),
    turnsBlockedAt: integer("turns_blocked_at"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at")
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => sql`(unixepoch())`),
    // Sticky "skip routine spawns until this time" set by the agent via
    // `defer_session(duration)`. Holds against periodic ticks until it
    // naturally expires; only replaced by a subsequent `defer_session`
    // call. New inbox rows bypass the defer (real signals always wake)
    // BUT do not wipe it — defer keeps suppressing pure-tick wakes for
    // the rest of the window. Capped at now + 24h at write time.
    deferUntil: integer("defer_until"),
  },
  (t) => [
    index("idx_sessions_agent_id").on(t.agentId),
    index("idx_sessions_parent").on(t.parentSessionId),
  ],
);

/**
 * One row per UIMessage. `parts` is `UIMessagePart[]` from the AI SDK,
 * stored as JSON. Tool calls + their results live as `tool-${name}`
 * parts inside the same assistant message — no per-step rows. File
 * attachments are `file` parts whose `url` is `/api/attachments/<...>`,
 * pointing at bytes on disk under `<dataDir>/attachments/<sessionId>/`.
 *
 * `content` / `tool_calls` / `tool_call_id` / `tool_name` columns are
 * gone. The pre-UIMessage shape is dropped, no backfill — see plan.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    parts: text("parts").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("idx_messages_session_id").on(t.sessionId)],
);

/**
 * Per-turn model-context snapshots. The canonical conversation stays in
 * `messages`; this table records the initial UIMessage projection passed to
 * the agent runtime when compaction changes model input. It is not a complete
 * provider transcript: system prompt, tool schemas, UIMessage-to-provider
 * conversion, and autonomous per-step injections are added after this layer.
 */
export const sessionContextSnapshots = sqliteTable(
  "session_context_snapshots",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    reason: text("reason", {
      enum: ["proactive", "payload_too_large", "context_overflow"],
    }).notNull(),
    compressed: integer("compressed", { mode: "boolean" }).notNull(),
    modelMessages: text("model_messages").notNull(),
    canonicalMessageCount: integer("canonical_message_count").notNull(),
    sourceLastMessageId: text("source_last_message_id"),
    summaryText: text("summary_text"),
    summarySha256: text("summary_sha256"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_context_snapshots_session").on(t.sessionId, t.createdAt),
    index("idx_context_snapshots_last_message").on(t.sourceLastMessageId),
  ],
);

export const userProfiles = sqliteTable("user_profiles", {
  id: text("id").primaryKey(),
  content: text("content").notNull().default(""),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Objective records group tasks under a tracked outcome. V1 objectives
 * are SQL-only and do not create sessions, dispatch work, or verify results
 * themselves; closeout is handled by a separate server service.
 */
export const objectives = sqliteTable(
  "objectives",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: OBJECTIVE_STATUSES }).notNull(),
    ownerAgentId: text("owner_agent_id").notNull(),
    ownerSessionId: text("owner_session_id"),
    createdBy: text("created_by").notNull(),
    createdInSessionId: text("created_in_session_id"),
    closeoutPrompt: text("closeout_prompt").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    completionSummary: text("completion_summary"),
    lastCloseoutFingerprint: text("last_closeout_fingerprint"),
    lastCloseoutBriefJson: text("last_closeout_brief_json"),
    lastCloseoutBriefAt: text("last_closeout_brief_at"),
  },
  (t) => [
    check(
      "objectives_status_check",
      sql`${t.status} IN ('active', 'waiting_on_tasks', 'ready_for_closeout', 'completed', 'failed', 'canceled')`,
    ),
    index("idx_objectives_status").on(t.status),
    index("idx_objectives_owner").on(t.ownerAgentId, t.status),
    index("idx_objectives_owner_session").on(t.ownerSessionId),
  ],
);

/**
 * Canonical task state. Markdown task files are imported once for local
 * migration/backup; live task reads and writes move through this table.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull(),
    assignee: text("assignee").notNull(),
    sessionId: text("session_id"),
    objectiveId: text("objective_id"),
    createdBy: text("created_by").notNull(),
    createdInSessionId: text("created_in_session_id"),
    parentId: text("parent_id"),
    dependsOnJson: text("depends_on_json").notNull().default("[]"),
    startAt: text("start_at"),
    dueAt: text("due_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    recurrenceJson: text("recurrence_json"),
    runs: integer("runs").notNull().default(0),
    lastRunAt: text("last_run_at"),
    team: text("team"),
    body: text("body").notNull().default(""),
  },
  (t) => [
    check(
      "tasks_status_check",
      sql`${t.status} IN ('open', 'in_progress', 'blocked', 'system_blocked', 'done', 'canceled')`,
    ),
    index("idx_tasks_assignee_status").on(t.assignee, t.status),
    index("idx_tasks_session_status").on(t.sessionId, t.status),
    index("idx_tasks_created_by").on(t.createdBy),
    index("idx_tasks_team").on(t.team),
    index("idx_tasks_parent").on(t.parentId),
    index("idx_tasks_objective").on(t.objectiveId),
    uniqueIndex("idx_tasks_one_in_progress_per_session")
      .on(t.sessionId)
      .where(sql`${t.sessionId} IS NOT NULL AND ${t.status} = 'in_progress'`),
  ],
);

export const taskMeta = sqliteTable("task_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Task-anchored discussion thread. One row per comment. Append-only —
 * no edit, no delete; mistakes get follow-up comments. `task_id` has no
 * FK constraint because tasks live as filesystem markdown, not DB rows.
 *
 * `kind` is nullable for plain comments. Reserved values: "result"
 * (assignee's canonical answer at completion) and "system" (scheduler /
 * automation-authored annotations). Tool surface gates writes.
 */
export const taskComments = sqliteTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    author: text("author").notNull(),
    /** Drizzle `enum` is a TS hint only (no DB CHECK constraint).
     *  Single source of truth: `COMMENT_KINDS` in `@openacme/tasks`. */
    kind: text("kind", { enum: COMMENT_KINDS }),
    body: text("body").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_task_comments_task").on(t.taskId, t.createdAt),
    index("idx_task_comments_kind").on(t.taskId, t.kind),
  ],
);

/**
 * Objective ledger. Unlike task events, objective events are SQL-only and can
 * cascade with their objective record.
 */
export const objectiveEvents = sqliteTable(
  "objective_events",
  {
    id: text("id").primaryKey(),
    objectiveId: text("objective_id")
      .notNull()
      .references(() => objectives.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    summary: text("summary").notNull(),
    detailsJson: text("details_json"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_objective_events_objective").on(
      t.objectiveId,
      t.createdAt,
    ),
  ],
);

/**
 * Append-only event log. Originally task-anchored; now polymorphic
 * across task events and session-level events (e.g. `ping_user` where
 * no task is in scope). Constraint: at least one of (task_id, session_id)
 * is set — enforced at write time in `EventStore.append`. Both indices
 * exist so reads from either anchor are cheap.
 *
 * `agent_id` is the actor (or "system:scheduler"); the recipient is
 * computed implicitly at read time from task involvement / session
 * binding.
 */
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    agentId: text("agent_id").notNull(),
    /** The actor that caused this event (agent id). Used both for
     *  prompt attribution and for the wake policy's echo suppression
     *  — a session never wakes from its owning agent's own actions.
     *  Null = anonymous / auto / system, which always wakes. */
    actor: text("actor"),
    /** Drizzle `enum` is a TS hint only. Single source of truth:
     *  `EVENT_KINDS` in `@openacme/tasks`. */
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    payload: text("payload"),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_task_events_task").on(t.taskId, t.createdAt),
    index("idx_task_events_session").on(t.sessionId, t.createdAt),
    index("idx_task_events_created").on(t.createdAt),
  ],
);

/**
 * Per-agent delivery queue. Rows are written when signals (user
 * messages, task events, system notices) should reach an agent that
 * isn't currently reading. The runtime drains pending rows at turn
 * start and at LLM-step boundaries, then **hard-deletes** them — this
 * table is staging, not audit. The immutable audit log lives in
 * `task_events`.
 *
 * Ordering is by `id` (autoincrement). Same-agent self-emits are
 * filtered at the delivery boundary (in AgentManager) so the agent's
 * own actions don't show up in its own inbox.
 */
export const agentInbox = sqliteTable(
  "agent_inbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: text("agent_id").notNull(),
    /** Drizzle `enum` is a TS hint only. Source of truth:
     *  `INBOX_KINDS` in `@openacme/tasks`. */
    kind: text("kind", { enum: INBOX_KINDS }).notNull(),
    /** Two values: `"user"` for anything originating from a human,
     *  `"system"` for everything platform-generated (task events,
     *  cron, system notices). Source of truth: `INBOX_SOURCES`. */
    source: text("source", { enum: INBOX_SOURCES }).notNull(),
    /** Optional originator id — user id for `source: "user"`, agent id
     *  or system tag for `source: "system"`. Not used for routing;
     *  surfaced in the rendered drain for audit / prompt context. */
    sourceId: text("source_id"),
    relatedTask: text("related_task"),
    relatedSession: text("related_session"),
    /** JSON. For `user_message`, the full UIMessage so it can be
     *  spliced into the chat history at drain time. For
     *  `system_notice`, a small structured object the renderer
     *  formats as text. */
    payload: text("payload").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("idx_inbox_agent").on(t.agentId, t.id)],
);

/**
 * Web Push subscriptions. One row per device (browser endpoint). The
 * deployment is single-operator, so no `user_id` — multi-device just
 * means multiple rows. `endpoint` is unique so a re-subscribe upserts
 * cleanly without orphaning the old row.
 *
 * Key material (p256dh + auth) is required by RFC 8291 to encrypt the
 * push payload. Treat the row as a credential — readable only to the
 * server process; never expose `p256dh` / `auth` in API responses.
 */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  lastUsedAt: integer("last_used_at"),
});

/**
 * Usage ledger: one row per LLM call (turn or overhead subagent call).
 * Deliberately NO foreign keys — deleting a session (or a compression
 * fork getting cleaned up) must not erase spend history; the ledger
 * outlives the conversations that produced it. `session_id` /
 * `message_id` / `task_id` are plain reference labels for drill-down
 * while the referent exists.
 *
 * `input_tokens` is the provider-reported TOTAL input including cache
 * reads and writes (the Anthropic adapter's convention); uncached input
 * = input − cached_input − cache_write. `cost_usd` is real spend (null
 * for subscription/local); `cost_usd_equivalent` is registry list price
 * whenever pricing is known, regardless of auth mode.
 */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    agentId: text("agent_id").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id"),
    taskId: text("task_id"),
    /** Drizzle `enum` is a TS hint only. Source of truth:
     *  `USAGE_KINDS` in `./usage-kinds.ts`. */
    kind: text("kind", { enum: USAGE_KINDS }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    authMode: text("auth_mode", { enum: USAGE_AUTH_MODES }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    costUsdEquivalent: real("cost_usd_equivalent"),
    costSource: text("cost_source", { enum: USAGE_COST_SOURCES }).notNull(),
    steps: integer("steps"),
    durationMs: integer("duration_ms"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    forensicRunId: text("forensic_run_id"),
    forensicPath: text("forensic_path"),
    providerRequestCount: integer("provider_request_count"),
  },
  (t) => [
    index("idx_usage_created").on(t.createdAt),
    index("idx_usage_agent_created").on(t.agentId, t.createdAt),
    index("idx_usage_session").on(t.sessionId),
    index("idx_usage_task").on(t.taskId),
    index("idx_usage_trace").on(t.traceId),
    index("idx_usage_forensic_run").on(t.forensicRunId),
  ],
);

/**
 * Session-scoped forensic timeline. This is a semantic, queryable index over
 * important lifecycle boundaries; local raw prompt/provider/tool evidence
 * remains in the AI forensic archive and Langfuse keeps the trace UI.
 *
 * `created_at_ms` is millisecond precision because multiple AI/tool lifecycle
 * boundaries regularly occur inside the same SQLite epoch second. List queries
 * use `(created_at_ms ASC, rowid ASC)` for stable timeline order.
 */
export const sessionTimelineEvents = sqliteTable(
  "session_timeline_events",
  {
    id: text("id").primaryKey(),
    createdAtMs: integer("created_at_ms").notNull(),
    sessionId: text("session_id").notNull(),
    agentId: text("agent_id"),
    messageId: text("message_id"),
    taskId: text("task_id"),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    status: text("status"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    forensicRunId: text("forensic_run_id"),
    usageEventId: text("usage_event_id"),
    durationMs: integer("duration_ms"),
    payload: text("payload"),
  },
  (t) => [
    index("idx_session_timeline_session").on(t.sessionId, t.createdAtMs),
    index("idx_session_timeline_trace").on(t.traceId),
    index("idx_session_timeline_forensic_run").on(t.forensicRunId),
    index("idx_session_timeline_usage").on(t.usageEventId),
  ],
);

export const workflowDefinitions = sqliteTable("workflow_definitions", {
  id: text("id").primaryKey(),
  status: text("status", {
    enum: ["draft", "published", "archived"],
  }).notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description"),
  inputSchemaJson: text("input_schema_json"),
  outputSchemaJson: text("output_schema_json"),
  triggersJson: text("triggers_json").notNull(),
  nodesJson: text("nodes_json").notNull(),
  uiJson: text("ui_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    inputSchemaJson: text("input_schema_json"),
    outputSchemaJson: text("output_schema_json"),
    triggersJson: text("triggers_json").notNull(),
    nodesJson: text("nodes_json").notNull(),
    uiJson: text("ui_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workflowId, t.version] }),
    index("idx_workflow_versions_workflow").on(t.workflowId, t.version),
  ],
);

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    definitionSource: text("definition_source", {
      enum: ["draft", "published"],
    }).notNull(),
    definitionSnapshotJson: text("definition_snapshot_json"),
    mode: text("mode", { enum: ["test", "live"] }).notNull(),
    triggerJson: text("trigger_json").notNull(),
    status: text("status", {
      enum: ["queued", "running", "waiting", "succeeded", "failed", "canceled"],
    }).notNull(),
    inputJson: text("input_json").notNull(),
    contextJson: text("context_json").notNull(),
    currentNodeId: text("current_node_id"),
    waitingReason: text("waiting_reason"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("idx_workflow_runs_workflow").on(t.workflowId, t.createdAt),
    index("idx_workflow_runs_status").on(t.status, t.createdAt),
    index("idx_workflow_runs_mode").on(t.mode, t.createdAt),
  ],
);

export const workflowStepAttempts = sqliteTable(
  "workflow_step_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "skipped", "canceled"],
    }).notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    durationMs: integer("duration_ms"),
    inputJson: text("input_json"),
    outputJson: text("output_json"),
    errorJson: text("error_json"),
    logsSummaryJson: text("logs_summary_json"),
    contextDiffJson: text("context_diff_json"),
  },
  (t) => [
    index("idx_workflow_steps_run").on(t.runId, t.nodeId),
    uniqueIndex("idx_workflow_steps_run_node_attempt").on(
      t.runId,
      t.nodeId,
      t.attempt,
    ),
  ],
);

export const workflowRunEvents = sqliteTable(
  "workflow_run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepRunId: text("step_run_id"),
    sequence: integer("sequence").notNull(),
    level: text("level", {
      enum: ["debug", "info", "error", "system"],
    }).notNull(),
    kind: text("kind", {
      enum: [
        "run_started",
        "step_started",
        "step_output",
        "step_failed",
        "step_completed",
        "branch_selected",
        "log",
        "run_completed",
        "run_failed",
      ],
    }).notNull(),
    message: text("message"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_workflow_events_run").on(t.runId, t.sequence),
    uniqueIndex("idx_workflow_events_run_sequence").on(t.runId, t.sequence),
  ],
);

export const workflowArtifacts = sqliteTable(
  "workflow_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepRunId: text("step_run_id").references(() => workflowStepAttempts.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    preview: text("preview"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_workflow_artifacts_run").on(t.runId)],
);

export const hostedIntegrationFamilies = sqliteTable(
  "hosted_integration_families",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    manifestJson: text("manifest_json").notNull(),
    diagnosticsJson: text("diagnostics_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_hosted_families_status").on(t.status)],
);

export const hostedIntegrationSourceRevisions = sqliteTable(
  "hosted_integration_source_revisions",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    provenanceJson: text("provenance_json"),
  },
  (t) => [index("idx_hosted_source_revisions_family").on(t.familyId, t.createdAt)],
);

export const hostedIntegrationSourceFiles = sqliteTable(
  "hosted_integration_source_files",
  {
    sourceRevisionId: text("source_revision_id")
      .notNull()
      .references(() => hostedIntegrationSourceRevisions.id, {
        onDelete: "cascade",
      }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    mediaType: text("media_type"),
  },
  (t) => [
    primaryKey({ columns: [t.sourceRevisionId, t.path] }),
    index("idx_hosted_source_files_revision").on(t.sourceRevisionId),
  ],
);

export const hostedIntegrationDrafts = sqliteTable(
  "hosted_integration_drafts",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    sourceRevisionId: text("source_revision_id").notNull(),
    lockId: text("lock_id").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_hosted_drafts_family_status").on(t.familyId, t.status),
    index("idx_hosted_drafts_lock").on(t.lockId),
  ],
);

export const hostedIntegrationDraftFiles = sqliteTable(
  "hosted_integration_draft_files",
  {
    draftId: text("draft_id")
      .notNull()
      .references(() => hostedIntegrationDrafts.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    mediaType: text("media_type"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.path] }),
    index("idx_hosted_draft_files_draft").on(t.draftId),
  ],
);

export const hostedIntegrationExamples = sqliteTable(
  "hosted_integration_examples",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => hostedIntegrationDrafts.id, { onDelete: "cascade" }),
    familyId: text("family_id").notNull(),
    toolName: text("tool_name").notNull(),
    category: text("category").notNull(),
    argsJson: text("args_json").notNull(),
    expectedJson: text("expected_json"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_hosted_examples_draft").on(t.draftId),
    uniqueIndex("idx_hosted_examples_draft_id").on(t.draftId, t.id),
  ],
);

export const hostedIntegrationProposedFamilies = sqliteTable(
  "hosted_integration_proposed_families",
  {
    familyId: text("family_id").primaryKey(),
    draftId: text("draft_id").notNull(),
    lockId: text("lock_id").notNull(),
    proposedBy: text("proposed_by").notNull(),
    createdAt: text("created_at").notNull(),
    status: text("status").notNull(),
  },
  (t) => [index("idx_hosted_proposed_status").on(t.status)],
);

export const hostedIntegrationLocks = sqliteTable(
  "hosted_integration_locks",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    lockedBy: text("locked_by").notNull(),
    draftId: text("draft_id"),
    acquiredAt: text("acquired_at").notNull(),
    renewedAt: text("renewed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    releasedAt: text("released_at"),
  },
  (t) => [
    index("idx_hosted_locks_family_expires").on(t.familyId, t.expiresAt),
    uniqueIndex("idx_hosted_locks_active_family")
      .on(t.familyId)
      .where(sql`${t.releasedAt} IS NULL`),
  ],
);

export const hostedIntegrationEnvironmentConfigs = sqliteTable(
  "hosted_integration_environment_configs",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    environment: text("environment").notNull(),
    revision: integer("revision").notNull(),
    configJson: text("config_json").notNull(),
    secretsMetadataJson: text("secrets_metadata_json").notNull().default("{}"),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    index("idx_hosted_environment_configs_family").on(
      t.familyId,
      t.environment,
    ),
  ],
);

export const hostedIntegrationSecretMetadata = sqliteTable(
  "hosted_integration_secret_metadata",
  {
    environmentConfigId: text("environment_config_id")
      .notNull()
      .references(() => hostedIntegrationEnvironmentConfigs.id, {
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    configured: integer("configured", { mode: "boolean" }).notNull(),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentConfigId, t.name] }),
    index("idx_hosted_secret_metadata_environment_config").on(
      t.environmentConfigId,
    ),
  ],
);

export const hostedIntegrationApprovals = sqliteTable(
  "hosted_integration_approvals",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    targetJson: text("target_json").notNull(),
    actorJson: text("actor_json").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_hosted_approvals_family").on(t.familyId, t.createdAt)],
);

export const hostedIntegrationDisablements = sqliteTable(
  "hosted_integration_disablements",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    toolName: text("tool_name"),
    targetJson: text("target_json").notNull(),
    reason: text("reason"),
    disabledBy: text("disabled_by").notNull(),
    disabledAt: text("disabled_at").notNull(),
  },
  (t) => [
    index("idx_hosted_disablements_family").on(t.familyId),
    uniqueIndex("idx_hosted_disablements_target").on(t.familyId, t.toolName),
  ],
);

export const hostedIntegrationGenerations = sqliteTable(
  "hosted_integration_generations",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    sourceRevisionId: text("source_revision_id").notNull(),
    status: text("status").notNull(),
    promotedAt: text("promoted_at").notNull(),
    promotedBy: text("promoted_by").notNull(),
    manifestJson: text("manifest_json").notNull(),
    toolNamesJson: text("tool_names_json").notNull(),
    validationJson: text("validation_json").notNull(),
    dependencyResolutionJson: text("dependency_resolution_json"),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    index("idx_hosted_generations_family").on(t.familyId, t.promotedAt),
    index("idx_hosted_generations_status").on(t.status),
  ],
);

export const hostedIntegrationGenerationFiles = sqliteTable(
  "hosted_integration_generation_files",
  {
    generationId: text("generation_id")
      .notNull()
      .references(() => hostedIntegrationGenerations.id, {
        onDelete: "cascade",
      }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    mediaType: text("media_type"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.generationId, t.path] }),
    index("idx_hosted_generation_files_generation").on(t.generationId),
  ],
);

export const hostedIntegrationActiveGenerations = sqliteTable(
  "hosted_integration_active_generations",
  {
    familyId: text("family_id").primaryKey(),
    generationId: text("generation_id")
      .notNull()
      .references(() => hostedIntegrationGenerations.id, {
        onDelete: "restrict",
      }),
    activatedAt: text("activated_at").notNull(),
    activatedBy: text("activated_by").notNull(),
    previousGenerationId: text("previous_generation_id"),
  },
  (t) => [uniqueIndex("idx_hosted_active_generation").on(t.generationId)],
);

export const hostedIntegrationGenerationInvocations = sqliteTable(
  "hosted_integration_generation_invocations",
  {
    leaseId: text("lease_id").primaryKey(),
    generationId: text("generation_id").notNull(),
    familyId: text("family_id").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("idx_hosted_generation_invocations_generation").on(
      t.generationId,
      t.completedAt,
    ),
  ],
);

export const hostedIntegrationJobs = sqliteTable(
  "hosted_integration_jobs",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    toolName: text("tool_name").notNull(),
    generationId: text("generation_id"),
    status: text("status").notNull(),
    actorJson: text("actor_json").notNull(),
    argsHash: text("args_hash").notNull(),
    resultJson: text("result_json"),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    cancelledAt: text("cancelled_at"),
  },
  (t) => [
    index("idx_hosted_jobs_family_status").on(t.familyId, t.status),
    index("idx_hosted_jobs_generation").on(t.generationId),
  ],
);

export const hostedIntegrationJobEvents = sqliteTable(
  "hosted_integration_job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => hostedIntegrationJobs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_hosted_job_events_job").on(t.jobId, t.sequence),
    uniqueIndex("idx_hosted_job_events_job_sequence").on(t.jobId, t.sequence),
  ],
);

export const hostedIntegrationRuns = sqliteTable(
  "hosted_integration_runs",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    toolName: text("tool_name").notNull(),
    generationId: text("generation_id").notNull(),
    actorJson: text("actor_json").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    resultEnvelopeRefJson: text("result_envelope_ref_json"),
    resultMetadataJson: text("result_metadata_json"),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
    endedAt: text("ended_at"),
    retentionState: text("retention_state").notNull().default("active"),
  },
  (t) => [
    index("idx_hosted_runs_family_tool").on(t.familyId, t.toolName),
    index("idx_hosted_runs_generation").on(t.generationId),
    index("idx_hosted_runs_retention").on(t.retentionState, t.createdAt),
  ],
);

export const hostedIntegrationArtifacts = sqliteTable(
  "hosted_integration_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => hostedIntegrationRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    mediaType: text("media_type"),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    storageRef: text("storage_ref").notNull(),
    retentionState: text("retention_state").notNull().default("active"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_hosted_artifacts_run").on(t.runId),
    index("idx_hosted_artifacts_retention").on(t.retentionState, t.createdAt),
    uniqueIndex("idx_hosted_artifacts_run_name").on(t.runId, t.name),
  ],
);

export const hostedIntegrationExecutionLogs = sqliteTable(
  "hosted_integration_execution_logs",
  {
    runId: text("run_id").primaryKey(),
    familyId: text("family_id").notNull(),
    toolName: text("tool_name").notNull(),
    generationId: text("generation_id").notNull(),
    actorJson: text("actor_json").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    durationMs: integer("duration_ms"),
    requestSanitizedJson: text("request_sanitized_json").notNull(),
    resultEnvelopeRefJson: text("result_envelope_ref_json"),
    resultMetadataJson: text("result_metadata_json"),
    errorJson: text("error_json"),
    traceId: text("trace_id"),
    spanId: text("span_id"),
  },
  (t) => [
    index("idx_hosted_execution_logs_family").on(t.familyId, t.startedAt),
    index("idx_hosted_execution_logs_trace").on(t.traceId),
  ],
);

export const hostedIntegrationFailureBuckets = sqliteTable(
  "hosted_integration_failure_buckets",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    toolName: text("tool_name").notNull(),
    generationId: text("generation_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    count: integer("count").notNull().default(1),
    latestRunId: text("latest_run_id"),
    firstSeenAt: text("first_seen_at").notNull(),
    latestSeenAt: text("latest_seen_at").notNull(),
    assignedTo: text("assigned_to"),
    closedAt: text("closed_at"),
    closedBy: text("closed_by"),
  },
  (t) => [
    index("idx_hosted_failure_buckets_family").on(t.familyId, t.status),
    uniqueIndex("idx_hosted_failure_buckets_unique_open")
      .on(t.familyId, t.toolName, t.generationId, t.fingerprint)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const hostedIntegrationFailureBucketEvents = sqliteTable(
  "hosted_integration_failure_bucket_events",
  {
    id: text("id").primaryKey(),
    bucketId: text("bucket_id")
      .notNull()
      .references(() => hostedIntegrationFailureBuckets.id, {
        onDelete: "cascade",
      }),
    eventType: text("event_type").notNull(),
    runId: text("run_id"),
    actor: text("actor"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_hosted_failure_bucket_events_bucket").on(t.bucketId)],
);

export const hostedIntegrationIdempotency = sqliteTable(
  "hosted_integration_idempotency",
  {
    key: text("key").primaryKey(),
    operation: text("operation").notNull(),
    actorId: text("actor_id").notNull(),
    targetJson: text("target_json").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    finalEnvelopeMetadataJson: text("final_envelope_metadata_json"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    expiresAt: text("expires_at"),
  },
  (t) => [
    index("idx_hosted_idempotency_actor").on(t.actorId, t.createdAt),
    index("idx_hosted_idempotency_expires").on(t.expiresAt),
  ],
);

/**
 * Human operators. The deployment is single-org / flat-role: every member
 * is a full admin, distinguished only so the system can route to them.
 * `email` is the identifier (self-asserted at enrollment — no SMTP, so no
 * verification) and doubles as the future notification address. The row id
 * is a surrogate key so an email change is a one-field edit, not a rewrite
 * of every future owner reference.
 *
 * `password_hash` is scrypt(password, salt) — a slow KDF, NOT the SHA-256
 * used for the high-entropy session/enroll tokens. Treat the row as a
 * credential: never surface `password_hash` / `password_salt` on the wire.
 */
export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Login sessions. The cookie/bearer carries a high-entropy token; only its
 * SHA-256 lives here (a stolen DB can't mint cookies). Member delete
 * cascades, so revoking a member instantly invalidates their sessions —
 * the reason this is stateful rather than a self-contained signed JWT.
 */
export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("idx_auth_sessions_member").on(t.memberId)],
);

/**
 * One-time credential-creation tokens — the single primitive behind both
 * first-run claim (token printed to the boot log) and invites (link the
 * founder hands off out-of-band). Single-use (`used_at` set on consume)
 * with a TTL. Only the SHA-256 is stored.
 */
export const enrollTokens = sqliteTable("enroll_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

// Schema-derived types. `$inferSelect` is what comes out of a query;
// `$inferInsert` is what callers pass in (defaults / nullables become
// optional, the rest stay required). The `parts` column is JSON-stringified
// `UIMessagePart[]` — the store layer parses on read, stringifies on write.
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type SessionContextSnapshotRow =
  typeof sessionContextSnapshots.$inferSelect;
export type NewSessionContextSnapshotRow =
  typeof sessionContextSnapshots.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type ObjectiveRow = typeof objectives.$inferSelect;
export type NewObjectiveRow = typeof objectives.$inferInsert;
export type ObjectiveEventRow = typeof objectiveEvents.$inferSelect;
export type NewObjectiveEventRow = typeof objectiveEvents.$inferInsert;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type NewTaskCommentRow = typeof taskComments.$inferInsert;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEventRow = typeof taskEvents.$inferInsert;
export type AgentInboxRow = typeof agentInbox.$inferSelect;
export type NewAgentInboxRow = typeof agentInbox.$inferInsert;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEventRow = typeof usageEvents.$inferInsert;
export type SessionTimelineEventRow = typeof sessionTimelineEvents.$inferSelect;
export type NewSessionTimelineEventRow =
  typeof sessionTimelineEvents.$inferInsert;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
export type NewWorkflowDefinitionRow = typeof workflowDefinitions.$inferInsert;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersionRow = typeof workflowVersions.$inferInsert;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRuns.$inferInsert;
export type WorkflowStepAttemptRow = typeof workflowStepAttempts.$inferSelect;
export type NewWorkflowStepAttemptRow =
  typeof workflowStepAttempts.$inferInsert;
export type WorkflowRunEventRow = typeof workflowRunEvents.$inferSelect;
export type NewWorkflowRunEventRow = typeof workflowRunEvents.$inferInsert;
export type WorkflowArtifactRow = typeof workflowArtifacts.$inferSelect;
export type NewWorkflowArtifactRow = typeof workflowArtifacts.$inferInsert;
export type HostedIntegrationFamilyRow =
  typeof hostedIntegrationFamilies.$inferSelect;
export type NewHostedIntegrationFamilyRow =
  typeof hostedIntegrationFamilies.$inferInsert;
export type HostedIntegrationSourceRevisionRow =
  typeof hostedIntegrationSourceRevisions.$inferSelect;
export type NewHostedIntegrationSourceRevisionRow =
  typeof hostedIntegrationSourceRevisions.$inferInsert;
export type HostedIntegrationSourceFileRow =
  typeof hostedIntegrationSourceFiles.$inferSelect;
export type NewHostedIntegrationSourceFileRow =
  typeof hostedIntegrationSourceFiles.$inferInsert;
export type HostedIntegrationDraftRow = typeof hostedIntegrationDrafts.$inferSelect;
export type NewHostedIntegrationDraftRow =
  typeof hostedIntegrationDrafts.$inferInsert;
export type HostedIntegrationDraftFileRow =
  typeof hostedIntegrationDraftFiles.$inferSelect;
export type NewHostedIntegrationDraftFileRow =
  typeof hostedIntegrationDraftFiles.$inferInsert;
export type HostedIntegrationExampleRow =
  typeof hostedIntegrationExamples.$inferSelect;
export type NewHostedIntegrationExampleRow =
  typeof hostedIntegrationExamples.$inferInsert;
export type HostedIntegrationProposedFamilyRow =
  typeof hostedIntegrationProposedFamilies.$inferSelect;
export type NewHostedIntegrationProposedFamilyRow =
  typeof hostedIntegrationProposedFamilies.$inferInsert;
export type HostedIntegrationLockRow = typeof hostedIntegrationLocks.$inferSelect;
export type NewHostedIntegrationLockRow =
  typeof hostedIntegrationLocks.$inferInsert;
export type HostedIntegrationEnvironmentConfigRow =
  typeof hostedIntegrationEnvironmentConfigs.$inferSelect;
export type NewHostedIntegrationEnvironmentConfigRow =
  typeof hostedIntegrationEnvironmentConfigs.$inferInsert;
export type HostedIntegrationSecretMetadataRow =
  typeof hostedIntegrationSecretMetadata.$inferSelect;
export type NewHostedIntegrationSecretMetadataRow =
  typeof hostedIntegrationSecretMetadata.$inferInsert;
export type HostedIntegrationApprovalRow =
  typeof hostedIntegrationApprovals.$inferSelect;
export type NewHostedIntegrationApprovalRow =
  typeof hostedIntegrationApprovals.$inferInsert;
export type HostedIntegrationDisablementRow =
  typeof hostedIntegrationDisablements.$inferSelect;
export type NewHostedIntegrationDisablementRow =
  typeof hostedIntegrationDisablements.$inferInsert;
export type HostedIntegrationGenerationRow =
  typeof hostedIntegrationGenerations.$inferSelect;
export type NewHostedIntegrationGenerationRow =
  typeof hostedIntegrationGenerations.$inferInsert;
export type HostedIntegrationGenerationFileRow =
  typeof hostedIntegrationGenerationFiles.$inferSelect;
export type NewHostedIntegrationGenerationFileRow =
  typeof hostedIntegrationGenerationFiles.$inferInsert;
export type HostedIntegrationActiveGenerationRow =
  typeof hostedIntegrationActiveGenerations.$inferSelect;
export type NewHostedIntegrationActiveGenerationRow =
  typeof hostedIntegrationActiveGenerations.$inferInsert;
export type HostedIntegrationGenerationInvocationRow =
  typeof hostedIntegrationGenerationInvocations.$inferSelect;
export type NewHostedIntegrationGenerationInvocationRow =
  typeof hostedIntegrationGenerationInvocations.$inferInsert;
export type HostedIntegrationJobRow = typeof hostedIntegrationJobs.$inferSelect;
export type NewHostedIntegrationJobRow =
  typeof hostedIntegrationJobs.$inferInsert;
export type HostedIntegrationJobEventRow =
  typeof hostedIntegrationJobEvents.$inferSelect;
export type NewHostedIntegrationJobEventRow =
  typeof hostedIntegrationJobEvents.$inferInsert;
export type HostedIntegrationRunRow = typeof hostedIntegrationRuns.$inferSelect;
export type NewHostedIntegrationRunRow =
  typeof hostedIntegrationRuns.$inferInsert;
export type HostedIntegrationArtifactRow =
  typeof hostedIntegrationArtifacts.$inferSelect;
export type NewHostedIntegrationArtifactRow =
  typeof hostedIntegrationArtifacts.$inferInsert;
export type HostedIntegrationExecutionLogRow =
  typeof hostedIntegrationExecutionLogs.$inferSelect;
export type NewHostedIntegrationExecutionLogRow =
  typeof hostedIntegrationExecutionLogs.$inferInsert;
export type HostedIntegrationFailureBucketRow =
  typeof hostedIntegrationFailureBuckets.$inferSelect;
export type NewHostedIntegrationFailureBucketRow =
  typeof hostedIntegrationFailureBuckets.$inferInsert;
export type HostedIntegrationFailureBucketEventRow =
  typeof hostedIntegrationFailureBucketEvents.$inferSelect;
export type NewHostedIntegrationFailureBucketEventRow =
  typeof hostedIntegrationFailureBucketEvents.$inferInsert;
export type HostedIntegrationIdempotencyRow =
  typeof hostedIntegrationIdempotency.$inferSelect;
export type NewHostedIntegrationIdempotencyRow =
  typeof hostedIntegrationIdempotency.$inferInsert;
export type MemberRow = typeof members.$inferSelect;
export type NewMemberRow = typeof members.$inferInsert;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type EnrollTokenRow = typeof enrollTokens.$inferSelect;
