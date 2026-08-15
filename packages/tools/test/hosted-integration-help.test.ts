import { afterEach, describe, expect, it } from "vitest";
import { registry } from "../src/registry.js";
import { toolCallContext } from "../src/session-context.js";
import {
  bindHostedToolHelp,
  HOSTED_TOOL_HELP_TOOL_NAME,
  type HostedToolHelpRequest,
} from "../src/builtins/hosted-integration-help.js";

afterEach(() => {
  bindHostedToolHelp(null);
});

describe("hosted tool help", () => {
  it("registers as a support built-in rather than a hosted invocation tool", () => {
    const entry = registry.get(HOSTED_TOOL_HELP_TOOL_NAME);
    expect(entry).toMatchObject({
      name: "hosted_tool_help",
      toolset: "hosted-integration-support",
    });
    expect(entry?.source).toBeUndefined();
  });

  it("delegates help requests to the bound server port", async () => {
    const calls: HostedToolHelpRequest[] = [];
    bindHostedToolHelp({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, help: { tool_name: request.params.tool_name } };
      },
    });

    const result = await runHelpTool(
      {
        tool_name: "hosted_qualys__qualys_count_assets",
        tool_detail: "summary",
        include_examples: true,
      },
      "analyst",
    );

    expect(result).toEqual({
      ok: true,
      help: { tool_name: "hosted_qualys__qualys_count_assets" },
    });
    expect(calls).toEqual([
      {
        actorId: "analyst",
        params: {
          tool_name: "hosted_qualys__qualys_count_assets",
          tool_detail: "summary",
          include_examples: true,
        },
      },
    ]);
  });

  it("treats null parameters as omitted because models often emit nullable optional fields", async () => {
    const calls: HostedToolHelpRequest[] = [];
    bindHostedToolHelp({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, help: { tool_name: request.params.tool_name } };
      },
    });

    await expect(
      runHelpTool(
        {
          tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
          tool_detail: "full",
          include_examples: true,
          parameters: null,
        },
        "analyst",
      ),
    ).resolves.toMatchObject({
      ok: true,
      help: {
        tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
      },
    });
    expect(calls[0]?.params).toMatchObject({
      tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
      tool_detail: "full",
      include_examples: true,
    });
    expect(calls[0]?.params).not.toHaveProperty("parameters", null);
  });

  it("requires active agent context", async () => {
    bindHostedToolHelp({
      invoke: async () => ({ ok: true }),
    });

    await expect(
      runHelpTool({ tool_name: "hosted_qualys__qualys_count_assets" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("rejects names outside the hosted invocation namespace", async () => {
    bindHostedToolHelp({
      invoke: async () => ({ ok: true }),
    });

    await expect(
      runHelpTool({ tool_name: "mcp_integration-hub__qualys_count_assets" }, "analyst"),
    ).rejects.toThrow(/hosted tool name/);
  });
});

async function runHelpTool(args: Record<string, unknown>, agentId?: string) {
  const entry = registry.get(HOSTED_TOOL_HELP_TOOL_NAME);
  expect(entry).toBeDefined();
  const raw = agentId
    ? await toolCallContext.run(
        {
          sessionId: "session_1",
          agentId,
          workspaceDir: "/tmp/openacme-agent/workspace",
        },
        () => entry!.handler(args),
      )
    : await entry!.handler(args);
  return JSON.parse(raw);
}
