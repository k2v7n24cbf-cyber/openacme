import { describe, expect, it } from "vitest";
import {
  appendWorkflowNode,
  cloneWorkflowNodeAfter,
  createWorkflowNodeTemplate,
  insertWorkflowNodeAfter,
  insertWorkflowNodeFirst,
  moveWorkflowNode,
  removeWorkflowNode,
  workflowTransformPresetById,
  WORKFLOW_TRANSFORM_PRESETS,
} from "@/app/workflows/authoring";

describe("workflow authoring helpers", () => {
  it("creates representative node defaults", () => {
    expect(createWorkflowNodeTemplate("set", 1)).toEqual({
      id: "set_01",
      type: "builtin.set",
      assign: { value: "$.input.value" },
    });
    expect(createWorkflowNodeTemplate("if", 2)).toEqual({
      id: "if_02",
      type: "builtin.if",
      condition: "$.input.enabled == true",
      then: [],
      else: [],
    });
    expect(createWorkflowNodeTemplate("foreach", 3)).toEqual({
      id: "foreach_03",
      type: "builtin.foreach",
      items: "$.input.items",
      itemVar: "item",
      body: [],
      concurrency: 1,
    });
    expect(createWorkflowNodeTemplate("sleep", 4)).toEqual({
      id: "sleep_04",
      type: "builtin.sleep",
      delayMs: 1000,
      reason: "Wait before continuing",
    });
    expect(createWorkflowNodeTemplate("throw_error", 5)).toEqual({
      id: "throw_error_05",
      type: "builtin.throw_error",
      message: "Controlled workflow failure",
      code: "workflow_error",
      details: "$.context",
    });
    expect(createWorkflowNodeTemplate("parallel", 6)).toEqual({
      id: "parallel_06",
      type: "builtin.parallel",
      branches: [
        { id: "branch_a", label: "Branch A", nodes: [] },
        { id: "branch_b", label: "Branch B", nodes: [] },
      ],
      concurrency: 2,
      failFast: true,
    });
    expect(
      createWorkflowNodeTemplate("mcp", 7, {
        server: "crm/demo",
        tool: "echo-message",
      }),
    ).toMatchObject({
      id: "mcp_crm_demo_echo_message_07",
      type: "mcp.tool",
      server: "crm/demo",
      tool: "echo-message",
    });
    expect(
      createWorkflowNodeTemplate("agent", 8, { id: "risk-review" }),
    ).toMatchObject({
      id: "agent_risk_review_08",
      type: "agent.call",
      agentId: "risk-review",
    });
  });

  it("appends with the next canonical array index", () => {
    const nodes = appendWorkflowNode(
      [
        { id: "set_01", type: "builtin.set" },
        { id: "exit_02", type: "builtin.exit" },
      ],
      "log",
    );

    expect(nodes.map((node) => node.id)).toEqual([
      "set_01",
      "exit_02",
      "log_03",
    ]);
  });

  it("inserts after the selected node without mutating existing references", () => {
    const nodes = [
      {
        id: "branch",
        type: "builtin.if_else",
        then: ["review"],
        else: ["exit"],
      },
      { id: "review", type: "agent.call" },
      { id: "exit", type: "builtin.exit" },
    ];

    const inserted = insertWorkflowNodeAfter(nodes, "branch", "log");

    expect(inserted.map((node) => node.id)).toEqual([
      "branch",
      "log_04",
      "review",
      "exit",
    ]);
    expect(inserted[0]).toMatchObject({
      id: "branch",
      then: ["review"],
      else: ["exit"],
    });
    expect(nodes.map((node) => node.id)).toEqual(["branch", "review", "exit"]);
  });

  it("inserts a selected trigger child as the first workflow node", () => {
    const nodes = [
      { id: "normalize", type: "builtin.transform" },
      { id: "exit", type: "builtin.exit" },
    ];

    const inserted = insertWorkflowNodeFirst(nodes, "set");

    expect(inserted.map((node) => node.id)).toEqual([
      "set_03",
      "normalize",
      "exit",
    ]);
    expect(nodes.map((node) => node.id)).toEqual(["normalize", "exit"]);
  });

  it("uses a later suffix when the natural inserted id already exists", () => {
    const nodes = [
      { id: "set_01", type: "builtin.set" },
      { id: "log_03", type: "builtin.log.info" },
    ];

    expect(insertWorkflowNodeAfter(nodes, "set_01", "log")[1]).toMatchObject({
      id: "log_04",
      type: "builtin.log.info",
    });
  });

  it("clones a node after itself with a unique id and updated self references", () => {
    const result = cloneWorkflowNodeAfter(
      [
        {
          id: "transform_02",
          type: "builtin.transform",
          transform: "$.steps.transform_02.output",
          assign: {
            value: {
              from: "$.steps.transform_02.output.value",
              mode: "replace",
            },
          },
        },
        { id: "transform_02_copy", type: "builtin.transform" },
      ],
      "transform_02",
    );

    expect(result?.clonedId).toBe("transform_02_copy_2");
    expect(result?.nodes.map((node) => node.id)).toEqual([
      "transform_02",
      "transform_02_copy_2",
      "transform_02_copy",
    ]);
    expect(result?.nodes[1]).toMatchObject({
      id: "transform_02_copy_2",
      transform: "$.steps.transform_02_copy_2.output",
      assign: {
        value: {
          from: "$.steps.transform_02_copy_2.output.value",
          mode: "replace",
        },
      },
    });
  });

  it("removes a node and prunes branch references to it", () => {
    const removed = removeWorkflowNode(
      [
        {
          id: "branch",
          type: "builtin.if_else",
          then: ["review", "notify"],
          else: ["review"],
        },
        {
          id: "loop",
          type: "builtin.foreach",
          body: ["review"],
        },
        {
          id: "parallel",
          type: "builtin.parallel",
          branches: [
            { id: "left", nodes: ["review", "notify"] },
            { id: "right", nodes: ["review"] },
          ],
        },
        { id: "review", type: "agent.call" },
      ],
      "review",
    );

    expect(removed).toEqual([
      {
        id: "branch",
        type: "builtin.if_else",
        then: ["notify"],
        else: [],
      },
      {
        id: "loop",
        type: "builtin.foreach",
        body: [],
      },
      {
        id: "parallel",
        type: "builtin.parallel",
        branches: [
          { id: "left", nodes: ["notify"] },
          { id: "right", nodes: [] },
        ],
      },
    ]);
  });

  it("moves nodes without mutating branch references", () => {
    const nodes = [
      {
        id: "branch",
        type: "builtin.if_else",
        then: ["review"],
        else: ["exit"],
      },
      { id: "review", type: "agent.call" },
      { id: "exit", type: "builtin.exit" },
    ];

    const moved = moveWorkflowNode(nodes, 2, -1);

    expect(moved.map((node) => node.id)).toEqual(["branch", "exit", "review"]);
    expect(moved[0]).toMatchObject({
      id: "branch",
      then: ["review"],
      else: ["exit"],
    });
    expect(nodes.map((node) => node.id)).toEqual(["branch", "review", "exit"]);
  });

  it("keeps the same array when move is out of range", () => {
    const nodes = [{ id: "only", type: "builtin.exit" }];
    expect(moveWorkflowNode(nodes, 0, -1)).toBe(nodes);
    expect(moveWorkflowNode(nodes, 0, 1)).toBe(nodes);
  });

  it("exposes transform operation presets with runnable default payloads", () => {
    expect(WORKFLOW_TRANSFORM_PRESETS.map((preset) => preset.id)).toEqual([
      "string.replace",
      "string.regex_replace",
      "string.regex_match",
      "json.parse",
      "json.stringify",
      "csv.parse",
      "csv.stringify",
      "ip.parse",
      "ip.is_ipv4",
      "ip.is_ipv6",
      "ip.in_subnet",
      "ip.netmask",
      "ip.network",
      "uri.parse",
    ]);
    expect(workflowTransformPresetById("string.replace")?.transform).toEqual({
      kind: "string.replace",
      value: "$.input.value",
      search: "old",
      replacement: "new",
      all: true,
    });
    expect(workflowTransformPresetById("csv.parse")?.transform).toEqual({
      kind: "csv.parse",
      value: "$.input.csv",
      headers: true,
      maxRows: 10000,
    });
    expect(workflowTransformPresetById("ip.in_subnet")?.transform).toEqual({
      kind: "ip.in_subnet",
      value: "$.input.ip",
      cidr: "10.0.0.0/8",
    });
    expect(workflowTransformPresetById("uri.parse")?.transform).toEqual({
      kind: "uri.parse",
      value: "$.input.url",
    });
    expect(workflowTransformPresetById("missing")).toBeUndefined();
  });
});
