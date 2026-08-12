import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDefinitionSchema, ConfigSchema } from "@openacme/config";
import {
  createFileHostedIntegrationConfigScopeStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
} from "@openacme/hosted-integrations";
import { registry as toolRegistry, toolCallContext } from "@openacme/tools";
import { createApp } from "../src/app.js";

let dataDir: string | null = null;
let closeApp: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeApp?.();
  closeApp = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe("/api/tools hosted integration surfacing", () => {
  it("syncs active hosted integration generations at startup", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir);
    const locks = createFileHostedIntegrationLockStore({
      dataDir,
      createId: () => "lock_1",
    });
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    const drafts = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore: locks,
      createId: () => "draft_1",
    });
    const draft = await drafts.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });
    expect(draft.ok).toBe(true);
    const promoted = await createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore: drafts,
      createId: () => "gen_1",
    }).promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    expect(promoted.ok).toBe(true);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { app, manager, close } = await createApp(config);
    closeApp = close;
    const member = manager.authStore.createMember({
      email: "test@example.com",
      password: "test-password-123",
    });
    const authToken = manager.authStore.createSession(member.id).token;

    const res = await app.request("http://127.0.0.1/api/tools", {
      headers: { host: "127.0.0.1", authorization: `Bearer ${authToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      toolsets: string[];
      tools: Array<{ name: string }>;
    };
    expect(body.toolsets).toContain("hosted-integrations");
    expect(
      body.tools.find((tool) => tool.name === "qualys_count_assets"),
    ).toMatchObject({
      name: "qualys_count_assets",
      toolset: "hosted-integrations",
      source: {
        kind: "hosted_integration",
        familyId: "qualys",
        familyName: "Qualys",
        generationId: "gen_1",
      },
    });
  });

  it("invokes selected hosted integration tools through the gateway using the agent default config scope", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir);
    const locks = createFileHostedIntegrationLockStore({
      dataDir,
      createId: () => "lock_1",
    });
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    const drafts = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore: locks,
      createId: () => "draft_1",
    });
    const draft = await drafts.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });
    expect(draft.ok).toBe(true);
    const promoted = await createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore: drafts,
      createId: () => "gen_1",
    }).promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    expect(promoted.ok).toBe(true);
    await seedConfigScope(dataDir);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { manager, close } = await createApp(config);
    closeApp = close;
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "analyst",
        name: "Analyst",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Use hosted integrations.",
        tools: ["qualys_count_assets"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedConfigScopeIds: ["qualys-prod"],
            defaultConfigScopeId: "qualys-prod",
            environment: "prod",
          },
        ],
      }),
    );

    const tools = toolRegistry.getVercelTools(
      new Set(["qualys_count_assets"]),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;
    const output = await toolCallContext.run(
      {
        agentId: "analyst",
        sessionId: "session_1",
        workspaceDir: path.join(dataDir, "agents", "analyst", "workspace"),
      },
      () => tools.qualys_count_assets!.execute({}),
    );

    const parsed = JSON.parse(output);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      replayed: false,
      generationId: "gen_1",
      envelope: {
        ok: true,
        result: {
          count: 1,
          endpoint: "https://qualys.example.test",
          ready: true,
        },
      },
    });

    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "blocked",
        name: "Blocked",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Do not use hosted integrations.",
        tools: [],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedConfigScopeIds: ["qualys-prod"],
            defaultConfigScopeId: "qualys-prod",
            environment: "prod",
          },
        ],
      }),
    );
    const deniedOutput = await toolCallContext.run(
      {
        agentId: "blocked",
        sessionId: "session_2",
        workspaceDir: path.join(dataDir, "agents", "blocked", "workspace"),
      },
      () => tools.qualys_count_assets!.execute({}),
    );
    expect(JSON.parse(deniedOutput)).toMatchObject({
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted integration tool is not enabled for agent",
      },
    });
  });
});

function writeFamily(root: string): void {
  const dir = path.join(
    root,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "family.yaml"), familyYaml());
  writeFileSync(
    path.join(dir, "qualys.py"),
    [
      "def call_tool(name, args, ctx):",
      "    return {",
      "        'count': 1,",
      "        'endpoint': ctx['config']['endpoint'],",
      "        'ready': ctx['secrets']['apiToken'] == 'raw-token-123',",
      "    }",
      "",
    ].join("\n"),
  );
}

async function seedConfigScope(root: string): Promise<void> {
  await createFileHostedIntegrationConfigScopeStore({
    dataDir: root,
  }).upsertConfigScope({
    scopeId: "qualys-prod",
    familyId: "qualys",
    environment: "prod",
    config: { endpoint: "https://qualys.example.test" },
    secrets: { apiToken: { configured: true } },
    updatedBy: "human:alen",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir: root,
  }).writeHumanOwnedSecrets({
    scopeId: "qualys-prod",
    secrets: { apiToken: "raw-token-123" },
    updatedBy: "human:alen",
  });
}

function familyYaml(): string {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count Qualys assets.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}
