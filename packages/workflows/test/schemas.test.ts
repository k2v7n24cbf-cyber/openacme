import { describe, expect, it } from "vitest";
import {
  WorkflowAssignmentMapSchema,
  WorkflowDefinitionSchema,
  WorkflowNodeSchema,
  WorkflowRunSchema,
  WorkflowRunStatusSchema,
  WorkflowTriggerSchema,
  validateWorkflowDefinitionAuthoring,
  validateWorkflowInputSchema,
  validateWorkflowGraphCompleteness,
  validateWorkflowJsonSchema,
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
          assign: { customerId: "$.workflowTrigger.input.customerId" },
        },
        {
          id: "normalize",
          type: "builtin.transform.object_pick",
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
          items: "$.workflowTrigger.input.customers",
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
      "builtin.transform.object_pick",
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
        items: "$.workflowTrigger.input.customers",
        body: ["normalize"],
        concurrency: 1,
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "each_customer",
        type: "builtin.foreach",
        items: "$.workflowTrigger.input.customers",
        body: ["normalize"],
        concurrency: 2,
      }).success,
    ).toBe(false);
  });

  it("accepts new M11.1 flow-control node schemas", () => {
    expect(
      WorkflowNodeSchema.safeParse({
        id: "warn_operator",
        type: "builtin.log.warn",
        message: "Asset owner missing",
        payload: { severity: "medium" },
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "fail_missing_owner",
        type: "builtin.throw_error",
        message: "Asset owner is missing",
        code: "asset_owner_missing",
        details: { assetId: "$.context.asset.id" },
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "wait_for_index",
        type: "builtin.sleep",
        delayMs: 2500,
        reason: "Wait for external index consistency",
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "parallel_enrichment",
        type: "builtin.parallel",
        branches: [
          { id: "qualys", label: "Qualys", nodes: ["get_qualys_asset"] },
          { id: "cmdb", nodes: ["get_cmdb_record"] },
        ],
        concurrency: 2,
        failFast: false,
        assign: {
          enrichment: "$.steps.parallel_enrichment.output.branches",
        },
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "parallel_draft",
        type: "builtin.parallel",
        branches: [
          { id: "branch_a", label: "Branch A", nodes: [] },
          { id: "branch_b", label: "Branch B", nodes: [] },
        ],
      }).success,
    ).toBe(true);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "route_by_kind",
        type: "builtin.switch",
        value: "$.workflowTrigger.input.kind",
        cases: [
          {
            id: "asset",
            label: "Asset",
            value: "asset",
            nodes: ["handle_asset"],
          },
          { id: "owner", value: "owner", nodes: ["handle_owner"] },
        ],
        default: ["handle_unknown"],
      }).success,
    ).toBe(true);
  });

  it("rejects invalid M11.1 flow-control node schemas", () => {
    expect(
      WorkflowNodeSchema.safeParse({
        id: "fail_missing_owner",
        type: "builtin.throw_error",
      }).success,
    ).toBe(false);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "wait_too_little",
        type: "builtin.sleep",
        delayMs: 0,
      }).success,
    ).toBe(false);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "wait_too_long",
        type: "builtin.sleep",
        delayMs: 300_001,
      }).success,
    ).toBe(false);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "parallel_empty",
        type: "builtin.parallel",
        branches: [],
      }).success,
    ).toBe(false);

    expect(
      WorkflowNodeSchema.safeParse({
        id: "switch_empty",
        type: "builtin.switch",
        value: "$.workflowTrigger.input.kind",
        cases: [],
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
          type: "builtin.if",
          condition: "$.workflowTrigger.input.ready",
          then: ["notify"],
          else: ["missing_exit"],
        },
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.customers",
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

  it("validates cross-node parallel branch references", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "parallel-reference-check",
      version: 1,
      status: "draft",
      name: "Parallel reference check",
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "qualys", nodes: ["get_qualys_asset"] },
            { id: "cmdb", nodes: ["missing_cmdb_record"] },
          ],
        },
        {
          id: "get_qualys_asset",
          type: "builtin.log.info",
          message: "qualys",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    expect(validateWorkflowNodeReferences(parsed.nodes)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "parallel_enrichment",
          field: "branches",
          targetId: "missing_cmdb_record",
        },
      ],
    });
  });

  it("validates cross-node switch case references", () => {
    const parsed = WorkflowDefinitionSchema.parse({
      id: "switch-reference-check",
      version: 1,
      status: "draft",
      name: "Switch reference check",
      nodes: [
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.workflowTrigger.input.kind",
          cases: [
            { id: "asset", value: "asset", nodes: ["handle_asset"] },
            { id: "owner", value: "owner", nodes: ["missing_owner"] },
          ],
          default: ["missing_default"],
        },
        {
          id: "handle_asset",
          type: "builtin.log.info",
          message: "asset",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    expect(validateWorkflowNodeReferences(parsed.nodes)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "route_by_kind",
          field: "cases",
          targetId: "missing_owner",
        },
        {
          nodeId: "route_by_kind",
          field: "default",
          targetId: "missing_default",
        },
      ],
    });
  });

  it("rejects duplicate and self-referential switch cases", () => {
    const duplicateCases = [
      {
        id: "route_by_kind",
        type: "builtin.switch",
        value: "$.workflowTrigger.input.kind",
        cases: [
          { id: "asset", value: "asset", nodes: ["handle_asset"] },
          { id: "asset", value: "asset_2", nodes: ["handle_owner"] },
        ],
      },
      {
        id: "handle_asset",
        type: "builtin.log.info",
        message: "asset",
      },
      {
        id: "handle_owner",
        type: "builtin.log.info",
        message: "owner",
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowNodeReferences(duplicateCases)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "route_by_kind",
          field: "cases",
          message: "Node route_by_kind has duplicate switch case id: asset",
        },
      ],
    });

    const selfReference = [
      {
        id: "route_by_kind",
        type: "builtin.switch",
        value: "$.workflowTrigger.input.kind",
        cases: [{ id: "loop", value: "loop", nodes: ["route_by_kind"] }],
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowNodeReferences(selfReference)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "route_by_kind",
          field: "cases",
          targetId: "route_by_kind",
        },
      ],
    });
  });

  it("rejects duplicate and self-referential parallel branches", () => {
    const duplicateBranches = [
      {
        id: "parallel_enrichment",
        type: "builtin.parallel",
        branches: [
          { id: "qualys", nodes: ["get_qualys_asset"] },
          { id: "qualys", nodes: ["get_cmdb_record"] },
        ],
      },
      {
        id: "get_qualys_asset",
        type: "builtin.log.info",
        message: "qualys",
      },
      {
        id: "get_cmdb_record",
        type: "builtin.log.info",
        message: "cmdb",
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowNodeReferences(duplicateBranches)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "parallel_enrichment",
          field: "branches",
          message:
            "Node parallel_enrichment has duplicate parallel branch id: qualys",
        },
      ],
    });

    const selfReference = [
      {
        id: "parallel_enrichment",
        type: "builtin.parallel",
        branches: [{ id: "loop", nodes: ["parallel_enrichment"] }],
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowNodeReferences(selfReference)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "parallel_enrichment",
          field: "branches",
          targetId: "parallel_enrichment",
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

  it("rejects executable nodes that are unreachable from the workflow entry", () => {
    const nodes = [
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
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowGraphCompleteness(nodes)).toMatchObject({
      ok: false,
      issues: [
        {
          nodeId: "detached_log",
          field: "entry",
        },
      ],
      message:
        "Workflow flow is incomplete. Connect or remove unreachable card(s): detached_log",
    });
  });

  it("treats branch, loop, and parallel children as reachable graph members", () => {
    const nodes = [
      {
        id: "risk_gate",
        type: "builtin.if",
        condition: "$.workflowTrigger.input.enabled",
        then: ["route_kind"],
        else: ["parallel_checks"],
      },
      {
        id: "route_kind",
        type: "builtin.switch",
        value: "$.workflowTrigger.input.kind",
        cases: [{ id: "asset", value: "asset", nodes: ["each_asset"] }],
        default: ["default_log"],
      },
      {
        id: "each_asset",
        type: "builtin.foreach",
        items: "$.workflowTrigger.input.assets",
        body: ["asset_log"],
      },
      {
        id: "asset_log",
        type: "builtin.log.info",
        message: "asset",
      },
      {
        id: "default_log",
        type: "builtin.log.info",
        message: "default",
      },
      {
        id: "parallel_checks",
        type: "builtin.parallel",
        branches: [
          { id: "a", nodes: ["check_a"] },
          { id: "b", nodes: ["check_b"] },
        ],
      },
      {
        id: "check_a",
        type: "builtin.log.info",
        message: "a",
      },
      {
        id: "check_b",
        type: "builtin.log.info",
        message: "b",
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowGraphCompleteness(nodes)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("ignores detached backend-only exit nodes for graph completeness", () => {
    const nodes = [
      {
        id: "start_log",
        type: "builtin.log.info",
        message: "start",
      },
      {
        id: "exit",
        type: "builtin.exit",
        status: "succeeded",
      },
    ].map((node) => WorkflowNodeSchema.parse(node));

    expect(validateWorkflowGraphCompleteness(nodes)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("rejects workflow definitions with whitespace-only names during authoring validation", () => {
    const definition = WorkflowDefinitionSchema.parse({
      id: "blank-name",
      version: 1,
      status: "draft",
      name: "   ",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "start",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    expect(validateWorkflowDefinitionAuthoring(definition)).toEqual({
      ok: false,
      issues: [{ field: "name", message: "Workflow needs a name" }],
      message: "Workflow needs a name",
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

  it("rejects whitespace-only trigger fields in shared trigger validation", () => {
    const triggers = [
      WorkflowTriggerSchema.parse({
        id: "nightly",
        kind: "scheduled",
        enabled: true,
        schedule: { kind: "cron", expr: "   " },
      }),
      WorkflowTriggerSchema.parse({
        id: "incoming",
        kind: "webhook",
        enabled: true,
        path: "   ",
      }),
    ];

    expect(validateWorkflowTriggers(triggers)).toMatchObject({
      ok: false,
      issues: [
        {
          triggerId: "nightly",
          field: "schedule",
          message: "Scheduled trigger nightly needs a cron schedule",
        },
        {
          triggerId: "incoming",
          field: "path",
          message: "Webhook trigger incoming path must be a string",
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

  it("validates complex workflow trigger input with JSON Schema array items", () => {
    const schema = {
      type: "object",
      required: ["assets"],
      properties: {
        assets: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "hostname", "vulnerabilities"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              hostname: { type: "string" },
              vulnerabilities: {
                type: "array",
                items: {
                  type: "object",
                  required: ["qid", "severity"],
                  properties: {
                    qid: { type: "string" },
                    severity: { type: "integer", minimum: 1, maximum: 5 },
                    title: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(
      validateWorkflowInputSchema(schema, {
        assets: [
          {
            id: "asset-1",
            hostname: "edge-01",
            vulnerabilities: [{ qid: "105170", severity: 5 }],
          },
        ],
      }),
    ).toEqual({ ok: true });

    expect(
      validateWorkflowInputSchema(schema, {
        assets: [
          {
            id: "asset-1",
            hostname: "edge-01",
            vulnerabilities: [{ qid: "105170", severity: "5" }],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error:
        "Input does not match schema: $.assets[0].vulnerabilities[0].severity must be integer",
    });
  });

  it("rejects malformed JSON Schema contracts before runtime input checks", () => {
    expect(
      validateWorkflowJsonSchema({
        type: "object",
        properties: {
          assets: {
            type: "array",
            items: ["object"],
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          path: "$.properties.assets.items",
          message: "must be a JSON Schema object or boolean",
        },
      ],
    });
  });

  it("rejects invalid assignment paths and defaults object assignments to replace", () => {
    expect(
      WorkflowAssignmentMapSchema.safeParse({
        "customer.id": "$.workflowTrigger.input.customerId",
      }).success,
    ).toBe(true);

    expect(
      WorkflowAssignmentMapSchema.safeParse({
        "customer id": "$.workflowTrigger.input.customerId",
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
