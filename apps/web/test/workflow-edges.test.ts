import { describe, expect, it } from "vitest";
import {
  connectWorkflowReferenceEdge,
  connectWorkflowRouteContinuationEdge,
  firstWorkflowReferenceTarget,
  insertWorkflowReferenceEdgeTarget,
  overwriteWorkflowReferenceEdge,
  overwriteWorkflowRouteContinuationEdge,
  reconnectWorkflowReferenceEdge,
  removeWorkflowReferenceEdge,
  removeWorkflowRouteContinuationEdge,
} from "@/app/workflows/edges";

describe("workflow reference edge mutations", () => {
  it("connects true branch references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
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
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
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
          condition: "$.workflowTrigger.input.enabled",
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
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
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
          items: "$.workflowTrigger.input.customers",
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

  it("connects parallel branch references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: [] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
          ],
        },
        { id: "copy_asset", type: "builtin.transform.object_pick" },
        { id: "parse_uri", type: "builtin.transform.object_pick" },
      ],
      {
        sourceId: "parallel_enrichment",
        targetId: "copy_asset",
        kind: "branch:asset",
      },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "parallel_enrichment",
          branches: [
            { id: "asset", label: "Asset", nodes: ["copy_asset"] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
          ],
        }),
        { id: "copy_asset", type: "builtin.transform.object_pick" },
        { id: "parse_uri", type: "builtin.transform.object_pick" },
      ],
    });
  });

  it("inserts a new reference entry before an existing route entry", () => {
    const nodes = [
      {
        id: "parallel_enrichment",
        type: "builtin.parallel",
        branches: [
          { id: "asset", label: "Asset", nodes: ["copy_asset"] },
          { id: "uri", label: "URI", nodes: [] },
        ],
      },
      { id: "copy_asset", type: "builtin.transform.object_pick" },
      { id: "normalize_asset", type: "builtin.transform.object_pick" },
    ];

    expect(
      firstWorkflowReferenceTarget(nodes, {
        sourceId: "parallel_enrichment",
        kind: "branch:asset",
      }),
    ).toBe("copy_asset");

    expect(
      insertWorkflowReferenceEdgeTarget(nodes, {
        sourceId: "parallel_enrichment",
        targetId: "normalize_asset",
        kind: "branch:asset",
      }),
    ).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          branches: [
            {
              id: "asset",
              label: "Asset",
              nodes: ["normalize_asset"],
            },
            { id: "uri", label: "URI", nodes: [] },
          ],
        }),
        { id: "copy_asset", type: "builtin.transform.object_pick" },
        {
          id: "normalize_asset",
          type: "builtin.transform.object_pick",
          next: ["copy_asset"],
        },
      ],
    });
  });

  it("overwrites reference targets for manually drawn handle flows", () => {
    const result = overwriteWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["old_review", "old_notify"],
          else: [],
        },
        { id: "old_review", type: "agent.call" },
        { id: "old_notify", type: "builtin.log.info" },
        { id: "new_review", type: "agent.call" },
      ],
      { sourceId: "branch", targetId: "new_review", kind: "then" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "branch",
          then: ["new_review"],
          else: [],
        }),
        { id: "old_review", type: "agent.call" },
        { id: "old_notify", type: "builtin.log.info" },
        { id: "new_review", type: "agent.call" },
      ],
    });
  });

  it("does not infer target card continuation for manually drawn handle flows", () => {
    const result = overwriteWorkflowReferenceEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["old_review"],
          else: [],
        },
        { id: "old_review", type: "agent.call" },
        { id: "new_review", type: "agent.call" },
        { id: "notify", type: "builtin.log.info" },
      ],
      {
        sourceId: "branch",
        targetId: "new_review",
        kind: "then",
        preserveTargets: { new_review: ["notify"] },
      },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "branch",
          then: ["new_review"],
          else: [],
        }),
        { id: "old_review", type: "agent.call" },
        { id: "new_review", type: "agent.call" },
        { id: "notify", type: "builtin.log.info" },
      ],
    });
  });

  it("reconnects and removes parallel branch references", () => {
    const reconnected = reconnectWorkflowReferenceEdge(
      [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [{ id: "asset", nodes: ["copy_asset"] }],
        },
        { id: "copy_asset", type: "builtin.transform.object_pick" },
        { id: "normalize_asset", type: "builtin.transform.object_pick" },
      ],
      {
        sourceId: "parallel_enrichment",
        previousTargetId: "copy_asset",
        targetId: "normalize_asset",
        kind: "branch:asset",
      },
    );

    expect(reconnected).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          branches: [{ id: "asset", nodes: ["normalize_asset"] }],
        }),
        { id: "copy_asset", type: "builtin.transform.object_pick" },
        { id: "normalize_asset", type: "builtin.transform.object_pick" },
      ],
    });

    if (!reconnected.ok) throw new Error("reconnect failed");
    expect(
      removeWorkflowReferenceEdge(reconnected.nodes, {
        sourceId: "parallel_enrichment",
        targetId: "normalize_asset",
        kind: "branch:asset",
      }),
    ).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          branches: [{ id: "asset", nodes: [] }],
        }),
        { id: "copy_asset", type: "builtin.transform.object_pick" },
        { id: "normalize_asset", type: "builtin.transform.object_pick" },
      ],
    });
  });

  it("connects switch case and default references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.workflowTrigger.input.kind",
          cases: [
            { id: "asset", value: "asset", nodes: [] },
            { id: "owner", value: "owner", nodes: ["owner_log"] },
          ],
          default: [],
        },
        { id: "asset_log", type: "builtin.log.info" },
        { id: "owner_log", type: "builtin.log.info" },
        { id: "unknown_log", type: "builtin.log.warn" },
      ],
      {
        sourceId: "route_by_kind",
        targetId: "asset_log",
        kind: "case:asset",
      },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "route_by_kind",
          cases: [
            { id: "asset", value: "asset", nodes: ["asset_log"] },
            { id: "owner", value: "owner", nodes: ["owner_log"] },
          ],
          default: [],
        }),
        { id: "asset_log", type: "builtin.log.info" },
        { id: "owner_log", type: "builtin.log.info" },
        { id: "unknown_log", type: "builtin.log.warn" },
      ],
    });

    if (!result.ok) throw new Error("switch case connect failed");
    expect(
      connectWorkflowReferenceEdge(result.nodes, {
        sourceId: "route_by_kind",
        targetId: "unknown_log",
        kind: "default",
      }),
    ).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          cases: [
            { id: "asset", value: "asset", nodes: ["asset_log"] },
            { id: "owner", value: "owner", nodes: ["owner_log"] },
          ],
          default: ["unknown_log"],
        }),
        { id: "asset_log", type: "builtin.log.info" },
        { id: "owner_log", type: "builtin.log.info" },
        { id: "unknown_log", type: "builtin.log.warn" },
      ],
    });
  });

  it("connects route continuation as explicit next from a switch case card", () => {
    const result = connectWorkflowRouteContinuationEdge(
      [
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.workflowTrigger.input.kind",
          cases: [{ id: "asset", value: "asset", nodes: ["asset_log"] }],
          default: ["unknown_log"],
        },
        { id: "asset_log", type: "builtin.log.info" },
        { id: "unknown_log", type: "builtin.log.warn" },
        { id: "done", type: "builtin.log.info" },
      ],
      { sourceId: "asset_log", targetId: "done" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          cases: [
            { id: "asset", value: "asset", nodes: ["asset_log"] },
          ],
          default: ["unknown_log"],
        }),
        { id: "asset_log", type: "builtin.log.info", next: ["done"] },
        { id: "unknown_log", type: "builtin.log.warn" },
        { id: "done", type: "builtin.log.info" },
      ],
    });
  });

  it("connects branch continuation as explicit next from the branch card", () => {
    const result = connectWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["warn_operator"],
          else: ["throw_controlled"],
        },
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
      { sourceId: "warn_operator", targetId: "wait_for_index" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "branch",
          then: ["warn_operator"],
          else: ["throw_controlled"],
        }),
        { id: "warn_operator", type: "builtin.log.info", next: ["wait_for_index"] },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
    });
  });

  it("overwrites downstream next without mutating route history", () => {
    const result = overwriteWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["warn_operator", "wait_for_index", "notify_old"],
          else: ["throw_controlled"],
        },
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "wait_for_index", type: "builtin.sleep" },
        { id: "notify_old", type: "builtin.log.info" },
        { id: "notify_new", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
      ],
      { sourceId: "warn_operator", targetId: "notify_new" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          id: "branch",
          then: ["warn_operator", "wait_for_index", "notify_old"],
          else: ["throw_controlled"],
        }),
        { id: "warn_operator", type: "builtin.log.info", next: ["notify_new"] },
        { id: "wait_for_index", type: "builtin.sleep" },
        { id: "notify_old", type: "builtin.log.info" },
        { id: "notify_new", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
      ],
    });
  });

  it("does not copy a target card downstream route when connecting into it", () => {
    const result = overwriteWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["warn_operator"],
          else: ["throw_controlled", "wait_for_index"],
        },
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
      {
        sourceId: "warn_operator",
        targetId: "throw_controlled",
        preserveTargets: { throw_controlled: ["wait_for_index"] },
      },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          then: ["warn_operator"],
          else: ["throw_controlled", "wait_for_index"],
        }),
        { id: "warn_operator", type: "builtin.log.info", next: ["throw_controlled"] },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
    });
  });

  it("does not copy target card preserved continuation when connecting into it", () => {
    const result = overwriteWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["warn_operator"],
          else: ["throw_controlled"],
        },
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
      {
        sourceId: "warn_operator",
        targetId: "throw_controlled",
        preserveTargets: { throw_controlled: ["wait_for_index"] },
      },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          then: ["warn_operator"],
          else: ["throw_controlled"],
        }),
        { id: "warn_operator", type: "builtin.log.info", next: ["throw_controlled"] },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
    });
  });

  it("removes route continuation from explicit next", () => {
    const result = removeWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky",
          then: ["warn_operator"],
          else: ["throw_controlled"],
        },
        {
          id: "warn_operator",
          type: "builtin.log.info",
          next: ["wait_for_index"],
        },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
      { sourceId: "warn_operator", targetId: "wait_for_index" },
    );

    expect(result).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          then: ["warn_operator"],
          else: ["throw_controlled"],
        }),
        { id: "warn_operator", type: "builtin.log.info", next: [] },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
    });
  });

  it("updates shared card continuation through explicit next only", () => {
    expect(
      overwriteWorkflowRouteContinuationEdge(
        [
          {
            id: "branch",
            type: "builtin.if",
            condition: "$.workflowTrigger.input.risky",
            then: ["warn_operator", "wait_for_index", "old_true"],
            else: ["throw_controlled", "wait_for_index", "old_false"],
          },
          { id: "warn_operator", type: "builtin.log.info" },
          { id: "throw_controlled", type: "builtin.throw_error" },
          { id: "wait_for_index", type: "builtin.sleep" },
          { id: "done", type: "builtin.log.info" },
          { id: "old_true", type: "builtin.log.info" },
          { id: "old_false", type: "builtin.log.info" },
        ],
        { sourceId: "wait_for_index", targetId: "done" },
      ),
    ).toEqual({
      ok: true,
      nodes: [
        expect.objectContaining({
          then: ["warn_operator", "wait_for_index", "old_true"],
          else: ["throw_controlled", "wait_for_index", "old_false"],
        }),
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep", next: ["done"] },
        { id: "done", type: "builtin.log.info" },
        { id: "old_true", type: "builtin.log.info" },
        { id: "old_false", type: "builtin.log.info" },
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
        { sourceId: "branch", targetId: "exit", kind: "body" },
      ),
    ).toEqual({ ok: false, reason: "edge_kind_not_supported" });

    expect(
      connectWorkflowReferenceEdge(
        [
          {
            id: "parallel",
            type: "builtin.parallel",
            branches: [{ id: "asset", nodes: [] }],
          },
          { id: "exit", type: "builtin.exit" },
        ],
        { sourceId: "parallel", targetId: "exit", kind: "branch:missing" },
      ),
    ).toEqual({ ok: false, reason: "edge_kind_not_supported" });
  });
});
