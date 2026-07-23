import type { Hono } from "hono";
import {
  COMMENT_KINDS,
  TaskStoreError,
  TASK_STATUSES,
  type CommentKind,
  type TaskStatus,
} from "@openacme/tasks";
import type { AgentManager } from "../agent-manager.js";
import { resolveTaskSourceSessions } from "../task-source-provenance.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PREVIEW_ALLOWED_TASK_SOURCE_SESSIONS_PATH =
  /^\/api\/tasks\/source-sessions$/;
const PREVIEW_ALLOWED_TASK_PATH =
  /^\/api\/tasks(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/(?:comments|events))?)?$/;
const PREVIEW_ALLOWED_AGENT_PATH = /^\/api\/agents$/;
const PREVIEW_ALLOWED_SESSION_MESSAGES_PATH =
  /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_.-]*\/messages$/;
const PREVIEW_ALLOWED_SESSION_PATH =
  /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PREVIEW_ALLOWED_USAGE_SUMMARY_PATH = /^\/api\/usage\/summary$/;
const PREVIEW_ALLOWED_HOME_PATH = /^\/api\/home$/;

function statusErrorCode(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "has_dependents":
      return 409;
    case "session_busy":
      return 409;
    case "deps_unsatisfied":
      return 409;
    case "cycle":
      return 400;
    case "unknown_deps":
      return 400;
    case "unknown_parent":
      return 400;
    case "invalid_id":
      return 400;
    default:
      return 400;
  }
}

function asStatusFilter(v: string | undefined): TaskStatus[] | undefined {
  if (!v) return undefined;
  const parts = v
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const valid = parts.filter((p): p is TaskStatus =>
    (TASK_STATUSES as readonly string[]).includes(p),
  );
  if (valid.length === 0) return undefined;
  return valid;
}

function isLoopbackPreviewHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  );
}

function previewTarget(
  rawBase: string | null,
  rawPath: string | null,
): URL | null {
  if (!rawBase || !rawPath) return null;
  let base: URL;
  let path: URL;
  try {
    base = new URL(rawBase);
    path = new URL(rawPath, "http://preview.local");
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  if (!isLoopbackPreviewHost(base.hostname)) return null;
  if (
    !PREVIEW_ALLOWED_TASK_SOURCE_SESSIONS_PATH.test(path.pathname) &&
    !PREVIEW_ALLOWED_TASK_PATH.test(path.pathname) &&
    !PREVIEW_ALLOWED_AGENT_PATH.test(path.pathname) &&
    !PREVIEW_ALLOWED_SESSION_PATH.test(path.pathname) &&
    !PREVIEW_ALLOWED_SESSION_MESSAGES_PATH.test(path.pathname) &&
    !PREVIEW_ALLOWED_USAGE_SUMMARY_PATH.test(path.pathname) &&
    !PREVIEW_ALLOWED_HOME_PATH.test(path.pathname)
  ) {
    return null;
  }
  return new URL(`${path.pathname}${path.search}`, base.origin);
}

export function registerTaskRoutes(app: Hono, manager: AgentManager): void {
  // GET-only same-origin proxy for the task board's local production preview.
  // It avoids browser CORS while keeping the target narrow and read-only.
  app.get("/api/task-preview", async (c) => {
    const url = new URL(c.req.url);
    const target = previewTarget(
      url.searchParams.get("base"),
      url.searchParams.get("path"),
    );
    if (!target) return c.json({ error: "invalid preview target" }, 400);
    try {
      const upstream = await fetch(target, {
        headers: { accept: "application/json" },
      });
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    } catch {
      return c.json({ error: "preview upstream failed" }, 502);
    }
  });

  // GET /api/tasks
  app.get("/api/tasks", (c) => {
    const url = new URL(c.req.url);
    const assignee = url.searchParams.get("assignee") ?? undefined;
    const created_by = url.searchParams.get("created_by") ?? undefined;
    const team = url.searchParams.get("team") ?? undefined;
    const session_id_raw = url.searchParams.get("session_id");
    const status = asStatusFilter(url.searchParams.get("status") ?? undefined);

    const session_id =
      session_id_raw === "null" ? null : (session_id_raw ?? undefined);

    const tasks = manager.taskStore.list({
      assignee,
      created_by,
      team,
      ...(session_id !== undefined ? { session_id } : {}),
      status,
    });
    // Bulk comment counts for the cards' badge — one query for all
    // visible tasks instead of N+1 from the client.
    const taskIds = tasks.map((t) => t.id);
    const counts = manager.taskStore.commentCounts(taskIds);
    const latestEvents = manager.taskStore.latestEventTimes(taskIds);
    // Strip body for the list view; clients hit GET /:id for the body.
    return c.json({
      tasks: tasks.map(({ body: _body, ...rest }) => {
        void _body;
        const updatedAt = Math.floor(Date.parse(rest.updated_at) / 1000);
        const lastActivity = Math.max(
          Number.isFinite(updatedAt) ? updatedAt : 0,
          latestEvents.get(rest.id) ?? 0,
        );
        return {
          ...rest,
          comment_count: counts.get(rest.id) ?? 0,
          last_activity_at: lastActivity,
        };
      }),
    });
  });

  // GET /api/tasks/source-sessions?ids=1,2,3 — read-only historical/debug
  // resolver for tasks created before created_in_session_id was persisted.
  // The durable path is task frontmatter; use the repair command to backfill.
  app.get("/api/tasks/source-sessions", (c) => {
    const url = new URL(c.req.url);
    const ids = parseTaskIdList(url.searchParams.get("ids"));
    if (ids.length === 0) return c.json({ tasks: {}, sessions: [] });
    const resolved = resolveTaskSourceSessions({
      taskIds: ids,
      messageStore: manager.messageStore,
      sessionStore: manager.sessionStore,
    });
    return c.json({ tasks: resolved.tasks, sessions: resolved.sessions });
  });

  // GET /api/tasks/:id
  app.get("/api/tasks/:id", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const task = manager.taskStore.get(id);
    if (!task) return c.json({ error: "not_found" }, 404);
    return c.json({ task });
  });

  // PATCH /api/tasks/:id — founder edit. Accepts session_id directly.
  app.patch("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const patch: Parameters<typeof manager.taskStore.update>[1] = {};
    if (typeof body["title"] === "string") patch.title = body["title"];
    if (typeof body["body"] === "string") patch.body = body["body"];
    if (typeof body["status"] === "string") {
      if (!(TASK_STATUSES as readonly string[]).includes(body["status"])) {
        return c.json({ error: "invalid status" }, 400);
      }
      patch.status = body["status"] as TaskStatus;
    }
    if (typeof body["assignee"] === "string") patch.assignee = body["assignee"];
    if (Object.prototype.hasOwnProperty.call(body, "session_id")) {
      const sid = body["session_id"];
      if (sid === null) patch.session_id = null;
      else if (typeof sid === "string") patch.session_id = sid;
      else return c.json({ error: "invalid session_id" }, 400);
    }
    if (Array.isArray(body["depends_on"])) {
      if (!body["depends_on"].every((d) => typeof d === "string")) {
        return c.json({ error: "depends_on must be string[]" }, 400);
      }
      patch.depends_on = body["depends_on"] as string[];
    }
    if (Object.prototype.hasOwnProperty.call(body, "start_at")) {
      const v = body["start_at"];
      if (v !== null && typeof v !== "string") {
        return c.json({ error: "invalid start_at" }, 400);
      }
      patch.start_at = v as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "due_at")) {
      const v = body["due_at"];
      if (v !== null && typeof v !== "string") {
        return c.json({ error: "invalid due_at" }, 400);
      }
      patch.due_at = v as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "recurrence")) {
      const v = body["recurrence"];
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) {
        return c.json({ error: "invalid recurrence" }, 400);
      }
      patch.recurrence = v as Parameters<
        typeof manager.taskStore.update
      >[1]["recurrence"];
    }
    if (Object.prototype.hasOwnProperty.call(body, "team")) {
      const v = body["team"];
      if (v !== null && typeof v !== "string") {
        return c.json({ error: "invalid team" }, 400);
      }
      patch.team = v;
    }

    try {
      const task = await manager.taskStore.update(id, patch, {
        actor: "system:user",
      });
      return c.json({ task });
    } catch (e) {
      if (e instanceof TaskStoreError) {
        return c.json(
          { error: e.code, message: e.message },
          statusErrorCode(e.code) as 400 | 404 | 409,
        );
      }
      throw e;
    }
  });

  // DELETE /api/tasks/:id?force=true
  app.delete("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const url = new URL(c.req.url);
    const force = url.searchParams.get("force") === "true";
    try {
      await manager.taskStore.delete(id, { force, actor: "system:user" });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof TaskStoreError) {
        return c.json(
          { error: e.code, message: e.message },
          statusErrorCode(e.code) as 400 | 404 | 409,
        );
      }
      throw e;
    }
  });

  // GET /api/tasks/:id/comments — discussion thread, oldest-first.
  app.get("/api/tasks/:id/comments", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    if (!manager.taskStore.get(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    const url = new URL(c.req.url);
    const limit = clampLimit(url.searchParams.get("limit"), 200, 1000);
    const sinceTs = parseUintParam(url.searchParams.get("since_ts"));
    const kindsRaw = url.searchParams.get("kinds");
    // Narrow incoming kind strings to canonical CommentKind union;
    // unknown values get dropped (filter, not validate).
    const validKindSet = new Set<string>(COMMENT_KINDS);
    const kinds = kindsRaw
      ? (kindsRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && validKindSet.has(s)) as CommentKind[])
      : undefined;
    const comments = manager.taskStore.listComments(id, {
      limit,
      sinceTs,
      kinds,
    });
    return c.json({ comments });
  });

  // POST /api/tasks/:id/comments — human leaves a comment. Author is
  // ALWAYS "system:user" — body cannot override (forge-as-agent gap;
  // there's no auth on the web↔server channel). `kind` is also locked
  // out: "system" is reserved, "result" is assignee-only and humans
  // aren't task assignees in OpenAcme. Untagged comments only via this
  // path.
  app.post("/api/tasks/:id/comments", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    if (!manager.taskStore.get(id)) {
      return c.json({ error: "not_found" }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const textRaw = body["body"];
    if (typeof textRaw !== "string") {
      return c.json({ error: "body required" }, 400);
    }
    const text = textRaw.trim();
    if (text.length === 0) {
      return c.json({ error: "body required" }, 400);
    }
    if (body["kind"] !== undefined && body["kind"] !== null) {
      return c.json(
        {
          error: "kind not permitted",
          message:
            "HTTP comments are always untagged. result and system kinds are agent / system only.",
        },
        400,
      );
    }

    try {
      const comment = await manager.taskStore.addComment({
        taskId: id,
        author: "system:user",
        body: text,
        kind: null,
      });
      return c.json({ comment });
    } catch (e) {
      if (e instanceof TaskStoreError) {
        return c.json(
          { error: e.code, message: e.message },
          statusErrorCode(e.code) as 400 | 404 | 409,
        );
      }
      throw e;
    }
  });

  // GET /api/tasks/:id/events — full event log for the detail panel.
  app.get("/api/tasks/:id/events", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    if (!manager.taskStore.get(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    const url = new URL(c.req.url);
    const limit = clampLimit(url.searchParams.get("limit"), 100, 1000);
    const sinceTs = parseUintParam(url.searchParams.get("since_ts")) ?? 0;
    const events = manager.eventStore.recentForTasks([id], sinceTs, limit);
    // recentForTasks returns DESC; reverse for chronological display.
    return c.json({ events: [...events].reverse() });
  });
}

function parseUintParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

function clampLimit(
  raw: string | null,
  defaultValue: number,
  max: number,
): number {
  const parsed = parseUintParam(raw);
  if (parsed === undefined || parsed === 0) return defaultValue;
  return Math.min(parsed, max);
}

function parseTaskIdList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!SAFE_ID.test(id) || seen.has(id)) continue;
    out.push(id);
    seen.add(id);
    if (out.length >= 500) break;
  }
  return out;
}
