import { describe, expect, it } from "vitest";
import {
  appendWorkflowNode,
  createWorkflowNodeTemplate,
  moveWorkflowNode,
} from "@/app/workflows/authoring";

describe("workflow authoring helpers", () => {
  it("creates representative node defaults", () => {
    expect(createWorkflowNodeTemplate("set", 1)).toEqual({
      id: "set_01",
      type: "builtin.set",
      assign: { value: "$.input.value" },
    });
    expect(createWorkflowNodeTemplate("if_else", 2)).toEqual({
      id: "if_else_02",
      type: "builtin.if_else",
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
    expect(
      createWorkflowNodeTemplate("mcp", 4, {
        server: "crm/demo",
        tool: "echo-message",
      }),
    ).toMatchObject({
      id: "mcp_crm_demo_echo_message_04",
      type: "mcp.tool",
      server: "crm/demo",
      tool: "echo-message",
    });
    expect(
      createWorkflowNodeTemplate("agent", 5, { id: "risk-review" }),
    ).toMatchObject({
      id: "agent_risk_review_05",
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
});
