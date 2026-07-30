import { describe, expect, it } from "vitest";
import {
  WorkflowAssignmentMapSchema,
  WorkflowDefinitionSchema,
  WorkflowNodeSchema,
  WorkflowRunSchema,
  WorkflowRunStatusSchema,
  WorkflowTriggerSchema,
  validateWorkflowNodeReferences,
  validateWorkflowTriggers,
} from "../src/index.js";

const now = "2026-07-30T00:00:00.000Z";

describe("workflow schemas", () => {
  it("accepts a manual-trigger draft with builtin, MCP, and agent nodes", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "customer-review",
      version: 1,
      status: "draft",
      name: "Customer review",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customerId: "$.input.customerId" },
        },
        {
          id: "normalize",
          type: "builtin.transform",
          input: { customer: "$.context.customer" },
          transform: { kind: "object_pick", fields: ["id"] },
          assign: {
            customer: {
              from: "$.steps.normalize.output",
              mode: "replace",
            },
          },
        },
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.context.riskScore > 70",
          then: ["notify"],
          else: ["exit"],
        },
        {
          id: "notify",
          type: "mcp.tool",
          server: "slack",
          tool: "send_message",
          input: { channel: "#ops" },
          assign: { notificationId: "$.steps.notify.output.id" },
        },
        {
          id: "review",
          type: "agent.call",
          agentId: "soc-analyst",
          prompt: "Review {{customerId}}",
        },
        {
          id: "audit_log",
          type: "builtin.log.info",
          message: "Customer ready",
          payload: "$.context.customer",
          assign: { loggedCustomer: "$.steps.audit_log.output.payload" },
        },
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          body: ["notify"],
          assign: { foreachSummary: "$.steps.each_customer.output" },
        },
        { id: "exit", type: "builtin.exit", status: "succeeded" },
      ],
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.nodes.map((n) => n.type)).toEqual([
      "builtin.set",
      "builtin.transform",
      "builtin.if_else",
      "mcp.tool",
      "agent.call",
      "builtin.log.info",
      "builtin.foreach",
      "builtin.exit",
    ]);
  });

  it("accepts optional workflow UI canvas layout metadata", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "customer-review",
      version: 1,
      status: "draft",
      name: "Customer review",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      ui: {
        canvas: {
          nodes: {
            exit: { position: { x: 120, y: 80 } },
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.ui).toEqual({
      canvas: {
        nodes: {
          exit: { position: { x: 120, y: 80 } },
        },
      },
    });
  });

  it("rejects invalid workflow UI canvas layout metadata", () => {
    const parsed = WorkflowDefinitionSchema.safeParse({
      id: "customer-review",
      version: 1,
      status: "draft",
      name: "Customer review",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      ui: {
        canvas: {
          nodes: {
            exit: { position: { x: "left", y: 80 } },
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown node families", () => {
    const parsed = WorkflowNodeSchema.safeParse({
      id: "bad",
      type: "tool.call",
      tool: "execute_code",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects deferred durable agent task nodes in the first release", () => {
    const parsed = WorkflowNodeSchema.safeParse({
      id: "open_task",
      type: "agent.task",
      agentId: "support",
      prompt: "Open a durable task",
    });

    expect(parsed.success).toBe(false);
  });

  it("bounds agent call timeout values", () => {
    expect(
      WorkflowNodeSchema.safeParse({
        id: "review",
        type: "agent.call",
        agentId: "support",
        prompt: "Review",
        timeoutMs: 300_000,
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "review",
        type: "agent.call",
        agentId: "support",
        prompt: "Review",
        timeoutMs: 300_001,
      }).success,
    ).toBe(false);
  });

  it("bounds foreach concurrency to the current sequential runtime cap", () => {
    expect(
      WorkflowNodeSchema.safeParse({
        id: "each_customer",
        type: "builtin.foreach",
        items: "$.input.customers",
        body: ["normalize"],
        concurrency: 1,
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "each_customer",
        type: "builtin.foreach",
        items: "$.input.customers",
        body: ["normalize"],
        concurrency: 2,
      }).success,
    ).toBe(false);
  });

  it("validates cross-node branch and foreach references", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "reference-check",
      version: 1,
      status: "draft",
      name: "Reference check",
      nodes: [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.input.ready",
          then: ["notify"],
          else: ["missing_exit"],
        },
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          body: ["notify", "missing_child"],
        },
        {
          id: "notify",
          type: "builtin.log.info",
          message: "notify",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    expect(validateWorkflowNodeReferences(parsed.nodes)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "branch",
          field: "else",
          targetId: "missing_exit",
        },
        {
          nodeId: "each_customer",
          field: "body",
          targetId: "missing_child",
        },
      ],
    });
  });

  it("rejects duplicate node ids in cross-node validation", () => {
    const nodes = [
      {
        id: "dup",
        type: "builtin.log.info",
        message: "first",
      },
      {
        id: "dup",
        type: "builtin.log.error",
        message: "second",
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowNodeReferences(nodes)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "dup",
          field: "id",
          message: "Duplicate workflow node id: dup",
        },
      ],
    });
  });

  it("rejects route-unsafe node ids in cross-node validation", () => {
    const nodes = [
      {
        id: "load/customer",
        type: "builtin.log.info",
        message: "first",
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowNodeReferences(nodes)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "load/customer",
          field: "id",
          message: "Invalid workflow node id: load/customer",
        },
      ],
    });
  });

  it("allows manual, scheduled, and webhook triggers to be enabled while keeping task deferred", () => {
    expect(
      WorkflowTriggerSchema.safeParse({
        id: "manual",
        kind: "manual",
        enabled: true,
      }).success,
    ).toBe(true);

    expect(
      WorkflowTriggerSchema.safeParse({
        id: "nightly",
        kind: "scheduled",
        enabled: true,
        schedule: { kind: "cron", expr: "0 0 * * *" },
        input: { source: "nightly" },
      }).success,
    ).toBe(true);

    expect(
      WorkflowTriggerSchema.safeParse({
        id: "incoming",
        kind: "webhook",
        enabled: true,
        path: "crm/customer-created",
        secretSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        inputSchema: {
          type: "object",
          required: ["customer"],
          properties: { customer: { type: "object" } },
        },
      }).success,
    ).toBe(true);

    expect(
      WorkflowTriggerSchema.safeParse({
        id: "task_gate",
        kind: "task",
        enabled: true,
        filter: { queue: "support" },
      }).success,
    ).toBe(false);

    expect(
      WorkflowTriggerSchema.safeParse({
        id: "nightly",
        kind: "scheduled",
        enabled: false,
        schedule: { kind: "cron", expr: "0 0 * * *" },
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate trigger ids and duplicate webhook paths", () => {
    const triggers = [
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
      {
        id: "incoming_a",
        kind: "manual",
        enabled: true,
      },
    ].map((trigger) => WorkflowTriggerSchema.parse(trigger));

    expect(validateWorkflowTriggers(triggers)).toMatchObject({
      ok: false,
      issues: [
        {
          triggerId: "incoming_b",
          field: "path",
          message: "Duplicate workflow webhook path: crm/customer",
        },
        {
          triggerId: "incoming_a",
          field: "id",
          message: "Duplicate workflow trigger id: incoming_a",
        },
      ],
    });
  });

  it("rejects route-unsafe trigger ids in trigger validation", () => {
    const triggers = [
      {
        id: "manual/review",
        kind: "manual",
        enabled: true,
      },
    ].map((trigger) => WorkflowTriggerSchema.parse(trigger));

    expect(validateWorkflowTriggers(triggers)).toMatchObject({
      ok: false,
      issues: [
        {
          triggerId: "manual/review",
          field: "id",
          message: "Invalid workflow trigger id: manual/review",
        },
      ],
    });
  });

  it("rejects invalid assignment paths and defaults object assignments to replace", () => {
    expect(
      WorkflowAssignmentMapSchema.safeParse({
        "customer.id": "$.input.customerId",
      }).success,
    ).toBe(true);

    expect(
      WorkflowAssignmentMapSchema.safeParse({
        "customer id": "$.input.customerId",
      }).success,
    ).toBe(false);

    const parsed = WorkflowAssignmentMapSchema.parse({
      customer: { from: "$.steps.normalize.output" },
    });
    expect(parsed.customer).toEqual({
      from: "$.steps.normalize.output",
      mode: "replace",
    });
  });

  it("rejects invalid run statuses and accepts test/live run metadata", () => {
    expect(WorkflowRunStatusSchema.safeParse("paused").success).toBe(false);

    const run = WorkflowRunSchema.parse({
      id: "run_1",
      workflowId: "wf_1",
      workflowVersion: 1,
      definitionSource: "draft",
      mode: "test",
      trigger: {
        kind: "manual",
        triggerId: "manual",
        requestedBy: "codex",
      },
      status: "queued",
      input: { customerId: "1" },
      context: {},
      createdAt: now,
    });

    expect(run).toMatchObject({
      definitionSource: "draft",
      mode: "test",
      trigger: {
        kind: "manual",
        triggerId: "manual",
        requestedBy: "codex",
      },
      currentNodeId: null,
      waitingReason: null,
    });
  });
});
