import type { MessageStore, Session, SessionStore } from "@openacme/db";
import type { Task } from "@openacme/tasks";

const DEFAULT_TASK_TOOL_MESSAGE_LIMIT = 5000;

export interface TaskSourceMatch {
  taskId: string;
  sessionId: string;
  priority: number;
  createdAt: number;
}

export interface ResolvedTaskSourceSessions {
  tasks: Record<string, string>;
  sessions: Array<Session & { taskIds: string[] }>;
  matches: TaskSourceMatch[];
  scannedMessages: number;
}

export interface TaskSourceRepairResult {
  dryRun: boolean;
  scannedMessages: number;
  missingBefore: number;
  resolved: number;
  updated: number;
  unresolved: number;
  changes: Array<{
    taskId: string;
    title: string;
    sourceSessionId: string;
  }>;
}

interface TaskSourceRepairTaskStore {
  list(): Task[];
  backfillCreatedInSessionId(
    id: string,
    createdInSessionId: string,
  ): Promise<{ task: Task; changed: boolean }>;
}

export function resolveTaskSourceSessions(input: {
  taskIds: Iterable<string>;
  messageStore: Pick<MessageStore, "listTaskToolMessages">;
  sessionStore?: Pick<SessionStore, "get">;
  limit?: number;
  minPriority?: number;
}): ResolvedTaskSourceSessions {
  const ids = [...new Set([...input.taskIds].filter(Boolean))];
  if (ids.length === 0) {
    return { tasks: {}, sessions: [], matches: [], scannedMessages: 0 };
  }

  const minPriority = input.minPriority ?? 1;
  const wanted = new Set(ids);
  const bestByTask = new Map<
    string,
    { sessionId: string; priority: number; createdAt: number }
  >();
  const rows = input.messageStore.listTaskToolMessages(
    input.limit ?? DEFAULT_TASK_TOOL_MESSAGE_LIMIT,
  );

  for (const row of rows) {
    for (const part of row.parts) {
      if (!isRecord(part)) continue;
      const type = typeof part["type"] === "string" ? part["type"] : "";
      const priority = taskToolSourcePriority(type);
      if (priority < minPriority) continue;

      const found = new Set<string>();
      collectTaskIdsFromToolValue(part["output"], found);
      collectTaskIdsFromToolValue(part["result"], found);
      for (const taskId of found) {
        if (!wanted.has(taskId)) continue;
        const current = bestByTask.get(taskId);
        if (
          !current ||
          priority > current.priority ||
          (priority === current.priority && row.createdAt < current.createdAt)
        ) {
          bestByTask.set(taskId, {
            sessionId: row.sessionId,
            priority,
            createdAt: row.createdAt,
          });
        }
      }
    }
  }

  const taskMap: Record<string, string> = {};
  const taskIdsBySession = new Map<string, string[]>();
  const matches: TaskSourceMatch[] = [];
  for (const [taskId, match] of bestByTask) {
    taskMap[taskId] = match.sessionId;
    matches.push({ taskId, ...match });
    const bucket = taskIdsBySession.get(match.sessionId) ?? [];
    bucket.push(taskId);
    taskIdsBySession.set(match.sessionId, bucket);
  }

  const sessions = input.sessionStore
    ? [...taskIdsBySession.entries()]
        .map(([sessionId, taskIds]) => {
          const session = input.sessionStore?.get(sessionId);
          if (!session) return null;
          return {
            ...session,
            taskIds: sortTaskIds(taskIds),
          };
        })
        .filter((session): session is Session & { taskIds: string[] } =>
          Boolean(session),
        )
    : [];

  return {
    tasks: taskMap,
    sessions,
    matches: matches.sort((a, b) =>
      a.taskId.localeCompare(b.taskId, undefined, { numeric: true }),
    ),
    scannedMessages: rows.length,
  };
}

export async function repairTaskSourceSessions(input: {
  taskStore: TaskSourceRepairTaskStore;
  messageStore: Pick<MessageStore, "listTaskToolMessages">;
  limit?: number;
  dryRun?: boolean;
}): Promise<TaskSourceRepairResult> {
  const dryRun = input.dryRun !== false;
  const missingTasks = input.taskStore
    .list()
    .filter((task) => !task.created_in_session_id);
  const taskById = new Map(missingTasks.map((task) => [task.id, task]));
  const resolved = resolveTaskSourceSessions({
    taskIds: taskById.keys(),
    messageStore: input.messageStore,
    limit: input.limit,
    minPriority: 3,
  });

  const changes = resolved.matches.flatMap((match) => {
    const task = taskById.get(match.taskId);
    if (!task) return [];
    return [
      {
        taskId: task.id,
        title: task.title,
        sourceSessionId: match.sessionId,
      },
    ];
  });

  let updated = 0;
  if (!dryRun) {
    for (const change of changes) {
      const result = await input.taskStore.backfillCreatedInSessionId(
        change.taskId,
        change.sourceSessionId,
      );
      if (result.changed) updated += 1;
    }
  }

  return {
    dryRun,
    scannedMessages: resolved.scannedMessages,
    missingBefore: missingTasks.length,
    resolved: changes.length,
    updated,
    unresolved: Math.max(0, missingTasks.length - changes.length),
    changes,
  };
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

function sortTaskIds(ids: string[]): string[] {
  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
