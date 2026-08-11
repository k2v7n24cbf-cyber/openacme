import { createHash } from "node:crypto";
import type { ObjectiveRow, ObjectiveStore } from "@openacme/db";
import type { Task, TaskStore, Comment } from "@openacme/tasks";

const ACTIVE_OBJECTIVE_STATUSES = new Set([
  "active",
  "waiting_on_tasks",
  "ready_for_closeout",
]);
const TERMINAL_TASK_STATUSES = new Set(["done", "canceled"]);
const DEFAULT_CHECK_LIMIT = 50;

export interface ObjectiveCloseoutWatcherOptions {
  objectiveStore: ObjectiveStore;
  taskStore: TaskStore;
}

export interface ObjectiveCloseoutCheckOptions {
  limit?: number;
  budgetMs?: number;
}

export interface ObjectiveCloseoutCheckResult {
  scanned: number;
  ready: ObjectiveCloseoutReady[];
}

export interface ObjectiveCloseoutReady {
  objective: ObjectiveRow;
  fingerprint: string;
  packet: ObjectiveCloseoutPacket;
  needsOwnerWake: true;
  reason: "linked_tasks_terminal" | "owner_wake_retry";
}

export interface ObjectiveCloseoutPacket {
  objective: {
    id: string;
    title: string;
    description: string;
    closeout_prompt: string;
    status: string;
  };
  rollup: {
    linked_task_count: number;
    terminal_task_count: number;
    nonterminal_task_count: number;
  };
  linked_tasks: ObjectiveCloseoutPacketTask[];
}

export interface ObjectiveCloseoutPacketTask {
  id: string;
  title: string;
  status: string;
  assignee: string;
  session_id: string | null;
  updated_at: string;
  closed_at: string | null;
  latest_result_comment_excerpt: string | null;
  latest_system_comment_excerpt: string | null;
  latest_comment_excerpts: Array<{
    id: string;
    author: string;
    kind: string | null;
    excerpt: string;
    created_at: number;
  }>;
}

export class ObjectiveCloseoutWatcher {
  private readonly objectiveStore: ObjectiveStore;
  private readonly taskStore: TaskStore;

  constructor(options: ObjectiveCloseoutWatcherOptions) {
    this.objectiveStore = options.objectiveStore;
    this.taskStore = options.taskStore;
  }

  async check(
    options: ObjectiveCloseoutCheckOptions = {},
  ): Promise<ObjectiveCloseoutCheckResult> {
    const limit = Math.max(1, options.limit ?? DEFAULT_CHECK_LIMIT);
    const started = Date.now();
    const objectives = this.objectiveStore
      .listObjectives({ limit: limit * 4 })
      .filter((objective) => ACTIVE_OBJECTIVE_STATUSES.has(objective.status))
      .slice(0, limit);
    const ready: ObjectiveCloseoutReady[] = [];

    for (const objective of objectives) {
      if (
        options.budgetMs !== undefined &&
        Date.now() - started > options.budgetMs
      ) {
        break;
      }
      const linkedTasks = this.taskStore.list({ objective_id: objective.id });
      if (linkedTasks.length === 0) continue;
      if (!linkedTasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) {
        continue;
      }

      const fingerprint = fingerprintLinkedTasks(linkedTasks);
      const wakeAlreadyRequested = hasOwnerWakeRequested(
        this.objectiveStore,
        objective.id,
        fingerprint,
      );
      if (
        objective.status === "ready_for_closeout" &&
        objective.lastCloseoutFingerprint === fingerprint &&
        wakeAlreadyRequested
      ) {
        continue;
      }

      const packet = buildCloseoutPacket(
        objective,
        linkedTasks,
        this.taskStore,
      );
      let nextObjective = objective;
      let reason: ObjectiveCloseoutReady["reason"] = "linked_tasks_terminal";

      if (
        objective.status !== "ready_for_closeout" ||
        objective.lastCloseoutFingerprint !== fingerprint
      ) {
        this.objectiveStore.recordCloseoutBrief(
          objective.id,
          { fingerprint, packet },
          "system:objective-closeout",
        );
        nextObjective = this.objectiveStore.updateObjective(
          objective.id,
          { status: "ready_for_closeout" },
          "system:objective-closeout",
        );
        this.objectiveStore.appendObjectiveEvent({
          objectiveId: objective.id,
          eventType: "linked_tasks_terminal",
          actor: "system:objective-closeout",
          summary: "All linked tasks are terminal",
          details: {
            fingerprint,
            linkedTaskIds: linkedTasks.map((task) => task.id).sort(),
          },
        });
      } else {
        reason = "owner_wake_retry";
      }

      ready.push({
        objective: nextObjective,
        fingerprint,
        packet,
        needsOwnerWake: true,
        reason,
      });
    }

    return { scanned: objectives.length, ready };
  }
}

function buildCloseoutPacket(
  objective: ObjectiveRow,
  linkedTasks: Task[],
  taskStore: TaskStore,
): ObjectiveCloseoutPacket {
  const terminal = linkedTasks.filter((task) =>
    TERMINAL_TASK_STATUSES.has(task.status),
  ).length;
  return {
    objective: {
      id: objective.id,
      title: objective.title,
      description: objective.description,
      closeout_prompt: objective.closeoutPrompt,
      status: objective.status,
    },
    rollup: {
      linked_task_count: linkedTasks.length,
      terminal_task_count: terminal,
      nonterminal_task_count: linkedTasks.length - terminal,
    },
    linked_tasks: [...linkedTasks]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((task) => packetTask(task, taskStore)),
  };
}

function packetTask(
  task: Task,
  taskStore: TaskStore,
): ObjectiveCloseoutPacketTask {
  const result = latest(taskStore.listComments(task.id, { kinds: ["result"] }));
  const system = latest(taskStore.listComments(task.id, { kinds: ["system"] }));
  const recent = taskStore
    .listComments(task.id)
    .slice(-3)
    .map((comment) => ({
      id: comment.id,
      author: comment.author,
      kind: comment.kind,
      excerpt: excerpt(comment.body, 500),
      created_at: comment.createdAt,
    }));
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    session_id: task.session_id,
    updated_at: task.updated_at,
    closed_at: task.closed_at,
    latest_result_comment_excerpt: result ? excerpt(result.body, 1_000) : null,
    latest_system_comment_excerpt: system ? excerpt(system.body, 1_000) : null,
    latest_comment_excerpts: recent,
  };
}

function fingerprintLinkedTasks(tasks: Task[]): string {
  const payload = [...tasks]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((task) => ({
      id: task.id,
      status: task.status,
      closed_at: task.closed_at,
      updated_at: task.updated_at,
    }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function hasOwnerWakeRequested(
  objectiveStore: ObjectiveStore,
  objectiveId: string,
  fingerprint: string,
): boolean {
  return objectiveStore.listObjectiveEvents(objectiveId).some((event) => {
    if (event.eventType !== "owner_wake_requested") return false;
    const details = event.details;
    return (
      typeof details === "object" &&
      details !== null &&
      "fingerprint" in details &&
      (details as { fingerprint?: unknown }).fingerprint === fingerprint
    );
  });
}

function latest(comments: Comment[]): Comment | null {
  return comments.length > 0 ? comments[comments.length - 1]! : null;
}

function excerpt(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
