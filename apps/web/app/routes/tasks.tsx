import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { GitBranch, Kanban, Rows3, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { JargonChip } from "@/app/components/ui/jargon-chip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { cn } from "@/app/lib/utils";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import { FilterCombobox } from "../tasks/filter-combobox";
import { TasksBoard } from "../tasks/board";
import {
  TaskDependencyMap,
  type SourceSessionCard,
} from "../tasks/dependency-map";
import { TaskDetailPanel, type AgentOption } from "../tasks/detail";
import { TaskListRow } from "../tasks/row";
import {
  ActivityWindowFilter,
  EMPTY_ACTIVITY_WINDOW,
  activityWindowActive,
  taskInActivityWindow,
  type ActivityWindow,
} from "../tasks/activity-filter";
import {
  DateRangeFilter,
  EMPTY_DATE_RANGE,
  dateRangeActive,
  taskInDateRange,
  type DateRange,
} from "../tasks/date-filter";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  formatRelativeFromIso,
  type Task,
  type TaskEvent,
  type TaskStatus,
} from "../tasks/types";

type ViewMode = "board" | "list" | "deps";
const VIEW_MODE_STORAGE_KEY = "openacme.tasks.viewMode";

interface SourceSessionMetadata {
  id: string;
  agentId: string;
  title: string | null;
  createdAt?: number;
  updatedAt?: number;
  parentSessionId?: string | null;
}

interface ResolvedSourceSessionMetadata extends SourceSessionMetadata {
  taskIds: string[];
}

interface TaskSourceHit {
  priority: number;
  createdAt: number;
}

export const Route = createFileRoute("/tasks")({
  validateSearch: z.object({
    id: z.coerce.string().optional(),
    apiBase: z.coerce.string().optional(),
    sourceSession: z.coerce.string().optional(),
  }),
  component: TasksPage,
});

const POLL_MS = 10_000;
const SOURCE_SESSION_FALLBACK_LIMIT = 80;
const SOURCE_SESSION_FALLBACK_CONCURRENCY = 6;

function normalizeApiBase(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return API_BASE;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return API_BASE;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return API_BASE;
  }
}

function apiBaseLabel(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
}

function previewApiUrl(apiBase: string, path: string): string {
  return `${API_BASE}/api/task-preview?base=${encodeURIComponent(apiBase)}&path=${encodeURIComponent(path)}`;
}

function taskIdsFromSessionMessages(value: unknown): Set<string> {
  return new Set(taskSourceHitsFromSessionMessages(value).keys());
}

function taskSourceHitsFromSessionMessages(
  value: unknown,
): Map<string, TaskSourceHit> {
  const hits = new Map<string, TaskSourceHit>();
  const ids = new Set<string>();
  const messages = Array.isArray(value) ? value : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const createdAt =
      typeof message["createdAt"] === "number" ? message["createdAt"] : 0;
    const parts = Array.isArray(message["parts"]) ? message["parts"] : [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const type = typeof part["type"] === "string" ? part["type"] : "";
      const priority = taskToolSourcePriority(type);
      if (priority === 0) continue;
      ids.clear();
      collectTaskIdsFromToolValue(part["output"], ids);
      collectTaskIdsFromToolValue(part["result"], ids);
      for (const taskId of ids) {
        const current = hits.get(taskId);
        if (
          !current ||
          priority > current.priority ||
          (priority === current.priority && createdAt < current.createdAt)
        ) {
          hits.set(taskId, { priority, createdAt });
        }
      }
    }
  }
  return hits;
}

function taskToolSourcePriority(type: string): number {
  switch (type) {
    case "tool-task_create":
      return 3;
    case "tool-task_update":
      return 2;
    case "tool-task_list":
      return 1;
    default:
      return 0;
  }
}

function collectTaskIdsFromToolValue(value: unknown, out: Set<string>): void {
  const parsed = parseMaybeJson(value);
  if (!parsed) return;
  collectTaskIdsFromParsedToolValue(parsed, out);
}

function collectTaskIdsFromParsedToolValue(value: unknown, out: Set<string>) {
  if (!isRecord(value)) return;
  const task = value["task"];
  if (isRecord(task) && typeof task["id"] === "string") out.add(task["id"]);
  const tasks = value["tasks"];
  if (Array.isArray(tasks)) {
    for (const item of tasks) {
      if (isRecord(item) && typeof item["id"] === "string") out.add(item["id"]);
    }
  }
}

function parseMaybeJson(value: unknown): unknown | null {
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function executionStartMs(events: TaskEvent[]): number | null {
  let earliest: number | null = null;
  for (const event of events) {
    if (event.kind !== "status_changed") continue;
    const payload = parseMaybeJson(event.payload);
    if (!isRecord(payload) || payload["to"] !== "in_progress") continue;
    if (!Number.isFinite(event.createdAt)) continue;
    const ms = event.createdAt * 1000;
    earliest = earliest === null ? ms : Math.min(earliest, ms);
  }
  return earliest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSourceSession(value: unknown): SourceSessionMetadata | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : null;
  const agentId =
    typeof value["agentId"] === "string"
      ? value["agentId"]
      : typeof value["agent_id"] === "string"
        ? value["agent_id"]
        : null;
  if (!id || !agentId) return null;
  const title = typeof value["title"] === "string" ? value["title"] : null;
  return {
    id,
    agentId,
    title,
    createdAt:
      typeof value["createdAt"] === "number" ? value["createdAt"] : undefined,
    updatedAt:
      typeof value["updatedAt"] === "number" ? value["updatedAt"] : undefined,
    parentSessionId:
      typeof value["parentSessionId"] === "string"
        ? value["parentSessionId"]
        : typeof value["parent_session_id"] === "string"
          ? value["parent_session_id"]
          : null,
  };
}

function parseHomeSourceSessions(value: unknown): SourceSessionMetadata[] {
  if (!isRecord(value)) return [];
  const out: SourceSessionMetadata[] = [];
  const seen = new Set<string>();
  for (const key of ["waiting", "running", "idle"] as const) {
    const sessions = Array.isArray(value[key]) ? value[key] : [];
    for (const item of sessions) {
      if (!isRecord(item)) continue;
      const id =
        typeof item["sessionId"] === "string" ? item["sessionId"] : null;
      const agentId =
        typeof item["agentId"] === "string" ? item["agentId"] : null;
      if (!id || !agentId || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        agentId,
        title: typeof item["title"] === "string" ? item["title"] : null,
        updatedAt:
          typeof item["lastActivity"] === "number"
            ? item["lastActivity"]
            : undefined,
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item !== undefined) await run(item);
      }
    },
  );
  await Promise.all(workers);
}

async function resolveTaskSourcesFromHome(
  apiUrl: (path: string) => string,
  taskIds: string[],
  signal: AbortSignal,
): Promise<{
  tasks: Map<string, string>;
  sessions: ResolvedSourceSessionMetadata[];
}> {
  const homeRes = await fetch(apiUrl("/api/home"), { signal });
  if (!homeRes.ok) return { tasks: new Map(), sessions: [] };

  const wanted = new Set(taskIds);
  const sessions = parseHomeSourceSessions(await homeRes.json()).slice(
    0,
    SOURCE_SESSION_FALLBACK_LIMIT,
  );
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const bestByTask = new Map<
    string,
    { sessionId: string; priority: number; createdAt: number }
  >();

  await mapWithConcurrency(
    sessions,
    SOURCE_SESSION_FALLBACK_CONCURRENCY,
    async (session) => {
      if (signal.aborted) return;
      try {
        const res = await fetch(
          apiUrl(`/api/sessions/${session.id}/messages`),
          { signal },
        );
        if (!res.ok) return;
        const hits = taskSourceHitsFromSessionMessages(await res.json());
        for (const taskId of taskIds) {
          if (!wanted.has(taskId)) continue;
          const hit = hits.get(taskId);
          if (!hit) continue;
          const current = bestByTask.get(taskId);
          if (
            !current ||
            hit.priority > current.priority ||
            (hit.priority === current.priority &&
              hit.createdAt < current.createdAt)
          ) {
            bestByTask.set(taskId, {
              sessionId: session.id,
              priority: hit.priority,
              createdAt: hit.createdAt,
            });
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
      }
    },
  );

  const taskMap = new Map<string, string>();
  const taskIdsBySession = new Map<string, string[]>();
  for (const [taskId, hit] of bestByTask) {
    taskMap.set(taskId, hit.sessionId);
    const bucket = taskIdsBySession.get(hit.sessionId) ?? [];
    bucket.push(taskId);
    taskIdsBySession.set(hit.sessionId, bucket);
  }

  const resolvedSessions = [...taskIdsBySession.entries()].flatMap(
    ([sessionId, matchedTaskIds]) => {
      const session = sessionById.get(sessionId);
      if (!session) return [];
      return [
        {
          ...session,
          taskIds: matchedTaskIds.sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          ),
        },
      ];
    },
  );

  return { tasks: taskMap, sessions: resolvedSessions };
}

function sourceSessionHref(
  sessionId: string,
  previewApiBase: string | null,
): string {
  const path = `/?session=${encodeURIComponent(sessionId)}`;
  return previewApiBase ? `${previewApiBase}${path}` : path;
}

function annotateCreatedInSession(
  tasks: Task[],
  sourceByTaskId: Map<string, string>,
): Task[] {
  if (sourceByTaskId.size === 0) return tasks;
  return tasks.map((task) =>
    !task.created_in_session_id && sourceByTaskId.has(task.id)
      ? {
          ...task,
          created_in_session_id: sourceByTaskId.get(task.id) ?? null,
        }
      : task,
  );
}

function TasksPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const urlId = search.id ?? null;
  const sourceSessionId = search.sourceSession?.trim() || null;
  const tasksApiBase = useMemo(
    () => normalizeApiBase(search.apiBase),
    [search.apiBase],
  );
  const previewApiBase = tasksApiBase === API_BASE ? null : tasksApiBase;
  const tasksReadOnly = previewApiBase !== null;
  const previewApiLabel = previewApiBase ? apiBaseLabel(previewApiBase) : null;
  const apiUrl = useMemo(
    () =>
      previewApiBase
        ? (path: string) => previewApiUrl(previewApiBase, path)
        : (path: string) => `${tasksApiBase}${path}`,
    [previewApiBase, tasksApiBase],
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sourceSessionTaskIds, setSourceSessionTaskIds] =
    useState<Set<string> | null>(null);
  const [sourceSession, setSourceSession] =
    useState<SourceSessionMetadata | null>(null);
  const [resolvedTaskSources, setResolvedTaskSources] = useState<
    Map<string, string>
  >(new Map());
  const [resolvedSourceSessions, setResolvedSourceSessions] = useState<
    ResolvedSourceSessionMetadata[]
  >([]);
  const [taskStartTimes, setTaskStartTimes] = useState<Map<string, number>>(
    new Map(),
  );
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmDeleteMode, setConfirmDeleteMode] = useState<
    "simple" | "cascade"
  >("simple");

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/tasks",
        entityType: "task" as const,
        entityId: selected?.id ?? null,
        content: draft ?? selected,
      }),
      [selected, draft],
    ),
  );
  // Pending navigation parked behind the discard-unsaved-changes dialog.
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_DATE_RANGE);
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>(
    EMPTY_ACTIVITY_WINDOW,
  );
  const sourceByTaskId = useMemo(() => {
    const out = new Map(resolvedTaskSources);
    if (sourceSessionId && sourceSessionTaskIds) {
      for (const taskId of sourceSessionTaskIds)
        out.set(taskId, sourceSessionId);
    }
    return out;
  }, [resolvedTaskSources, sourceSessionId, sourceSessionTaskIds]);
  const displayedTasks = useMemo(
    () => annotateCreatedInSession(tasks, sourceByTaskId),
    [tasks, sourceByTaskId],
  );
  const unresolvedTaskSourceKey = useMemo(
    () =>
      tasks
        .filter((task) => !task.created_in_session_id)
        .map((task) => task.id)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .join(","),
    [tasks],
  );
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "board";
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "list" || stored === "board" || stored === "deps"
      ? stored
      : "board";
  });

  // Render-synced mirror of `dirty` for the poll callbacks (set below,
  // once dirty is computed).
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  // Agents move tasks while this page is open — poll the list and refetch
  // on window focus so the board tracks the workforce, not the last reload.
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal, true);
    void loadAgents(ctrl.signal);
    const tick = window.setInterval(
      () => void load(ctrl.signal, false),
      POLL_MS,
    );
    const onFocus = () => void load(ctrl.signal, false);
    window.addEventListener("focus", onFocus);
    return () => {
      ctrl.abort();
      window.clearInterval(tick);
      window.removeEventListener("focus", onFocus);
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!sourceSessionId) {
      setSourceSessionTaskIds(null);
      setSourceSession(null);
      return;
    }
    const ctrl = new AbortController();
    async function loadSourceSession() {
      try {
        const [messagesRes, sessionRes] = await Promise.all([
          fetch(apiUrl(`/api/sessions/${sourceSessionId}/messages`), {
            signal: ctrl.signal,
          }),
          fetch(apiUrl(`/api/sessions/${sourceSessionId}`), {
            signal: ctrl.signal,
          }),
        ]);
        if (!messagesRes.ok) throw new Error(`HTTP ${messagesRes.status}`);
        setSourceSessionTaskIds(
          taskIdsFromSessionMessages(await messagesRes.json()),
        );
        if (sessionRes.ok) {
          setSourceSession(parseSourceSession(await sessionRes.json()));
        } else {
          setSourceSession(null);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setSourceSessionTaskIds(null);
        setSourceSession(null);
        toast.error("Failed to load source session");
      }
    }
    void loadSourceSession();
    return () => ctrl.abort();
  }, [apiUrl, sourceSessionId]);

  useEffect(() => {
    if (sourceSessionId) {
      setResolvedTaskSources(new Map());
      setResolvedSourceSessions([]);
      return;
    }
    const ids = unresolvedTaskSourceKey
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setResolvedTaskSources(new Map());
      setResolvedSourceSessions([]);
      return;
    }
    if (!previewApiBase) {
      setResolvedTaskSources(new Map());
      setResolvedSourceSessions([]);
      return;
    }

    const ctrl = new AbortController();
    async function loadResolvedSources() {
      try {
        const fallback = await resolveTaskSourcesFromHome(
          apiUrl,
          ids,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setResolvedTaskSources(fallback.tasks);
        setResolvedSourceSessions(fallback.sessions);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setResolvedTaskSources(new Map());
        setResolvedSourceSessions([]);
      }
    }

    void loadResolvedSources();
    return () => ctrl.abort();
  }, [apiUrl, previewApiBase, sourceSessionId, unresolvedTaskSourceKey]);

  // URL → selection state. /tasks?id=<id> loads that task; /tasks resets.
  useEffect(() => {
    if (urlId) {
      void loadOne(urlId);
    } else {
      setSelected(null);
      setDraft(null);
    }
  }, [urlId, apiUrl]);

  const load = async (signal: AbortSignal | undefined, initial: boolean) => {
    try {
      if (initial) setLoading(true);
      const res = await fetch(apiUrl("/api/tasks"), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { tasks: Task[] };
      setTasks(json.tasks);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Poll failures keep stale data on screen; only the first load toasts.
      if (initial) toast.error("Failed to load tasks");
    } finally {
      if (initial) setLoading(false);
    }
  };

  const loadAgents = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(apiUrl("/api/agents"), { signal });
      if (!res.ok) return;
      const list = (await res.json()) as {
        id: string;
        name: string;
        avatar?: string;
      }[];
      setAgents(
        list.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar })),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // non-fatal: assignee select falls back to current value
    }
  };

  // Abort the in-flight detail fetch on every new one — rapid row
  // switching must not land out-of-order responses under the wrong URL.
  const loadOneCtrlRef = useRef<AbortController | null>(null);
  const loadOne = async (id: string, quiet = false) => {
    loadOneCtrlRef.current?.abort();
    const ctrl = new AbortController();
    loadOneCtrlRef.current = ctrl;
    try {
      const res = await fetch(apiUrl(`/api/tasks/${id}`), {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { task: Task };
      // A quiet (poll) refresh never clobbers in-progress edits.
      if (quiet && dirtyRef.current) return;
      setSelected(json.task);
      setDraft(json.task);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (!quiet) toast.error("Failed to load task");
    }
  };

  // Keep the open task fresh alongside the list poll (the activity
  // timeline already polls; without this the header could contradict it).
  useEffect(() => {
    if (!urlId) return;
    const tick = window.setInterval(() => {
      if (dirtyRef.current) return;
      void loadOne(urlId, true);
    }, POLL_MS);
    return () => window.clearInterval(tick);
  }, [urlId, apiUrl]);

  const save = async () => {
    if (!draft) return;
    if (tasksReadOnly) {
      toast.message("Read-only preview");
      return;
    }
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        title: draft.title,
        body: draft.body ?? "",
        status: draft.status,
        assignee: draft.assignee,
        depends_on: draft.depends_on,
        start_at: draft.start_at,
        due_at: draft.due_at,
        recurrence: draft.recurrence,
      };
      // Only send session_id when the user deliberately changed it
      // (unbind). An untouched value would read as an explicit bind and
      // defeat the store's clear-session-on-reassign invariant.
      if (selected && draft.session_id !== selected.session_id) {
        patch.session_id = draft.session_id;
      }
      const res = await fetch(apiUrl(`/api/tasks/${draft.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: Task };
      setSelected(json.task);
      setDraft(json.task);
      await load(undefined, false);
      toast.success("Saved");
      if (json.task.status !== draft.status) {
        const note = explainAutoCorrect(json.task, draft.status);
        toast.message(note.title, { description: note.description });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Drag-end handler for board mode: optimistic move, PATCH status, revert on error.
  const moveStatus = async (id: string, target: TaskStatus) => {
    if (tasksReadOnly) {
      toast.message("Read-only preview");
      return;
    }
    const before = tasks;
    const current = before.find((t) => t.id === id);
    if (!current) return;
    setTasks(before.map((t) => (t.id === id ? { ...t, status: target } : t)));
    try {
      const res = await fetch(apiUrl(`/api/tasks/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { task: Task };
      // The store may auto-correct (e.g., back to blocked if deps unmet,
      // or a recurring task re-arming itself after done).
      if (json.task.status !== target) {
        const note = explainAutoCorrect(json.task, target);
        toast.message(note.title, { description: note.description });
      }
      await load(undefined, false);
      // If the moved task was the selected one, refresh detail view too.
      if (selected?.id === id) {
        setSelected(json.task);
        setDraft(json.task);
      }
    } catch (e) {
      setTasks(before);
      toast.error((e as Error).message);
    }
  };

  const remove = async (id: string, force: boolean) => {
    if (tasksReadOnly) {
      toast.message("Read-only preview");
      return false;
    }
    try {
      const res = await fetch(
        apiUrl(`/api/tasks/${id}${force ? "?force=true" : ""}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        if (err.error === "has_dependents") {
          return false;
        }
        throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
      }
      const wasSelected = selected?.id === id;
      await load(undefined, false);
      toast.success("Deleted");
      setConfirmDelete(null);
      if (wasSelected) void navigate({ to: "/tasks", search: taskSearch() });
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  const teams = useMemo(() => {
    const set = new Set<string>();
    for (const t of displayedTasks) if (t.team) set.add(t.team);
    return [...set].sort();
  }, [displayedTasks]);

  const agentName = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents],
  );

  const sourceSessionCards = useMemo(() => {
    const cards = new Map<string, SourceSessionCard>();
    const add = (session: {
      id: string;
      title: string | null;
      agentId: string | null;
    }) => {
      const agentId = session.agentId;
      cards.set(session.id, {
        id: session.id,
        title: session.title,
        agentId,
        agentName: agentId ? (agentName.get(agentId) ?? agentId) : null,
        href: sourceSessionHref(session.id, previewApiBase),
      });
    };

    if (sourceSessionId) {
      add({
        id: sourceSessionId,
        title: sourceSession?.title ?? null,
        agentId: sourceSession?.agentId ?? null,
      });
    }

    for (const session of resolvedSourceSessions) add(session);

    for (const task of displayedTasks) {
      const sessionId = task.created_in_session_id;
      if (!sessionId || cards.has(sessionId)) continue;
      cards.set(sessionId, {
        id: sessionId,
        title: null,
        agentId: null,
        agentName: null,
        href: sourceSessionHref(sessionId, previewApiBase),
      });
    }

    return cards;
  }, [
    agentName,
    displayedTasks,
    previewApiBase,
    resolvedSourceSessions,
    sourceSession,
    sourceSessionId,
  ]);

  // Only assignees that actually own a task — the picker tracks the
  // board, not the full roster, so dead options never accumulate.
  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const t of displayedTasks) if (t.assignee) set.add(t.assignee);
    return [...set].sort((a, b) =>
      (agentName.get(a) ?? a).localeCompare(agentName.get(b) ?? b),
    );
  }, [displayedTasks, agentName]);

  const filtersActive =
    teamFilter !== "all" ||
    assigneeFilter !== "all" ||
    query.trim() !== "" ||
    dateRangeActive(dateRange) ||
    activityWindowActive(activityWindow);

  const clearFilters = () => {
    setTeamFilter("all");
    setAssigneeFilter("all");
    setQuery("");
    setDateRange((r) => ({ ...r, from: null, to: null }));
    setActivityWindow(EMPTY_ACTIVITY_WINDOW);
  };

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return displayedTasks.filter((t) => {
      if (teamFilter !== "all" && t.team !== teamFilter) return false;
      if (assigneeFilter !== "all" && t.assignee !== assigneeFilter)
        return false;
      if (!taskInDateRange((field) => t[field], dateRange)) return false;
      if (!taskInActivityWindow(t, activityWindow)) return false;
      if (q) {
        const hay = `${t.title} #${t.id} ${t.assignee} ${t.team ?? ""} ${
          t.body ?? ""
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    displayedTasks,
    teamFilter,
    assigneeFilter,
    query,
    dateRange,
    activityWindow,
  ]);

  const dependencyMapTasks = useMemo(() => {
    if (!sourceSessionId) return visibleTasks;
    const scoped = visibleTasks.filter(
      (task) =>
        task.created_in_session_id === sourceSessionId ||
        sourceSessionTaskIds?.has(task.id),
    );
    return scoped.length > 0 ? scoped : visibleTasks;
  }, [sourceSessionId, sourceSessionTaskIds, visibleTasks]);

  const dependencyLayoutStorageKey = useMemo(() => {
    const apiScope = previewApiBase ?? "local";
    const sessionScope = sourceSessionId ?? "all";
    return `${apiScope}|${sessionScope}`;
  }, [previewApiBase, sourceSessionId]);

  const dependencyTimelineKey = useMemo(
    () =>
      dependencyMapTasks
        .map(
          (task) =>
            `${encodeURIComponent(task.id)}:${task.status}:${task.updated_at}`,
        )
        .join("|"),
    [dependencyMapTasks],
  );

  useEffect(() => {
    if (viewMode !== "deps" || !dependencyTimelineKey) {
      setTaskStartTimes(new Map());
      return;
    }

    const ctrl = new AbortController();
    const taskIds = dependencyTimelineKey
      .split("|")
      .map((part) => part.split(":")[0])
      .filter((id): id is string => !!id)
      .map((id) => decodeURIComponent(id));

    async function loadTaskStartTimes() {
      const entries = await Promise.all(
        taskIds.map(async (taskId) => {
          try {
            const res = await fetch(
              apiUrl(
                `/api/tasks/${encodeURIComponent(taskId)}/events?limit=100`,
              ),
              { signal: ctrl.signal },
            );
            if (!res.ok) return null;
            const json = (await res.json()) as { events?: TaskEvent[] };
            const startedAt = executionStartMs(json.events ?? []);
            return startedAt === null ? null : ([taskId, startedAt] as const);
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            return null;
          }
        }),
      );
      if (ctrl.signal.aborted) return;
      const next = new Map<string, number>();
      for (const entry of entries) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setTaskStartTimes(next);
    }

    void loadTaskStartTimes().catch((e) => {
      if ((e as Error).name === "AbortError") return;
      setTaskStartTimes(new Map());
    });
    return () => ctrl.abort();
  }, [apiUrl, dependencyTimelineKey, viewMode]);

  const grouped = useMemo(() => {
    const out = new Map<TaskStatus, Task[]>();
    for (const s of STATUS_ORDER) out.set(s, []);
    for (const t of visibleTasks) {
      out.get(t.status)?.push(t);
    }
    for (const list of out.values()) {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return out;
  }, [visibleTasks]);

  const dirty = !!(
    draft &&
    selected &&
    (draft.title !== selected.title ||
      (draft.body ?? "") !== (selected.body ?? "") ||
      draft.status !== selected.status ||
      draft.assignee !== selected.assignee ||
      JSON.stringify(draft.depends_on) !==
        JSON.stringify(selected.depends_on) ||
      (draft.session_id ?? null) !== (selected.session_id ?? null) ||
      (draft.start_at ?? null) !== (selected.start_at ?? null) ||
      (draft.due_at ?? null) !== (selected.due_at ?? null) ||
      JSON.stringify(draft.recurrence) !== JSON.stringify(selected.recurrence))
  );
  dirtyRef.current = dirty;

  // Unsaved edits never silently die: selection changes route through
  // the discard dialog while dirty.
  const guardNav = (go: () => void) => {
    if (dirtyRef.current) setPendingNav(() => go);
    else go();
  };
  const taskSearch = (id?: string | null) =>
    ({
      ...(id ? { id } : {}),
      ...(previewApiBase ? { apiBase: previewApiBase } : {}),
      ...(sourceSessionId ? { sourceSession: sourceSessionId } : {}),
    }) satisfies { id?: string; apiBase?: string; sourceSession?: string };
  const pickTask = (id: string) => {
    if (id === urlId) return;
    guardNav(() => void navigate({ to: "/tasks", search: taskSearch(id) }));
  };
  const closeDetail = () => {
    guardNav(() => void navigate({ to: "/tasks", search: taskSearch() }));
  };

  // Cmd/Ctrl+S saves the open task instead of the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (!draft) return;
        e.preventDefault();
        if (dirty && !saving && !tasksReadOnly) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-paper-rule px-3 py-2 md:px-6">
          <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
            Tasks
          </h1>
          {previewApiBase && (
            <span
              title={previewApiBase}
              className="inline-flex h-6 items-center border border-signal-amber/50 bg-signal-amber/10 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-signal-amber"
            >
              Prod API {previewApiLabel} · Read only
            </span>
          )}
          {sourceSessionId && (
            <span
              title={sourceSessionId}
              className="inline-flex h-6 items-center border border-paper-rule bg-paper-sunk px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft"
            >
              Source session {sourceSessionId.slice(0, 8)}
            </span>
          )}

          {!loading && tasks.length > 0 ? (
            <>
              <div className="relative min-w-[9rem] flex-1 md:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, body, #id"
                  className="h-7 pl-8 pr-7 text-[13px]"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>

              {assignees.length > 1 && (
                <FilterCombobox
                  value={assigneeFilter}
                  onChange={setAssigneeFilter}
                  allLabel="All assignees"
                  searchPlaceholder="Filter agents"
                  options={assignees.map((a) => ({
                    value: a,
                    label: agentName.get(a) ?? a,
                  }))}
                />
              )}

              {teams.length > 0 && (
                <FilterCombobox
                  value={teamFilter}
                  onChange={setTeamFilter}
                  allLabel="All teams"
                  searchPlaceholder="Filter teams"
                  options={teams.map((t) => ({ value: t, label: t }))}
                />
              )}

              <DateRangeFilter value={dateRange} onChange={setDateRange} />
              <ActivityWindowFilter
                value={activityWindow}
                onChange={setActivityWindow}
              />

              {/* Eats the slack so the count + view toggle pin right while
                  the search caps at max-w-xs. */}
              <div className="flex-1" />

              {filtersActive && (
                <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-ink-faint">
                  <span>
                    {visibleTasks.length} / {tasks.length}
                  </span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 uppercase tracking-[0.08em] text-ink-soft transition-colors hover:text-plot-red"
                  >
                    <X className="size-3" />
                    Clear
                  </button>
                </span>
              )}
            </>
          ) : (
            <div className="flex-1" />
          )}

          <div className="ml-auto inline-flex shrink-0 border border-paper-rule">
            <button
              onClick={() => setViewMode("board")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "board"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink",
              )}
            >
              <Kanban className="size-3.5" />
              Board
            </button>
            <button
              onClick={() => setViewMode("deps")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 border-l border-paper-rule px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "deps"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink",
              )}
            >
              <GitBranch className="size-3.5" />
              Deps
            </button>
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 border-l border-paper-rule px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors",
                viewMode === "list"
                  ? "bg-ink text-paper"
                  : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink",
              )}
            >
              <Rows3 className="size-3.5" />
              List
            </button>
          </div>
        </header>

        {loading ? (
          <div className="relative flex flex-1 items-end px-6 py-12 section-enter">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Reading task store
            </span>
            <LoadingHairline />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyTasksState />
        ) : visibleTasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <Search className="size-5 text-ink-faint/70" aria-hidden />
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              No tasks match
            </span>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {viewMode === "board" ? (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <TasksBoard
                  tasks={visibleTasks}
                  selectedId={selected?.id ?? null}
                  onPick={pickTask}
                  onMove={(id, target) => void moveStatus(id, target)}
                  readOnly={tasksReadOnly}
                />
              </div>
            ) : viewMode === "deps" ? (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <TaskDependencyMap
                  tasks={dependencyMapTasks}
                  selectedId={selected?.id ?? null}
                  onPick={pickTask}
                  focusSessionId={sourceSessionId}
                  sourceSessions={sourceSessionCards}
                  taskStartTimes={taskStartTimes}
                  layoutStorageKey={dependencyLayoutStorageKey}
                  apiUrl={apiUrl}
                />
              </div>
            ) : (
              <aside
                className={cn(
                  "flex shrink-0 flex-col overflow-y-auto border-paper-rule md:w-96 md:border-r",
                  selected ? "hidden md:flex" : "flex w-full md:w-96",
                )}
              >
                {STATUS_ORDER.map((status) => {
                  const items = grouped.get(status) ?? [];
                  if (items.length === 0) return null;
                  return (
                    <div key={status}>
                      <div className="flex items-center justify-between border-b border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        <span>{STATUS_LABEL[status]}</span>
                        <TabularTick value={items.length} />
                      </div>
                      <div className="flex flex-col">
                        {items.map((t) => (
                          <TaskListRow
                            key={t.id}
                            task={t}
                            isActive={selected?.id === t.id}
                            onPick={() => pickTask(t.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </aside>
            )}

            {/* One detail surface for both modes: the routed pane. Board
                opens it as a right-anchored sheet over the columns (the
                board keeps its full width); list keeps it resident. */}
            {viewMode === "list" && (
              <section
                className={cn(
                  "flex flex-1 flex-col overflow-hidden",
                  !selected ? "hidden md:flex" : "flex",
                )}
              >
                {selected && draft && <BackToTasks onClick={closeDetail} />}
                {!selected || !draft ? (
                  <div className="flex flex-1 items-start justify-center px-6 pt-24">
                    <div className="max-w-sm">
                      <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                        No selection
                      </div>
                      <h3 className="mt-2 text-base font-semibold text-ink">
                        Pick a task
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                        Each task has a title, status, assignee, schedule, and
                        free-form body. Status changes are gated by
                        dependencies.
                      </p>
                    </div>
                  </div>
                ) : (
                  <TaskDetailPanel
                    selected={selected}
                    draft={draft}
                    saving={saving}
                    dirty={dirty}
                    agents={agents}
                    tasks={displayedTasks}
                    onChange={setDraft}
                    onSave={() => void save()}
                    onDeleteClick={() => setConfirmDelete(selected.id)}
                    apiUrl={apiUrl}
                    readOnly={tasksReadOnly}
                  />
                )}
              </section>
            )}
          </div>
        )}

        {/* Board mode: detail as a full-height right sheet over the
            columns. Escape / overlay-click route through closeDetail, so
            the dirty guard still applies. Mobile: full takeover above
            the bottom tab bar, like the rest of the app. */}
        <Dialog
          open={viewMode !== "list" && !!selected && !!draft}
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="left-0 right-0 top-0 h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden border-0 border-l border-paper-rule data-[state=closed]:slide-out-to-right-6 data-[state=open]:slide-in-from-right-6 sm:max-w-none md:left-auto md:h-dvh md:max-h-none md:w-[min(54rem,94vw)]"
          >
            <VisuallyHidden.Root>
              <DialogTitle>{selected?.title ?? "Task"}</DialogTitle>
              <DialogDescription>
                Edit task details: title, status, assignee, schedule,
                recurrence, dependencies, and body.
              </DialogDescription>
            </VisuallyHidden.Root>
            {selected && draft && (
              <TaskDetailPanel
                selected={selected}
                draft={draft}
                saving={saving}
                dirty={dirty}
                agents={agents}
                tasks={displayedTasks}
                onChange={setDraft}
                onSave={() => void save()}
                onDeleteClick={() => setConfirmDelete(selected.id)}
                onClose={closeDetail}
                apiUrl={apiUrl}
                readOnly={tasksReadOnly}
              />
            )}
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!pendingNav}
          onOpenChange={(open) => {
            if (!open) setPendingNav(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogDescription>
                This task has edits that aren&apos;t saved.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingNav(null)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const go = pendingNav;
                  setPendingNav(null);
                  go?.();
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={!!confirmDelete}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmDelete(null);
              setConfirmDeleteMode("simple");
            }
          }}
        >
          <DialogContent>
            {confirmDeleteMode === "simple" ? (
              <>
                <DialogHeader>
                  <DialogTitle>Delete this task?</DialogTitle>
                  <DialogDescription>
                    Permanent. If other tasks depend on this one, you&apos;ll be
                    asked whether to cascade.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setConfirmDelete(null);
                      setConfirmDeleteMode("simple");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      if (!confirmDelete) return;
                      const ok = await remove(confirmDelete, false);
                      if (!ok) setConfirmDeleteMode("cascade");
                    }}
                  >
                    Delete
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Cascade delete?</DialogTitle>
                  <DialogDescription>
                    Other tasks depend on this one. Cascading removes them all.
                  </DialogDescription>
                </DialogHeader>
                {confirmDelete && (
                  <ol className="my-2 max-h-48 space-y-1.5 overflow-y-auto border-t border-paper-rule pt-3">
                    {displayedTasks
                      .filter((t) => t.depends_on.includes(confirmDelete))
                      .map((t) => (
                        <li
                          key={t.id}
                          className="flex items-baseline gap-2 text-sm"
                        >
                          <span className="font-mono text-[12px] tabular-nums text-ink-faint">
                            {`#${t.id}`}
                          </span>
                          <span className="truncate text-ink">{t.title}</span>
                        </li>
                      ))}
                  </ol>
                )}
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setConfirmDelete(null);
                      setConfirmDeleteMode("simple");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      if (!confirmDelete) return;
                      await remove(confirmDelete, true);
                    }}
                  >
                    Cascade
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}

// Mobile-only escape hatch back to the list/board when the detail pane
// takes over the full width.
function BackToTasks({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-4 mt-3 inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft hover:text-plot-red md:hidden"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Back to tasks
    </button>
  );
}

function explainAutoCorrect(
  task: Task,
  requested: TaskStatus,
): { title: string; description: string } {
  // Marking a recurring task done re-arms it — designed behavior, not
  // a correction, so don't make it read like an error.
  if (task.recurrence && requested === "done" && task.status === "open") {
    const next = task.start_at
      ? formatRelativeFromIso(task.start_at)
      : "pending";
    return {
      title: "Recurring task re-armed",
      description: `Run ${task.runs} complete. Next fire ${next}.`,
    };
  }
  if (task.status === "blocked" && requested === "open") {
    return {
      title: `Auto-corrected to ${STATUS_LABEL[task.status]}`,
      description: "Dependencies aren't all done yet.",
    };
  }
  return {
    title: `Auto-corrected to ${STATUS_LABEL[task.status]}`,
    description: `Server returned status ${task.status} instead of ${requested}.`,
  };
}

// One-pass vocabulary scribe-in: open → in_progress → done, then settle on
// in_progress (the most informative state). Not an eternal loop — §7.4's
// "choreographed motion" anti-pattern targets staggered/multi-curve flourish;
// a single bounded pass through the vocabulary is the §7.3 designed-empty-
// state primitive ("scribes in to demonstrate the format").
const EMPTY_DEMO_STATES: { label: string; dot: string }[] = [
  { label: "OPEN", dot: "bg-ink" },
  { label: "IN PROGRESS", dot: "bg-plot-red" },
  { label: "DONE", dot: "bg-ink-soft" },
];
// Settle index = IN PROGRESS (the live state). After the cycle, the demo
// row freezes here so the empty state's primary teaching is "this is what
// active work looks like."
const EMPTY_DEMO_SETTLE_IDX = 1;
const EMPTY_DEMO_STEP_MS = 1500;

function EmptyTasksState() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let step = 0;
    const tick = () => {
      if (cancelled) return;
      if (step >= EMPTY_DEMO_STATES.length - 1) {
        // Final settle frame.
        setIdx(EMPTY_DEMO_SETTLE_IDX);
        return;
      }
      step += 1;
      setIdx(step);
      window.setTimeout(tick, EMPTY_DEMO_STEP_MS);
    };
    const t = window.setTimeout(tick, EMPTY_DEMO_STEP_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, []);
  const current =
    EMPTY_DEMO_STATES[idx] ?? EMPTY_DEMO_STATES[EMPTY_DEMO_SETTLE_IDX]!;
  return (
    <div className="mx-auto w-full max-w-2xl px-6 pt-12">
      <SectionEyebrow meta="0 tasks">Empty board</SectionEyebrow>

      <div className="mt-6 border border-dashed border-paper-rule paper-surface px-4 py-4 section-enter opacity-80">
        <div className="label-faceplate mb-3 text-ink-faint">Preview</div>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink truncate">
              Draft the weekly status note
            </div>
            <div className="mt-1 meta-row">@your-agent · filed just now</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span aria-hidden className={cn("status-dot", current.dot)} />
            <span key={idx} className="label-faceplate tick">
              {current.label}
            </span>
          </div>
        </div>
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-soft">
        <JargonChip
          term="Task"
          explanation={
            <span>
              A unit of work an agent files for itself or another agent. Has a
              title, status, assignee, schedule, and free-form body. Status
              transitions are gated by declared dependencies.
            </span>
          }
        >
          Tasks
        </JargonChip>{" "}
        are how agents track work, for themselves and for you. Each one moves
        between <span className="font-mono text-ink">open</span>,{" "}
        <span className="font-mono text-ink">in_progress</span>, and{" "}
        <span className="font-mono text-ink">done</span>. They appear here as
        agents file them. Ask an agent in chat to{" "}
        <span className="font-mono text-ink">file a task to investigate X</span>{" "}
        to start.
      </p>
    </div>
  );
}
