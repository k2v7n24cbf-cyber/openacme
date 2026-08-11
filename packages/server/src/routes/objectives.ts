import type { Context, Hono } from "hono";
import {
  OBJECTIVE_STATUSES,
  ObjectiveStoreError,
  type ObjectiveStatus,
} from "@openacme/db";
import { TaskStoreError, type Task } from "@openacme/tasks";
import type { AgentManager } from "../agent-manager.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TERMINAL_OBJECTIVE_STATUSES = [
  "completed",
  "failed",
  "canceled",
] as const;

function statusErrorCode(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid_status":
      return 400;
    default:
      return 400;
  }
}

function isObjectiveStatus(value: string): value is ObjectiveStatus {
  return (OBJECTIVE_STATUSES as readonly string[]).includes(value);
}

function isTerminalTask(task: Task): boolean {
  return task.status === "done" || task.status === "canceled";
}

function frontmatterOnly(task: Task) {
  const { body: _body, ...frontmatter } = task;
  void _body;
  return frontmatter;
}

function objectiveRollup(manager: AgentManager, objectiveId: string) {
  const tasks = manager.taskStore.list({ objective_id: objectiveId });
  const terminal = tasks.filter(isTerminalTask).length;
  return {
    linked_task_count: tasks.length,
    terminal_task_count: terminal,
    nonterminal_task_count: tasks.length - terminal,
  };
}

function errorResponse(c: Context, e: unknown) {
  if (e instanceof ObjectiveStoreError || e instanceof TaskStoreError) {
    return c.json(
      { error: e.code, message: e.message },
      statusErrorCode(e.code) as 400 | 404,
    );
  }
  throw e;
}

export function registerObjectiveRoutes(
  app: Hono,
  manager: AgentManager,
): void {
  app.get("/api/objectives", (c) => {
    const url = new URL(c.req.url);
    const ownerAgentId = url.searchParams.get("owner_agent_id") ?? undefined;
    const ownerSessionId =
      url.searchParams.get("owner_session_id") ?? undefined;
    const rawStatus = url.searchParams.get("status") ?? undefined;
    if (rawStatus !== undefined && !isObjectiveStatus(rawStatus)) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Math.min(Math.max(Number(rawLimit), 1), 200) : 50;
    const objectives = manager.objectiveStore.listObjectives({
      ownerAgentId,
      ownerSessionId,
      status: rawStatus,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({
      objectives: objectives.map((objective) => ({
        ...objective,
        rollup: objectiveRollup(manager, objective.id),
      })),
    });
  });

  app.post("/api/objectives", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body" }, 400);
    }
    const input = body as Record<string, unknown>;
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      return c.json({ error: "invalid_title" }, 400);
    }
    if (
      typeof input.owner_agent_id !== "string" ||
      input.owner_agent_id.trim().length === 0
    ) {
      return c.json({ error: "invalid_owner_agent_id" }, 400);
    }
    const status =
      typeof input.status === "string" && isObjectiveStatus(input.status)
        ? input.status
        : undefined;
    if (typeof input.status === "string" && status === undefined) {
      return c.json({ error: "invalid_status" }, 400);
    }
    try {
      const objective = manager.objectiveStore.createObjective({
        title: input.title,
        description:
          typeof input.description === "string" ? input.description : "",
        status,
        ownerAgentId: input.owner_agent_id,
        ownerSessionId:
          typeof input.owner_session_id === "string"
            ? input.owner_session_id
            : input.owner_session_id === null
              ? null
              : undefined,
        createdBy:
          typeof input.created_by === "string"
            ? input.created_by
            : "system:user",
        createdInSessionId:
          typeof input.created_in_session_id === "string"
            ? input.created_in_session_id
            : input.created_in_session_id === null
              ? null
              : undefined,
        closeoutPrompt:
          typeof input.closeout_prompt === "string"
            ? input.closeout_prompt
            : "",
      });
      return c.json({ objective }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/api/objectives/:id", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const objective = manager.objectiveStore.getObjective(id);
    if (!objective) return c.json({ error: "not_found" }, 404);
    const tasks = manager.taskStore.list({ objective_id: id });
    return c.json({
      objective,
      rollup: objectiveRollup(manager, id),
      tasks: tasks.map(frontmatterOnly),
    });
  });

  app.patch("/api/objectives/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body" }, 400);
    }
    const input = body as Record<string, unknown>;
    if (typeof input.status === "string" && !isObjectiveStatus(input.status)) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const status: ObjectiveStatus | undefined =
      typeof input.status === "string" && isObjectiveStatus(input.status)
        ? input.status
        : undefined;
    try {
      const objective = manager.objectiveStore.updateObjective(
        id,
        {
          title: typeof input.title === "string" ? input.title : undefined,
          description:
            typeof input.description === "string"
              ? input.description
              : undefined,
          status,
          closeoutPrompt:
            typeof input.closeout_prompt === "string"
              ? input.closeout_prompt
              : undefined,
          ownerAgentId:
            typeof input.owner_agent_id === "string"
              ? input.owner_agent_id
              : undefined,
          ...(Object.prototype.hasOwnProperty.call(input, "owner_session_id")
            ? {
                ownerSessionId:
                  typeof input.owner_session_id === "string"
                    ? input.owner_session_id
                    : null,
              }
            : {}),
        },
        "system:user",
      );
      return c.json({ objective });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get("/api/objectives/:id/events", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    if (!manager.objectiveStore.getObjective(id)) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ events: manager.objectiveStore.listObjectiveEvents(id) });
  });

  app.post("/api/objectives/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    if (!SAFE_ID.test(id) || !SAFE_ID.test(taskId)) {
      return c.json({ error: "invalid id" }, 400);
    }
    try {
      const objective = manager.objectiveStore.getObjective(id);
      if (!objective)
        throw new ObjectiveStoreError("not_found", `Objective ${id} not found`);
      const existing = manager.taskStore.get(taskId);
      if (!existing)
        throw new TaskStoreError("not_found", `Task ${taskId} not found`);
      const task = await manager.taskStore.update(
        taskId,
        { objective_id: id },
        { actor: "system:user" },
      );
      let nextObjective = objective;
      if (objective.status === "ready_for_closeout" && !isTerminalTask(task)) {
        nextObjective = manager.objectiveStore.updateObjective(
          id,
          { status: "waiting_on_tasks" },
          "system:user",
        );
        manager.objectiveStore.appendObjectiveEvent({
          objectiveId: id,
          eventType: "objective_reopened",
          actor: "system:user",
          summary: `Objective reopened after attaching task ${taskId}`,
          details: { taskId },
        });
      }
      manager.objectiveStore.appendObjectiveEvent({
        objectiveId: id,
        eventType: "task_attached",
        actor: "system:user",
        summary: `Attached task ${taskId}`,
        details: { taskId },
      });
      return c.json({ objective: nextObjective, task: frontmatterOnly(task) });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.delete("/api/objectives/:id/tasks/:taskId", async (c) => {
    const id = c.req.param("id");
    const taskId = c.req.param("taskId");
    if (!SAFE_ID.test(id) || !SAFE_ID.test(taskId)) {
      return c.json({ error: "invalid id" }, 400);
    }
    try {
      const objective = manager.objectiveStore.getObjective(id);
      if (!objective)
        throw new ObjectiveStoreError("not_found", `Objective ${id} not found`);
      if (!manager.taskStore.get(taskId)) {
        throw new TaskStoreError("not_found", `Task ${taskId} not found`);
      }
      const task = await manager.taskStore.update(
        taskId,
        { objective_id: null },
        { actor: "system:user" },
      );
      manager.objectiveStore.appendObjectiveEvent({
        objectiveId: id,
        eventType: "task_detached",
        actor: "system:user",
        summary: `Detached task ${taskId}`,
        details: { taskId },
      });
      return c.json({ objective, task: frontmatterOnly(task) });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post("/api/objectives/:id/close", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_body" }, 400);
    }
    const input = body as Record<string, unknown>;
    const status = input.status;
    if (
      typeof status !== "string" ||
      !(TERMINAL_OBJECTIVE_STATUSES as readonly string[]).includes(status)
    ) {
      return c.json({ error: "invalid_status" }, 400);
    }
    if (
      typeof input.summary !== "string" ||
      input.summary.trim().length === 0
    ) {
      return c.json({ error: "invalid_summary" }, 400);
    }
    try {
      const objective =
        status === "completed"
          ? manager.objectiveStore.completeObjective(
              id,
              input.summary,
              "system:user",
            )
          : status === "failed"
            ? manager.objectiveStore.failObjective(
                id,
                input.summary,
                "system:user",
              )
            : manager.objectiveStore.cancelObjective(
                id,
                input.summary,
                "system:user",
              );
      return c.json({ objective });
    } catch (e) {
      return errorResponse(c, e);
    }
  });
}
