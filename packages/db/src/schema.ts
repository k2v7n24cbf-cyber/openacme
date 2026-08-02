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
 * Exact per-turn model-context snapshots. The canonical conversation stays in
 * `messages`; this table records the projected UIMessage list sent to the
 * provider when runtime compaction changes what the model sees.
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
export type MemberRow = typeof members.$inferSelect;
export type NewMemberRow = typeof members.$inferInsert;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type EnrollTokenRow = typeof enrollTokens.$inferSelect;
