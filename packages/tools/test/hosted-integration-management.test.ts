import { describe, expect, it, afterEach } from "vitest";
import { registry } from "../src/registry.js";
import { toolCallContext } from "../src/session-context.js";
import {
  bindHostedToolManagement,
  HOSTED_TOOL_MANAGEMENT_TOOL_NAMES,
  type HostedToolManagementRequest,
} from "../src/builtins/hosted-integration-management.js";

afterEach(() => {
  bindHostedToolManagement(null);
});

describe("hosted integration management tools", () => {
  it("registers the complete Tool Developer Agent lifecycle tool surface", () => {
    expect(
      HOSTED_TOOL_MANAGEMENT_TOOL_NAMES.filter(
        (name) => registry.get(name) === undefined,
      ),
    ).toEqual([]);
    expect(HOSTED_TOOL_MANAGEMENT_TOOL_NAMES).toEqual([
      "hosted_tool_family_list",
      "hosted_tool_family_create",
      "hosted_tool_source_read",
      "hosted_tool_source_view",
      "hosted_tool_lock_acquire",
      "hosted_tool_lock_renew",
      "hosted_tool_lock_release",
      "hosted_tool_draft_create",
      "hosted_tool_draft_get",
      "hosted_tool_draft_patch",
      "hosted_tool_draft_delete",
      "hosted_tool_example_list",
      "hosted_tool_example_upsert",
      "hosted_tool_example_run",
      "hosted_tool_validate",
      "hosted_tool_promote",
      "hosted_tool_generation_list",
      "hosted_tool_generation_get",
      "hosted_tool_generation_diff",
      "hosted_tool_generation_rollback",
      "hosted_tool_environment_config_list",
      "hosted_tool_environment_config_get",
      "hosted_tool_readiness_get",
      "hosted_tool_debug_run",
      "hosted_tool_run_get",
      "hosted_tool_artifact_get",
      "hosted_tool_failure_bucket_list",
      "hosted_tool_failure_bucket_get",
      "hosted_tool_failure_bucket_assign",
      "hosted_tool_failure_bucket_close",
    ]);
  });

  it("delegates management tool calls to the bound control-plane port", async () => {
    const calls: HostedToolManagementRequest[] = [];
    bindHostedToolManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, family: { id: request.params.family_id } };
      },
    });

    const result = await runTool(
      "hosted_tool_lock_acquire",
      { family_id: "qualys", ttl_ms: 60_000 },
      "tool-developer",
    );

    expect(result).toEqual({ ok: true, family: { id: "qualys" } });
    expect(calls).toEqual([
      {
        actorId: "tool-developer",
        toolName: "hosted_tool_lock_acquire",
        operation: "hosted_tool_lock_acquire",
        params: { family_id: "qualys", ttl_ms: 60_000 },
      },
    ]);
  });

  it("returns a clear platform-unavailable error when unbound", async () => {
    const result = await runTool(
      "hosted_tool_family_list",
      {},
      "tool-developer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "platform_unavailable" },
    });
  });

  it("requires an active agent context before invoking the bound port", async () => {
    const calls: HostedToolManagementRequest[] = [];
    bindHostedToolManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool("hosted_tool_family_list", {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
    expect(calls).toEqual([]);
  });

  it("surfaces Tool Developer Agent policy success and normal-agent denial from the control-plane port", async () => {
    bindHostedToolManagement({
      invoke: async (request) => {
        if (request.actorId !== "tool-developer") {
          return {
            ok: false,
            error: {
              code: "policy_denied",
              message: "agent cannot manage hosted integrations",
            },
          };
        }
        return { ok: true, families: [] };
      },
    });

    await expect(
      runTool("hosted_tool_family_list", {}, "tool-developer"),
    ).resolves.toEqual({ ok: true, families: [] });
    await expect(
      runTool("hosted_tool_family_list", {}, "analyst"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("accepts null for LLM-required optional fields and delegates them", async () => {
    const calls: HostedToolManagementRequest[] = [];
    bindHostedToolManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    await expect(
      runTool(
        "hosted_tool_draft_create",
        {
          family_id: "qualys",
          lock_id: "lock_1",
          source_revision_id: null,
        },
        "tool-developer",
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      runTool(
        "hosted_tool_promote",
        {
          draft_id: "draft_1",
          lock_id: "lock_1",
          approval_id: null,
        },
        "tool-developer",
      ),
    ).resolves.toEqual({ ok: true });

    expect(calls.map((call) => call.params)).toEqual([
      {
        family_id: "qualys",
        lock_id: "lock_1",
        source_revision_id: null,
      },
      {
        draft_id: "draft_1",
        lock_id: "lock_1",
        approval_id: null,
      },
    ]);
  });

  it("delegates source windows and targeted draft patch modes", async () => {
    const calls: HostedToolManagementRequest[] = [];
    bindHostedToolManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    await expect(
      runTool(
        "hosted_tool_source_read",
        {
          family_id: "qualys",
          path: "qualys.py",
          start_line: 40,
          max_lines: 20,
        },
        "tool-developer",
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      runTool(
        "hosted_tool_draft_patch",
        {
          draft_id: "draft_1",
          lock_id: "lock_1",
          path: "qualys.py",
          mode: "replace_text",
          old_text: "return {'count': 1}",
          new_text: "return {'count': 2}",
        },
        "tool-developer",
      ),
    ).resolves.toEqual({ ok: true });

    expect(calls.map((call) => call.params)).toEqual([
      {
        family_id: "qualys",
        path: "qualys.py",
        start_line: 40,
        max_lines: 20,
      },
      {
        draft_id: "draft_1",
        lock_id: "lock_1",
        path: "qualys.py",
        mode: "replace_text",
        old_text: "return {'count': 1}",
        new_text: "return {'count': 2}",
      },
    ]);
  });

  it("redacts secret-shaped keys and values from management tool responses", async () => {
    bindHostedToolManagement({
      invoke: async () => ({
        ok: true,
        environmentConfig: {
          id: "qualys-prod",
          secrets: { apiToken: { configured: true } },
          nested: { password: "super-secret-value" },
          note: "bearer raw-token-123",
        },
      }),
    });

    const result = await runTool(
      "hosted_tool_environment_config_get",
      { family_id: "qualys", environment: "prod" },
      "tool-developer",
    );

    expect(JSON.stringify(result)).not.toContain("apiToken");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("raw-token-123");
    expect(result).toMatchObject({
      ok: true,
      environmentConfig: {
        secrets: "[REDACTED]",
        nested: { password: "[REDACTED]" },
        note: "[REDACTED]",
      },
    });
  });

  it("delegates readiness inspection through the control-plane port", async () => {
    const calls: HostedToolManagementRequest[] = [];
    bindHostedToolManagement({
      invoke: async (request) => {
        calls.push(request);
        return {
          ok: true,
          readiness: {
            kind: "environment_config",
            status: "blocked",
            code: "missing",
            target: {
              familyId: "qualys",
              environment: "prod",
              environmentConfigId: "qualys-prod",
            },
            blockers: [
              {
                code: "missing_environment_config",
                message: "environment config is missing",
              },
            ],
          },
        };
      },
    });

    await expect(
      runTool(
        "hosted_tool_readiness_get",
        {
          target_type: "environment_config",
          family_id: "qualys",
          environment: "prod",
        },
        "tool-developer",
      ),
    ).resolves.toMatchObject({
      ok: true,
      readiness: {
        kind: "environment_config",
        status: "blocked",
        code: "missing",
      },
    });
    expect(calls).toMatchObject([
      {
        actorId: "tool-developer",
        operation: "hosted_tool_readiness_get",
        params: {
          target_type: "environment_config",
          family_id: "qualys",
          environment: "prod",
        },
      },
    ]);
  });

  it("rejects offline parity readiness as a product management-tool target", async () => {
    const calls: HostedToolManagementRequest[] = [];
    bindHostedToolManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool(
      "hosted_tool_readiness_get",
      { target_type: "mig" + "ration" },
      "tool-developer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
      },
    });
    expect(calls).toEqual([]);
  });

  it("rejects self-approval style destructive promotion parameters", async () => {
    bindHostedToolManagement({
      invoke: async () => {
        throw new Error("should not be called");
      },
    });

    const output = await registry.dispatch("hosted_tool_promote", {
      draft_id: "draft_1",
      lock_id: "lock_1",
      approvalGranted: true,
    });

    expect(JSON.parse(output)).toMatchObject({
      error: expect.stringContaining("Unrecognized key"),
    });
  });
});

async function runTool(
  name: string,
  args: Record<string, unknown>,
  actorId?: string,
): Promise<unknown> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  const exec = () => tool.handler(args);
  const output = actorId
    ? await toolCallContext.run({ agentId: actorId }, exec)
    : await exec();
  return JSON.parse(output);
}
