import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/connection.js";
import { createObjectiveStore } from "../src/stores/objective-store.js";
import { WasmDatabase } from "../src/wasm/adapter.js";

function freshDb() {
  const db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

describe("ObjectiveStore", () => {
  let nowMs: number;
  let store: ReturnType<typeof createObjectiveStore>;

  beforeEach(() => {
    nowMs = Date.parse("2026-08-11T10:00:00.000Z");
    store = createObjectiveStore(freshDb(), {
      now: () => new Date(nowMs),
    });
  });

  it("creates, gets, lists, updates, and records objective ledger events", () => {
    const objective = store.createObjective({
      id: "obj-1",
      title: "Ship objective layer",
      description: "Add durable objective grouping.",
      ownerAgentId: "agent-1",
      ownerSessionId: "session-1",
      createdBy: "agent-1",
      createdInSessionId: "session-1",
      closeoutPrompt: "Check whether the full plan is done.",
    });

    expect(objective).toMatchObject({
      id: "obj-1",
      title: "Ship objective layer",
      description: "Add durable objective grouping.",
      status: "active",
      ownerAgentId: "agent-1",
      ownerSessionId: "session-1",
      createdBy: "agent-1",
      createdInSessionId: "session-1",
      closeoutPrompt: "Check whether the full plan is done.",
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:00.000Z",
      completedAt: null,
      completionSummary: null,
    });
    expect(store.getObjective("obj-1")?.title).toBe("Ship objective layer");

    nowMs += 1_000;
    const updated = store.updateObjective(
      "obj-1",
      {
        status: "waiting_on_tasks",
        title: "Ship objective layer MVP",
      },
      "agent-1",
    );

    expect(updated).toMatchObject({
      id: "obj-1",
      title: "Ship objective layer MVP",
      status: "waiting_on_tasks",
      updatedAt: "2026-08-11T10:00:01.000Z",
    });
    expect(store.listObjectives({ ownerAgentId: "agent-1" })).toHaveLength(1);
    expect(store.listObjectives({ status: "waiting_on_tasks" })).toHaveLength(
      1,
    );
    expect(store.listObjectives({ ownerSessionId: "session-1" })).toHaveLength(
      1,
    );
    expect(store.listObjectives({ ownerAgentId: "other" })).toEqual([]);

    const event = store.appendObjectiveEvent({
      id: "event-custom",
      objectiveId: "obj-1",
      eventType: "task_attached",
      actor: "agent-1",
      summary: "Attached task-1",
      details: { taskId: "task-1" },
    });

    expect(event).toMatchObject({
      id: "event-custom",
      objectiveId: "obj-1",
      eventType: "task_attached",
      actor: "agent-1",
      summary: "Attached task-1",
      details: { taskId: "task-1" },
    });
    expect(store.listObjectiveEvents("obj-1").map((e) => e.eventType)).toEqual([
      "objective_created",
      "objective_updated",
      "task_attached",
    ]);
  });

  it("closes objectives through completed, failed, and canceled helpers", () => {
    store.createObjective({
      id: "obj-completed",
      title: "Complete me",
      ownerAgentId: "agent-1",
      createdBy: "agent-1",
    });
    store.createObjective({
      id: "obj-failed",
      title: "Fail me",
      ownerAgentId: "agent-1",
      createdBy: "agent-1",
    });
    store.createObjective({
      id: "obj-canceled",
      title: "Cancel me",
      ownerAgentId: "agent-1",
      createdBy: "agent-1",
    });

    nowMs += 5_000;

    expect(
      store.completeObjective("obj-completed", "Done as requested", "agent-1"),
    ).toMatchObject({
      status: "completed",
      completionSummary: "Done as requested",
      completedAt: "2026-08-11T10:00:05.000Z",
    });
    expect(
      store.failObjective(
        "obj-failed",
        "Could not satisfy requirements",
        "agent-1",
      ),
    ).toMatchObject({
      status: "failed",
      completionSummary: "Could not satisfy requirements",
      completedAt: "2026-08-11T10:00:05.000Z",
    });
    expect(
      store.cancelObjective("obj-canceled", "No longer needed", "agent-1"),
    ).toMatchObject({
      status: "canceled",
      completionSummary: "No longer needed",
      completedAt: "2026-08-11T10:00:05.000Z",
    });

    expect(
      store
        .listObjectiveEvents("obj-completed")
        .map((event) => event.eventType),
    ).toEqual(["objective_created", "objective_completed"]);
    expect(
      store.listObjectiveEvents("obj-failed").map((event) => event.eventType),
    ).toEqual(["objective_created", "objective_failed"]);
    expect(
      store.listObjectiveEvents("obj-canceled").map((event) => event.eventType),
    ).toEqual(["objective_created", "objective_canceled"]);
  });

  it("rejects invalid objective statuses before hitting the DB", () => {
    expect(() =>
      store.createObjective({
        id: "obj-invalid",
        title: "Invalid",
        ownerAgentId: "agent-1",
        createdBy: "agent-1",
        status: "system_blocked" as never,
      }),
    ).toThrow(/invalid objective status/i);

    store.createObjective({
      id: "obj-valid",
      title: "Valid",
      ownerAgentId: "agent-1",
      createdBy: "agent-1",
    });

    expect(() =>
      store.updateObjective(
        "obj-valid",
        { status: "system_blocked" as never },
        "agent-1",
      ),
    ).toThrow(/invalid objective status/i);
  });

  it("stores closeout brief snapshots with a ledger event", () => {
    store.createObjective({
      id: "obj-brief",
      title: "Brief me",
      ownerAgentId: "agent-1",
      createdBy: "agent-1",
    });

    nowMs += 2_000;

    const updated = store.recordCloseoutBrief(
      "obj-brief",
      {
        fingerprint: "fp-1",
        packet: { linkedTaskIds: ["task-1"] },
        brief: { suggested_owner_action: "close_completed" },
      },
      "system:objective-closeout",
    );

    expect(updated).toMatchObject({
      id: "obj-brief",
      lastCloseoutFingerprint: "fp-1",
      lastCloseoutBriefAt: "2026-08-11T10:00:02.000Z",
    });
    expect(JSON.parse(updated.lastCloseoutBriefJson ?? "{}")).toMatchObject({
      packet: { linkedTaskIds: ["task-1"] },
      brief: { suggested_owner_action: "close_completed" },
    });
    expect(
      store.listObjectiveEvents("obj-brief").map((e) => e.eventType),
    ).toEqual(["objective_created", "closeout_brief_generated"]);
  });

  it("stores failed closeout snapshots without a generated ledger event", () => {
    store.createObjective({
      id: "obj-failed-brief",
      title: "Brief failed",
      ownerAgentId: "agent-1",
      createdBy: "agent-1",
    });

    store.recordCloseoutBrief(
      "obj-failed-brief",
      {
        fingerprint: "fp-1",
        packet: { linkedTaskIds: ["task-1"] },
        brief: null,
        summaryStatus: "failed",
        failureReasons: ["summarizer_unavailable"],
      },
      "system:objective-closeout",
    );

    expect(
      store.listObjectiveEvents("obj-failed-brief").map((e) => e.eventType),
    ).toEqual(["objective_created"]);
  });

  it("deletes objectives owned by an agent and cascades their ledger events", () => {
    store.createObjective({
      id: "delete-me",
      title: "Delete me",
      ownerAgentId: "agent-delete",
      createdBy: "agent-delete",
    });
    store.createObjective({
      id: "keep-me",
      title: "Keep me",
      ownerAgentId: "agent-keep",
      createdBy: "agent-keep",
    });
    store.appendObjectiveEvent({
      id: "delete-event",
      objectiveId: "delete-me",
      eventType: "objective_updated",
      actor: "agent-delete",
      summary: "Will be removed",
    });

    const result = store.deleteObjectivesForOwner(
      "agent-delete",
      "system:agent-delete",
    );

    expect(result).toEqual({ deletedIds: ["delete-me"], deletedCount: 1 });
    expect(store.getObjective("delete-me")).toBeNull();
    expect(store.getObjective("keep-me")?.id).toBe("keep-me");
    expect(store.listObjectiveEvents("delete-me")).toEqual([]);
  });
});
