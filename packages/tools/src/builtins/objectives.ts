import { z } from "zod";
import {
  OBJECTIVE_STATUSES,
  ObjectiveStoreError,
  type ObjectiveStatus,
  type ObjectiveStore,
} from "@openacme/db";
import { TaskStore, TaskStoreError, type Task } from "@openacme/tasks";
import { registry } from "../registry.js";
import { getCurrentAgentId, getCurrentSessionId } from "../session-context.js";

const ObjectiveIdParam = z.string().min(1);
const TaskIdParam = z.union([z.string().min(1), z.number().int()]);
const TerminalCloseStatuses = ["completed", "failed", "canceled"] as const;

function taskId(v: string | number): string {
  return String(v);
}

function nonBlank(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface ObjectiveStoreBindings {
  objectiveStore: ObjectiveStore;
  taskStore: TaskStore;
}

let bindings: ObjectiveStoreBindings | null = null;

export function bindObjectiveStore(b: ObjectiveStoreBindings): void {
  bindings = b;
}

function requireBindings(): ObjectiveStoreBindings | { error: string } {
  if (!bindings) {
    return {
      error:
        "objectives not initialized — AgentManager must call bindObjectiveStore().",
    };
  }
  return bindings;
}

function requireAgentContext(toolName: string): string | { error: string } {
  const agentId = getCurrentAgentId();
  if (!agentId) {
    return { error: `${toolName} requires an active agent context.` };
  }
  return agentId;
}

function errorJson(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error:
      error instanceof ObjectiveStoreError || error instanceof TaskStoreError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error),
  });
}

function objectiveRollup(taskStore: TaskStore, objectiveId: string) {
  const tasks = taskStore.list({ objective_id: objectiveId });
  const terminal = tasks.filter(isTerminalTask).length;
  return {
    linked_task_count: tasks.length,
    terminal_task_count: terminal,
    nonterminal_task_count: tasks.length - terminal,
  };
}

function isTerminalTask(task: Task): boolean {
  return task.status === "done" || task.status === "canceled";
}

// ── objective_create ─────────────────────────────────────────────────

registry.register({
  name: "objective_create",
  toolset: "tasks",
  description:
    "Create an objective grouping for tracked outcomes. Objectives do not create sessions or tasks by themselves.",
  parameters: z.object({
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    closeout_prompt: z
      .string()
      .optional()
      .describe("Optional owner guidance for final closeout review."),
    owner_agent_id: z
      .string()
      .optional()
      .describe("Defaults to the current agent."),
    owner_session_id: z
      .string()
      .nullable()
      .optional()
      .describe("Defaults to the current session when available."),
  }),
  emoji: "🎯",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const agentId = requireAgentContext("objective_create");
    if (typeof agentId !== "string") {
      return JSON.stringify({ ok: false, error: agentId.error });
    }

    const a = args as {
      title: string;
      description?: string;
      closeout_prompt?: string;
      owner_agent_id?: string;
      owner_session_id?: string | null;
    };
    const sessionId = getCurrentSessionId() || null;
    try {
      const objective = b.objectiveStore.createObjective({
        title: a.title,
        description: a.description ?? "",
        ownerAgentId: nonBlank(a.owner_agent_id) ?? agentId,
        ownerSessionId: nonBlank(a.owner_session_id) ?? sessionId,
        createdBy: agentId,
        createdInSessionId: sessionId,
        closeoutPrompt: a.closeout_prompt ?? "",
      });
      return JSON.stringify({ ok: true, objective });
    } catch (e) {
      return errorJson(e);
    }
  },
});

// ── objective_view ───────────────────────────────────────────────────

registry.register({
  name: "objective_view",
  toolset: "tasks",
  description:
    "Read an objective with linked task rollup and objective events.",
  parameters: z.object({
    id: ObjectiveIdParam.describe("Objective id."),
  }),
  emoji: "🔭",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const a = args as { id: string };
    const objective = b.objectiveStore.getObjective(a.id);
    if (!objective) {
      return JSON.stringify({
        ok: false,
        error: `Objective ${a.id} not found.`,
      });
    }
    return JSON.stringify({
      ok: true,
      objective,
      rollup: objectiveRollup(b.taskStore, objective.id),
      events: b.objectiveStore.listObjectiveEvents(objective.id),
      tasks: b.taskStore
        .list({ objective_id: objective.id })
        .map(({ body: _body, ...frontmatter }) => {
          void _body;
          return frontmatter;
        }),
    });
  },
});

// ── objective_list ───────────────────────────────────────────────────

registry.register({
  name: "objective_list",
  toolset: "tasks",
  description: "List objectives. Pass filters to narrow by owner or status.",
  parameters: z.object({
    owner_agent_id: z.string().optional(),
    owner_session_id: z.string().optional(),
    status: z.enum(OBJECTIVE_STATUSES).optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  emoji: "📌",
  parallelSafe: true,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const a = args as {
      owner_agent_id?: string;
      owner_session_id?: string;
      status?: ObjectiveStatus;
      limit?: number;
    };
    const all = b.objectiveStore.listObjectives({
      ownerAgentId: a.owner_agent_id,
      ownerSessionId: a.owner_session_id,
      status: a.status,
      limit: a.limit ?? 50,
    });
    return JSON.stringify({
      ok: true,
      count: all.length,
      objectives: all.map((objective) => ({
        ...objective,
        rollup: objectiveRollup(b.taskStore, objective.id),
      })),
    });
  },
});

// ── objective_update ─────────────────────────────────────────────────

registry.register({
  name: "objective_update",
  toolset: "tasks",
  description:
    "Patch objective metadata or status. Does not verify task results.",
  parameters: z.object({
    id: ObjectiveIdParam,
    title: z.string().min(1).max(500).optional(),
    description: z.string().optional(),
    status: z.enum(OBJECTIVE_STATUSES).optional(),
    closeout_prompt: z.string().optional(),
    owner_agent_id: z.string().optional(),
    owner_session_id: z.string().nullable().optional(),
  }),
  emoji: "📝",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const agentId = requireAgentContext("objective_update");
    if (typeof agentId !== "string") {
      return JSON.stringify({ ok: false, error: agentId.error });
    }
    const a = args as {
      id: string;
      title?: string;
      description?: string;
      status?: ObjectiveStatus;
      closeout_prompt?: string;
      owner_agent_id?: string;
      owner_session_id?: string | null;
    };
    try {
      const objective = b.objectiveStore.updateObjective(
        a.id,
        {
          title: a.title,
          description: a.description,
          status: a.status,
          closeoutPrompt: a.closeout_prompt,
          ownerAgentId: a.owner_agent_id,
          ...(Object.prototype.hasOwnProperty.call(a, "owner_session_id")
            ? { ownerSessionId: a.owner_session_id }
            : {}),
        },
        agentId,
      );
      return JSON.stringify({ ok: true, objective });
    } catch (e) {
      return errorJson(e);
    }
  },
});

// ── objective_attach_task / objective_detach_task ────────────────────

registry.register({
  name: "objective_attach_task",
  toolset: "tasks",
  description:
    "Attach an existing task to an objective. Reopens ready objectives when nonterminal work is attached.",
  parameters: z.object({
    id: ObjectiveIdParam.describe("Objective id."),
    task_id: TaskIdParam.describe("Task id to attach."),
  }),
  emoji: "🔗",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const agentId = requireAgentContext("objective_attach_task");
    if (typeof agentId !== "string") {
      return JSON.stringify({ ok: false, error: agentId.error });
    }
    const a = args as { id: string; task_id: string | number };
    const id = a.id;
    const tid = taskId(a.task_id);
    try {
      const objective = b.objectiveStore.getObjective(id);
      if (!objective)
        throw new ObjectiveStoreError("not_found", `Objective ${id} not found`);
      const existing = b.taskStore.get(tid);
      if (!existing)
        throw new TaskStoreError("not_found", `Task ${tid} not found`);
      const task = await b.taskStore.update(
        tid,
        { objective_id: id },
        { actor: agentId },
      );
      let nextObjective = objective;
      if (objective.status === "ready_for_closeout" && !isTerminalTask(task)) {
        nextObjective = b.objectiveStore.updateObjective(
          id,
          { status: "waiting_on_tasks" },
          agentId,
        );
        b.objectiveStore.appendObjectiveEvent({
          objectiveId: id,
          eventType: "objective_reopened",
          actor: agentId,
          summary: `Objective reopened after attaching task ${tid}`,
          details: { taskId: tid },
        });
      }
      b.objectiveStore.appendObjectiveEvent({
        objectiveId: id,
        eventType: "task_attached",
        actor: agentId,
        summary: `Attached task ${tid}`,
        details: { taskId: tid },
      });
      return JSON.stringify({ ok: true, objective: nextObjective, task });
    } catch (e) {
      return errorJson(e);
    }
  },
});

registry.register({
  name: "objective_detach_task",
  toolset: "tasks",
  description:
    "Detach a task from an objective. Detach/delete is cleanup and does not imply objective completion.",
  parameters: z.object({
    id: ObjectiveIdParam.describe("Objective id."),
    task_id: TaskIdParam.describe("Task id to detach."),
  }),
  emoji: "⛓️",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const agentId = requireAgentContext("objective_detach_task");
    if (typeof agentId !== "string") {
      return JSON.stringify({ ok: false, error: agentId.error });
    }
    const a = args as { id: string; task_id: string | number };
    const id = a.id;
    const tid = taskId(a.task_id);
    try {
      const objective = b.objectiveStore.getObjective(id);
      if (!objective)
        throw new ObjectiveStoreError("not_found", `Objective ${id} not found`);
      if (!b.taskStore.get(tid)) {
        throw new TaskStoreError("not_found", `Task ${tid} not found`);
      }
      const task = await b.taskStore.update(
        tid,
        { objective_id: null },
        { actor: agentId },
      );
      b.objectiveStore.appendObjectiveEvent({
        objectiveId: id,
        eventType: "task_detached",
        actor: agentId,
        summary: `Detached task ${tid}`,
        details: { taskId: tid },
      });
      return JSON.stringify({ ok: true, objective, task });
    } catch (e) {
      return errorJson(e);
    }
  },
});

// ── objective_close / objective_event ────────────────────────────────

registry.register({
  name: "objective_close",
  toolset: "tasks",
  description:
    "Close an objective as completed, failed, or canceled. Only the objective owner can close through this tool.",
  parameters: z.object({
    id: ObjectiveIdParam,
    status: z.enum(TerminalCloseStatuses),
    summary: z.string().min(1),
  }),
  emoji: "✅",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const agentId = requireAgentContext("objective_close");
    if (typeof agentId !== "string") {
      return JSON.stringify({ ok: false, error: agentId.error });
    }
    const a = args as {
      id: string;
      status: (typeof TerminalCloseStatuses)[number];
      summary: string;
    };
    const objective = b.objectiveStore.getObjective(a.id);
    if (!objective) {
      return JSON.stringify({
        ok: false,
        error: `Objective ${a.id} not found.`,
      });
    }
    if (objective.ownerAgentId !== agentId) {
      return JSON.stringify({
        ok: false,
        error: `Only the objective owner (${objective.ownerAgentId}) can close this objective.`,
      });
    }
    try {
      const closed =
        a.status === "completed"
          ? b.objectiveStore.completeObjective(a.id, a.summary, agentId)
          : a.status === "failed"
            ? b.objectiveStore.failObjective(a.id, a.summary, agentId)
            : b.objectiveStore.cancelObjective(a.id, a.summary, agentId);
      return JSON.stringify({ ok: true, objective: closed });
    } catch (e) {
      return errorJson(e);
    }
  },
});

registry.register({
  name: "objective_event",
  toolset: "tasks",
  description:
    "Append an objective ledger event. Does not change task or objective status.",
  parameters: z.object({
    id: ObjectiveIdParam,
    event_type: z.string().min(1),
    summary: z.string().min(1),
    details: z.unknown().optional(),
  }),
  emoji: "🧾",
  parallelSafe: false,
  handler: async (args) => {
    const b = requireBindings();
    if ("error" in b) return JSON.stringify({ ok: false, error: b.error });
    const agentId = requireAgentContext("objective_event");
    if (typeof agentId !== "string") {
      return JSON.stringify({ ok: false, error: agentId.error });
    }
    const a = args as {
      id: string;
      event_type: string;
      summary: string;
      details?: unknown;
    };
    try {
      const event = b.objectiveStore.appendObjectiveEvent({
        objectiveId: a.id,
        eventType: a.event_type,
        actor: agentId,
        summary: a.summary,
        details: a.details,
      });
      return JSON.stringify({ ok: true, event });
    } catch (e) {
      return errorJson(e);
    }
  },
});
