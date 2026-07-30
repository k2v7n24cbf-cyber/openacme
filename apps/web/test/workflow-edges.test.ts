import { describe, expect, it } from "vitest";
import {
  connectWorkflowReferenceEdge,
  reconnectWorkflowReferenceEdge,
  removeWorkflowReferenceEdge,
} from "@/app/workflows/edges";

describe("workflow reference edge mutations", () => {
  it("connects true branch references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.input.risky",
          then: [],
          else: [],
        },
        { id: "review", type: "agent.call" },
      ],
      { sourceId: "branch", targetId: "review", kind: "then" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({ id: "branch", then: ["review"], else: [] }),
        { id: "review", type: "agent.call" },
      ],
    });
  });

  it("connects false branch references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.input.risky",
          then: [],
          else: [],
        },
        { id: "auto_approve", type: "builtin.set" },
      ],
      { sourceId: "branch", targetId: "auto_approve", kind: "else" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "branch",
          then: [],
          else: ["auto_approve"],
        }),
        { id: "auto_approve", type: "builtin.set" },
      ],
    });
  });

  it("reconnects branch references without duplicating targets", () => {
    const result = reconnectWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.enabled",
          then: ["old_target"],
        },
        { id: "old_target", type: "builtin.log.info" },
        { id: "new_target", type: "builtin.exit" },
      ],
      {
        sourceId: "branch",
        previousTargetId: "old_target",
        targetId: "new_target",
        kind: "then",
      },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({ id: "branch", then: ["new_target"] }),
        { id: "old_target", type: "builtin.log.info" },
        { id: "new_target", type: "builtin.exit" },
      ],
    });
  });

  it("removes branch references", () => {
    const result = removeWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.input.risky",
          then: ["review", "notify"],
          else: ["exit"],
        },
        { id: "review", type: "agent.call" },
        { id: "notify", type: "builtin.log.info" },
        { id: "exit", type: "builtin.exit" },
      ],
      { sourceId: "branch", targetId: "notify", kind: "then" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "branch",
          then: ["review"],
          else: ["exit"],
        }),
        { id: "review", type: "agent.call" },
        { id: "notify", type: "builtin.log.info" },
        { id: "exit", type: "builtin.exit" },
      ],
    });
  });

  it("connects foreach body references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          itemVar: "customer",
          body: [],
        },
        { id: "score_customer", type: "builtin.python" },
      ],
      { sourceId: "each_customer", targetId: "score_customer", kind: "body" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "each_customer",
          body: ["score_customer"],
        }),
        { id: "score_customer", type: "builtin.python" },
      ],
    });
  });

  it("rejects edge kinds that cannot be represented by the canonical schema", () => {
    expect(
      connectWorkflowReferenceEdge(
        [
          { id: "set_customer", type: "builtin.set" },
          { id: "exit", type: "builtin.exit" },
        ],
        { sourceId: "set_customer", targetId: "exit", kind: "then" },
      ),
    ).toEqual({ ok: false, reason: "edge_kind_not_supported" });

    expect(
      connectWorkflowReferenceEdge(
        [
          { id: "branch", type: "builtin.if", then: [] },
          { id: "exit", type: "builtin.exit" },
        ],
        { sourceId: "branch", targetId: "exit", kind: "else" },
      ),
    ).toEqual({ ok: false, reason: "edge_kind_not_supported" });
  });
});
