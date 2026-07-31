import { describe, expect, it } from "vitest";
import { buildWorkflowGraphProjection } from "@/app/workflows/graph";

describe("buildWorkflowGraphProjection", () => {
  it("creates trigger and sequential edges for visible workflow cards", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [{ id: "manual_review", kind: "manual", enabled: true }],
      nodes: [
        { id: "set_customer", type: "builtin.set" },
        { id: "normalize", type: "builtin.transform" },
        { id: "exit", type: "builtin.exit" },
      ],
    });

    expect(graph.warnings).toEqual([]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "trigger:manual_review",
      "set_customer",
      "normalize",
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      "edge:trigger:manual_review:set_customer",
      "edge:sequence:set_customer:normalize",
    ]);
  });

  it("uses persisted canvas layout positions for workflow step nodes", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        { id: "set_customer", type: "builtin.set" },
        { id: "exit", type: "builtin.exit" },
      ],
      layout: {
        nodes: {
          set_customer: { position: { x: 120, y: 80 } },
        },
      },
    });

    expect(graph.nodes.find((node) => node.id === "set_customer")).toEqual(
      expect.objectContaining({
        position: { x: 120, y: 80 },
      }),
    );
    expect(graph.nodes.find((node) => node.id === "exit")).toBeUndefined();
  });

  it("creates branch edges for if nodes", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.enabled",
          then: ["notify"],
          else: ["skip"],
        },
        { id: "notify", type: "builtin.log.info" },
        { id: "skip", type: "builtin.log.info" },
      ],
    });

    expect(graph.warnings).toEqual([]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:then:branch:notify",
          source: "branch",
          target: "notify",
          label: "true",
        }),
        expect.objectContaining({
          id: "edge:else:branch:skip",
          source: "branch",
          target: "skip",
          label: "false",
        }),
      ]),
    );
  });

  it("creates true and false branch edges for if-else nodes", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.input.risky",
          then: ["manual_review"],
          else: ["auto_approve"],
        },
        { id: "manual_review", type: "agent.call" },
        { id: "auto_approve", type: "builtin.set" },
      ],
    });

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:then:branch:manual_review",
          label: "true",
        }),
        expect.objectContaining({
          id: "edge:else:branch:auto_approve",
          label: "false",
        }),
      ]),
    );
  });

  it("does not create default sequence edges from explicit branch handles", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.risky",
          then: [],
          else: [],
        },
        { id: "normalize", type: "builtin.transform" },
      ],
    });

    expect(graph.edges.map((edge) => edge.id)).not.toContain(
      "edge:sequence:branch:normalize",
    );
  });

  it("creates foreach body edges", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          itemVar: "customer",
          body: ["score_customer"],
        },
        { id: "score_customer", type: "builtin.python" },
        { id: "exit", type: "builtin.exit" },
      ],
    });

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:body:each_customer:score_customer",
          label: "body",
        }),
      ]),
    );
  });

  it("surfaces missing branch references as warnings and placeholder nodes", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.input.risky",
          then: ["missing_step"],
          else: ["exit"],
        },
        { id: "exit", type: "builtin.exit" },
      ],
    });

    expect(graph.warnings).toEqual([
      "Node branch then references missing node missing_step",
    ]);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "missing:branch:then:missing_step",
          data: expect.objectContaining({
            kind: "missing",
            label: "missing_step",
          }),
        }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:then:branch:missing:branch:then:missing_step",
          sourceHandle: "then",
          data: { kind: "then", targetRef: "missing_step", invalid: true },
        }),
      ]),
    );
  });
});
