import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema, createObjectiveStore, WasmDatabase } from "@openacme/db";
import { TaskStore } from "@openacme/tasks";
import { registry } from "../src/registry.js";
import { bindObjectiveStore } from "../src/builtins/objectives.js";
import { toolCallContext } from "../src/session-context.js";

let dir: string;
let db: WasmDatabase;
let taskStore: TaskStore;
let objectiveStore: ReturnType<typeof createObjectiveStore>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-tools-objectives-"));
  db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  taskStore = new TaskStore(dir);
  objectiveStore = createObjectiveStore(db);
  bindObjectiveStore({ objectiveStore, taskStore });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown>,
  ctx: { agentId?: string; sessionId?: string } = {},
): Promise<{ ok: boolean; [k: string]: unknown }> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const exec = () => tool.handler(args);
  const out = ctx.agentId
    ? await toolCallContext.run(
        { agentId: ctx.agentId, sessionId: ctx.sessionId ?? "" },
        exec,
      )
    : await exec();
  return JSON.parse(out);
}

describe("objective tools", () => {
  it("creates objectives with current agent/session ownership defaults", async () => {
    const result = await call(
      "objective_create",
      {
        title: "Ship objective layer",
        description: "Group tasks and wake owner for closeout.",
        closeout_prompt: "Check whether the requested outcome is done.",
      },
      { agentId: "agent-1", sessionId: "session-1" },
    );

    expect(result.ok).toBe(true);
    const objective = result.objective as {
      id: string;
      ownerAgentId: string;
      ownerSessionId: string;
      createdBy: string;
      createdInSessionId: string;
      status: string;
    };
    expect(objective).toMatchObject({
      ownerAgentId: "agent-1",
      ownerSessionId: "session-1",
      createdBy: "agent-1",
      createdInSessionId: "session-1",
      status: "active",
    });
    expect(objectiveStore.listObjectiveEvents(objective.id)).toHaveLength(1);
  });

  it("normalizes blank model-supplied owner fields to current context", async () => {
    const result = await call(
      "objective_create",
      {
        title: "Blank owner from model",
        owner_agent_id: "",
        owner_session_id: null,
      },
      { agentId: "agent-1", sessionId: "session-1" },
    );

    expect(result.ok).toBe(true);
    expect(result.objective).toMatchObject({
      ownerAgentId: "agent-1",
      ownerSessionId: "session-1",
      createdBy: "agent-1",
      createdInSessionId: "session-1",
    });
  });

  it("requires active agent context for mutating objective tools", async () => {
    const result = await call("objective_create", {
      title: "No context",
    });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/active agent context/i);
  });

  it("views, lists, updates, appends events, and closes by owner", async () => {
    const created = await call(
      "objective_create",
      { title: "Close me" },
      { agentId: "owner", sessionId: "owner-session" },
    );
    const id = (created.objective as { id: string }).id;

    const listed = await call(
      "objective_list",
      { owner_agent_id: "owner" },
      { agentId: "reader" },
    );
    expect(listed.ok).toBe(true);
    expect(
      (listed.objectives as Array<{ id: string }>).map((o) => o.id),
    ).toEqual([id]);

    const updated = await call(
      "objective_update",
      {
        id,
        status: "waiting_on_tasks",
        title: "Close me later",
      },
      { agentId: "owner" },
    );
    expect(updated.ok).toBe(true);
    expect((updated.objective as { status: string }).status).toBe(
      "waiting_on_tasks",
    );

    const event = await call(
      "objective_event",
      {
        id,
        event_type: "task_attached",
        summary: "Attached task 1",
        details: { task_id: "1" },
      },
      { agentId: "owner" },
    );
    expect(event.ok).toBe(true);

    const denied = await call(
      "objective_close",
      { id, status: "completed", summary: "Done" },
      { agentId: "other" },
    );
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toMatch(/only the objective owner/i);

    const closed = await call(
      "objective_close",
      { id, status: "completed", summary: "Done" },
      { agentId: "owner" },
    );
    expect(closed.ok).toBe(true);
    expect((closed.objective as { status: string }).status).toBe("completed");

    const viewed = await call("objective_view", { id }, { agentId: "reader" });
    expect(viewed.ok).toBe(true);
    expect(
      (viewed.events as Array<{ eventType: string }>).map((e) => e.eventType),
    ).toEqual([
      "objective_created",
      "objective_updated",
      "task_attached",
      "objective_completed",
    ]);
  });

  it("attaches and detaches tasks, reopening ready objectives for nonterminal work", async () => {
    const objective = objectiveStore.createObjective({
      id: "objective-1",
      title: "Ready objective",
      status: "ready_for_closeout",
      ownerAgentId: "owner",
      createdBy: "owner",
    });
    const task = await taskStore.create({
      title: "Follow up",
      assignee: "owner",
      created_by: "owner",
    });

    const attached = await call(
      "objective_attach_task",
      { id: objective.id, task_id: task.id },
      { agentId: "owner" },
    );
    expect(attached.ok).toBe(true);
    expect(taskStore.get(task.id)?.objective_id).toBe(objective.id);
    expect(objectiveStore.getObjective(objective.id)?.status).toBe(
      "waiting_on_tasks",
    );
    expect(
      objectiveStore.listObjectiveEvents(objective.id).map((e) => e.eventType),
    ).toEqual([
      "objective_created",
      "objective_updated",
      "objective_reopened",
      "task_attached",
    ]);

    const detached = await call(
      "objective_detach_task",
      { id: objective.id, task_id: task.id },
      { agentId: "owner" },
    );
    expect(detached.ok).toBe(true);
    expect(taskStore.get(task.id)?.objective_id).toBeNull();
    expect(
      objectiveStore.listObjectiveEvents(objective.id).map((e) => e.eventType),
    ).toEqual([
      "objective_created",
      "objective_updated",
      "objective_reopened",
      "task_attached",
      "task_detached",
    ]);
  });
});
