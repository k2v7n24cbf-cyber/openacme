import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";

const ai = vi.hoisted(() => ({
  streamObject: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamObject: ai.streamObject,
  };
});

let dataDir: string;
let manager: AgentManager;
let closeApp: () => Promise<void>;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-closeout-wiring-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "openai", model: "gpt-5.5", auth: "oauth" },
  });
  const created = await createApp(config, {
    resolveModel: () => ({ provider: "mock-model" }) as never,
  });
  manager = created.manager;
  closeApp = created.close;
  ai.streamObject.mockReset();
});

afterEach(async () => {
  await closeApp();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("objective closeout production wiring", () => {
  it("uses the configured summarizer to store a closeout brief snapshot", async () => {
    ai.streamObject.mockReturnValue({
      fullStream: (async function* () {
        yield {};
      })(),
      object: Promise.resolve({
        objective_completion_assessment: "needs_follow_up",
        suggested_owner_action: "add_followup_task",
        confidence: "high",
        task_outcomes: [
          {
            task_id: "1",
            status: "done",
            claimed_result: "Only the happy path was checked.",
            verification_note: "Rollback evidence is missing.",
            concerns: ["rollback not validated"],
          },
        ],
        warnings: ["rollback not validated"],
        notices: [],
        recommended_follow_up: ["validate rollback"],
        rationale: "The terminal task does not satisfy the closeout prompt.",
      }),
    });

    const session = manager.sessionStore.create("owner");
    const objective = manager.objectiveStore.createObjective({
      title: "Ship release",
      description: "Release only after rollback validation exists.",
      status: "waiting_on_tasks",
      ownerAgentId: "owner",
      ownerSessionId: session.id,
      createdBy: "owner",
      createdInSessionId: session.id,
      closeoutPrompt: "Do not close if rollback evidence is missing.",
    });
    const task = await manager.taskStore.create({
      title: "Validate rollback",
      assignee: "owner",
      created_by: "owner",
      session_id: session.id,
      objective_id: objective.id,
    });
    await manager.taskStore.addComment({
      taskId: task.id,
      author: "owner",
      kind: "result",
      body: "Only the happy path was checked; rollback was not validated.",
    });
    await manager.taskStore.update(task.id, { status: "done" });

    manager.objectiveCloseoutService.start();
    manager.objectiveCloseoutService.kick("test");
    await manager.objectiveCloseoutService.drain(10_000);

    const refreshed = manager.objectiveStore.getObjective(objective.id);
    expect(refreshed?.status).toBe("ready_for_closeout");
    expect(refreshed?.lastCloseoutBriefJson).toBeTruthy();
    const snapshot = JSON.parse(refreshed!.lastCloseoutBriefJson!);
    expect(snapshot.brief).toMatchObject({
      suggested_owner_action: "add_followup_task",
      confidence: "high",
    });
    expect(ai.streamObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 600 }),
    );
  });
});
