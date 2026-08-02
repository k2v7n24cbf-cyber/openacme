import { describe, expect, it } from "vitest";
import {
  connectWorkflowReferenceEdge,
  connectWorkflowRouteContinuationEdge,
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
          type: "builtin.if",
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
          type: "builtin.if",
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
        { id: "copy_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
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
        { id: "copy_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
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
        { id: "copy_asset", type: "builtin.transform" },
        { id: "normalize_asset", type: "builtin.transform" },
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
        { id: "copy_asset", type: "builtin.transform" },
        { id: "normalize_asset", type: "builtin.transform" },
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
        { id: "copy_asset", type: "builtin.transform" },
        { id: "normalize_asset", type: "builtin.transform" },
      ],
    });
  });

  it("connects switch case and default references", () => {
    const result = connectWorkflowReferenceEdge(
      [
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.input.kind",
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

  it("connects route continuation from a card inside one switch case only", () => {
    const result = connectWorkflowRouteContinuationEdge(
      [
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.input.kind",
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
            { id: "asset", value: "asset", nodes: ["asset_log", "done"] },
          ],
          default: ["unknown_log"],
        }),
        { id: "asset_log", type: "builtin.log.info" },
        { id: "unknown_log", type: "builtin.log.warn" },
        { id: "done", type: "builtin.log.info" },
      ],
    });
  });

  it("connects a route continuation from a card inside one branch only", () => {
    const result = connectWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.risky",
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
          then: ["warn_operator", "wait_for_index"],
          else: ["throw_controlled"],
        }),
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
    });
  });

  it("removes a route continuation from its branch list", () => {
    const result = removeWorkflowRouteContinuationEdge(
      [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.risky",
          then: ["warn_operator", "wait_for_index"],
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
          then: ["warn_operator"],
          else: ["throw_controlled"],
        }),
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error" },
        { id: "wait_for_index", type: "builtin.sleep" },
      ],
    });
  });

  it("rejects route continuations from cards shared by multiple routes", () => {
    expect(
      connectWorkflowRouteContinuationEdge(
        [
          {
            id: "branch",
            type: "builtin.if",
            condition: "$.input.risky",
            then: ["warn_operator", "wait_for_index"],
            else: ["throw_controlled", "wait_for_index"],
          },
          { id: "warn_operator", type: "builtin.log.info" },
          { id: "throw_controlled", type: "builtin.throw_error" },
          { id: "wait_for_index", type: "builtin.sleep" },
          { id: "done", type: "builtin.log.info" },
        ],
        { sourceId: "wait_for_index", targetId: "done" },
      ),
    ).toEqual({ ok: false, reason: "ambiguous_route_source" });
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
