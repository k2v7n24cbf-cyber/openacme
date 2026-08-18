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

  it("accepts vocabulary lookup fields for parameter-specific help", async () => {
    const calls: HostedToolHelpRequest[] = [];
    bindHostedToolHelp({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    await expect(
      runHelpTool(
        {
          tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
          parameters: [
            {
              name: "filter_body.filters.field",
              query: "last check-in",
              limit: 5,
            },
          ],
        },
        "analyst",
      ),
    ).resolves.toEqual({ ok: true });

    expect(calls[0]?.params).toMatchObject({
      tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
      tool_detail: "summary",
      include_examples: false,
      parameters: [
        {
          name: "filter_body.filters.field",
          detail: "summary",
          include_examples: false,
          query: "last check-in",
          limit: 5,
        },
      ],
    });
  });

  it("accepts mixed vocabulary query and exact value so help can return guidance", async () => {
    const calls: HostedToolHelpRequest[] = [];
    bindHostedToolHelp({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    await expect(
      runHelpTool(
        {
          tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
          parameters: [
            {
              name: "filter_body.filters.field",
              query: "asset",
              value: "asset.name",
            },
          ],
        },
        "analyst",
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls[0]?.params.parameters?.[0]).toMatchObject({
      query: "asset",
      value: "asset.name",
    });
  });

  it("teaches ambiguous vocabulary recovery through the model-facing schema", () => {
    const entry = registry.get(HOSTED_TOOL_HELP_TOOL_NAME);
    expect(entry?.description).toContain("vocabulary lookup is ambiguous");
    expect(entry?.description).toContain("candidate parameter path");
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

  it("redacts secret-shaped values from thrown help errors", async () => {
    bindHostedToolHelp({
      invoke: async () => {
        throw new Error(
          "help backend returned Authorization: Bearer raw-token-123 and super-secret-value",
        );
      },
    });

    const result = await runHelpTool(
      {
        tool_name: "hosted_qualys__qualys_cloud_agent_hostasset_count",
        tool_detail: "full",
      },
      "analyst",
    );

    expect(JSON.stringify(result)).not.toContain("raw-token-123");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "runtime_error",
        message:
          "help backend returned [REDACTED]: [REDACTED] and [REDACTED]",
      },
    });
  });

  it("rejects names outside the hosted invocation namespace", async () => {
    bindHostedToolHelp({
      invoke: async () => ({ ok: true }),
    });

    await expect(
      runHelpTool(
        { tool_name: "mcp_integration-hub__qualys_count_assets" },
        "analyst",
      ),
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
