import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import {
  createCommentStore,
  createDatabase,
  createEventStore,
  createObjectiveStore,
} from "@openacme/db";
import { TaskStore } from "@openacme/tasks";
import { ObjectiveCloseoutWatcher } from "../src/objective-closeout-watcher.js";

let dataDir: string;
let db: ReturnType<typeof createDatabase>;
let objectiveStore: ReturnType<typeof createObjectiveStore>;
let taskStore: TaskStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-objective-closeout-"));
  db = createDatabase(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
  );
  objectiveStore = createObjectiveStore(db);
  taskStore = new TaskStore(path.join(dataDir, "tasks"), {
    db,
    commentStore: createCommentStore(db),
    eventStore: createEventStore(db),
  });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function watcher() {
  return new ObjectiveCloseoutWatcher({ objectiveStore, taskStore });
}

describe("ObjectiveCloseoutWatcher", () => {
  it("ignores objectives with no linked tasks or nonterminal linked tasks", async () => {
    const noTasks = objectiveStore.createObjective({
      id: "objective-no-tasks",
      title: "No tasks",
      status: "waiting_on_tasks",
      ownerAgentId: "owner",
      createdBy: "owner",
    });
    const waiting = objectiveStore.createObjective({
      id: "objective-waiting",
      title: "Waiting",
      status: "waiting_on_tasks",
      ownerAgentId: "owner",
      createdBy: "owner",
    });
    await taskStore.create({
      title: "Still open",
      assignee: "owner",
      created_by: "owner",
      objective_id: waiting.id,
    });

    const result = await watcher().check();

    expect(result.ready).toHaveLength(0);
    expect(objectiveStore.getObjective(noTasks.id)?.status).toBe(
      "waiting_on_tasks",
    );
    expect(objectiveStore.getObjective(waiting.id)?.status).toBe(
      "waiting_on_tasks",
    );
  });

  it("moves all-terminal linked tasks to ready_for_closeout with a deterministic packet", async () => {
    const objective = objectiveStore.createObjective({
      id: "objective-ready",
      title: "Ship closeout",
      description: "Full objective body",
      status: "waiting_on_tasks",
      ownerAgentId: "owner",
      ownerSessionId: "owner-session",
      createdBy: "owner",
      closeoutPrompt: "Check the promised deliverable.",
    });
    const done = await taskStore.create({
      title: "Implement work",
      body: "Task spec body",
      assignee: "owner",
      created_by: "owner",
      objective_id: objective.id,
    });
    await taskStore.addComment({
      taskId: done.id,
      author: "owner",
      kind: "result",
      body: "Implemented the requested behavior.",
    });
    await taskStore.addComment({
      taskId: done.id,
      author: "system:watchdog",
      kind: "system",
      body: "System warning about a missing artifact.",
    });
    await taskStore.update(done.id, { status: "done" });

    const result = await watcher().check();

    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]!.objective.id).toBe(objective.id);
    expect(result.ready[0]!.needsOwnerWake).toBe(true);
    expect(objectiveStore.getObjective(objective.id)?.status).toBe(
      "ready_for_closeout",
    );
    expect(objectiveStore.getObjective(objective.id)?.lastCloseoutFingerprint)
      .toBe(result.ready[0]!.fingerprint);
    expect(result.ready[0]!.packet).toMatchObject({
      objective: {
        id: objective.id,
        title: "Ship closeout",
        status: "waiting_on_tasks",
        closeout_prompt: "Check the promised deliverable.",
      },
      rollup: {
        linked_task_count: 1,
        terminal_task_count: 1,
        nonterminal_task_count: 0,
      },
    });
    expect(result.ready[0]!.packet.linked_tasks[0]).toMatchObject({
      id: done.id,
      title: "Implement work",
      status: "done",
      latest_result_comment_excerpt: "Implemented the requested behavior.",
      latest_system_comment_excerpt: "System warning about a missing artifact.",
    });
    expect(
      objectiveStore
        .listObjectiveEvents(objective.id)
        .map((event) => event.eventType),
    ).toContain("linked_tasks_terminal");
  });

  it("ignores detached, deleted, and recurring-reset linked work that is not terminal", async () => {
    const objective = objectiveStore.createObjective({
      id: "objective-cleanup",
      title: "Cleanup semantics",
      status: "waiting_on_tasks",
      ownerAgentId: "owner",
      createdBy: "owner",
    });
    const detached = await taskStore.create({
      title: "Detached",
      assignee: "owner",
      created_by: "owner",
      objective_id: objective.id,
    });
    await taskStore.update(detached.id, { objective_id: null });
    const deleted = await taskStore.create({
      title: "Deleted",
      assignee: "owner",
      created_by: "owner",
      objective_id: objective.id,
    });
    await taskStore.delete(deleted.id, { actor: "owner" });
    await taskStore.create({
      title: "Recurring reset",
      assignee: "owner",
      created_by: "owner",
      objective_id: objective.id,
      recurrence: { kind: "interval", every_ms: 3_600_000 },
    });

    const result = await watcher().check();

    expect(result.ready).toHaveLength(0);
    expect(objectiveStore.getObjective(objective.id)?.status).toBe(
      "waiting_on_tasks",
    );
  });

  it("uses fingerprint and owner_wake_requested events to suppress duplicate owner wake candidates", async () => {
    const objective = objectiveStore.createObjective({
      id: "objective-fingerprint",
      title: "Fingerprint",
      status: "waiting_on_tasks",
      ownerAgentId: "owner",
      createdBy: "owner",
    });
    const task = await taskStore.create({
      title: "Done",
      assignee: "owner",
      created_by: "owner",
      objective_id: objective.id,
    });
    await taskStore.update(task.id, { status: "canceled" });

    const first = await watcher().check();
    expect(first.ready).toHaveLength(1);
    const fingerprint = first.ready[0]!.fingerprint;

    const retry = await watcher().check();
    expect(retry.ready).toHaveLength(1);
    expect(retry.ready[0]!.reason).toBe("owner_wake_retry");

    objectiveStore.appendObjectiveEvent({
      objectiveId: objective.id,
      eventType: "owner_wake_requested",
      actor: "system:test",
      summary: "Owner wake requested",
      details: { fingerprint },
    });

    const afterWake = await watcher().check();
    expect(afterWake.ready).toHaveLength(0);
  });
});
