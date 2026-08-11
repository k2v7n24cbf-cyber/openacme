import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { WorkflowManager } from "@openacme/workflows";
import { createApp } from "../src/app.js";
import { ServerRuntime } from "../src/runtime.js";

let dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

function tempConfig() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "openacme-runtime-"));
  dataDirs.push(dataDir);
  return ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
}

describe("ServerRuntime", () => {
  it("constructs AgentManager and WorkflowManager as siblings", async () => {
    const runtime = new ServerRuntime(tempConfig());

    expect(runtime.workflowManager).toBeInstanceOf(WorkflowManager);
    expect(runtime.agentManager.dispatcher.runningSessionIds()).toEqual([]);
    expect(runtime.workflowExecutionPorts.agent).toBe(
      runtime.workflowAgentRuntime,
    );
    expect(runtime.workflowExecutionPorts.python).toBe(
      runtime.workflowPythonRuntime,
    );

    await runtime.close();
  });

  it("createApp exposes the runtime without changing the manager alias", async () => {
    const { manager, runtime, close } = await createApp(tempConfig());

    expect(runtime).toBeInstanceOf(ServerRuntime);
    expect(runtime.agentManager).toBe(manager);
    expect(runtime.workflowManager).toBeInstanceOf(WorkflowManager);
    expect(runtime.workflowExecutionPorts.agent?.listAgents()).toEqual([]);
    expect(runtime.workflowExecutionPorts.python).toBe(
      runtime.workflowPythonRuntime,
    );

    await close();
  });

  it("starts and stops the workflow dispatcher poller", async () => {
    const runtime = new ServerRuntime(tempConfig(), {
      workflowDispatcherIntervalMs: 20,
      workflowDispatcherNow: () => new Date("2026-07-30T02:00:30.000Z"),
    });

    runtime.workflowStore.createDraft({
      id: "wf_runtime_scheduled",
      name: "Runtime Scheduled",
      triggers: [
        {
          id: "nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: { source: "runtime" },
        },
      ],
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.workflowTrigger.input.source",
        },
      ],
    });
    runtime.workflowStore.publish("wf_runtime_scheduled");

    await runtime.startWorkflowDispatcher();
    expect(runtime.isWorkflowDispatcherRunning()).toBe(true);
    await waitFor(() =>
      runtime.workflowStore
        .listRuns({ workflowId: "wf_runtime_scheduled" })
        .some(
          (run) =>
            run.status === "succeeded" &&
            run.trigger.kind === "scheduled" &&
            run.trigger.scheduledAt === "2026-07-30T02:00:00.000Z",
        ),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      runtime.workflowStore.listRuns({ workflowId: "wf_runtime_scheduled" }),
    ).toHaveLength(1);

    runtime.stopWorkflowDispatcher();
    expect(runtime.isWorkflowDispatcherRunning()).toBe(false);

    await runtime.close();
  });
});

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1_000, intervalMs = 20 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}
