import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
    toolRegistry.register({
      name: "mcp_integration-hub__qualys_count_assets",
      toolset: "mcp-integration-hub",
      description: "Legacy integration-hub Qualys MCP tool.",
      parameters: z.object({}),
      handler: async () => "{}",
    });

    let res: Response;
    try {
      res = await app.request("http://127.0.0.1/api/tools", {
        headers: { host: "127.0.0.1", authorization: `Bearer ${authToken}` },
      });
    } finally {
      toolRegistry.deregister("mcp_integration-hub__qualys_count_assets");
    }

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
    expect(
      body.tools.some(
        (tool) => tool.name === "mcp_integration-hub__qualys_count_assets",
      ),
    ).toBe(false);
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

  it("keeps hosted integration repair routing out of caller-facing tool failures", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(
      dataDir,
      [
        "def call_tool(name, args, ctx):",
        "    raise ValueError('agent-visible failure should stay generic')",
        "",
      ].join("\n"),
    );
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

    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: { code: "tool_failed", message: "tool failed" },
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: "gen_1",
    });
    expect(output).not.toContain("bucket");
    expect(output).not.toContain("repair");
    expect(output).not.toContain("task");
  });

  it("binds hosted integration management tools to the server control-plane port", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { manager, close } = await createApp(config);
    closeApp = close;
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "tool-developer",
        name: "Tool Developer",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Manage hosted integrations.",
        tools: ["hosted_integration_family_list"],
      }),
    );
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "analyst",
        name: "Analyst",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Analyze data.",
        tools: [],
      }),
    );

    const tools = toolRegistry.getVercelTools(
      new Set(["hosted_integration_family_list"]),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;
    const allowedOutput = await toolCallContext.run(
      {
        agentId: "tool-developer",
        sessionId: "session_1",
        workspaceDir: path.join(
          dataDir,
          "agents",
          "tool-developer",
          "workspace",
        ),
      },
      () => tools.hosted_integration_family_list!.execute({}),
    );
    expect(JSON.parse(allowedOutput)).toMatchObject({
      ok: true,
      families: [
        {
          id: "qualys",
          name: "Qualys",
          toolNames: ["qualys_count_assets"],
        },
      ],
    });

    const deniedOutput = await toolCallContext.run(
      {
        agentId: "analyst",
        sessionId: "session_2",
        workspaceDir: path.join(dataDir, "agents", "analyst", "workspace"),
      },
      () => tools.hosted_integration_family_list!.execute({}),
    );
    expect(JSON.parse(deniedOutput)).toMatchObject({
      ok: false,
      error: {
        code: "policy_denied",
        message: "agent cannot manage hosted integrations",
      },
    });
  });

  it("runs examples and promotes drafts through hosted integration management tools", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { manager, close } = await createApp(config);
    closeApp = close;
    const managementToolNames = [
      "hosted_integration_lock_acquire",
      "hosted_integration_draft_create",
      "hosted_integration_draft_patch",
      "hosted_integration_example_upsert",
      "hosted_integration_example_run",
      "hosted_integration_promote",
    ];
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "tool-developer",
        name: "Tool Developer",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Manage hosted integrations.",
        tools: managementToolNames,
      }),
    );

    const tools = toolRegistry.getVercelTools(
      new Set(managementToolNames),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        await toolCallContext.run(
          {
            agentId: "tool-developer",
            sessionId: `session_${name}`,
            workspaceDir: path.join(
              dataDir!,
              "agents",
              "tool-developer",
              "workspace",
            ),
          },
          () => tools[name]!.execute(args),
        ),
      );

    const lock = await call("hosted_integration_lock_acquire", {
      family_id: "qualys",
      ttl_ms: 60_000,
    });
    expect(lock).toMatchObject({ ok: true, lock: { familyId: "qualys" } });

    const draft = await call("hosted_integration_draft_create", {
      family_id: "qualys",
      lock_id: lock.lock.id,
      source_revision_id: "source_rev_1",
    });
    expect(draft).toMatchObject({ ok: true, draft: { familyId: "qualys" } });

    await expect(
      call("hosted_integration_draft_patch", {
        draft_id: draft.draft.id,
        lock_id: lock.lock.id,
        path: "qualys.py",
        content: [
          "def call_tool(name, args, ctx):",
          "    return {'count': 7, 'mode': 'draft-example'}",
          "",
        ].join("\n"),
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      call("hosted_integration_example_upsert", {
        draft_id: draft.draft.id,
        lock_id: lock.lock.id,
        example: {
          id: "smoke_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "smoke",
          args: {},
          expected: {},
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    const run = await call("hosted_integration_example_run", {
      draft_id: draft.draft.id,
      example_id: "smoke_count",
    });
    expect(run).toMatchObject({
      ok: true,
      envelope: { ok: true, result: { count: 7, mode: "draft-example" } },
    });

    const promoted = await call("hosted_integration_promote", {
      draft_id: draft.draft.id,
      lock_id: lock.lock.id,
    });
    expect(promoted).toMatchObject({
      ok: true,
      generation: {
        familyId: "qualys",
        status: "active",
      },
    });

    expect(
      toolRegistry.getInfo().find((tool) => tool.name === "qualys_count_assets")
        ?.source,
    ).toMatchObject({
      kind: "hosted_integration",
      familyId: "qualys",
      generationId: promoted.generation.id,
    });
  });

  it("exposes failure bucket repair lifecycle through management tools", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { manager, runtime, close } = await createApp(config);
    closeApp = close;
    const seeded =
      await runtime.hostedIntegrationService.failureBuckets.recordFailure({
        log: {
          runId: "run_failed_1",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_1",
          actorId: "agent:analyst",
          configScopeId: "qualys-prod",
          configRevision: 1,
          sanitizedArgs: {},
          status: "failed",
          startedAt: "2026-08-12T10:00:00.000Z",
          endedAt: "2026-08-12T10:00:01.000Z",
          durationMs: 1000,
          error: { code: "tool_bug", message: "ValueError: boom" },
        },
      });
    if (!seeded.ok) throw new Error("failed to seed bucket");

    const lock = await runtime.hostedIntegrationService.locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    if (!lock.ok) throw new Error("failed to lock family");
    const draft = await runtime.hostedIntegrationService.drafts.createDraft({
      familyId: "qualys",
      lockId: lock.lock.id,
      sourceRevisionId: "source_rev_1",
    });
    if (!draft.ok) throw new Error("failed to create draft");
    const patched =
      await runtime.hostedIntegrationService.drafts.writeDraftFile({
        draftId: draft.draft.id,
        lockId: lock.lock.id,
        path: "qualys.py",
        content: [
          "def call_tool(name, args, ctx):",
          "    return {'fixed': True}",
          "",
        ].join("\n"),
      });
    if (!patched.ok) throw new Error("failed to patch draft");
    await runtime.hostedIntegrationService.examples.upsertExample({
      draftId: draft.draft.id,
      lockId: lock.lock.id,
      example: {
        id: "regression_1",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        category: "regression",
        args: {},
        expected: {},
      },
    });
    const promoted =
      await runtime.hostedIntegrationService.generations.promoteDraft({
        draftId: draft.draft.id,
        promotedBy: "agent:tool-developer",
        validation: { ok: true, diagnostics: [] },
      });
    if (!promoted.ok) throw new Error("failed to promote fix generation");

    const managementToolNames = [
      "hosted_integration_failure_bucket_list",
      "hosted_integration_failure_bucket_get",
      "hosted_integration_failure_bucket_assign",
      "hosted_integration_failure_bucket_close",
    ];
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "tool-developer",
        name: "Tool Developer",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Repair hosted integrations.",
        tools: managementToolNames,
      }),
    );
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "analyst",
        name: "Analyst",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Analyze data.",
        tools: [],
      }),
    );

    const tools = toolRegistry.getVercelTools(
      new Set(managementToolNames),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;
    const call = async (
      name: string,
      args: Record<string, unknown>,
      agentId = "tool-developer",
    ) =>
      JSON.parse(
        await toolCallContext.run(
          {
            agentId,
            sessionId: `session_${name}_${agentId}`,
            workspaceDir: path.join(dataDir!, "agents", agentId, "workspace"),
          },
          () => tools[name]!.execute(args),
        ),
      );

    await expect(
      call("hosted_integration_failure_bucket_list", {}, "analyst"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });

    const listed = await call("hosted_integration_failure_bucket_list", {
      family_id: "qualys",
    });
    expect(listed).toMatchObject({
      ok: true,
      buckets: [{ id: seeded.bucket.id, count: 1, status: "open" }],
    });

    await expect(
      call("hosted_integration_failure_bucket_get", {
        bucket_id: seeded.bucket.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      bucket: { id: seeded.bucket.id, familyId: "qualys" },
    });

    await expect(
      call("hosted_integration_failure_bucket_assign", {
        bucket_id: seeded.bucket.id,
        assigned_to: "tool-developer",
      }),
    ).resolves.toMatchObject({
      ok: true,
      bucket: { id: seeded.bucket.id, assignedTo: "tool-developer" },
    });

    await expect(
      call("hosted_integration_failure_bucket_close", {
        bucket_id: seeded.bucket.id,
        draft_id: draft.draft.id,
        generation_id: promoted.generation.id,
        regression_example_id: "missing_regression",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "regression_example_not_found" },
    });

    await expect(
      call("hosted_integration_failure_bucket_close", {
        bucket_id: seeded.bucket.id,
        draft_id: draft.draft.id,
        generation_id: promoted.generation.id,
        regression_example_id: "regression_1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      bucket: { id: seeded.bucket.id, status: "closed" },
    });
  });
});

function writeFamily(root: string, source?: string): void {
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
    source ??
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
