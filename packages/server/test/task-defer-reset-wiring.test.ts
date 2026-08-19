import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { registry, toolCallContext } from "@openacme/tools";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";

let dataDir: string;
let manager: AgentManager;
let closeApp: () => Promise<void>;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-task-defer-reset-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  const created = await createApp(config);
  manager = created.manager;
  closeApp = created.close;
});

afterEach(async () => {
  await closeApp();
  rmSync(dataDir, { recursive: true, force: true });
});

async function callTaskCreate(args: Record<string, unknown>) {
  const tool = registry.get("task_create");
  if (!tool) throw new Error("task_create not registered");
  const out = await toolCallContext.run(
    { agentId: "agent-1", sessionId: "session-1" },
    () => tool.handler(args),
  );
  return JSON.parse(out) as { ok: boolean; task?: { id: string } };
}

describe("task defer reset wiring", () => {
  it("clears a real session defer and records timeline when current self-work becomes ready", async () => {
    manager.sessionStore.create("agent-1", {
      id: "session-1",
      title: "Coordination",
      kind: "chat",
    });
    const priorDeferUntil = Math.floor(Date.now() / 1000) + 3600;
    manager.sessionStore.setDeferUntil("session-1", priorDeferUntil);

    const result = await callTaskCreate({
      title: "Continue coordination",
      assignee: "agent-1",
    });

    expect(result.ok).toBe(true);
    expect(manager.sessionStore.getDeferUntil("session-1")).toBeNull();
    const timeline = manager.sessionTimelineStore.list(
      { sessionId: "session-1" },
      { limit: 10 },
    );
    expect(timeline.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "session-1",
          agentId: "agent-1",
          taskId: result.task?.id,
          eventType: "session.defer.cleared_by_self_task",
          source: "server",
          status: "completed",
          payload: expect.objectContaining({
            taskStatus: "open",
            sourceTool: "task_create",
            priorDeferUntil,
          }),
        }),
      ]),
    );
  });
});
