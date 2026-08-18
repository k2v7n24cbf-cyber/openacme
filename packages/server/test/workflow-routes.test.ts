import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { ServerRuntime } from "../src/runtime.js";
import type { WorkflowExecutionPorts } from "@openacme/workflows";
import type { Hono } from "hono";

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let runtime: ServerRuntime;
let authToken: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-workflow-routes-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager, runtime } = await createApp(config));
  const member = manager.authStore.createMember({
    email: "workflow@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
});

it("lists workflow MCP metadata without exposing builtin tool registry", async () => {
  await replaceAppWithWorkflowPorts({
    mcp: {
      async listTools() {
        return [
          {
            server: "crm",
            tool: "lookup",
            name: "mcp_crm__lookup",
            description: "Lookup customer",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string" } },
            },
          },
        ];
      },
      async callTool() {
        return { output: {} };
      },
    },
  });

  const res = await req("/api/workflows/mcp/tools");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    tools: [
      {
        server: "crm",
        tool: "lookup",
        name: "mcp_crm__lookup",
        description: "Lookup customer",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    ],
  });
});

it("lists workflow agent metadata through the workflow port", async () => {
  await replaceAppWithWorkflowPorts({
    agent: {
      listAgents: () => [
        {
          id: "support",
          name: "Support",
          role: "Handles support triage",
          instantMessagesEnabled: true,
        },
      ],
      async callAgent() {
        return { output: {} };
      },
    },
  });

  const res = await req("/api/workflows/agents");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    agents: [
      {
        id: "support",
        name: "Support",
        role: "Handles support triage",
        instantMessagesEnabled: true,
      },
    ],
  });
});

async function replaceAppWithWorkflowPorts(
  workflowExecutionPorts: WorkflowExecutionPorts,
) {
  await runtime.close();
  ({ app, manager, runtime } = await createApp(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
    { workflowExecutionPorts },
  ));
  const member = manager.authStore.createMember({
    email: "workflow-mcp@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
}

afterEach(async () => {
  await runtime.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function req(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return app.request(`http://127.0.0.1${p}`, { ...init, headers });
}

async function jsonReq(p: string, body: unknown, method = "POST") {
  return req(p, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function publicJsonReq(
  p: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`http://openacme.example${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "openacme.example",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runnableNodes() {
  return [
    {
      id: "set_customer",
      type: "builtin.set",
      next: ["normalize"],
      assign: { customer: "$.workflowTrigger.input.customer" },
    },
    {
      id: "normalize",
      type: "builtin.transform.object_pick",
      input: { customer: "$.context.customer" },
      transform: {
        kind: "object_pick",
        source: "customer",
        fields: ["id", "name"],
      },
      assign: {
        customer: {
          from: "$.steps.normalize.output.value",
          mode: "replace",
        },
      },
      next: ["exit"],
    },
    {
      id: "exit",
      type: "builtin.exit",
      status: "succeeded",
      output: "$.context.customer",
    },
  ];
}

describe("workflow routes", () => {
  it("round-trips optional workflow UI metadata without changing nodes", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_layout_api",
      name: "Layout API",
      nodes: runnableNodes(),
      ui: {
        canvas: {
          nodes: {
            set_customer: { position: { x: 120, y: 80 } },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).workflow).toMatchObject({
      id: "wf_layout_api",
      nodes: runnableNodes(),
      ui: {
        canvas: {
          nodes: {
            set_customer: { position: { x: 120, y: 80 } },
          },
        },
      },
    });

    res = await jsonReq(
      "/api/workflows/wf_layout_api",
      {
        ui: {
          canvas: {
            nodes: {
              set_customer: { position: { x: 240, y: 160 } },
            },
          },
        },
      },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).workflow.ui).toEqual({
      canvas: {
        nodes: {
          set_customer: { position: { x: 240, y: 160 } },
        },
      },
    });

    res = await jsonReq("/api/workflows/wf_layout_api/publish", {});
    expect(res.status).toBe(200);
    expect((await res.json()).workflow.ui).toEqual({
      canvas: {
        nodes: {
          set_customer: { position: { x: 240, y: 160 } },
        },
      },
    });

    res = await jsonReq("/api/workflows/wf_layout_api", { ui: null }, "PATCH");
    expect(res.status).toBe(200);
    expect((await res.json()).workflow.ui).toBeUndefined();
  });

  it("creates, lists, updates, and publishes workflow drafts", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_customer",
      name: "Customer flow",
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).workflow).toMatchObject({
      id: "wf_customer",
      name: "Customer flow",
      status: "draft",
      version: 1,
    });

    res = await req("/api/workflows");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).workflows.map((wf: { id: string }) => wf.id),
    ).toEqual(["wf_customer"]);

    res = await req("/api/workflows?limit=abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid limit" });

    res = await req("/api/workflows?status=draft&status=published");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });

    res = await req("/api/workflows?teamId=team_alpha");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "workflow_scope_unsupported",
    });

    res = await req("/api/workflows?agentId=support");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "workflow_scope_unsupported",
    });

    res = await jsonReq(
      "/api/workflows/wf_customer",
      { name: "Customer flow v2" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect((await res.json()).workflow.name).toBe("Customer flow v2");

    res = await req("/api/workflows/wf_customer");
    expect(res.status).toBe(200);
    expect((await res.json()).workflow).toMatchObject({
      id: "wf_customer",
      name: "Customer flow v2",
    });

    res = await jsonReq("/api/workflows/wf_customer/publish", {});
    expect(res.status).toBe(200);
    expect((await res.json()).workflow).toMatchObject({
      id: "wf_customer",
      status: "published",
      version: 2,
    });

    res = await req("/api/workflows/wf_customer", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).workflow).toMatchObject({
      id: "wf_customer",
      status: "archived",
    });

    res = await req("/api/workflows");
    expect(res.status).toBe(200);
    expect((await res.json()).workflows).toEqual([]);

    res = await req("/api/workflows?status=archived");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).workflows.map((wf: { id: string }) => wf.id),
    ).toEqual(["wf_customer"]);

    res = await jsonReq("/api/workflows", {
      id: "bad/id",
      name: "Bad workflow id",
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid id" });
  });

  it("rejects invalid cross-node references before publish or run creation", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_invalid_reference_create",
      name: "Invalid reference create",
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.ready",
          then: ["missing_node"],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Node branch then references missing node missing_node",
    });

    res = await jsonReq("/api/workflows", {
      id: "wf_invalid_node_id_create",
      name: "Invalid node id create",
      nodes: [
        {
          id: "load/customer",
          type: "builtin.log.info",
          message: "Invalid node id",
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid workflow node id: load/customer",
    });

    runtime.workflowStore.createDraft({
      id: "wf_invalid_reference_existing",
      name: "Invalid reference existing",
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.ready",
          then: ["missing_node"],
        },
      ],
    });

    res = await jsonReq(
      "/api/workflows/wf_invalid_reference_existing/publish",
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Node branch then references missing node missing_node",
    });

    res = await jsonReq(
      "/api/workflows/wf_invalid_reference_existing/runs/test",
      {
        input: { ready: true },
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Node branch then references missing node missing_node",
    });

    res = await req("/api/workflows/wf_invalid_reference_existing/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runs: [],
      hasMore: false,
      nextOffset: null,
    });
  });

  it("rejects detached executable workflow nodes on create, update, publish, and test run", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_detached_create",
      name: "Detached create",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "start",
          next: ["finish_log"],
        },
        {
          id: "finish_log",
          type: "builtin.log.info",
          message: "finish",
        },
        {
          id: "detached_log",
          type: "builtin.log.info",
          message: "detached",
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Workflow flow is incomplete. Connect or remove unreachable card(s): detached_log",
    });

    res = await jsonReq("/api/workflows", {
      id: "wf_detached_patch",
      name: "Detached patch",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "start",
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_detached_patch",
      {
        nodes: [
          {
            id: "start_log",
            type: "builtin.log.info",
            message: "start",
          },
          {
            id: "detached_log",
            type: "builtin.log.info",
            message: "detached",
          },
        ],
      },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Workflow flow is incomplete. Connect or remove unreachable card(s): detached_log",
    });

    runtime.workflowStore.createDraft({
      id: "wf_detached_existing",
      name: "Detached existing",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "start",
        },
        {
          id: "detached_log",
          type: "builtin.log.info",
          message: "detached",
        },
      ],
    });

    res = await req("/api/workflows/wf_detached_existing");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workflow: {
        id: "wf_detached_existing",
        nodes: [{ id: "start_log" }, { id: "detached_log" }],
      },
    });

    res = await jsonReq("/api/workflows/wf_detached_existing/publish", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Workflow flow is incomplete. Connect or remove unreachable card(s): detached_log",
    });

    res = await jsonReq("/api/workflows/wf_detached_existing/runs/test", {
      input: {},
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Workflow flow is incomplete. Connect or remove unreachable card(s): detached_log",
    });

    res = await req("/api/workflows/wf_detached_existing/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runs: [],
      hasMore: false,
      nextOffset: null,
    });
  });

  it("rejects UI-equivalent whitespace-only workflow and trigger fields", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_blank_name",
      name: "   ",
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Workflow needs a name" });

    res = await jsonReq("/api/workflows", {
      id: "wf_name_patch_guard",
      name: "Name patch guard",
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_name_patch_guard",
      { name: "   " },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Workflow needs a name" });

    res = await jsonReq("/api/workflows", {
      id: "wf_blank_trigger_fields",
      name: "Blank trigger fields",
      triggers: [
        {
          id: "nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "   " },
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Scheduled trigger nightly needs a cron schedule",
    });

    res = await jsonReq("/api/workflows", {
      id: "wf_blank_webhook_path",
      name: "Blank webhook path",
      triggers: [
        {
          id: "incoming",
          kind: "webhook",
          enabled: true,
          path: "   ",
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Webhook trigger incoming path must be a string",
    });
  });

  it("rejects duplicate trigger ids and duplicate webhook paths before publish or run creation", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_invalid_triggers_create",
      name: "Invalid triggers create",
      triggers: [
        { id: "manual", kind: "manual", enabled: true },
        { id: "manual", kind: "manual", enabled: true },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Duplicate workflow trigger id: manual",
    });

    res = await jsonReq("/api/workflows", {
      id: "wf_invalid_trigger_id_create",
      name: "Invalid trigger id create",
      triggers: [{ id: "manual/review", kind: "manual", enabled: true }],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid workflow trigger id: manual/review",
    });

    res = await jsonReq("/api/workflows", {
      id: "wf_invalid_triggers_update",
      name: "Invalid triggers update",
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_invalid_triggers_update",
      {
        triggers: [
          {
            id: "incoming_a",
            kind: "webhook",
            enabled: true,
            path: "crm/customer",
          },
          {
            id: "incoming_b",
            kind: "webhook",
            enabled: false,
            path: "/crm/customer/",
          },
        ],
      },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Duplicate workflow webhook path: crm/customer",
    });

    runtime.workflowStore.createDraft({
      id: "wf_invalid_triggers_existing",
      name: "Invalid triggers existing",
      triggers: [
        {
          id: "incoming_a",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
        },
        {
          id: "incoming_b",
          kind: "webhook",
          enabled: true,
          path: "/crm/customer/",
        },
      ],
      nodes: runnableNodes(),
    });

    res = await jsonReq(
      "/api/workflows/wf_invalid_triggers_existing/publish",
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Duplicate workflow webhook path: crm/customer",
    });

    res = await jsonReq(
      "/api/workflows/wf_invalid_triggers_existing/runs/test",
      {
        input: { customer: { id: "blocked", name: "Blocked" } },
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Duplicate workflow webhook path: crm/customer",
    });

    res = await req("/api/workflows/wf_invalid_triggers_existing/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runs: [],
      hasMore: false,
      nextOffset: null,
    });
  });

  it("rejects run creation when workflow input does not match input schema", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_input_schema_guard",
      name: "Input schema guard",
      inputSchema: {
        type: "object",
        required: ["customer"],
        properties: {
          customer: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      triggers: [
        {
          id: "manual_review",
          kind: "manual",
          enabled: true,
          inputSchema: {
            type: "object",
            required: ["approvalNote"],
            properties: { approvalNote: { type: "string" } },
          },
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_input_schema_guard/runs/test", {
      input: {},
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Input does not match schema: $.customer is required",
    });

    res = await req("/api/workflows/wf_input_schema_guard/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runs: [],
      hasMore: false,
      nextOffset: null,
    });

    res = await jsonReq("/api/workflows/wf_input_schema_guard/runs/test", {
      input: { customer: { id: "cust_1", name: "Ada" } },
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_input_schema_guard/publish", {});
    expect(res.status).toBe(200);

    res = await jsonReq("/api/workflows/wf_input_schema_guard/runs/live", {
      input: { customer: { id: 123, name: "Ada" } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Input does not match schema: $.customer.id must be string",
    });

    res = await jsonReq(
      "/api/workflows/wf_input_schema_guard/triggers/manual_review/runs",
      { input: {} },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Input does not match schema: $.customer is required",
    });

    res = await jsonReq(
      "/api/workflows/wf_input_schema_guard/triggers/manual_review/runs",
      { input: { customer: { id: "cust_2", name: "Grace" } } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Trigger input does not match schema: $.approvalNote is required",
    });

    res = await req("/api/workflows/wf_input_schema_guard/runs");
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toHaveLength(1);
  });

  it("rejects malformed workflow and trigger JSON Schema contracts", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_invalid_json_schema",
      name: "Invalid JSON Schema",
      inputSchema: {
        type: "object",
        properties: {
          assets: {
            type: "array",
            items: ["object"],
          },
        },
      },
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Input schema is invalid: $.properties.assets.items must be a JSON Schema object or boolean",
    });

    res = await jsonReq("/api/workflows", {
      id: "wf_trigger_invalid_json_schema",
      name: "Invalid trigger JSON Schema",
      triggers: [
        {
          id: "manual_review",
          kind: "manual",
          enabled: true,
          inputSchema: {
            type: "object",
            required: "approvalNote",
          },
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Trigger manual_review input schema is invalid: $.required must be an array of property names",
    });
  });

  it("runs draft tests and published live runs with inspectable detail", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_run_api",
      name: "Run API",
      triggers: [{ id: "manual_review", kind: "manual", enabled: true }],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_run_api/runs/test", {
      input: {
        customer: { id: "cust_1", name: "Ada", secret: "not selected" },
      },
    });
    expect(res.status).toBe(201);
    const testRun = (await res.json()) as {
      run: { id: string; status: string; mode: string; context: unknown };
      steps: Array<{
        nodeId: string;
        status: string;
        durationMs: number | null;
      }>;
      events: Array<{ kind: string; message?: string; payload?: unknown }>;
    };
    expect(testRun.run).toMatchObject({
      status: "succeeded",
      mode: "test",
      context: { customer: { id: "cust_1", name: "Ada" } },
      durationMs: expect.any(Number),
    });
    expect(testRun.steps.map((step) => [step.nodeId, step.status])).toEqual([
      ["set_customer", "succeeded"],
      ["normalize", "succeeded"],
      ["exit", "succeeded"],
    ]);
    expect(testRun.steps.map((step) => step.durationMs)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(testRun.events.map((event) => event.kind)).toContain(
      "run_completed",
    );

    res = await jsonReq("/api/workflows/wf_run_api/runs/test", {
      version: 2,
      input: { customer: { id: "cust_version", name: "Version Ada" } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "test_run_version_not_supported",
    });

    res = await jsonReq("/api/workflows/wf_run_api/publish", {});
    expect(res.status).toBe(200);

    res = await jsonReq("/api/workflows/wf_run_api/runs/live", {
      input: { customer: { id: "cust_2", name: "Grace" } },
    });
    expect(res.status).toBe(201);
    const liveRun = (await res.json()) as { run: { id: string; mode: string } };
    expect(liveRun.run.mode).toBe("live");

    runtime.workflowStore.recordArtifact({
      id: "artifact_api_output",
      runId: testRun.run.id,
      stepRunId: runtime.workflowStore.listStepAttempts(testRun.run.id)[1]?.id,
      kind: "step_output",
      path: "workflows/wf_run_api/test-output.json",
      preview: '{"customer":"cust_1"}',
      createdAt: "2026-07-30T00:03:00.000Z",
    });

    res = await req(`/api/workflow-runs/${testRun.run.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      run: { id: string; input?: unknown };
      steps: Array<{
        nodeId: string;
        input?: unknown;
        output?: unknown;
        contextDiff?: unknown;
      }>;
      events: Array<{ sequence: number }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
        createdAt: string;
      }>;
    };
    expect(detail.run.id).toBe(testRun.run.id);
    expect(detail.run.input).toEqual({
      customer: { id: "cust_1", name: "Ada", secret: "[redacted]" },
    });
    const normalizeStep = detail.steps.find(
      (step) => step.nodeId === "normalize",
    );
    expect(normalizeStep?.input).toEqual({
      input: { customer: { id: "cust_1", name: "Ada" } },
      transform: {
        kind: "object_pick",
        source: "customer",
        fields: ["id", "name"],
      },
      assign: {
        customer: {
          from: "$.steps.normalize.output.value",
          mode: "replace",
          value: { id: "cust_1", name: "Ada" },
        },
      },
    });
    expect(normalizeStep?.output).toEqual({
      value: { id: "cust_1", name: "Ada" },
    });
    expect(normalizeStep?.contextDiff).toEqual({
      customer: {
        before: { id: "cust_1", name: "Ada", secret: "[redacted]" },
        after: { id: "cust_1", name: "Ada" },
      },
    });
    expect(detail.events.map((event) => event.sequence)).toEqual(
      detail.events.map((event) => event.sequence).sort((a, b) => a - b),
    );
    expect(detail.artifacts).toEqual([
      {
        id: "artifact_api_output",
        runId: testRun.run.id,
        stepRunId: runtime.workflowStore.listStepAttempts(testRun.run.id)[1]
          ?.id,
        kind: "step_output",
        path: "workflows/wf_run_api/test-output.json",
        preview: '{"customer":"cust_1"}',
        createdAt: "2026-07-30T00:03:00.000Z",
      },
    ]);

    res = await req("/api/workflow-runs?workflowId=wf_run_api&mode=test");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).toEqual([testRun.run.id]);

    res = await req("/api/workflow-runs?workflowId=wf_run_api&limit=1");
    expect(res.status).toBe(200);
    const firstPage = (await res.json()) as {
      runs: Array<{ id: string }>;
      limit: number;
      offset: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    expect(firstPage).toMatchObject({
      limit: 1,
      offset: 0,
      hasMore: true,
      nextOffset: 1,
    });
    expect(firstPage.runs.map((run) => run.id)).toEqual([liveRun.run.id]);

    res = await req(
      "/api/workflow-runs?workflowId=wf_run_api&limit=1&offset=1",
    );
    expect(res.status).toBe(200);
    const secondPage = (await res.json()) as {
      runs: Array<{ id: string }>;
      limit: number;
      offset: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    expect(secondPage).toMatchObject({
      limit: 1,
      offset: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect(secondPage.runs.map((run) => run.id)).toEqual([testRun.run.id]);

    res = await jsonReq(
      "/api/workflows/wf_run_api/triggers/manual_review/runs",
      {
        input: { customer: { id: "cust_trigger", name: "Trigger Ada" } },
      },
    );
    expect(res.status).toBe(201);
    const triggerRun = (await res.json()) as {
      run: { id: string; status: string; mode: string; trigger: unknown };
    };
    expect(triggerRun.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "manual",
        triggerId: "manual_review",
        requestedBy: "operator",
        input: { customer: { id: "cust_trigger", name: "Trigger Ada" } },
      },
    });

    res = await jsonReq(
      "/api/workflows/wf_run_api",
      {
        nodes: [
          {
            id: "missing",
            type: "builtin.transform.value_resolve",
            input: { customer: "$.context.customer.missing" },
            transform: { kind: "value.resolve", value: "$" },
          },
        ],
      },
      "PATCH",
    );
    expect(res.status).toBe(200);

    res = await jsonReq("/api/workflows/wf_run_api/runs/test", {
      input: { customer: { id: "cust_failed", name: "Failed Ada" } },
    });
    expect(res.status).toBe(201);
    const failedRun = (await res.json()) as {
      run: { id: string; status: string };
    };
    expect(failedRun.run.status).toBe("failed");

    res = await req(`/api/workflow-runs/${failedRun.run.id}`);
    expect(res.status).toBe(200);
    const failedDetail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{ nodeId: string; status: string; error?: unknown }>;
      events: Array<{ kind: string }>;
    };
    expect(failedDetail.run).toMatchObject({
      id: failedRun.run.id,
      status: "failed",
    });
    expect(failedDetail.steps).toEqual([
      expect.objectContaining({
        nodeId: "missing",
        status: "failed",
        error: {
          name: "Error",
          message: "Reference not found: $.context.customer.missing",
        },
      }),
    ]);
    expect(failedDetail.events.map((event) => event.kind)).toContain(
      "step_failed",
    );

    res = await req("/api/workflow-runs?status=failed");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).toEqual([failedRun.run.id]);

    res = await req("/api/workflows/wf_run_api/runs?status=failed");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).toEqual([failedRun.run.id]);

    res = await req("/api/workflows/wf_run_api/runs?limit=2");
    expect(res.status).toBe(200);
    const workflowRunPage = (await res.json()) as {
      runs: Array<{ id: string }>;
      limit: number;
      offset: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    expect(workflowRunPage).toMatchObject({
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });
    expect(workflowRunPage.runs.map((run) => run.id)).toEqual([
      failedRun.run.id,
      triggerRun.run.id,
    ]);
  });

  it("starts workflow test runs asynchronously when requested", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_async_test_run",
      name: "Async test run",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "wait",
          type: "builtin.sleep",
          delayMs: 1000,
          next: ["log_done"],
        },
        {
          id: "log_done",
          type: "builtin.log.info",
          message: "async complete",
        },
      ],
    });
    expect(res.status).toBe(201);

    const startedAt = Date.now();
    res = await jsonReq("/api/workflows/wf_async_test_run/runs/test", {
      input: { marker: "async" },
      async: true,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(500);
    const initial = (await res.json()) as {
      run: { id: string; status: string; currentNodeId?: string | null };
    };
    expect(initial.run.status).toBe("running");

    let detail:
      | {
          run: { status: string };
          steps: Array<{ nodeId: string; status: string }>;
          events: Array<{ kind: string; message?: string }>;
        }
      | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      res = await req(`/api/workflow-runs/${initial.run.id}`);
      expect(res.status).toBe(200);
      detail = (await res.json()) as typeof detail;
      if (detail?.run.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(detail?.run.status).toBe("succeeded");
    expect(detail?.steps.map((step) => [step.nodeId, step.status])).toEqual([
      ["wait", "succeeded"],
      ["log_done", "succeeded"],
    ]);
    expect(detail?.events.map((event) => event.kind)).toContain("log");
  });

  it("executes multiple workflow test runs concurrently without sharing run state", async () => {
    for (const workflow of [
      { id: "wf_concurrent_alpha", message: "alpha complete" },
      { id: "wf_concurrent_beta", message: "beta complete" },
    ]) {
      const res = await jsonReq("/api/workflows", {
        id: workflow.id,
        name: workflow.id,
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "wait",
            type: "builtin.sleep",
            delayMs: 250,
            next: ["log_done"],
          },
          {
            id: "log_done",
            type: "builtin.log.info",
            message: workflow.message,
          },
        ],
      });
      expect(res.status).toBe(201);
    }

    const [alphaRes, betaRes] = await Promise.all([
      jsonReq("/api/workflows/wf_concurrent_alpha/runs/test", {
        input: { marker: "alpha" },
      }),
      jsonReq("/api/workflows/wf_concurrent_beta/runs/test", {
        input: { marker: "beta" },
      }),
    ]);

    expect(alphaRes.status).toBe(201);
    expect(betaRes.status).toBe(201);
    const [alpha, beta] = (await Promise.all([
      alphaRes.json(),
      betaRes.json(),
    ])) as Array<{
      run: {
        id: string;
        workflowId: string;
        status: string;
        input: unknown;
        startedAt: string;
        endedAt: string;
      };
      steps: Array<{ nodeId: string; status: string }>;
      events: Array<{ kind: string; message?: string }>;
    }>;

    expect(alpha.run).toMatchObject({
      workflowId: "wf_concurrent_alpha",
      status: "succeeded",
      input: { marker: "alpha" },
    });
    expect(beta.run).toMatchObject({
      workflowId: "wf_concurrent_beta",
      status: "succeeded",
      input: { marker: "beta" },
    });
    expect(alpha.run.id).not.toBe(beta.run.id);
    expect(alpha.steps.map((step) => [step.nodeId, step.status])).toEqual([
      ["wait", "succeeded"],
      ["log_done", "succeeded"],
    ]);
    expect(beta.steps.map((step) => [step.nodeId, step.status])).toEqual([
      ["wait", "succeeded"],
      ["log_done", "succeeded"],
    ]);
    expect(alpha.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "log",
          message: "alpha complete",
        }),
      ]),
    );
    expect(beta.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "log",
          message: "beta complete",
        }),
      ]),
    );

    const alphaStarted = new Date(alpha.run.startedAt).getTime();
    const alphaEnded = new Date(alpha.run.endedAt).getTime();
    const betaStarted = new Date(beta.run.startedAt).getTime();
    const betaEnded = new Date(beta.run.endedAt).getTime();
    expect(alphaStarted).toBeLessThan(betaEnded);
    expect(betaStarted).toBeLessThan(alphaEnded);

    expect(runtime.workflowStore.listRuns()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: alpha.run.id,
          workflowId: "wf_concurrent_alpha",
          status: "succeeded",
        }),
        expect.objectContaining({
          id: beta.run.id,
          workflowId: "wf_concurrent_beta",
          status: "succeeded",
        }),
      ]),
    );
  });

  it("runs MCP workflow steps through HTTP with persisted trace", async () => {
    const calls: unknown[] = [];
    const observedDuringTool: Array<{
      status: string;
      currentNodeId: string | null;
      steps: Array<{ nodeId: string; status: string }>;
    }> = [];
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool(req) {
          calls.push(req);
          const [run] = runtime.workflowStore.listRuns({
            workflowId: "wf_mcp_http",
          });
          if (run) {
            observedDuringTool.push({
              status: run.status,
              currentNodeId: run.currentNodeId,
              steps: runtime.workflowStore
                .listStepAttempts(run.id)
                .map((step) => ({
                  nodeId: step.nodeId,
                  status: step.status,
                })),
            });
          }
          return {
            output: {
              id: "cust_1",
              score: 91,
            },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_mcp_http",
      name: "MCP HTTP",
      nodes: [
        {
          id: "crm_lookup",
          type: "mcp.tool",
          server: "crm",
          tool: "lookup",
          input: { id: "$.workflowTrigger.input.customerId" },
          assign: {
            crm: "$.steps.crm_lookup.output.result",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_mcp_http/runs/test", {
      input: { customerId: "cust_1" },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: {
        status: string;
        context: unknown;
        currentNodeId: string | null;
      };
      steps: Array<{
        nodeId: string;
        status: string;
        input?: unknown;
        output?: unknown;
      }>;
      events: Array<{ kind: string; sequence: number }>;
    };
    expect(calls).toEqual([
      {
        server: "crm",
        tool: "lookup",
        input: { id: "cust_1" },
        timeoutMs: undefined,
        signal: expect.objectContaining({ aborted: false }),
      },
    ]);
    expect(observedDuringTool).toEqual([
      {
        status: "running",
        currentNodeId: "crm_lookup",
        steps: [{ nodeId: "crm_lookup", status: "running" }],
      },
    ]);
    expect(detail.run).toMatchObject({
      status: "succeeded",
      context: { crm: { id: "cust_1", score: 91 } },
      currentNodeId: null,
    });
    expect(detail.steps[0]).toMatchObject({
      nodeId: "crm_lookup",
      status: "succeeded",
      output: {
        server: "crm",
        tool: "lookup",
        result: { id: "cust_1", score: 91 },
      },
    });
    expect(detail.events.map((event) => [event.sequence, event.kind])).toEqual([
      [1, "run_started"],
      [2, "step_started"],
      [3, "step_output"],
      [4, "step_completed"],
      [5, "run_completed"],
    ]);
  });

  it("spills large workflow step outputs through the deployed store seam", async () => {
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool() {
          return {
            output: {
              records: "x".repeat(70_000),
              apiKey: "raw-route-spill-key",
            },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_spill_http",
      name: "Spill HTTP",
      nodes: [
        {
          id: "large_output",
          type: "mcp.tool",
          server: "crm",
          tool: "large_export",
          input: {},
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_spill_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        id: string;
        nodeId: string;
        output?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      events: Array<{
        kind: string;
        payload?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    expect(detail.run.status).toBe("succeeded");
    const artifactRef = detail.steps[0]?.output?.artifact;
    expect(artifactRef).toMatchObject({
      kind: "step_output",
      path: expect.stringMatching(
        new RegExp(`^runs/${detail.run.id}/steps/.+/output\\.json$`),
      ),
      preview: expect.stringContaining('"records"'),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(detail.steps[0]?.output)).not.toContain(
      "raw-route-spill-key",
    );
    const eventArtifactRef = detail.events.find(
      (event) => event.kind === "step_output",
    )?.payload?.artifact;
    expect(eventArtifactRef).toMatchObject({
      kind: "event_payload",
      path: expect.stringMatching(
        new RegExp(`^runs/${detail.run.id}/events/.+/payload\\.json$`),
      ),
      preview: expect.stringContaining('"records"'),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(eventArtifactRef)).not.toContain(
      "raw-route-spill-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: artifactRef?.id,
          runId: detail.run.id,
          stepRunId: detail.steps[0]?.id,
          kind: "step_output",
          path: artifactRef?.path,
          preview: artifactRef?.preview,
        }),
        expect.objectContaining({
          id: eventArtifactRef?.id,
          runId: detail.run.id,
          stepRunId: detail.steps[0]?.id,
          kind: "event_payload",
          path: eventArtifactRef?.path,
          preview: eventArtifactRef?.preview,
        }),
      ]),
    );
    expect(detail.artifacts).toHaveLength(2);

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      artifactRef?.path ?? "",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-route-spill-key");

    const eventArtifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      eventArtifactRef?.path ?? "",
    );
    expect(existsSync(eventArtifactPath)).toBe(true);
    const eventArtifactJson = readFileSync(eventArtifactPath, "utf8");
    expect(eventArtifactJson).toContain('"[redacted]"');
    expect(eventArtifactJson).not.toContain("raw-route-spill-key");
  });

  it("persists spilled step-start payload artifacts after creating the running step", async () => {
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool(req) {
          return { output: req.input };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_step_start_spill_http",
      name: "Step Start Spill HTTP",
      nodes: [
        {
          id: "large_echo",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: {
            records: "x".repeat(70_000),
            apiKey: "raw-step-start-spill-key",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_step_start_spill_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{ id: string; status: string }>;
      events: Array<{
        kind: string;
        payload?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
      }>;
    };

    expect(detail.run.status).toBe("succeeded");
    expect(detail.steps[0]).toMatchObject({
      nodeId: "large_echo",
      status: "succeeded",
    });
    const startedRef = detail.events.find(
      (event) => event.kind === "step_started",
    )?.payload?.artifact;
    expect(startedRef).toMatchObject({
      kind: "event_payload",
      path: expect.stringMatching(
        new RegExp(`^runs/${detail.run.id}/events/.+/payload\\.json$`),
      ),
      preview: expect.stringContaining('"nodeId"'),
      byteLength: expect.any(Number),
    });
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: startedRef?.id,
          runId: detail.run.id,
          stepRunId: detail.steps[0]?.id,
          kind: "event_payload",
          path: startedRef?.path,
        }),
      ]),
    );
    expect(JSON.stringify(startedRef)).not.toContain(
      "raw-step-start-spill-key",
    );
  });

  it("serves workflow artifact content through a run-owned API route", async () => {
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool() {
          return {
            output: {
              records: "x".repeat(70_000),
              apiKey: "raw-route-download-key",
            },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_artifact_content_http",
      name: "Artifact Content HTTP",
      nodes: [
        {
          id: "large_output",
          type: "mcp.tool",
          server: "crm",
          tool: "large_export",
          input: {},
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_artifact_content_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string };
      steps: Array<{
        output?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
          };
        };
      }>;
    };
    const artifactRef = detail.steps[0]?.output?.artifact;
    expect(artifactRef).toBeDefined();

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}`,
    );
    expect(res.status).toBe(200);
    const artifactContent = (await res.json()) as {
      artifact: {
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
      };
      content: unknown;
    };
    expect(artifactContent.artifact).toMatchObject({
      id: artifactRef!.id,
      runId: detail.run.id,
      kind: "step_output",
      path: artifactRef!.path,
    });
    expect(artifactContent.content).toMatchObject({
      server: "crm",
      tool: "large_export",
      result: {
        records: expect.stringContaining("xxx"),
        apiKey: "[redacted]",
      },
    });
    expect(JSON.stringify(artifactContent)).not.toContain(
      "raw-route-download-key",
    );

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(
      `${artifactRef!.id}.json`,
    );
    const downloadedArtifact = await res.text();
    expect(downloadedArtifact).toContain('"apiKey": "[redacted]"');
    expect(downloadedArtifact).not.toContain("raw-route-download-key");

    res = await jsonReq("/api/workflows/wf_artifact_content_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const otherDetail = (await res.json()) as { run: { id: string } };

    res = await req(
      `/api/workflow-runs/${otherDetail.run.id}/artifacts/${artifactRef!.id}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "artifact_not_found" });

    runtime.workflowStore.recordArtifact({
      id: "artifact_escape",
      runId: detail.run.id,
      kind: "step_output",
      path: "../state.db",
      preview: null,
    });
    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/artifact_escape`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "artifact_not_found" });
  });

  it("prunes old workflow artifact files through an admin API route", async () => {
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool() {
          return {
            output: {
              records: "x".repeat(70_000),
              apiKey: "raw-route-prune-key",
            },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_artifact_prune_http",
      name: "Artifact Prune HTTP",
      nodes: [
        {
          id: "large_output",
          type: "mcp.tool",
          server: "crm",
          tool: "large_export",
          input: {},
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_artifact_prune_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string };
      steps: Array<{
        output?: {
          artifact?: {
            id: string;
            path: string;
          };
        };
      }>;
      artifacts: Array<{ id: string; path: string }>;
    };
    const artifactRef = detail.steps[0]?.output?.artifact;
    expect(artifactRef).toBeDefined();
    expect(detail.artifacts).toHaveLength(2);

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      artifactRef!.path,
    );
    expect(existsSync(artifactPath)).toBe(true);

    res = await jsonReq("/api/workflow-artifacts/prune", {
      createdBefore: "2999-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scannedArtifacts: 2,
      deletedFiles: 2,
      missingFiles: 0,
      skippedUnsafePaths: 0,
    });
    expect(existsSync(artifactPath)).toBe(false);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const detailAfterPrune = (await res.json()) as {
      artifacts: Array<{ id: string; path: string }>;
    };
    expect(detailAfterPrune.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: artifactRef!.id,
          path: artifactRef!.path,
        }),
      ]),
    );

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "artifact_not_found" });

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}/download`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "artifact_not_found" });

    res = await jsonReq("/api/workflow-artifacts/prune", {
      createdBefore: "not-a-date",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid body" });
  });

  it("spills large final workflow context through the deployed store seam", async () => {
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool() {
          return {
            output: {
              records: "x".repeat(70_000),
              apiKey: "raw-route-context-key",
            },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_context_spill_http",
      name: "Context Spill HTTP",
      nodes: [
        {
          id: "large_context",
          type: "mcp.tool",
          server: "crm",
          tool: "large_context",
          input: {},
          assign: {
            export: "$.steps.large_context.output.result",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_context_spill_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: {
        id: string;
        status: string;
        context?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      };
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    expect(detail.run.status).toBe("succeeded");
    const contextArtifactRef = detail.run.context?.artifact;
    expect(contextArtifactRef).toMatchObject({
      kind: "run_context",
      path: `runs/${detail.run.id}/context.json`,
      preview: expect.stringContaining('"records"'),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(detail.run.context)).not.toContain(
      "raw-route-context-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: contextArtifactRef?.id,
          runId: detail.run.id,
          stepRunId: null,
          kind: "run_context",
          path: contextArtifactRef?.path,
          preview: contextArtifactRef?.preview,
        }),
      ]),
    );

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      contextArtifactRef?.path ?? "",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-route-context-key");
  });

  it("spills large workflow run inputs through the deployed store seam", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_run_input_spill_http",
      name: "Run Input Spill HTTP",
      nodes: [
        {
          id: "set_customer_id",
          type: "builtin.set",
          assign: {
            customerId: "$.workflowTrigger.input.customer.id",
          },
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_run_input_spill_http/runs/test", {
      input: {
        customer: {
          id: "cust_route_input_spill",
          records: "x".repeat(70_000),
          apiKey: "raw-route-run-input-key",
        },
      },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: {
        id: string;
        status: string;
        context?: {
          customerId?: string;
        };
        input?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      };
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.context?.customerId).toBe("cust_route_input_spill");
    const inputArtifactRef = detail.run.input?.artifact;
    expect(inputArtifactRef).toMatchObject({
      kind: "run_input",
      path: `runs/${detail.run.id}/input.json`,
      preview: expect.stringContaining('"cust_route_input_spill"'),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(detail.run.input)).not.toContain(
      "raw-route-run-input-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: inputArtifactRef?.id,
          runId: detail.run.id,
          stepRunId: null,
          kind: "run_input",
          path: inputArtifactRef?.path,
          preview: inputArtifactRef?.preview,
        }),
      ]),
    );

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      inputArtifactRef?.path ?? "",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-route-run-input-key");

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${inputArtifactRef!.id}`,
    );
    expect(res.status).toBe(200);
    const artifactContent = (await res.json()) as { content: unknown };
    expect(artifactContent.content).toMatchObject({
      customer: {
        id: "cust_route_input_spill",
        apiKey: "[redacted]",
      },
    });
    expect(JSON.stringify(artifactContent)).not.toContain(
      "raw-route-run-input-key",
    );

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${inputArtifactRef!.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(
      `${inputArtifactRef!.id}.json`,
    );
    const downloaded = await res.text();
    expect(downloaded).toContain('"apiKey": "[redacted]"');
    expect(downloaded).not.toContain("raw-route-run-input-key");
  });

  it("spills large workflow step logs summaries through the deployed store seam", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_logs_spill_http",
      name: "Logs Spill HTTP",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_logs_spill_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const initialDetail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        id: string;
        nodeId: string;
        attempt: number;
        status: string;
        startedAt: string | null;
        endedAt: string | null;
        durationMs: number | null;
        input?: unknown;
        output?: unknown;
        error?: unknown;
        contextDiff?: unknown;
      }>;
    };
    expect(initialDetail.run.status).toBe("succeeded");
    const exitStep = initialDetail.steps[0];
    expect(exitStep).toBeDefined();

    runtime.workflowStore.recordStepAttempt({
      id: exitStep!.id,
      runId: initialDetail.run.id,
      nodeId: exitStep!.nodeId,
      attempt: exitStep!.attempt,
      status: "succeeded",
      startedAt: exitStep!.startedAt,
      endedAt: exitStep!.endedAt,
      durationMs: exitStep!.durationMs,
      input: exitStep!.input,
      output: exitStep!.output,
      error: exitStep!.error,
      logsSummary: {
        lines: ["large route log summary", "x".repeat(70_000)],
        apiKey: "raw-route-logs-key",
      },
      contextDiff: exitStep!.contextDiff,
    });

    res = await req(`/api/workflow-runs/${initialDetail.run.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      run: { id: string };
      steps: Array<{
        id: string;
        logsSummary?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    const logsArtifactRef = detail.steps[0]?.logsSummary?.artifact;
    expect(logsArtifactRef).toMatchObject({
      kind: "step_logs_summary",
      path: expect.stringMatching(
        new RegExp(`^runs/${detail.run.id}/steps/.+/logs-summary\\.json$`),
      ),
      preview: expect.stringContaining("large route log summary"),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(detail.steps[0]?.logsSummary)).not.toContain(
      "raw-route-logs-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: logsArtifactRef?.id,
          runId: detail.run.id,
          stepRunId: detail.steps[0]?.id,
          kind: "step_logs_summary",
          path: logsArtifactRef?.path,
          preview: logsArtifactRef?.preview,
        }),
      ]),
    );

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      logsArtifactRef?.path ?? "",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-route-logs-key");
  });

  it("spills large workflow step context diffs through the deployed store seam", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_context_diff_spill_http",
      name: "Context Diff Spill HTTP",
      nodes: [
        {
          id: "set_profile",
          type: "builtin.set",
          assign: {
            profile: "$.workflowTrigger.input.profile",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_context_diff_spill_http/runs/test", {
      input: {
        profile: {
          id: "cust_route_context_diff",
          records: "x".repeat(70_000),
          apiKey: "raw-route-context-diff-key",
        },
      },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        id: string;
        nodeId: string;
        contextDiff?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    expect(detail.run.status).toBe("succeeded");
    const step = detail.steps.find((item) => item.nodeId === "set_profile");
    const contextDiffRef = step?.contextDiff?.artifact;
    expect(contextDiffRef).toMatchObject({
      kind: "step_context_diff",
      preview: expect.stringContaining('"cust_route_context_diff"'),
      byteLength: expect.any(Number),
    });
    expect(contextDiffRef?.path).toMatch(
      new RegExp(`^runs/${detail.run.id}/steps/.+/context-diff\\.json$`),
    );
    expect(JSON.stringify(step?.contextDiff)).not.toContain(
      "raw-route-context-diff-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: contextDiffRef?.id,
          runId: detail.run.id,
          stepRunId: step?.id,
          kind: "step_context_diff",
          path: contextDiffRef?.path,
          preview: contextDiffRef?.preview,
        }),
      ]),
    );

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      contextDiffRef?.path ?? "",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-route-context-diff-key");

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${contextDiffRef!.id}`,
    );
    expect(res.status).toBe(200);
    const artifactContent = (await res.json()) as { content: unknown };
    expect(artifactContent.content).toMatchObject({
      profile: {
        after: {
          id: "cust_route_context_diff",
          apiKey: "[redacted]",
        },
      },
    });
    expect(JSON.stringify(artifactContent)).not.toContain(
      "raw-route-context-diff-key",
    );

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${contextDiffRef!.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(
      `${contextDiffRef!.id}.json`,
    );
    const downloaded = await res.text();
    expect(downloaded).toContain('"apiKey": "[redacted]"');
    expect(downloaded).not.toContain("raw-route-context-diff-key");
  });

  it("spills large workflow step errors through the deployed store seam", async () => {
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool() {
          throw Object.assign(new Error("large route failure"), {
            details: {
              records: "x".repeat(70_000),
              apiKey: "raw-route-error-key",
            },
          });
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_error_spill_http",
      name: "Error Spill HTTP",
      nodes: [
        {
          id: "large_error",
          type: "mcp.tool",
          server: "crm",
          tool: "large_failure",
          input: {},
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_error_spill_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        id: string;
        nodeId: string;
        status: string;
        error?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    expect(detail.run.status).toBe("failed");
    const errorArtifactRef = detail.steps[0]?.error?.artifact;
    expect(errorArtifactRef).toMatchObject({
      kind: "step_error",
      path: expect.stringMatching(
        new RegExp(`^runs/${detail.run.id}/steps/.+/error\\.json$`),
      ),
      preview: expect.stringContaining("large route failure"),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(detail.steps[0]?.error)).not.toContain(
      "raw-route-error-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: errorArtifactRef?.id,
          runId: detail.run.id,
          stepRunId: detail.steps[0]?.id,
          kind: "step_error",
          path: errorArtifactRef?.path,
          preview: errorArtifactRef?.preview,
        }),
      ]),
    );

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      errorArtifactRef?.path ?? "",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-route-error-key");
  });

  it("preserves cancellation when execution finishes after cancel", async () => {
    const cancelResponses: Array<{ status: number; runStatus?: string }> = [];
    const signalStates: Array<{
      beforeCancel: boolean | null;
      afterCancel: boolean | null;
    }> = [];
    await replaceAppWithWorkflowPorts({
      mcp: {
        async callTool(req) {
          const signal = (
            req as typeof req & {
              signal?: AbortSignal;
            }
          ).signal;
          const [run] = runtime.workflowStore.listRuns({
            workflowId: "wf_cancel_during_execution",
          });
          expect(run).toBeDefined();
          const beforeCancel = signal?.aborted ?? null;
          const cancelRes = await jsonReq(
            `/api/workflow-runs/${run!.id}/cancel`,
            {},
          );
          const cancelDetail = (await cancelRes.json()) as {
            run?: { status: string };
          };
          cancelResponses.push({
            status: cancelRes.status,
            runStatus: cancelDetail.run?.status,
          });
          signalStates.push({
            beforeCancel,
            afterCancel: signal?.aborted ?? null,
          });
          return { output: { id: "cust_cancel", score: 99 } };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_cancel_during_execution",
      name: "Cancel During Execution",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "Starting cancelable workflow",
          payload: "$.workflowTrigger.input.customerId",
          next: ["crm_lookup"],
        },
        {
          id: "crm_lookup",
          type: "mcp.tool",
          server: "crm",
          tool: "lookup",
          input: {
            id: "$.workflowTrigger.input.customerId",
            apiKey: "$.workflowTrigger.input.apiKey",
          },
          assign: {
            crm: "$.steps.crm_lookup.output.result",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_cancel_during_execution/runs/test", {
      input: { customerId: "cust_cancel", apiKey: "raw-cancel-api-key" },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; currentNodeId: string | null };
      steps: Array<{
        nodeId: string;
        status: string;
        input?: unknown;
        endedAt?: string | null;
        durationMs?: number | null;
      }>;
      events: Array<{ kind: string; payload?: unknown }>;
    };
    expect(cancelResponses).toEqual([{ status: 200, runStatus: "canceled" }]);
    expect(signalStates).toEqual([{ beforeCancel: false, afterCancel: true }]);
    expect(detail.run).toMatchObject({
      status: "canceled",
      currentNodeId: null,
    });
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "start_log",
        status: "succeeded",
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        nodeId: "crm_lookup",
        status: "canceled",
        input: {
          server: "crm",
          tool: "lookup",
          input: { id: "cust_cancel", apiKey: "[redacted]" },
          assign: {
            crm: {
              from: "$.steps.crm_lookup.output.result",
              mode: "replace",
            },
          },
        },
      }),
    ]);
    expect(JSON.stringify(detail)).not.toContain("raw-cancel-api-key");
    expect(
      detail.events.find(
        (event) =>
          event.kind === "step_started" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "nodeId" in event.payload &&
          event.payload.nodeId === "crm_lookup" &&
          "input" in event.payload,
      )?.payload,
    ).toMatchObject({
      input: {
        input: { id: "cust_cancel", apiKey: "[redacted]" },
      },
    });
    expect(detail.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "log",
      "step_completed",
      "step_started",
      "run_canceled",
    ]);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as {
      run: { status: string };
      steps: Array<{
        nodeId: string;
        status: string;
        input?: unknown;
        endedAt?: string | null;
        durationMs?: number | null;
      }>;
      events: Array<{ kind: string; payload?: unknown }>;
    };
    expect(persisted.run.status).toBe("canceled");
    expect(persisted.steps).toEqual([
      expect.objectContaining({
        nodeId: "start_log",
        status: "succeeded",
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        nodeId: "crm_lookup",
        status: "canceled",
        input: {
          server: "crm",
          tool: "lookup",
          input: { id: "cust_cancel", apiKey: "[redacted]" },
          assign: {
            crm: {
              from: "$.steps.crm_lookup.output.result",
              mode: "replace",
            },
          },
        },
      }),
    ]);
    expect(JSON.stringify(persisted)).not.toContain("raw-cancel-api-key");
    expect(
      persisted.events.find(
        (event) =>
          event.kind === "step_started" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "nodeId" in event.payload &&
          event.payload.nodeId === "crm_lookup" &&
          "input" in event.payload,
      )?.payload,
    ).toMatchObject({
      input: {
        input: { id: "cust_cancel", apiKey: "[redacted]" },
      },
    });
    expect(persisted.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "log",
      "step_completed",
      "step_started",
      "run_canceled",
    ]);
  });

  it("keeps durable event persistence independent from observer event port failures", async () => {
    const observedEventKinds: string[] = [];
    await replaceAppWithWorkflowPorts({
      events: {
        async append(event) {
          observedEventKinds.push(event.kind);
          throw new Error("observer_down");
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_observer_event_failure",
      name: "Observer Event Failure",
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_observer_event_failure/runs/test", {
      input: { customer: { id: "cust_1", name: "Ada" } },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { status: string; context: unknown };
      events: Array<{ kind: string; sequence: number }>;
    };

    expect(observedEventKinds).toContain("run_started");
    expect(detail.run).toMatchObject({
      status: "succeeded",
      context: { customer: { id: "cust_1", name: "Ada" } },
    });
    expect(detail.events.map((event) => [event.sequence, event.kind])).toEqual([
      [1, "run_started"],
      [2, "step_started"],
      [3, "step_completed"],
      [4, "run_completed"],
    ]);
  });

  it("runs agent.call workflow steps through HTTP with persisted trace", async () => {
    const calls: unknown[] = [];
    await replaceAppWithWorkflowPorts({
      agent: {
        listAgents: () => [],
        async callAgent(req) {
          calls.push(req);
          return {
            sessionId: "agent_session_1",
            output: {
              response: "Support says cust_1 is ready",
              sessionId: "agent_session_1",
            },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_agent_http",
      name: "Agent HTTP",
      nodes: [
        {
          id: "ask_support",
          type: "agent.call",
          agentId: "support",
          prompt: "Review {{$.workflowTrigger.input.customerId}}",
          input: { customerId: "$.workflowTrigger.input.customerId" },
          assign: {
            support: "$.steps.ask_support.output",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_agent_http/runs/test", {
      input: { customerId: "cust_1" },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: {
        id: string;
        status: string;
        context: unknown;
        durationMs: number | null;
      };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{ kind: string }>;
    };
    expect(calls).toEqual([
      {
        agentId: "support",
        prompt: "Review cust_1",
        input: { customerId: "cust_1" },
        runId: detail.run.id,
        timeoutMs: undefined,
        signal: expect.objectContaining({ aborted: false }),
      },
    ]);
    expect(detail.run).toMatchObject({
      status: "succeeded",
      context: {
        support: {
          response: "Support says cust_1 is ready",
          sessionId: "agent_session_1",
        },
      },
    });
    expect(detail.steps[0]).toMatchObject({
      nodeId: "ask_support",
      status: "succeeded",
      input: {
        agentId: "support",
        prompt: "Review cust_1",
        input: { customerId: "cust_1" },
      },
      output: {
        response: "Support says cust_1 is ready",
        sessionId: "agent_session_1",
      },
    });
    expect(detail.events.map((event) => event.kind)).toContain("step_output");
  });

  it("propagates cancellation to agent.call workflow steps", async () => {
    const cancelResponses: Array<{ status: number; runStatus?: string }> = [];
    const signalStates: Array<{
      beforeCancel: boolean | null;
      afterCancel: boolean | null;
    }> = [];
    await replaceAppWithWorkflowPorts({
      agent: {
        listAgents: () => [],
        async callAgent(req) {
          const signal = (
            req as typeof req & {
              signal?: AbortSignal;
            }
          ).signal;
          const [run] = runtime.workflowStore.listRuns({
            workflowId: "wf_agent_cancel_http",
          });
          expect(run).toBeDefined();
          const beforeCancel = signal?.aborted ?? null;
          const cancelRes = await jsonReq(
            `/api/workflow-runs/${run!.id}/cancel`,
            {},
          );
          const cancelDetail = (await cancelRes.json()) as {
            run?: { status: string };
          };
          cancelResponses.push({
            status: cancelRes.status,
            runStatus: cancelDetail.run?.status,
          });
          signalStates.push({
            beforeCancel,
            afterCancel: signal?.aborted ?? null,
          });
          return {
            sessionId: "agent_cancel_session",
            output: { response: "late agent output" },
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_agent_cancel_http",
      name: "Agent Cancel HTTP",
      nodes: [
        {
          id: "ask_support",
          type: "agent.call",
          agentId: "support",
          prompt: "Review",
          assign: {
            support: "$.steps.ask_support.output",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_agent_cancel_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { status: string; currentNodeId: string | null; context: unknown };
      steps: Array<{ nodeId: string; status: string }>;
      events: Array<{ kind: string }>;
    };

    expect(cancelResponses).toEqual([{ status: 200, runStatus: "canceled" }]);
    expect(signalStates).toEqual([{ beforeCancel: false, afterCancel: true }]);
    expect(detail.run).toMatchObject({
      status: "canceled",
      currentNodeId: null,
      context: {},
    });
    expect(detail.steps).toEqual([
      expect.objectContaining({ nodeId: "ask_support", status: "canceled" }),
    ]);
    expect(detail.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_canceled",
    ]);
  });

  it("runs foreach and Python workflow steps through HTTP with persisted item traces", async () => {
    const calls: unknown[] = [];
    await replaceAppWithWorkflowPorts({
      python: {
        async execute(req) {
          calls.push(req);
          const input = req.input as { value: number };
          return {
            output: input.value * 2,
            stdout: `doubled ${input.value}\n`,
            stderr: "",
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_foreach_python_http",
      name: "Foreach Python HTTP",
      nodes: [
        {
          id: "each_value",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.values",
          body: ["double_value"],
          concurrency: 1,
        },
        {
          id: "double_value",
          type: "builtin.python",
          input: { value: "item" },
          code: "output = input['value'] * 2",
          timeoutMs: 1000,
          assign: {
            doubled: {
              from: "$.steps.double_value.output.value",
              mode: "append",
            },
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_foreach_python_http/runs/test", {
      input: { values: [2, 5] },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { status: string; context: unknown };
      steps: Array<{
        nodeId: string;
        attempt: number;
        status: string;
        input?: unknown;
        output?: unknown;
      }>;
      events: Array<{ kind: string }>;
    };

    expect(detail.run).toMatchObject({
      status: "succeeded",
      context: { doubled: [4, 10] },
    });
    expect(calls).toEqual([
      {
        code: "output = input['value'] * 2",
        input: { value: 2 },
        reset: undefined,
        timeoutMs: 1000,
        signal: expect.objectContaining({ aborted: false }),
      },
      {
        code: "output = input['value'] * 2",
        input: { value: 5 },
        reset: undefined,
        timeoutMs: 1000,
        signal: expect.objectContaining({ aborted: false }),
      },
    ]);
    expect(
      detail.steps
        .filter((step) => step.nodeId === "double_value")
        .map((step) => [step.attempt, step.status, step.input, step.output]),
    ).toEqual([
      [
        1,
        "succeeded",
        {
          code: "output = input['value'] * 2",
          input: { value: 2 },
          timeoutMs: 1000,
          assign: {
            doubled: {
              from: "$.steps.double_value.output.value",
              mode: "append",
              value: 4,
            },
          },
        },
        { value: 4, stdout: "doubled 2\n", stderr: "" },
      ],
      [
        2,
        "succeeded",
        {
          code: "output = input['value'] * 2",
          input: { value: 5 },
          timeoutMs: 1000,
          assign: {
            doubled: {
              from: "$.steps.double_value.output.value",
              mode: "append",
              value: 10,
            },
          },
        },
        { value: 10, stdout: "doubled 5\n", stderr: "" },
      ],
    ]);
    expect(
      detail.steps.find((step) => step.nodeId === "each_value")?.output,
    ).toMatchObject({
      count: 2,
      succeededCount: 2,
      failedCount: 0,
      items: [
        {
          index: 0,
          status: "succeeded",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          durationMs: expect.any(Number),
          steps: { double_value: { value: 4 } },
        },
        {
          index: 1,
          status: "succeeded",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          durationMs: expect.any(Number),
          steps: { double_value: { value: 10 } },
        },
      ],
    });
    expect(
      detail.events
        .filter((event) => event.message?.includes("Foreach item"))
        .map((event) => [
          event.message,
          (event.payload as { index?: number; status?: string } | undefined)
            ?.index,
          (event.payload as { index?: number; status?: string } | undefined)
            ?.status,
        ]),
    ).toEqual([
      ["Foreach item 1 started", 0, undefined],
      ["Foreach item 1 completed", 0, "succeeded"],
      ["Foreach item 2 started", 1, undefined],
      ["Foreach item 2 completed", 1, "succeeded"],
    ]);
    expect(detail.events.map((event) => event.kind)).toContain("step_output");
  });

  it("spills large Python workflow outputs through the deployed store seam", async () => {
    await replaceAppWithWorkflowPorts({
      python: {
        async execute() {
          return {
            output: {
              records: "x".repeat(70_000),
              apiKey: "raw-route-python-output-key",
            },
            stdout: "python large output\n",
            stderr: "",
          };
        },
      },
    });

    let res = await jsonReq("/api/workflows", {
      id: "wf_python_output_spill_http",
      name: "Python Output Spill HTTP",
      nodes: [
        {
          id: "large_python",
          type: "builtin.python",
          input: {},
          code: "output = {'records': 'x' * 70000}",
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_python_output_spill_http/runs/test",
      {
        input: {},
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        id: string;
        nodeId: string;
        output?: {
          artifact?: {
            id: string;
            kind: string;
            path: string;
            preview: string;
            byteLength: number;
          };
        };
      }>;
      artifacts: Array<{
        id: string;
        runId: string;
        stepRunId: string | null;
        kind: string;
        path: string;
        preview: string | null;
      }>;
    };

    expect(detail.run.status).toBe("succeeded");
    const step = detail.steps.find((item) => item.nodeId === "large_python");
    const artifactRef = step?.output?.artifact;
    expect(artifactRef).toMatchObject({
      kind: "step_output",
      path: expect.stringMatching(
        new RegExp(`^runs/${detail.run.id}/steps/.+/output\\.json$`),
      ),
      preview: expect.stringContaining('"value"'),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(step?.output)).not.toContain(
      "raw-route-python-output-key",
    );
    expect(detail.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: artifactRef?.id,
          runId: detail.run.id,
          stepRunId: step?.id,
          kind: "step_output",
          path: artifactRef?.path,
          preview: artifactRef?.preview,
        }),
      ]),
    );

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}`,
    );
    expect(res.status).toBe(200);
    const artifactContent = (await res.json()) as {
      content: {
        value?: { apiKey?: string; records?: string };
        stdout?: string;
        stderr?: string;
      };
    };
    expect(artifactContent.content).toMatchObject({
      value: {
        apiKey: "[redacted]",
        records: expect.stringContaining("xxx"),
      },
      stdout: "python large output\n",
      stderr: "",
    });
    expect(JSON.stringify(artifactContent)).not.toContain(
      "raw-route-python-output-key",
    );

    res = await req(
      `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      `${artifactRef!.id}.json`,
    );
    const downloaded = await res.text();
    expect(downloaded).toContain('"apiKey": "[redacted]"');
    expect(downloaded).toContain("python large output");
    expect(downloaded).not.toContain("raw-route-python-output-key");
  });

  it("runs enabled manual triggers and rejects disabled future triggers without creating runs", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_triggers",
      name: "Trigger API",
      triggers: [
        { id: "manual_review", kind: "manual", enabled: true },
        {
          id: "nightly",
          kind: "scheduled",
          enabled: false,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await req("/api/workflows/wf_triggers/triggers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      triggers: [
        {
          id: "manual_review",
          kind: "manual",
          enabled: true,
          runnable: true,
        },
        {
          id: "nightly",
          kind: "scheduled",
          enabled: false,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          runnable: false,
        },
      ],
    });

    res = await jsonReq("/api/workflows/wf_triggers/publish", {});
    expect(res.status).toBe(200);

    res = await jsonReq(
      "/api/workflows/wf_triggers/triggers/manual_review/runs",
      {
        input: { customer: { id: "cust_1", name: "Ada" } },
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; mode: string; trigger: unknown };
    };
    expect(detail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "manual",
        triggerId: "manual_review",
        requestedBy: "operator",
        input: { customer: { id: "cust_1", name: "Ada" } },
      },
    });

    res = await jsonReq("/api/workflows/wf_triggers/triggers/nightly/runs", {
      input: { customer: { id: "cust_2", name: "Lin" } },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "trigger_kind_not_runnable" });

    res = await jsonReq(
      "/api/workflows/wf_triggers/triggers/manual:review/runs",
      { input: { customer: { id: "cust_3", name: "Noor" } } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid triggerId" });

    res = await req("/api/workflows/wf_triggers/runs");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).toEqual([detail.run.id]);

    res = await req("/api/workflow-runs?triggerId=manual_review");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).toContain(detail.run.id);

    res = await req("/api/workflow-runs?triggerId=nightly");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).not.toContain(detail.run.id);

    res = await req(
      `/api/workflow-runs?triggerId=manual_review&createdFrom=2000-01-01&createdTo=${encodeURIComponent(new Date().toISOString())}`,
    );
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map((run: { id: string }) => run.id),
    ).toContain(detail.run.id);

    res = await req(
      "/api/workflow-runs?createdFrom=2030-01-02&createdTo=2030-01-01",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid date range" });

    res = await req(
      "/api/workflows/wf_triggers/runs?triggerId=manual_review&createdTo=2000-01-01",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runs: [],
      hasMore: false,
      nextOffset: null,
    });

    res = await req("/api/workflow-runs?createdFrom=not-a-date");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid createdFrom" });

    res = await req("/api/workflow-runs?createdFrom=2026-02-31");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid createdFrom" });

    res = await req(
      "/api/workflows/wf_triggers/runs?createdTo=2026-02-31T00:00:00Z",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid createdTo" });

    res = await req("/api/workflow-runs?createdFrom=2026-02-28T23:30:00-02:00");
    expect(res.status).toBe(200);

    res = await req(
      `/api/workflow-runs?createdFrom=${encodeURIComponent("2026-02-28 23:30:00")}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid createdFrom" });

    res = await req("/api/workflow-runs?mode=preview");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid mode" });

    res = await req("/api/workflow-runs?mode=test&mode=live");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid mode" });

    res = await req("/api/workflow-runs?workflowId=bad/id");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid workflowId" });

    res = await req(
      "/api/workflow-runs?workflowId=wf_triggers&workflowId=wf_other",
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid workflowId" });

    res = await req("/api/workflow-runs?teamId=team_alpha");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "workflow_scope_unsupported",
    });

    res = await req("/api/workflow-runs?agentId=support");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "workflow_scope_unsupported",
    });

    res = await req("/api/workflows/wf:triggers/runs");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid workflowId" });

    res = await req("/api/workflows/wf_triggers/runs?status=complete");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });

    res = await req("/api/workflow-runs?limit=abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid limit" });

    res = await req("/api/workflow-runs?limit=0");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid limit" });

    res = await req("/api/workflow-runs?limit=1&limit=2");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid limit" });

    res = await req("/api/workflows/wf_triggers/runs?offset=1abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid offset" });

    res = await req("/api/workflows/wf_triggers/runs?offset=-1");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid offset" });

    res = await req("/api/workflows/wf_triggers/runs?offset=0&offset=1");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid offset" });
  });

  it("dispatches enabled scheduled triggers through the workflow dispatcher", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_scheduled_dispatch",
      name: "Scheduled Dispatch API",
      inputSchema: {
        type: "object",
        required: ["customer"],
        properties: {
          customer: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      triggers: [
        {
          id: "invalid_nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: {
            customer: { id: "cust_invalid_scheduled" },
          },
        },
        {
          id: "nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: {
            customer: { id: "cust_scheduled", name: "Scheduled Ada" },
          },
        },
        {
          id: "disabled_nightly",
          kind: "scheduled",
          enabled: false,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
        },
        {
          id: "later",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
        },
      ],
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: { scheduled: true },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await req("/api/workflows/wf_scheduled_dispatch/triggers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      triggers: [
        {
          id: "invalid_nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: {
            customer: { id: "cust_invalid_scheduled" },
          },
          runnable: false,
        },
        {
          id: "nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: {
            customer: { id: "cust_scheduled", name: "Scheduled Ada" },
          },
          runnable: false,
        },
        {
          id: "disabled_nightly",
          kind: "scheduled",
          enabled: false,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          runnable: false,
        },
        {
          id: "later",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
          runnable: false,
        },
      ],
    });

    res = await jsonReq("/api/workflows/wf_scheduled_dispatch/publish", {});
    expect(res.status).toBe(200);

    res = await jsonReq(
      "/api/workflows/wf_scheduled_dispatch/triggers/nightly/runs",
      { input: {} },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "trigger_kind_not_runnable" });

    const firstScan = await runtime.dispatchDueScheduledWorkflowTriggers({
      now: new Date("2026-07-30T02:00:30.000Z"),
    });
    expect(firstScan.scheduledAt).toBe("2026-07-30T02:00:00.000Z");
    expect(firstScan.dispatched).toHaveLength(1);
    expect(firstScan.dispatched[0]).toMatchObject({
      workflowId: "wf_scheduled_dispatch",
      workflowVersion: 2,
      triggerId: "nightly",
      result: {
        run: {
          status: "succeeded",
          mode: "live",
          trigger: {
            kind: "scheduled",
            triggerId: "nightly",
            scheduledAt: "2026-07-30T02:00:00.000Z",
          },
        },
      },
    });
    expect(firstScan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerId: "invalid_nightly",
          reason: "execution_failed",
          error: "Input does not match schema: $.customer.name is required",
        }),
        expect.objectContaining({
          triggerId: "disabled_nightly",
          reason: "disabled",
        }),
        expect.objectContaining({ triggerId: "later", reason: "not_due" }),
      ]),
    );

    const secondScan = await runtime.dispatchDueScheduledWorkflowTriggers({
      now: new Date("2026-07-30T02:00:45.000Z"),
    });
    expect(secondScan.dispatched).toEqual([]);
    expect(secondScan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          triggerId: "nightly",
          reason: "already_dispatched",
        }),
      ]),
    );

    res = await req("/api/workflows/wf_scheduled_dispatch/runs");
    expect(res.status).toBe(200);
    const runs = (await res.json()) as {
      runs: Array<{ id: string; trigger: unknown }>;
    };
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]?.trigger).toEqual({
      kind: "scheduled",
      triggerId: "nightly",
      scheduledAt: "2026-07-30T02:00:00.000Z",
    });

    res = await req(`/api/workflow-runs/${runs.runs[0]!.id}`);
    expect(res.status).toBe(200);
    const scheduledDetail = (await res.json()) as {
      run: { status: string; mode: string; trigger: unknown };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{ kind: string }>;
    };
    expect(scheduledDetail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "scheduled",
        triggerId: "nightly",
        scheduledAt: "2026-07-30T02:00:00.000Z",
      },
    });
    expect(scheduledDetail.steps).toEqual([
      expect.objectContaining({
        nodeId: "exit",
        status: "succeeded",
        output: {
          status: "succeeded",
          output: { scheduled: true },
        },
      }),
    ]);
    expect(scheduledDetail.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "run_started",
        "step_started",
        "step_completed",
        "run_completed",
      ]),
    );
  });

  it("runs enabled webhook triggers through the shared trigger run path", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_webhook_trigger",
      name: "Webhook Trigger API",
      inputSchema: {
        type: "object",
        required: ["customer"],
        properties: {
          customer: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      triggers: [
        {
          id: "incoming_customer",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
          inputSchema: {
            type: "object",
            required: ["source"],
            properties: { source: { const: "crm" } },
          },
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await req("/api/workflows/wf_webhook_trigger/triggers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      triggers: [
        {
          id: "incoming_customer",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
          inputSchema: {
            type: "object",
            required: ["source"],
            properties: { source: { const: "crm" } },
          },
          runnable: true,
        },
      ],
    });

    res = await jsonReq("/api/workflows/wf_webhook_trigger/publish", {});
    expect(res.status).toBe(200);

    res = await jsonReq(
      "/api/workflows/wf_webhook_trigger/triggers/incoming_customer/runs",
      {
        input: { source: "crm", customer: { id: "cust_webhook", name: "Ida" } },
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; mode: string; trigger: unknown };
    };
    expect(detail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "webhook",
        triggerId: "incoming_customer",
      },
    });

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persistedDetail = (await res.json()) as {
      run: { status: string; mode: string; trigger: unknown };
      steps: Array<{ nodeId: string; status: string }>;
      events: Array<{ kind: string }>;
    };
    expect(persistedDetail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "webhook",
        triggerId: "incoming_customer",
      },
    });
    expect(
      persistedDetail.steps.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_customer", "succeeded"],
      ["normalize", "succeeded"],
      ["exit", "succeeded"],
    ]);
    expect(persistedDetail.events.map((event) => event.kind)).toContain(
      "run_completed",
    );

    res = await jsonReq(
      "/api/workflows/wf_webhook_trigger/triggers/incoming_customer/runs",
      {
        input: {
          source: "manual",
          customer: { id: "cust_blocked", name: "Blocked" },
        },
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Trigger input does not match schema: $.source must equal "crm"',
    });

    res = await req("/api/workflows/wf_webhook_trigger/runs");
    expect(res.status).toBe(200);
    expect(
      (await res.json()).runs.map(
        (run: { id: string; trigger?: { triggerId?: string } }) => [
          run.id,
          run.trigger?.triggerId,
        ],
      ),
    ).toEqual([[detail.run.id, "incoming_customer"]]);
  });

  it("accepts public webhook ingress only with the configured trigger secret", async () => {
    const secret = "public-webhook-secret";
    let res = await jsonReq("/api/workflows", {
      id: "wf_public_webhook",
      name: "Public Webhook API",
      inputSchema: {
        type: "object",
        required: ["customer"],
        properties: {
          customer: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      triggers: [
        {
          id: "incoming_customer",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
          secretSha256: sha256(secret),
          inputSchema: {
            type: "object",
            required: ["source"],
            properties: { source: { const: "crm" } },
          },
        },
        {
          id: "open_customer",
          kind: "webhook",
          enabled: true,
          path: "crm/open-customer",
        },
      ],
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_public_webhook/publish", {});
    expect(res.status).toBe(200);

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/incoming_customer",
      {
        source: "crm",
        customer: { id: "cust_public", name: "Public Ada" },
      },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "webhook_secret_invalid" });

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/open_customer",
      {
        source: "crm",
        customer: { id: "cust_open", name: "Open Ada" },
      },
      { "x-openacme-webhook-secret": "unused" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "webhook_secret_required" });

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/incoming:customer",
      {
        source: "crm",
        customer: { id: "cust_public", name: "Public Ada" },
      },
      { "x-openacme-webhook-secret": secret },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid triggerId" });

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/incoming_customer",
      {
        source: "manual",
        customer: { id: "cust_blocked", name: "Blocked" },
      },
      { "x-openacme-webhook-secret": secret },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Trigger input does not match schema: $.source must equal "crm"',
    });

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/incoming_customer",
      {
        source: "crm",
        customer: { id: "cust_public", name: "Public Ada" },
      },
      {
        "x-openacme-webhook-secret": secret,
        "x-openacme-webhook-request-id": "req_public_1",
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; mode: string; trigger: unknown };
    };
    expect(detail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "webhook",
        triggerId: "incoming_customer",
        requestId: "req_public_1",
      },
    });

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/by-path/crm/customer",
      {
        source: "crm",
        customer: { id: "cust_path", name: "Path Ada" },
      },
      {
        "x-openacme-webhook-secret": secret,
        "x-openacme-webhook-request-id": "req_public_path_1",
      },
    );
    expect(res.status).toBe(201);
    const pathDetail = (await res.json()) as {
      run: { id: string; status: string; mode: string; trigger: unknown };
    };
    expect(pathDetail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "webhook",
        triggerId: "incoming_customer",
        requestId: "req_public_path_1",
      },
    });

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const publicDetail = (await res.json()) as {
      run: { status: string; mode: string; trigger: unknown };
      steps: Array<{ nodeId: string; status: string }>;
      events: Array<{ kind: string }>;
    };
    expect(publicDetail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "webhook",
        triggerId: "incoming_customer",
        requestId: "req_public_1",
      },
    });
    expect(
      publicDetail.steps.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_customer", "succeeded"],
      ["normalize", "succeeded"],
      ["exit", "succeeded"],
    ]);
    expect(publicDetail.events.map((event) => event.kind)).toContain(
      "run_completed",
    );

    res = await req(`/api/workflow-runs/${pathDetail.run.id}`);
    expect(res.status).toBe(200);
    const publicPathDetail = (await res.json()) as {
      run: { status: string; mode: string; trigger: unknown };
      steps: Array<{ nodeId: string; status: string }>;
      events: Array<{ kind: string }>;
    };
    expect(publicPathDetail.run).toMatchObject({
      status: "succeeded",
      mode: "live",
      trigger: {
        kind: "webhook",
        triggerId: "incoming_customer",
        requestId: "req_public_path_1",
      },
    });
    expect(
      publicPathDetail.steps.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_customer", "succeeded"],
      ["normalize", "succeeded"],
      ["exit", "succeeded"],
    ]);
    expect(publicPathDetail.events.map((event) => event.kind)).toContain(
      "run_completed",
    );

    res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook/by-path/crm/missing",
      {
        source: "crm",
        customer: { id: "cust_missing", name: "Missing Ada" },
      },
      { "x-openacme-webhook-secret": secret },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "trigger_not_found" });

    res = await req("/api/workflows/wf_public_webhook/runs");
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toHaveLength(2);
  });

  it("rejects public webhook path ingress when published paths are ambiguous", async () => {
    const secret = "public-webhook-secret";
    runtime.workflowStore.createDraft({
      id: "wf_public_webhook_ambiguous",
      name: "Public Webhook Ambiguous API",
      triggers: [
        {
          id: "incoming_customer_a",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
          secretSha256: sha256(secret),
        },
        {
          id: "incoming_customer_b",
          kind: "webhook",
          enabled: true,
          path: "/crm/customer/",
          secretSha256: sha256(secret),
        },
      ],
      nodes: runnableNodes(),
    });
    runtime.workflowStore.publish("wf_public_webhook_ambiguous");

    let res = await publicJsonReq(
      "/api/workflow-webhooks/wf_public_webhook_ambiguous/by-path/crm/customer",
      { customer: { id: "cust_ambiguous", name: "Ambiguous Ada" } },
      { "x-openacme-webhook-secret": secret },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "webhook_path_ambiguous" });

    res = await req("/api/workflows/wf_public_webhook_ambiguous/runs");
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toHaveLength(0);
  });

  it("reruns a past run from its input and rejects cancel for terminal runs", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_rerun",
      name: "Rerun API",
      nodes: runnableNodes(),
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_rerun/runs/test", {
      input: { customer: { id: "cust_1", name: "Ada" } },
    });
    expect(res.status).toBe(201);
    const first = (await res.json()) as { run: { id: string } };

    res = await jsonReq(`/api/workflow-runs/${first.run.id}/rerun`, {});
    expect(res.status).toBe(201);
    const rerun = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
    };
    expect(rerun.run.id).not.toBe(first.run.id);
    expect(rerun.run.status).toBe("succeeded");
    expect(rerun.run.context).toEqual({
      customer: { id: "cust_1", name: "Ada" },
    });

    res = await jsonReq(`/api/workflow-runs/${rerun.run.id}/cancel`, {});
    expect(res.status).toBe(409);
  });

  it("persists canceled builtin.exit with canceled step and audit event", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_exit_canceled_http",
      name: "Exit Canceled HTTP",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "canceled",
          output: { reason: "operator-defined stop" },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_exit_canceled_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{ kind: string; message?: string; payload?: unknown }>;
    };
    expect(detail.run.status).toBe("canceled");
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "exit",
        status: "canceled",
        output: {
          status: "canceled",
          output: { reason: "operator-defined stop" },
        },
      }),
    ]);
    expect(detail.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_canceled",
      "step_completed",
    ]);
    expect(detail.events.at(-2)).toMatchObject({
      kind: "run_canceled",
      message: "Workflow run canceled",
      payload: {
        status: "canceled",
        output: { reason: "operator-defined stop" },
      },
    });

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.status).toBe("canceled");
    expect(persisted.steps[0]).toMatchObject({
      nodeId: "exit",
      status: "canceled",
    });
    expect(persisted.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_canceled",
      "step_completed",
    ]);
  });

  it("persists failed builtin.exit with a step_failed audit event", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_exit_failed_http",
      name: "Exit Failed HTTP",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "failed",
          output: { reason: "business rule failed" },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_exit_failed_http/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{ kind: string; message?: string; payload?: unknown }>;
    };
    expect(detail.run.status).toBe("failed");
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "exit",
        status: "failed",
        output: {
          status: "failed",
          output: { reason: "business rule failed" },
        },
      }),
    ]);
    expect(detail.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_failed",
      "step_failed",
    ]);
    expect(detail.events.at(-1)).toMatchObject({
      kind: "step_failed",
      message: "Step exit failed",
      payload: {
        status: "failed",
        output: {
          status: "failed",
          output: { reason: "business rule failed" },
        },
      },
    });

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.status).toBe("failed");
    expect(persisted.steps[0]).toMatchObject({
      nodeId: "exit",
      status: "failed",
    });
    expect(persisted.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_failed",
      "step_failed",
    ]);
  });

  it("persists warn logs, sleep output, and controlled throw_error evidence", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_runtime_evidence",
      name: "M11 Runtime Evidence",
      nodes: [
        {
          id: "warn_operator",
          type: "builtin.log.warn",
          message: "Asset owner missing",
          payload: { severity: "medium" },
          next: ["wait_for_index"],
        },
        {
          id: "wait_for_index",
          type: "builtin.sleep",
          delayMs: 1,
          reason: "Wait for external index consistency",
          next: ["fail_missing_owner"],
        },
        {
          id: "fail_missing_owner",
          type: "builtin.throw_error",
          message: "Asset owner is missing",
          code: "asset_owner_missing",
          details: { assetId: "$.workflowTrigger.input.asset.id" },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_m11_runtime_evidence/runs/test", {
      input: { asset: { id: "asset_http_1" } },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        nodeId: string;
        status: string;
        output?: unknown;
        error?: unknown;
        durationMs: number | null;
        logsSummary?: unknown;
      }>;
      events: Array<{
        level: string;
        kind: string;
        message?: string;
        payload?: unknown;
      }>;
    };

    expect(detail.run.status).toBe("failed");
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "warn_operator",
        status: "succeeded",
        output: {
          message: "Asset owner missing",
          payload: { severity: "medium" },
        },
        logsSummary: {
          logs: [
            {
              level: "warn",
              message: "Asset owner missing",
              payload: { severity: "medium" },
            },
          ],
        },
      }),
      expect.objectContaining({
        nodeId: "wait_for_index",
        status: "succeeded",
        output: {
          delayMs: 1,
          reason: "Wait for external index consistency",
        },
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        nodeId: "fail_missing_owner",
        status: "failed",
        error: {
          name: "WorkflowNodeExecutionError",
          message: "Asset owner is missing",
          details: {
            code: "asset_owner_missing",
            details: { assetId: "asset_http_1" },
          },
        },
        durationMs: expect.any(Number),
      }),
    ]);
    expect(detail.events.map((event) => [event.level, event.kind])).toEqual([
      ["system", "run_started"],
      ["system", "step_started"],
      ["warn", "log"],
      ["system", "step_completed"],
      ["system", "step_started"],
      ["system", "step_completed"],
      ["system", "step_started"],
      ["error", "step_failed"],
      ["system", "run_failed"],
    ]);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.status).toBe("failed");
    expect(persisted.steps[0]?.logsSummary).toEqual({
      logs: [
        {
          level: "warn",
          message: "Asset owner missing",
          payload: { severity: "medium" },
        },
      ],
    });
    expect(persisted.steps[2]?.error).toEqual({
      name: "WorkflowNodeExecutionError",
      message: "Asset owner is missing",
      details: {
        code: "asset_owner_missing",
        details: { assetId: "asset_http_1" },
      },
    });
  });

  it("persists assignment rollback and node-specific assignment error details", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_assignment_evidence",
      name: "M11 Assignment Evidence",
      nodes: [
        {
          id: "set_initial",
          type: "builtin.set",
          next: ["partial_failure"],
          assign: {
            asset: "$.workflowTrigger.input.asset",
            notes: "$.workflowTrigger.input.notes",
          },
        },
        {
          id: "partial_failure",
          type: "builtin.set",
          assign: {
            notes: {
              from: "$.workflowTrigger.input.newNote",
              mode: "append",
            },
            asset: {
              from: "$.workflowTrigger.input.invalidMergeValue",
              mode: "merge",
            },
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_m11_assignment_evidence/runs/test", {
      input: {
        asset: { id: "asset_http_assign_1" },
        notes: ["original"],
        newNote: "should rollback",
        invalidMergeValue: "not an object",
      },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{
        nodeId: string;
        status: string;
        contextDiff?: unknown;
        error?: unknown;
      }>;
    };

    expect(detail.run.status).toBe("failed");
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "set_initial",
        status: "succeeded",
        contextDiff: {
          asset: {
            before: null,
            after: { id: "asset_http_assign_1" },
          },
          notes: {
            before: null,
            after: ["original"],
          },
        },
      }),
      expect.objectContaining({
        nodeId: "partial_failure",
        status: "failed",
        error: {
          name: "WorkflowNodeExecutionError",
          message:
            "merge assignment for asset requires an object target and object value",
          details: {
            assignmentPath: "asset",
            assignmentMode: "merge",
            targetType: "object",
            valueType: "string",
          },
        },
      }),
    ]);
    expect(detail.steps[1]?.contextDiff).toBeUndefined();

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.status).toBe("failed");
    expect(persisted.steps[1]?.error).toEqual({
      name: "WorkflowNodeExecutionError",
      message:
        "merge assignment for asset requires an object target and object value",
      details: {
        assignmentPath: "asset",
        assignmentMode: "merge",
        targetType: "object",
        valueType: "string",
      },
    });
    expect(persisted.steps[1]?.contextDiff).toBeUndefined();
  });

  it("persists structured transform operation errors through run detail", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_transform_evidence",
      name: "M11 Transform Evidence",
      nodes: [
        {
          id: "invalid_transform",
          type: "builtin.transform.object_pick",
          input: {
            customer: "$.workflowTrigger.input.customer",
          },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: "id",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq("/api/workflows/wf_m11_transform_evidence/runs/test", {
      input: { customer: { id: "cust_http_transform_1", name: "Ada" } },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string };
      steps: Array<{ nodeId: string; status: string; error?: unknown }>;
    };

    expect(detail.run.status).toBe("failed");
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "invalid_transform",
        status: "failed",
        error: {
          name: "WorkflowNodeExecutionError",
          message:
            "Transform operation object_pick has invalid field fields: expected string[]",
          details: {
            operationKind: "object_pick",
            field: "fields",
            expected: "string[]",
            actualType: "string",
          },
        },
      }),
    ]);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.status).toBe("failed");
    expect(persisted.steps[0]?.error).toEqual({
      name: "WorkflowNodeExecutionError",
      message:
        "Transform operation object_pick has invalid field fields: expected string[]",
      details: {
        operationKind: "object_pick",
        field: "fields",
        expected: "string[]",
        actualType: "string",
      },
    });
  });

  it("persists string JSON and CSV transform operation outputs", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_transform_operations_evidence",
      name: "M11 Transform Operations Evidence",
      nodes: [
        {
          id: "replace_text",
          type: "builtin.transform.string_replace",
          transform: {
            kind: "string.replace",
            value: "$.workflowTrigger.input.text",
            search: "risk",
            replacement: "issue",
            all: true,
          },
          assign: {
            normalizedText: "$.steps.replace_text.output.value",
          },
          next: ["parse_json"],
        },
        {
          id: "parse_json",
          type: "builtin.transform.json_parse",
          transform: {
            kind: "json.parse",
            value: "$.workflowTrigger.input.json",
          },
          assign: {
            parsed: "$.steps.parse_json.output.value",
          },
          next: ["parse_csv"],
        },
        {
          id: "parse_csv",
          type: "builtin.transform.csv_parse",
          transform: {
            kind: "csv.parse",
            value: "$.workflowTrigger.input.csv",
            headers: true,
            maxRows: 10,
          },
          assign: {
            rows: "$.steps.parse_csv.output.value",
          },
          next: ["stringify_csv"],
        },
        {
          id: "stringify_csv",
          type: "builtin.transform.csv_stringify",
          transform: {
            kind: "csv.stringify",
            value: "$.context.rows",
            headers: ["id", "name"],
          },
          assign: {
            csv: "$.steps.stringify_csv.output.value",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_m11_transform_operations_evidence/runs/test",
      {
        input: {
          text: "risk accepted, risk tracked",
          json: '{"asset":"asset_http_transform_ops_1"}',
          csv: "id,name\n1,Ada\n2,Lin",
        },
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
    };

    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.context).toEqual({
      normalizedText: "issue accepted, issue tracked",
      parsed: { asset: "asset_http_transform_ops_1" },
      rows: [
        { id: "1", name: "Ada" },
        { id: "2", name: "Lin" },
      ],
      csv: "id,name\n1,Ada\n2,Lin",
    });
    expect(
      detail.steps.map((step) => [step.nodeId, step.status, step.output]),
    ).toEqual([
      ["replace_text", "succeeded", { value: "issue accepted, issue tracked" }],
      [
        "parse_json",
        "succeeded",
        { value: { asset: "asset_http_transform_ops_1" } },
      ],
      [
        "parse_csv",
        "succeeded",
        {
          value: [
            { id: "1", name: "Ada" },
            { id: "2", name: "Lin" },
          ],
        },
      ],
      ["stringify_csv", "succeeded", { value: "id,name\n1,Ada\n2,Lin" }],
    ]);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.context).toEqual(detail.run.context);
    expect(persisted.steps.map((step) => step.output)).toEqual(
      detail.steps.map((step) => step.output),
    );
  });

  it("persists IP transform operation outputs and branch routing evidence", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_ip_transform_evidence",
      name: "M11 IP Transform Evidence",
      nodes: [
        {
          id: "parse_ip",
          type: "builtin.transform.ip_parse",
          transform: { kind: "ip.parse", value: "$.workflowTrigger.input.ip" },
          assign: { parsedIp: "$.steps.parse_ip.output.value" },
          next: ["check_internal"],
        },
        {
          id: "check_internal",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.ip",
            cidr: "10.0.0.0/8",
          },
          assign: { isInternal: "$.steps.check_internal.output.value" },
          next: ["network"],
        },
        {
          id: "network",
          type: "builtin.transform.ip_network",
          transform: {
            kind: "ip.network",
            cidr: "$.workflowTrigger.input.cidr",
          },
          assign: { network: "$.steps.network.output.value" },
          next: ["route_ip"],
        },
        {
          id: "route_ip",
          type: "builtin.if",
          condition: "$.context.isInternal == true",
          then: ["log_internal"],
          else: ["log_external"],
        },
        {
          id: "log_internal",
          type: "builtin.log.info",
          message: "internal ip",
          payload: "$.context",
        },
        {
          id: "log_external",
          type: "builtin.log.info",
          message: "external ip",
          payload: "$.context",
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_m11_ip_transform_evidence/runs/test",
      {
        input: { ip: "10.20.30.40", cidr: "10.20.30.40/24" },
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{ level: string; kind: string; message?: string }>;
    };

    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.context).toEqual({
      parsedIp: {
        version: 4,
        address: "10.20.30.40",
        normalized: "10.20.30.40",
        integer: "169090600",
        octets: [10, 20, 30, 40],
      },
      isInternal: true,
      network: {
        version: 4,
        address: "10.20.30.0",
        prefix: 24,
        cidr: "10.20.30.0/24",
      },
    });
    expect(
      detail.steps.map((step) => [step.nodeId, step.status, step.output]),
    ).toEqual([
      [
        "parse_ip",
        "succeeded",
        {
          value: {
            version: 4,
            address: "10.20.30.40",
            normalized: "10.20.30.40",
            integer: "169090600",
            octets: [10, 20, 30, 40],
          },
        },
      ],
      ["check_internal", "succeeded", { value: true }],
      [
        "network",
        "succeeded",
        {
          value: {
            version: 4,
            address: "10.20.30.0",
            prefix: 24,
            cidr: "10.20.30.0/24",
          },
        },
      ],
      [
        "route_ip",
        "succeeded",
        {
          result: true,
          selected: ["log_internal"],
          skipped: ["log_external"],
        },
      ],
      [
        "log_internal",
        "succeeded",
        {
          message: "internal ip",
          payload: detail.run.context,
        },
      ],
      ["log_external", "skipped", undefined],
    ]);
    expect(
      detail.events.map((event) => [event.level, event.kind, event.message]),
    ).toContainEqual(["info", "log", "internal ip"]);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.context).toEqual(detail.run.context);
    expect(persisted.steps.map((step) => step.output)).toEqual(
      detail.steps.map((step) => step.output),
    );
  });

  it("persists URI parse operation outputs and log evidence", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_uri_transform_evidence",
      name: "M11 URI Transform Evidence",
      nodes: [
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: {
            kind: "uri.parse",
            value: "$.workflowTrigger.input.url",
          },
          assign: {
            uri: "$.steps.parse_uri.output.value",
          },
          next: ["log_uri"],
        },
        {
          id: "log_uri",
          type: "builtin.log.info",
          message: "uri parsed",
          payload: {
            host: "$.context.uri.host",
            path: "$.context.uri.pathname",
            query: "$.context.uri.query",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_m11_uri_transform_evidence/runs/test",
      {
        input: {
          url: "https://user:secret@api.example.com:8443/v1/assets?id=123&tag=cloud&tag=prod#section",
        },
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{
        level: string;
        kind: string;
        message?: string;
        payload?: unknown;
      }>;
    };

    const parsedUri = {
      href: "https://api.example.com:8443/v1/assets?id=123&tag=cloud&tag=prod#section",
      protocol: "https:",
      scheme: "https",
      origin: "https://api.example.com:8443",
      host: "api.example.com:8443",
      hostname: "api.example.com",
      port: "8443",
      pathname: "/v1/assets",
      path: "/v1/assets?id=123&tag=cloud&tag=prod",
      search: "?id=123&tag=cloud&tag=prod",
      query: { id: "123", tag: ["cloud", "prod"] },
      queryList: [
        { key: "id", value: "123" },
        { key: "tag", value: "cloud" },
        { key: "tag", value: "prod" },
      ],
      hash: "#section",
      fragment: "section",
      username: null,
      password: "[redacted]",
      hasCredentials: true,
    };
    expect(detail.run.status).toBe("succeeded");
    expect(JSON.stringify(detail.run.context)).not.toContain("secret");
    expect(
      JSON.stringify(detail.steps.map((step) => step.output)),
    ).not.toContain("secret");
    expect(detail.run.context).toEqual({ uri: parsedUri });
    expect(
      detail.steps.map((step) => [step.nodeId, step.status, step.output]),
    ).toEqual([
      ["parse_uri", "succeeded", { value: parsedUri }],
      [
        "log_uri",
        "succeeded",
        {
          message: "uri parsed",
          payload: {
            host: "api.example.com:8443",
            path: "/v1/assets",
            query: { id: "123", tag: ["cloud", "prod"] },
          },
        },
      ],
    ]);
    expect(
      detail.events.map((event) => [event.level, event.kind, event.message]),
    ).toContainEqual(["info", "log", "uri parsed"]);

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.context).toEqual(detail.run.context);
    expect(persisted.steps.map((step) => step.output)).toEqual(
      detail.steps.map((step) => step.output),
    );
  });

  it("persists parallel branch aggregate outputs and events", async () => {
    let res = await jsonReq("/api/workflows", {
      id: "wf_m11_parallel_runtime_evidence",
      name: "M11 Parallel Runtime Evidence",
      nodes: [
        {
          id: "parallel_checks",
          type: "builtin.parallel",
          failFast: false,
          concurrency: 3,
          next: ["log_parallel_summary"],
          branches: [
            { id: "asset", label: "Asset", nodes: ["parse_asset"] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
            { id: "policy", label: "Policy", nodes: ["fail_policy"] },
          ],
          assign: {
            parallelSummary: "$.steps.parallel_checks.output",
          },
        },
        {
          id: "parse_asset",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.asset",
          },
          assign: {
            branchValue: "$.steps.parse_asset.output.value",
          },
        },
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: {
            kind: "uri.parse",
            value: "$.workflowTrigger.input.asset.url",
          },
          assign: {
            branchValue: "$.steps.parse_uri.output.value.hostname",
          },
        },
        {
          id: "fail_policy",
          type: "builtin.throw_error",
          message: "policy rejected asset",
          code: "policy_rejected",
        },
        {
          id: "log_parallel_summary",
          type: "builtin.log.info",
          message: "parallel summary",
          payload: {
            succeeded: "$.context.parallelSummary.succeededCount",
            failed: "$.context.parallelSummary.failedCount",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await jsonReq(
      "/api/workflows/wf_m11_parallel_runtime_evidence/runs/test",
      {
        input: {
          asset: {
            id: "asset_parallel_http_1",
            url: "https://assets.example.com/v1/assets/asset_parallel_http_1",
          },
        },
      },
    );
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
      steps: Array<{
        nodeId: string;
        status: string;
        durationMs?: number;
        output?: unknown;
        error?: unknown;
      }>;
      events: Array<{
        level: string;
        kind: string;
        message?: string;
        payload?: unknown;
      }>;
    };

    const parallelOutput = detail.steps.find(
      (step) => step.nodeId === "parallel_checks",
    )?.output as
      | {
          count: number;
          succeededCount: number;
          failedCount: number;
          canceledCount: number;
          branchOrder: string[];
          branches: Record<
            string,
            {
              status: string;
              durationMs: number;
              steps: Record<string, unknown>;
              context: Record<string, unknown>;
              error?: unknown;
            }
          >;
        }
      | undefined;

    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.durationMs).toEqual(expect.any(Number));
    expect(parallelOutput).toMatchObject({
      count: 3,
      succeededCount: 2,
      failedCount: 1,
      canceledCount: 0,
      branchOrder: ["asset", "uri", "policy"],
      branches: {
        asset: {
          status: "succeeded",
          durationMs: expect.any(Number),
          steps: {
            parse_asset: {
              value: {
                id: "asset_parallel_http_1",
                url: "https://assets.example.com/v1/assets/asset_parallel_http_1",
              },
            },
          },
          context: {
            branchValue: {
              id: "asset_parallel_http_1",
              url: "https://assets.example.com/v1/assets/asset_parallel_http_1",
            },
          },
        },
        uri: {
          status: "succeeded",
          durationMs: expect.any(Number),
          steps: {
            parse_uri: expect.objectContaining({
              value: expect.objectContaining({
                hostname: "assets.example.com",
                pathname: "/v1/assets/asset_parallel_http_1",
              }),
            }),
          },
          context: {
            branchValue: "assets.example.com",
          },
        },
        policy: {
          status: "failed",
          durationMs: expect.any(Number),
          error: {
            message: "policy rejected asset",
            details: { code: "policy_rejected" },
          },
        },
      },
    });
    expect(JSON.stringify(detail.run.context)).toContain("parallelSummary");
    expect(detail.run.context).not.toHaveProperty("branchValue");
    expect(
      detail.steps.find((step) => step.nodeId === "parallel_checks"),
    ).toMatchObject({
      status: "succeeded",
      durationMs: expect.any(Number),
    });
    expect(detail.steps.map((step) => [step.nodeId, step.status])).toEqual(
      expect.arrayContaining([
        ["parse_asset", "succeeded"],
        ["parse_uri", "succeeded"],
        ["fail_policy", "failed"],
        ["parallel_checks", "succeeded"],
        ["log_parallel_summary", "succeeded"],
      ]),
    );
    expect(
      detail.events.map((event) => [event.level, event.kind, event.message]),
    ).toEqual(
      expect.arrayContaining([
        ["system", "parallel_started", "Parallel parallel_checks started"],
        ["system", "parallel_branch_started", "Parallel branch asset started"],
        [
          "system",
          "parallel_branch_completed",
          "Parallel branch asset completed",
        ],
        ["error", "parallel_branch_failed", "Parallel branch policy failed"],
        ["warn", "parallel_completed", "Parallel parallel_checks completed"],
        ["info", "log", "parallel summary"],
      ]),
    );
    expect(
      detail.events.find((event) => event.message === "parallel summary")
        ?.payload,
    ).toEqual({ succeeded: 2, failed: 1 });

    res = await req(`/api/workflow-runs/${detail.run.id}`);
    expect(res.status).toBe(200);
    const persisted = (await res.json()) as typeof detail;
    expect(persisted.run.context).toEqual(detail.run.context);
    expect(persisted.steps.map((step) => step.output)).toEqual(
      detail.steps.map((step) => step.output),
    );
    expect(persisted.events.map((event) => event.kind)).toEqual(
      detail.events.map((event) => event.kind),
    );
  });

  it("cancels non-terminal runs and records an audit event", async () => {
    const workflow = runtime.workflowStore.createDraft({
      id: "wf_cancel",
      name: "Cancel API",
      nodes: runnableNodes(),
    });
    const run = runtime.workflowStore.createRun({
      id: "run_cancel_running",
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      definitionSource: "draft",
      mode: "test",
      status: "running",
      input: { customer: { id: "cust_cancel", name: "Cancel Ada" } },
      currentNodeId: "set_customer",
      startedAt: new Date().toISOString(),
    });
    runtime.workflowStore.appendRunEvent({
      runId: run.id,
      level: "system",
      kind: "run_started",
      message: "Workflow run started",
    });
    runtime.workflowStore.recordStepAttempt({
      id: "step_cancel_running",
      runId: run.id,
      nodeId: "set_customer",
      attempt: 1,
      status: "running",
      startedAt: "2026-07-30T10:00:00.000Z",
      input: { customer: { id: "cust_cancel", name: "Cancel Ada" } },
    });

    const res = await jsonReq(`/api/workflow-runs/${run.id}/cancel`, {});
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      run: {
        id: string;
        status: string;
        currentNodeId: string | null;
        endedAt: string | null;
      };
      steps: Array<{
        nodeId: string;
        status: string;
        endedAt: string | null;
        durationMs: number | null;
      }>;
      events: Array<{ kind: string; payload?: unknown }>;
    };
    expect(detail.run).toMatchObject({
      id: run.id,
      status: "canceled",
      currentNodeId: null,
    });
    expect(detail.run.endedAt).toEqual(expect.any(String));
    expect(detail.events.map((event) => event.kind)).toEqual([
      "run_started",
      "run_canceled",
    ]);
    expect(detail.events.at(-1)?.payload).toEqual({
      previousStatus: "running",
    });
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "set_customer",
        status: "canceled",
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
      }),
    ]);

    const stored = runtime.workflowStore.getRun(run.id);
    expect(stored?.status).toBe("canceled");
    expect(runtime.workflowStore.listStepAttempts(run.id)).toEqual([
      expect.objectContaining({
        nodeId: "set_customer",
        status: "canceled",
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("heals terminal run details when completed step rows were left running", async () => {
    const workflow = runtime.workflowStore.createDraft({
      id: "wf_heal_completed_running_step",
      name: "Heal Completed Running Step",
      nodes: runnableNodes(),
    });
    const run = runtime.workflowStore.createRun({
      id: "run_heal_completed_running_step",
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      definitionSource: "draft",
      mode: "test",
      status: "canceled",
      input: { customer: { id: "cust_heal", name: "Heal Ada" } },
      currentNodeId: null,
      startedAt: "2026-07-30T10:00:00.000Z",
      endedAt: "2026-07-30T10:00:02.000Z",
      durationMs: 2000,
    });
    runtime.workflowStore.recordStepAttempt({
      id: `${run.id}:set_customer:1`,
      runId: run.id,
      nodeId: "set_customer",
      attempt: 1,
      status: "running",
      startedAt: "2026-07-30T10:00:00.100Z",
    });
    runtime.workflowStore.appendRunEvent({
      runId: run.id,
      stepRunId: `${run.id}:set_customer:1`,
      level: "system",
      kind: "step_completed",
      message: "Step set_customer completed",
      payload: { status: "succeeded" },
      createdAt: "2026-07-30T10:00:00.300Z",
    });

    const res = await req(`/api/workflow-runs/${run.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      steps: Array<{
        nodeId: string;
        status: string;
        endedAt: string | null;
        durationMs: number | null;
      }>;
    };
    expect(detail.steps).toEqual([
      expect.objectContaining({
        nodeId: "set_customer",
        status: "succeeded",
        endedAt: "2026-07-30T10:00:00.300Z",
        durationMs: 200,
      }),
    ]);
    expect(runtime.workflowStore.listStepAttempts(run.id)).toEqual([
      expect.objectContaining({
        nodeId: "set_customer",
        status: "succeeded",
        endedAt: "2026-07-30T10:00:00.300Z",
        durationMs: 200,
      }),
    ]);
  });
});
