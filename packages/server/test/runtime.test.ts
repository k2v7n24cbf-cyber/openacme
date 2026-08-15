import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { WorkflowManager } from "@openacme/workflows";
import type { HostedIntegrationService } from "@openacme/hosted-integrations";
import { createDatabase } from "@openacme/db";
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
    expect(await runtime.hostedIntegrationService.listFamilies()).toEqual([]);

    await runtime.close();
  });

  it("uses file-backed hosted integrations for local trusted auto mode", async () => {
    const config = tempConfig();
    const runtime = new ServerRuntime(config);
    expect(runtime.hostedIntegrationPersistenceBackend).toBe("file");

    await runtime.hostedIntegrationService.sourceFiles.replaceSourceFiles({
      familyId: "qualys",
      sourceRevisionId: "source_rev_1",
      updatedBy: "agent:tool-developer",
      files: {
        "family.yaml": "id: qualys\nname: Qualys\nversion: 1\ntools: []\n",
      },
    });

    const db = createDatabase(config);
    try {
      expect(
        db
          .prepare("SELECT id FROM hosted_integration_source_revisions WHERE id = ?")
          .get("source_rev_1"),
      ).toBeUndefined();
    } finally {
      db.close();
      await runtime.close();
    }
  });

  it("uses DB-backed hosted integrations for authenticated auto mode", async () => {
    const config = ConfigSchema.parse({
      ...tempConfig(),
      server: { host: "0.0.0.0", requireAuth: true },
    });
    const runtime = new ServerRuntime(config);
    expect(runtime.hostedIntegrationPersistenceBackend).toBe("db");

    await runtime.hostedIntegrationService.sourceFiles.replaceSourceFiles({
      familyId: "qualys",
      sourceRevisionId: "source_rev_1",
      updatedBy: "agent:tool-developer",
      files: {
        "family.yaml": "id: qualys\nname: Qualys\nversion: 1\ntools: []\n",
      },
    });

    const db = createDatabase(config);
    try {
      expect(
        db
          .prepare("SELECT id FROM hosted_integration_source_revisions WHERE id = ?")
          .get("source_rev_1"),
      ).toMatchObject({ id: "source_rev_1" });
    } finally {
      db.close();
      await runtime.close();
    }
  });

  it("refuses file-backed hosted integrations in authenticated mode", async () => {
    const config = ConfigSchema.parse({
      ...tempConfig(),
      server: { host: "0.0.0.0", requireAuth: true },
      hostedIntegrations: { persistenceBackend: "file" },
    });
    (
      config as typeof config & {
        hostedIntegrations: { persistenceBackend: "file" };
      }
    ).hostedIntegrations = { persistenceBackend: "file" };

    expect(() => new ServerRuntime(config)).toThrow(
      /file-backed persistence is only allowed for local trusted/,
    );
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

  it("closes the hosted integrations service through app shutdown", async () => {
    const hostedIntegrationService: HostedIntegrationService = {
      listFamilies: async () => [
        {
          id: "runtime_fake",
          name: "Runtime Fake",
          status: "active",
          version: 1,
          toolNames: ["runtime_fake_echo"],
        },
      ],
      getFamily: async () => null,
      getDiagnostics: async () => [],
      generations: {
        listGenerations: vi.fn(async () => []),
      },
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as HostedIntegrationService;

    const { app, manager, close } = await createApp(tempConfig(), {
      hostedIntegrationService,
    });
    const member = manager.authStore.createMember({
      email: "test@example.com",
      password: "test-password-123",
    });
    const authToken = manager.authStore.createSession(member.id).token;
    const res = await app.request(
      "http://127.0.0.1/api/hosted-integrations/families",
      {
        headers: { host: "127.0.0.1", authorization: `Bearer ${authToken}` },
      },
    );

    expect(res.status).toBe(200);
    expect(hostedIntegrationService.start).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({
      families: [
        {
          id: "runtime_fake",
          name: "Runtime Fake",
          status: "active",
          version: 1,
          toolNames: ["runtime_fake_echo"],
        },
      ],
    });

    await close();
    expect(hostedIntegrationService.close).toHaveBeenCalledOnce();
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
