import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/registry.js";
import { toolCallContext } from "../src/session-context.js";
import { HostedIntegrationToolRegistryAdapter } from "../src/hosted-integrations.js";

describe("hosted integration tool registry adapter", () => {
  it("registers promoted tools with hosted integration metadata", () => {
    const registry = new ToolRegistry();
    const adapter = new HostedIntegrationToolRegistryAdapter({
      registry,
      invoke: async () => "{}",
    });

    const result = adapter.syncFamily(activeQualysSnapshot("gen_1"));

    expect(result).toEqual({
      ok: true,
      registeredToolNames: ["qualys_count_assets"],
      removedToolNames: [],
    });
    expect(registry.getInfo()).toEqual([
      {
        name: "qualys_count_assets",
        description: "Count Qualys assets.",
        toolset: "hosted-integrations",
        source: {
          kind: "hosted_integration",
          familyId: "qualys",
          familyName: "Qualys",
          generationId: "gen_1",
        },
      },
    ]);
  });

  it("rejects collisions with non-hosted tools", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "qualys_count_assets",
      toolset: "filesystem",
      description: "Existing tool.",
      parameters: z.object({}),
      handler: async () => "{}",
    });
    const adapter = new HostedIntegrationToolRegistryAdapter({
      registry,
      invoke: async () => "{}",
    });

    expect(adapter.syncFamily(activeQualysSnapshot("gen_1"))).toEqual({
      ok: false,
      reason: "tool_name_collision",
      toolName: "qualys_count_assets",
      existingToolset: "filesystem",
    });
    expect(registry.get("qualys_count_assets")?.toolset).toBe("filesystem");
  });

  it("refreshes entries while existing generated tool objects keep their generation", async () => {
    const calls: Array<{ generationId: string; actorId: string }> = [];
    const registry = new ToolRegistry();
    const adapter = new HostedIntegrationToolRegistryAdapter({
      registry,
      invoke: async (request) => {
        calls.push({
          generationId: request.generationId,
          actorId: request.actorId,
        });
        return JSON.stringify({ ok: true, generationId: request.generationId });
      },
    });
    expect(adapter.syncFamily(activeQualysSnapshot("gen_1")).ok).toBe(true);
    const oldTools = registry.getVercelTools(new Set(["qualys_count_assets"]));

    expect(adapter.syncFamily(activeQualysSnapshot("gen_2")).ok).toBe(true);
    const freshTools = registry.getVercelTools(
      new Set(["qualys_count_assets"]),
    );

    await toolCallContext.run(
      {
        agentId: "agent:analyst",
        sessionId: "session_1",
        workspaceDir: "/tmp/openacme-test",
      },
      async () => {
        await executeTool(oldTools.qualys_count_assets, {});
        await executeTool(freshTools.qualys_count_assets, {});
      },
    );

    expect(calls).toEqual([
      { generationId: "gen_1", actorId: "agent:analyst" },
      { generationId: "gen_2", actorId: "agent:analyst" },
    ]);
  });
});

function activeQualysSnapshot(generationId: string) {
  return {
    familyId: "qualys",
    familyName: "Qualys",
    generationId,
    tools: [
      {
        name: "qualys_count_assets",
        description: "Count Qualys assets.",
        parameters: z.object({}),
      },
    ],
  };
}

async function executeTool(tool: unknown, args: Record<string, unknown>) {
  const execute = (
    tool as { execute: (args: Record<string, unknown>) => unknown }
  ).execute;
  return execute(args);
}
