import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentDefinitionSchema, ConfigSchema } from "@openacme/config";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationEnvironmentConfigStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
} from "@openacme/hosted-integrations";
import {
  LEGACY_INTEGRATION_HUB_FIVE_READONLY_TOOL_SYNC_FAMILY,
  type LegacyIntegrationHubReplacementFamilyFixture,
} from "../../hosted-integrations/test-support/integration-hub/fixtures.js";
import { registry as toolRegistry, toolCallContext } from "@openacme/tools";
import { createApp } from "../src/app.js";

let dataDir: string | null = null;
let closeApp: (() => Promise<void>) | null = null;
const MANAGED_QUALYS_COUNT_ASSETS = "managed_qualys__qualys_count_assets";

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
      body.tools.find((tool) => tool.name === MANAGED_QUALYS_COUNT_ASSETS),
    ).toMatchObject({
      name: MANAGED_QUALYS_COUNT_ASSETS,
      toolset: "hosted-integrations",
      source: {
        kind: "hosted_integration",
        familyId: "qualys",
        familyName: "Qualys",
        toolName: "qualys_count_assets",
        generationId: "gen_1",
      },
    });
    expect(
      body.tools.some(
        (tool) => tool.name === "mcp_integration-hub__qualys_count_assets",
      ),
    ).toBe(true);
  });

  it("syncs a five-tool integration-hub read-only pilot without hiding remote MCP tools", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    const fixture = LEGACY_INTEGRATION_HUB_FIVE_READONLY_TOOL_SYNC_FAMILY;
    writeFixtureFamily(dataDir, fixture);
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
    const draft = await drafts.createDraftFromFiles({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_5_tool_sync",
      files: fixture.sourceFiles,
    });
    expect(draft.ok).toBe(true);
    const promoted = await createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore: drafts,
      createId: () => "gen_5_tool_sync",
    }).promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    expect(promoted.ok).toBe(true);
    await seedEnvironmentConfig(dataDir);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { app, manager, close } = await createApp(config);
    closeApp = close;
    const member = manager.authStore.createMember({
      email: "pilot@example.com",
      password: "test-password-123",
    });
    const authToken = manager.authStore.createSession(member.id).token;
    for (const name of fixture.legacyMcpToolNames) {
      toolRegistry.register({
        name,
        toolset: "mcp-integration-hub",
        description: `Legacy integration-hub ${name}`,
        parameters: z.object({}),
        handler: async () => "{}",
      });
    }

    try {
      const res = await app.request("http://127.0.0.1/api/tools", {
        headers: { host: "127.0.0.1", authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tools: Array<{
          name: string;
          toolset: string;
          source?: { kind: string; familyId?: string; toolName?: string };
        }>;
      };

      for (const [
        index,
        nativeToolName,
      ] of fixture.replacementToolNames.entries()) {
        const managedToolName = fixture.managedToolNames[index]!;
        const legacyMcpToolName = fixture.legacyMcpToolNames[index]!;
        expect(
          body.tools.find((tool) => tool.name === managedToolName),
        ).toMatchObject({
          name: managedToolName,
          toolset: "hosted-integrations",
          source: {
            kind: "hosted_integration",
            familyId: "qualys",
            toolName: nativeToolName,
          },
        });
        expect(
          body.tools.find((tool) => tool.name === legacyMcpToolName),
        ).toMatchObject({
          name: legacyMcpToolName,
          toolset: "mcp-integration-hub",
        });
      }

      await manager.createAgent(
        AgentDefinitionSchema.parse({
          id: "pilot-analyst",
          name: "Pilot Analyst",
          role: "",
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          persona: "Use managed hosted integration pilot tools.",
          tools: fixture.managedToolNames,
          hostedIntegrationBindings: fixture.replacementToolNames.map(
            (toolName) => hostedToolBinding(toolName),
          ),
        }),
      );
      await manager.createAgent(
        AgentDefinitionSchema.parse({
          id: "pilot-mcp-only",
          name: "Pilot MCP Only",
          role: "",
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          persona: "Only has legacy MCP integration-hub tools.",
          tools: fixture.legacyMcpToolNames,
          hostedIntegrationBindings: fixture.replacementToolNames.map(
            (toolName) => hostedToolBinding(toolName),
          ),
        }),
      );

      const tools = toolRegistry.getVercelTools(
        new Set(fixture.managedToolNames),
      ) as Record<
        string,
        { execute: (args: Record<string, unknown>) => Promise<string> }
      >;
      for (const [
        index,
        managedToolName,
      ] of fixture.managedToolNames.entries()) {
        const output = await toolCallContext.run(
          {
            agentId: "pilot-analyst",
            sessionId: `session_pilot_${index}`,
            workspaceDir: path.join(
              dataDir,
              "agents",
              "pilot-analyst",
              "workspace",
            ),
          },
          () => tools[managedToolName]!.execute({ pilot: true }),
        );
        const parsed = JSON.parse(output);
        expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
        expect(parsed).toMatchObject({
          ok: true,
          generationId: "gen_5_tool_sync",
          envelope: {
            ok: true,
            result: {
              replacement: true,
              tool: fixture.replacementToolNames[index],
              args: { pilot: true },
              auth_configured: true,
            },
          },
        });
      }

      const deniedOutput = await toolCallContext.run(
        {
          agentId: "pilot-mcp-only",
          sessionId: "session_pilot_denied",
          workspaceDir: path.join(
            dataDir,
            "agents",
            "pilot-mcp-only",
            "workspace",
          ),
        },
        () => tools[fixture.managedToolNames[0]!]!.execute({}),
      );
      expect(JSON.parse(deniedOutput)).toMatchObject({
        ok: false,
        error: { code: "policy_denied" },
      });
    } finally {
      for (const name of fixture.legacyMcpToolNames) {
        toolRegistry.deregister(name);
      }
    }
  });

  it("invokes selected hosted integration tools through the gateway using the agent default environment config", async () => {
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
    await seedEnvironmentConfig(dataDir);

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
        tools: ["managed_tool_help", MANAGED_QUALYS_COUNT_ASSETS],
        hostedIntegrationBindings: [
          hostedToolBinding("qualys_count_assets"),
        ],
      }),
    );

    const tools = toolRegistry.getVercelTools(
      new Set(["managed_tool_help", MANAGED_QUALYS_COUNT_ASSETS]),
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
      () => tools[MANAGED_QUALYS_COUNT_ASSETS]!.execute({}),
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
    const helpOutput = await toolCallContext.run(
      {
        agentId: "analyst",
        sessionId: "session_1_help",
        workspaceDir: path.join(dataDir, "agents", "analyst", "workspace"),
      },
      () =>
        tools.managed_tool_help!.execute({
          tool_name: MANAGED_QUALYS_COUNT_ASSETS,
          tool_detail: "summary",
          include_examples: false,
        }),
    );
    expect(JSON.parse(helpOutput)).toMatchObject({
      ok: true,
      help: {
        tool_name: MANAGED_QUALYS_COUNT_ASSETS,
        tool_help: {
          summary: "Count Qualys assets.",
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
          hostedToolBinding("qualys_count_assets"),
        ],
      }),
    );
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "mcp-only",
        name: "MCP Only",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Only has the legacy MCP surface.",
        tools: ["mcp_integration-hub__qualys_count_assets"],
        hostedIntegrationBindings: [
          hostedToolBinding("qualys_count_assets"),
        ],
      }),
    );
    const deniedOutput = await toolCallContext.run(
      {
        agentId: "blocked",
        sessionId: "session_2",
        workspaceDir: path.join(dataDir, "agents", "blocked", "workspace"),
      },
      () => tools[MANAGED_QUALYS_COUNT_ASSETS]!.execute({}),
    );
    expect(JSON.parse(deniedOutput)).toMatchObject({
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted integration tool is not enabled for agent",
      },
    });
    const mcpOnlyOutput = await toolCallContext.run(
      {
        agentId: "mcp-only",
        sessionId: "session_3",
        workspaceDir: path.join(dataDir, "agents", "mcp-only", "workspace"),
      },
      () => tools[MANAGED_QUALYS_COUNT_ASSETS]!.execute({}),
    );
    expect(JSON.parse(mcpOnlyOutput)).toMatchObject({
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
    await seedEnvironmentConfig(dataDir);

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
        tools: [MANAGED_QUALYS_COUNT_ASSETS],
        hostedIntegrationBindings: [
          hostedToolBinding("qualys_count_assets"),
        ],
      }),
    );

    const tools = toolRegistry.getVercelTools(
      new Set([MANAGED_QUALYS_COUNT_ASSETS]),
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
      () => tools[MANAGED_QUALYS_COUNT_ASSETS]!.execute({}),
    );

    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: { code: "tool_failed", message: "tool failed" },
      familyId: "qualys",
      toolName: "qualys_count_assets",
      canonicalToolName: MANAGED_QUALYS_COUNT_ASSETS,
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
    writeFamily(dataDir, undefined, { configBacked: false });

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { manager, close } = await createApp(config);
    closeApp = close;
    const managementToolNames = [
      "hosted_integration_family_create",
      "hosted_integration_source_read",
      "hosted_integration_source_view",
      "hosted_integration_lock_acquire",
      "hosted_integration_draft_create",
      "hosted_integration_draft_patch",
      "hosted_integration_example_upsert",
      "hosted_integration_example_run",
      "hosted_integration_promote",
      "hosted_integration_readiness_get",
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

    await expect(
      call("hosted_integration_family_create", {
        family_id: "bad-family",
        name: "Bad Family",
        tool_name: "managed_qualys__qualys_count_assets",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
        message:
          "tool_name: must be a family-native hosted integration tool name, not a managed canonical registry name",
      },
    });

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
      call("hosted_integration_source_read", {
        draft_id: draft.draft.id,
        path: "qualys.py",
        start_line: 2,
        max_lines: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      path: "qualys.py",
      content: [
        "    return {",
        "        'count': 1,",
        "        'endpoint': ctx['config']['endpoint'],",
      ].join("\n"),
      totalLines: 7,
      startLine: 2,
      endLine: 4,
      truncated: true,
    });

    await expect(
      call("hosted_integration_source_view", {
        draft_id: draft.draft.id,
        family_id: "qualys",
        tool_name: "qualys_count_assets",
      }),
    ).resolves.toMatchObject({
      ok: true,
      view: {
        mode: "focused",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        diagnostics: [
          {
            code: "selected_handler_missing",
          },
        ],
      },
    });

    await expect(
      call("hosted_integration_readiness_get", {
        target_type: "environment_config",
        family_id: "qualys",
        environment: "prod",
      }),
    ).resolves.toMatchObject({
      ok: true,
      readiness: {
        kind: "environment_config",
        status: "blocked",
        code: "missing",
      },
    });

    await expect(
      call("hosted_integration_readiness_get", {
        target_type: "mig" + "ration",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
      },
    });

    await expect(
      call("hosted_integration_draft_patch", {
        draft_id: draft.draft.id,
        lock_id: lock.lock.id,
        path: "qualys.py",
        mode: "replace_text",
        old_text: [
          "    return {",
          "        'count': 1,",
          "        'endpoint': ctx['config']['endpoint'],",
          "        'ready': ctx['secrets']['apiToken'] == 'raw-token-123',",
          "    }",
        ].join("\n"),
        new_text: "    return {'count': 7, 'mode': 'draft-example'}",
      }),
    ).resolves.toMatchObject({ ok: true, mode: "replace_text" });

    await expect(
      call("hosted_integration_draft_patch", {
        draft_id: draft.draft.id,
        lock_id: lock.lock.id,
        path: "qualys.py",
        mode: "insert_after",
        anchor_text: "def call_tool(name, args, ctx):",
        insert_text: "\n    # patched through targeted management edit",
      }),
    ).resolves.toMatchObject({ ok: true, mode: "insert_after" });

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
      toolRegistry
        .getInfo()
        .find((tool) => tool.name === MANAGED_QUALYS_COUNT_ASSETS)?.source,
    ).toMatchObject({
      kind: "hosted_integration",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: promoted.generation.id,
    });
  });

  it("exposes failure bucket repair lifecycle through management tools", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir, undefined, { configBacked: false });

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
          environmentConfigId: "qualys-prod",
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

    const closeRegression = await call("hosted_integration_failure_bucket_close", {
      bucket_id: seeded.bucket.id,
      draft_id: draft.draft.id,
      generation_id: promoted.generation.id,
      regression_example_id: "regression_1",
    });
    expect(closeRegression).toMatchObject({
      ok: true,
      bucket: { id: seeded.bucket.id, status: "closed" },
    });
  });

  it("returns focused source views only through authorized management tools", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(
      dataDir,
      [
        "def normalize(args):",
        "    return args",
        "",
        "def tool_qualys_count_assets(args, context):",
        "    return {'count': len(normalize(args))}",
        "",
        "def tool_qualys_search_assets(args, context):",
        "    return {'items': ['not-focused']}",
        "",
      ].join("\n"),
    );

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { manager, runtime, close } = await createApp(config);
    closeApp = close;
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

    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "tool-developer",
        name: "Tool Developer",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Inspect hosted integrations.",
        tools: ["hosted_integration_source_view"],
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
      new Set(["hosted_integration_source_view"]),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;
    const call = async (agentId: string) =>
      JSON.parse(
        await toolCallContext.run(
          {
            agentId,
            sessionId: `session_source_view_${agentId}`,
            workspaceDir: path.join(dataDir!, "agents", agentId, "workspace"),
          },
          () =>
            tools.hosted_integration_source_view!.execute({
              draft_id: draft.draft.id,
              family_id: "qualys",
              tool_name: "qualys_count_assets",
              include_shared_helpers: true,
            }),
        ),
      );

    await expect(call("analyst")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
    await expect(call("tool-developer")).resolves.toMatchObject({
      ok: true,
      view: {
        mode: "focused",
        source: {
          selectedHandler: {
            source: expect.stringContaining("def tool_qualys_count_assets"),
          },
          helpers: [
            {
              name: "normalize",
            },
          ],
          collapsedToolHandlers: [],
        },
      },
    });
  });

  it("exposes generation diffs through authorized management tools", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir, "def call_tool(name, args, ctx):\n    return {'count': 1}\n");
    const locks = createFileHostedIntegrationLockStore({
      dataDir,
      createId: () => "lock_1",
    });
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    let draftCounter = 0;
    const drafts = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore: locks,
      createId: () => `draft_${++draftCounter}`,
    });
    const generations = createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore: drafts,
      createId: () => `gen_${draftCounter}`,
    });

    const firstDraft = await drafts.createDraftFromFiles({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
      files: {
        "family.yaml": familyYaml(),
        "qualys.py": "def call_tool(name, args, ctx):\n    return {'count': 1}\n",
      },
    });
    if (!firstDraft.ok) throw new Error(firstDraft.reason);
    const first = await generations.promoteDraft({
      draftId: firstDraft.draft.id,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    if (!first.ok) throw new Error(first.reason);

    const secondDraft = await drafts.createDraftFromFiles({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_2",
      files: {
        "family.yaml": familyYaml(),
        "qualys.py": "def call_tool(name, args, ctx):\n    return {'count': 2}\n",
      },
    });
    if (!secondDraft.ok) throw new Error(secondDraft.reason);
    const second = await generations.promoteDraft({
      draftId: secondDraft.draft.id,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    if (!second.ok) throw new Error(second.reason);

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
        persona: "Compare hosted integrations.",
        tools: ["hosted_integration_generation_diff"],
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
      new Set(["hosted_integration_generation_diff"]),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;
    const call = async (agentId: string) =>
      JSON.parse(
        await toolCallContext.run(
          {
            agentId,
            sessionId: `session_generation_diff_${agentId}`,
            workspaceDir: path.join(dataDir!, "agents", agentId, "workspace"),
          },
          () =>
            tools.hosted_integration_generation_diff!.execute({
              base_generation_id: first.generation.id,
              compare_generation_id: second.generation.id,
              mode: "unified",
            }),
        ),
      );

    await expect(call("analyst")).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
    await expect(call("tool-developer")).resolves.toMatchObject({
      ok: true,
      diff: {
        mode: "unified",
        files: [
          {
            path: "qualys.py",
            changeType: "modified",
            unifiedPatch: expect.stringContaining("+    return {'count': 2}"),
          },
        ],
      },
    });
  });
});

function writeFamily(
  root: string,
  source?: string,
  options: { configBacked?: boolean } = {},
): void {
  const dir = path.join(
    root,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "family.yaml"),
    familyYaml({ configBacked: options.configBacked ?? true }),
  );
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

function writeFixtureFamily(
  root: string,
  fixture: LegacyIntegrationHubReplacementFamilyFixture,
): void {
  const dir = path.join(
    root,
    "hosted-integrations",
    "source",
    "families",
    fixture.familyId,
  );
  mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(fixture.sourceFiles)) {
    writeFileSync(path.join(dir, filePath), content);
  }
}

async function seedEnvironmentConfig(root: string): Promise<void> {
  const environmentConfigs = createFileHostedIntegrationEnvironmentConfigStore({
    dataDir: root,
  });
  const secrets = createFileHostedIntegrationSecretStore({
    dataDir: root,
  });
  for (const environment of ["prod", "test_debug"] as const) {
    await environmentConfigs.upsertEnvironmentConfig({
      familyId: "qualys",
      environment,
      config: {
        endpoint: "https://qualys.example.test",
        QUALYS_VM_URL: "https://qualys-vm.example.test",
        QUALYS_GATEWAY_URL: "https://qualys-gateway.example.test",
      },
      secrets: {
        apiToken: { configured: true },
        QUALYS_USERNAME: { configured: true },
        QUALYS_PASSWORD: { configured: true },
      },
      updatedBy: "human:alen",
    });
    await secrets.writeHumanOwnedSecrets({
      environmentConfigId: `qualys-${environment}`,
      secrets: {
        apiToken: "raw-token-123",
        QUALYS_USERNAME: "qualys-user",
        QUALYS_PASSWORD: "qualys-password",
      },
      updatedBy: "human:alen",
    });
  }
}

function hostedToolBinding(toolName: string) {
  return {
    familyId: "qualys",
    toolName,
    allowedEnvironments: ["prod"],
    defaultEnvironment: "prod",
    generationPin: { type: "current" },
    bindingKind: "agent",
    updatedAt: "2026-08-14T10:00:00.000Z",
    updatedBy: "human:test",
  };
}

function familyYaml(
  options: { configBacked?: boolean } = {},
): string {
  const runtimeConfig =
    options.configBacked === false
      ? `runtimeConfig:
  requiredConfigKeys: []
  requiredSecretKeys: []
`
      : `runtimeConfig:
  requiredConfigKeys:
    - endpoint
  requiredSecretKeys:
    - apiToken
`;
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  handlerDispatch: legacy_call_tool
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
${runtimeConfig}tools:
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
