import { afterEach, describe, expect, it } from "vitest";
import { registry } from "../src/registry.js";
import { toolCallContext } from "../src/session-context.js";
import {
  bindWorkflowManagement,
  WORKFLOW_CONSUMER_TOOL_NAMES,
  WORKFLOW_MANAGEMENT_TOOL_NAMES,
  type WorkflowManagementRequest,
} from "../src/builtins/workflow-management.js";

afterEach(() => {
  bindWorkflowManagement(null);
});

describe("workflow management tools", () => {
  it("registers the complete workflow authoring tool surface", () => {
    expect(
      WORKFLOW_MANAGEMENT_TOOL_NAMES.filter(
        (name) => registry.get(name) === undefined,
      ),
    ).toEqual([]);
    expect(WORKFLOW_CONSUMER_TOOL_NAMES).toEqual([
      "workflow_help",
      "workflow_callable_list",
      "workflow_callable_get",
      "workflow_run",
      "workflow_run_get",
      "workflow_artifact_get",
    ]);
  });

  it("returns the workflow card catalog without runtime binding", async () => {
    const result = await runTool(
      "workflow_card_catalog",
      {},
      "workflow-engineer",
    );

    expect(result.ok).toBe(true);
    expect(result.cards.map((card: { type: string }) => card.type)).toContain(
      "builtin.if",
    );
    expect(result.cards.map((card: { type: string }) => card.type)).toContain(
      "builtin.transform.uri_parse",
    );
    expect(result.cards.map((card: { type: string }) => card.type)).toContain(
      "builtin.output.set",
    );
    expect(result.cards.map((card: { type: string }) => card.type)).toContain(
      "mcp.tool",
    );
    expect(result.cards.map((card: { type: string }) => card.type)).toContain(
      "hosted.tool",
    );
    expect(result.cards.map((card: { type: string }) => card.type)).toContain(
      "agent.call",
    );
    expect(
      result.cards.map((card: { type: string }) => card.type),
    ).not.toContain("builtin.if_else");
  });

  it("delegates workflow management calls to the bound runtime port", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, workflows: [] };
      },
    });

    const result = await runTool(
      "workflow_list",
      { status: "draft", limit: 10 },
      "workflow-engineer",
    );

    expect(result).toEqual({ ok: true, workflows: [] });
    expect(calls).toEqual([
      {
        actorId: "workflow-engineer",
        toolName: "workflow_list",
        operation: "workflow_list",
        params: { status: "draft", limit: 10 },
      },
    ]);
  });

  it("delegates published workflow consumer calls to the bound runtime port", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, run: { status: "succeeded" }, output: { ok: true } };
      },
    });

    const result = await runTool(
      "workflow_run",
      {
        workflow_id: "wf_customer",
        trigger_id: "manual",
        input: { customerId: "c_1" },
      },
      "analyst",
    );

    expect(result).toEqual({
      ok: true,
      run: { status: "succeeded" },
      output: { ok: true },
    });
    expect(calls).toEqual([
      {
        actorId: "analyst",
        toolName: "workflow_run",
        operation: "workflow_run",
        params: {
          workflow_id: "wf_customer",
          trigger_id: "manual",
          input: { customerId: "c_1" },
        },
      },
    ]);
  });

  it("delegates workflow_help requests to the bound runtime port", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, summary: "Workflow authoring help" };
      },
    });

    const result = await runTool(
      "workflow_help",
      {
        target: { kind: "card_type", card_type: "builtin.if" },
        detail: "full",
        include_examples: true,
        parameters: [{ name: "condition", detail: "full" }],
      },
      "workflow-engineer",
    );

    expect(result).toEqual({ ok: true, summary: "Workflow authoring help" });
    expect(calls).toEqual([
      {
        actorId: "workflow-engineer",
        toolName: "workflow_help",
        operation: "workflow_help",
        params: {
          target: { kind: "card_type", card_type: "builtin.if" },
          detail: "full",
          include_examples: true,
          parameters: [{ name: "condition", detail: "full" }],
        },
      },
    ]);
  });

  it("validates workflow_help target requests before delegation", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool(
      "workflow_help",
      { target: { kind: "card_type" } },
      "workflow-engineer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(calls).toEqual([]);
  });

  it("delegates valid workflow_help_upsert requests to the bound runtime port", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool(
      "workflow_help_upsert",
      {
        target: { kind: "card_type", card_type: "builtin.if" },
        help: {
          summary: "Branch deterministically.",
          parameters: {
            condition: {
              summary: "Boolean condition expression.",
              full: "Use $.workflowTrigger.input.* or $.steps.*.",
            },
          },
        },
      },
      "workflow-engineer",
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        actorId: "workflow-engineer",
        toolName: "workflow_help_upsert",
        operation: "workflow_help_upsert",
        params: {
          target: { kind: "card_type", card_type: "builtin.if" },
          help: {
            summary: "Branch deterministically.",
            parameters: {
              condition: {
                summary: "Boolean condition expression.",
                full: "Use $.workflowTrigger.input.* or $.steps.*.",
              },
            },
          },
        },
      },
    ]);
  });

  it("requires an active agent context", async () => {
    const result = await runTool("workflow_card_catalog", {});

    expect(result).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("returns platform unavailable for runtime-bound tools before server binding", async () => {
    const result = await runTool(
      "workflow_tool_inventory",
      {},
      "workflow-engineer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "platform_unavailable" },
    });
  });

  it("validates tool parameters before delegation", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool(
      "workflow_get",
      { workflow_id: "bad id" },
      "workflow-engineer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(calls).toEqual([]);
  });

  it("requires workflow_validate to declare the validation mode", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool(
      "workflow_validate",
      { candidate: {} },
      "workflow-engineer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(result.error.message).toContain("mode");
    expect(calls).toEqual([]);
  });

  it("requires workflow_run_get step detail requests to include step_id", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const result = await runTool(
      "workflow_run_get",
      { run_id: "run_123", detail: "step" },
      "workflow-engineer",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(result.error.message).toContain("step_id");
    expect(calls).toEqual([]);
  });

  it("validates workflow_card_test_run mode-specific requests", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true };
      },
    });

    const invalid = await runTool(
      "workflow_card_test_run",
      { mode: "from_workflow", workflow_id: "wf_1" },
      "workflow-engineer",
    );

    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
    expect(invalid.error.message).toContain("step_id");
    expect(calls).toEqual([]);

    const valid = await runTool(
      "workflow_card_test_run",
      {
        mode: "candidate",
        node: {
          id: "log_message",
          type: "builtin.log.info",
          message: "$.workflowTrigger.input.message",
        },
        input: { message: "hello" },
      },
      "workflow-engineer",
    );

    expect(valid).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        actorId: "workflow-engineer",
        toolName: "workflow_card_test_run",
        operation: "workflow_card_test_run",
        params: {
          mode: "candidate",
          node: {
            id: "log_message",
            type: "builtin.log.info",
            message: "$.workflowTrigger.input.message",
            next: [],
          },
          input: { message: "hello" },
        },
      },
    ]);
  });

  it("delegates workflow_validate mode-specific requests", async () => {
    const calls: WorkflowManagementRequest[] = [];
    bindWorkflowManagement({
      invoke: async (request) => {
        calls.push(request);
        return { ok: true, issues: [] };
      },
    });

    const result = await runTool(
      "workflow_validate",
      { mode: "candidate", candidate: { name: "Draft", nodes: [] } },
      "workflow-engineer",
    );

    expect(result).toEqual({ ok: true, issues: [] });
    expect(calls).toEqual([
      {
        actorId: "workflow-engineer",
        toolName: "workflow_validate",
        operation: "workflow_validate",
        params: {
          mode: "candidate",
          candidate: { name: "Draft", nodes: [] },
        },
      },
    ]);
  });
});

async function runTool(
  name: string,
  args: Record<string, unknown>,
  actorId?: string,
) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const exec = () => tool.handler(args);
  const output = actorId
    ? await toolCallContext.run(
        {
          agentId: actorId,
          sessionId: "session_1",
          workspaceDir: "/tmp/openacme",
        },
        exec,
      )
    : await exec();
  return JSON.parse(output);
}
