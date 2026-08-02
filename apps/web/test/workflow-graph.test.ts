import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
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
          label: undefined,
        }),
        expect.objectContaining({
          id: "edge:else:branch:skip",
          source: "branch",
          target: "skip",
          label: undefined,
        }),
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toContain(
      "edge:sequence:notify:skip",
    );
  });

  it("connects if routes only to their first visible card and sequences route bodies", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.enabled",
          then: ["normalize", "notify"],
          else: ["skip", "audit"],
        },
        { id: "normalize", type: "builtin.transform" },
        { id: "notify", type: "builtin.log.info" },
        { id: "skip", type: "builtin.log.info" },
        { id: "audit", type: "builtin.log.info" },
        { id: "done", type: "builtin.log.info" },
      ],
    });

    expect(graph.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "edge:then:branch:normalize",
        "edge:else:branch:skip",
        "edge:route:branch:then:normalize:notify",
        "edge:route:branch:else:skip:audit",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:then:branch:notify",
        "edge:else:branch:audit",
        "edge:sequence:notify:skip",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:sequence:notify:done",
        "edge:sequence:audit:done",
      ]),
    );
  });

  it("places default if true routes on the left and false routes on the right", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "risk_gate",
          type: "builtin.if",
          condition: "$.input.risky",
          then: ["warn_operator", "wait_for_index"],
          else: ["throw_controlled", "wait_for_index"],
        },
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error", message: "No" },
        { id: "wait_for_index", type: "builtin.sleep", delayMs: 1000 },
      ],
    });

    const parent = graph.nodes.find((node) => node.id === "risk_gate");
    const trueNode = graph.nodes.find((node) => node.id === "warn_operator");
    const falseNode = graph.nodes.find(
      (node) => node.id === "throw_controlled",
    );
    const mergeNode = graph.nodes.find((node) => node.id === "wait_for_index");

    expect(parent).toBeDefined();
    expect(trueNode).toBeDefined();
    expect(falseNode).toBeDefined();
    expect(mergeNode).toBeDefined();
    expect(trueNode!.position.x).toBeLessThan(parent!.position.x);
    expect(falseNode!.position.x).toBeGreaterThan(parent!.position.x);
    expect(falseNode!.position.x - trueNode!.position.x).toBeGreaterThanOrEqual(
      500,
    );
    expect(Math.abs(mergeNode!.position.x - parent!.position.x)).toBeLessThan(
      160,
    );
    expect(trueNode!.position.y - parent!.position.y).toBeGreaterThanOrEqual(
      160,
    );
  });

  it("does not override persisted if route positions", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "risk_gate",
          type: "builtin.if",
          condition: "$.input.risky",
          then: ["warn_operator"],
          else: ["throw_controlled"],
        },
        { id: "warn_operator", type: "builtin.log.info" },
        { id: "throw_controlled", type: "builtin.throw_error", message: "No" },
      ],
      layout: {
        nodes: {
          warn_operator: { position: { x: 920, y: 440 } },
          throw_controlled: { position: { x: 120, y: 440 } },
        },
      },
    });

    expect(graph.nodes.find((node) => node.id === "warn_operator")).toEqual(
      expect.objectContaining({
        position: { x: 920, y: 440 },
      }),
    );
    expect(graph.nodes.find((node) => node.id === "throw_controlled")).toEqual(
      expect.objectContaining({
        position: { x: 120, y: 440 },
      }),
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
          label: undefined,
        }),
        expect.objectContaining({
          id: "edge:else:branch:auto_approve",
          label: undefined,
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

  it("creates a single foreach body entry edge and sequences body nodes", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          itemVar: "customer",
          body: ["score_customer", "log_customer"],
        },
        { id: "score_customer", type: "builtin.python" },
        { id: "log_customer", type: "builtin.log.info" },
      ],
    });

    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "edge:body:each_customer:group:each_customer:body",
        "edge:route:each_customer:body:score_customer:log_customer",
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:body:each_customer:group:each_customer:body",
          label: undefined,
        }),
        expect.objectContaining({
          id: "edge:route:each_customer:body:score_customer:log_customer",
          label: undefined,
        }),
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toContain(
      "edge:body:each_customer:log_customer",
    );
    expect(
      graph.nodes.find((node) => node.id === "each_customer")?.data,
    ).toEqual(
      expect.objectContaining({
        summary: "Loop over input.customers as customer",
      }),
    );
  });

  it("places foreach body as a right-side loop scope and continues from the foreach card", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          itemVar: "customer",
          body: ["score_customer", "log_customer"],
        },
        { id: "score_customer", type: "builtin.transform" },
        { id: "log_customer", type: "builtin.log.info" },
        { id: "after_loop", type: "builtin.log.info" },
      ],
    });

    const parent = graph.nodes.find((node) => node.id === "each_customer");
    const firstBody = graph.nodes.find((node) => node.id === "score_customer");
    const secondBody = graph.nodes.find((node) => node.id === "log_customer");
    const continuation = graph.nodes.find((node) => node.id === "after_loop");
    const bodyGroup = graph.nodes.find(
      (node) => node.id === "group:each_customer:body",
    );

    expect(graph.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "edge:body:each_customer:group:each_customer:body",
        "edge:route:each_customer:body:score_customer:log_customer",
        "edge:sequence:each_customer:after_loop",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:sequence:score_customer:log_customer",
        "edge:sequence:log_customer:after_loop",
      ]),
    );
    expect(parent).toBeDefined();
    expect(firstBody).toBeDefined();
    expect(secondBody).toBeDefined();
    expect(continuation).toBeDefined();
    expect(bodyGroup).toEqual(
      expect.objectContaining({
        type: "workflowGroup",
        targetPosition: Position.Left,
        data: expect.objectContaining({
          kind: "group",
          type: "foreach.body",
        }),
      }),
    );
    expect(firstBody!.position.x).toBeGreaterThan(parent!.position.x);
    expect(secondBody!.position.x).toBe(firstBody!.position.x);
    expect(secondBody!.position.y).toBeGreaterThan(firstBody!.position.y);
    expect(bodyGroup!.position.x).toBeLessThan(firstBody!.position.x);
    expect(bodyGroup!.position.y).toBeLessThan(firstBody!.position.y);
    expect(firstBody!.position.x - bodyGroup!.position.x).toBeLessThan(72);
    expect(
      bodyGroup!.position.x +
        Number(bodyGroup!.data.canvasWidth) -
        firstBody!.position.x,
    ).toBeGreaterThan(200);
    expect(
      bodyGroup!.position.y +
        Number(bodyGroup!.data.canvasHeight) -
        secondBody!.position.y,
    ).toBeGreaterThan(80);
    expect(bodyGroup!.data.groupRailWidth).toBe(
      firstBody!.position.x - bodyGroup!.position.x,
    );
    expect(bodyGroup!.data.groupRailY).toBe(
      firstBody!.position.y + 120 / 2 - bodyGroup!.position.y,
    );
    expect(firstBody).toEqual(
      expect.objectContaining({
        targetPosition: Position.Left,
        data: expect.objectContaining({ targetSide: "left" }),
      }),
    );
    expect(secondBody?.targetPosition).toBe(Position.Top);
    expect(
      Math.abs(continuation!.position.x - parent!.position.x),
    ).toBeLessThan(2);
    expect(continuation!.position.y).toBeGreaterThan(secondBody!.position.y);
    expect(firstBody?.data.flowDirection).toBe("vertical");
  });

  it("keeps nested foreach and if route edges separate", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "each_asset",
          type: "builtin.foreach",
          items: "$.input.assets",
          itemVar: "asset",
          body: ["route_asset", "mark_true", "mark_false", "record_asset"],
        },
        {
          id: "route_asset",
          type: "builtin.if",
          condition: "$.context.asset.risky == true",
          then: ["mark_true"],
          else: ["mark_false"],
        },
        { id: "mark_true", type: "builtin.set" },
        { id: "mark_false", type: "builtin.set" },
        { id: "record_asset", type: "builtin.log.info" },
        { id: "after_loop", type: "builtin.log.info" },
      ],
    });

    expect(graph.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "edge:body:each_asset:group:each_asset:body",
        "edge:then:route_asset:mark_true",
        "edge:else:route_asset:mark_false",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:body:each_asset:mark_true",
        "edge:body:each_asset:mark_false",
        "edge:body:each_asset:record_asset",
        "edge:sequence:mark_true:mark_false",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:route:each_asset:body:mark_true:mark_false",
        "edge:sequence:mark_true:mark_false",
        "edge:sequence:mark_true:record_asset",
        "edge:sequence:mark_false:record_asset",
        "edge:sequence:record_asset:after_loop",
      ]),
    );
  });

  it("creates switch case handles and places cases in declared slots", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.input.kind",
          cases: [
            {
              id: "asset",
              label: "Asset",
              value: "asset",
              nodes: ["asset_log"],
            },
            {
              id: "owner",
              label: "Owner",
              value: "owner",
              nodes: ["owner_log"],
            },
          ],
          default: ["unknown_log"],
        },
        { id: "asset_log", type: "builtin.log.info" },
        { id: "owner_log", type: "builtin.log.info" },
        { id: "unknown_log", type: "builtin.log.warn" },
      ],
    });

    const parent = graph.nodes.find((node) => node.id === "route_by_kind");
    const asset = graph.nodes.find((node) => node.id === "asset_log");
    const owner = graph.nodes.find((node) => node.id === "owner_log");
    const fallback = graph.nodes.find((node) => node.id === "unknown_log");

    expect(parent?.data.sourceHandles).toEqual([
      { id: "case:asset", label: "Asset" },
      { id: "case:owner", label: "Owner" },
      { id: "default", label: "default" },
    ]);
    expect(parent?.data.canvasWidth).toBeGreaterThan(220);
    expect(graph.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "edge:case:asset:route_by_kind:asset_log",
        "edge:case:owner:route_by_kind:owner_log",
        "edge:default:route_by_kind:unknown_log",
      ]),
    );
    expect(asset!.position.x).toBeLessThan(parent!.position.x);
    expect(owner!.position.x).toBeGreaterThan(asset!.position.x);
    expect(fallback!.position.x).toBeGreaterThan(owner!.position.x);
  });

  it("keeps a single populated switch case in its declared slot", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
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
        { id: "owner_log", type: "builtin.log.info" },
      ],
    });

    const parent = graph.nodes.find((node) => node.id === "route_by_kind");
    const owner = graph.nodes.find((node) => node.id === "owner_log");

    expect(parent).toBeDefined();
    expect(owner).toBeDefined();
    expect(owner!.position.x).toBeGreaterThan(parent!.position.x);
  });

  it("creates parallel branch handles and edges", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: ["copy_asset"] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
          ],
        },
        { id: "copy_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
      ],
    });

    expect(graph.warnings).toEqual([]);
    expect(
      graph.nodes.find((node) => node.id === "parallel_enrichment")?.data
        .sourceHandles,
    ).toEqual([
      {
        id: "branch:asset",
        label: "Asset",
        offsetPx: 43,
        color: "var(--signal-blue)",
      },
      {
        id: "branch:uri",
        label: "URI",
        offsetPx: 175,
        color: "var(--plot-red)",
      },
    ]);
    expect(
      graph.nodes.find((node) => node.id === "parallel_enrichment")?.data
        .badges,
    ).toEqual(["Parallel", "2 branches"]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:branch:asset:parallel_enrichment:copy_asset",
          source: "parallel_enrichment",
          target: "copy_asset",
          sourceHandle: "branch:asset",
          label: undefined,
          data: {
            kind: "branch:asset",
            targetRef: "copy_asset",
            invalid: false,
          },
        }),
        expect.objectContaining({
          id: "edge:branch:uri:parallel_enrichment:parse_uri",
          source: "parallel_enrichment",
          target: "parse_uri",
          sourceHandle: "branch:uri",
          label: undefined,
        }),
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toContain(
      "edge:sequence:parallel_enrichment:copy_asset",
    );
    expect(graph.edges.map((edge) => edge.id)).not.toContain(
      "edge:sequence:copy_asset:parse_uri",
    );
  });

  it("places populated parallel branches on right-side lanes", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: ["copy_asset"] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
          ],
        },
        { id: "copy_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
      ],
    });

    const parent = graph.nodes.find(
      (node) => node.id === "parallel_enrichment",
    );
    const firstChild = graph.nodes.find((node) => node.id === "copy_asset");
    const secondChild = graph.nodes.find((node) => node.id === "parse_uri");

    expect(parent).toBeDefined();
    expect(firstChild).toBeDefined();
    expect(secondChild).toBeDefined();
    expect(firstChild!.position.x).toBeGreaterThan(parent!.position.x);
    expect(secondChild!.position.x).toBeGreaterThan(parent!.position.x);
    expect(secondChild!.position.y).toBeGreaterThan(firstChild!.position.y);
    expect(firstChild).toEqual(
      expect.objectContaining({
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: expect.objectContaining({ flowDirection: "horizontal" }),
      }),
    );
    expect(secondChild).toEqual(
      expect.objectContaining({
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: expect.objectContaining({ flowDirection: "horizontal" }),
      }),
    );
  });

  it("keeps parallel cards compact as branch handles are added", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: [] },
            { id: "uri", label: "URI", nodes: [] },
            { id: "network", label: "Network", nodes: [] },
            { id: "owner", label: "Owner", nodes: [] },
          ],
        },
      ],
    });

    expect(
      graph.nodes.find((node) => node.id === "parallel_enrichment")?.data
        .canvasWidth,
    ).toBe(250);
    expect(
      graph.nodes.find((node) => node.id === "parallel_enrichment")?.data
        .canvasHeight,
    ).toBe(86);
  });

  it("leaves parallel branch terminals unmerged unless the route explicitly includes a merge card", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: ["copy_asset"] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
          ],
        },
        { id: "copy_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
        { id: "notify", type: "builtin.log.info" },
      ],
    });

    expect(graph.edges.map((edge) => edge.id)).not.toContain(
      "edge:sequence:copy_asset:parse_uri",
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:sequence:copy_asset:notify",
        "edge:sequence:parse_uri:notify",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).toContain(
      "edge:sequence:parallel_enrichment:notify",
    );
    const parent = graph.nodes.find(
      (node) => node.id === "parallel_enrichment",
    );
    const notify = graph.nodes.find((node) => node.id === "notify");
    expect(parent).toBeDefined();
    expect(notify).toBeDefined();
    expect(Math.abs(notify!.position.x - parent!.position.x)).toBeLessThan(2);
    expect(notify!.position.y).toBeGreaterThan(parent!.position.y);
  });

  it("draws explicit route continuation edges when a branch list includes a merge card", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: ["copy_asset", "notify"] },
            { id: "uri", label: "URI", nodes: ["parse_uri"] },
          ],
        },
        { id: "copy_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
        { id: "notify", type: "builtin.log.info" },
      ],
    });

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge:route:parallel_enrichment:branch:asset:copy_asset:notify",
          source: "copy_asset",
          target: "notify",
          label: undefined,
        }),
      ]),
    );
  });

  it("connects parallel branches only to their first visible cards and sequences branch bodies", () => {
    const graph = buildWorkflowGraphProjection({
      triggers: [],
      nodes: [
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            {
              id: "asset",
              label: "Asset",
              nodes: ["copy_asset", "score_asset"],
            },
            {
              id: "uri",
              label: "URI",
              nodes: ["parse_uri", "score_uri"],
            },
          ],
        },
        { id: "copy_asset", type: "builtin.transform" },
        { id: "score_asset", type: "builtin.transform" },
        { id: "parse_uri", type: "builtin.transform" },
        { id: "score_uri", type: "builtin.transform" },
        { id: "notify", type: "builtin.log.info" },
      ],
    });

    expect(graph.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining([
        "edge:branch:asset:parallel_enrichment:copy_asset",
        "edge:branch:uri:parallel_enrichment:parse_uri",
        "edge:route:parallel_enrichment:branch:asset:copy_asset:score_asset",
        "edge:route:parallel_enrichment:branch:uri:parse_uri:score_uri",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:branch:asset:parallel_enrichment:score_asset",
        "edge:branch:uri:parallel_enrichment:score_uri",
        "edge:sequence:score_asset:parse_uri",
      ]),
    );
    expect(graph.edges.map((edge) => edge.id)).not.toEqual(
      expect.arrayContaining([
        "edge:sequence:score_asset:notify",
        "edge:sequence:score_uri:notify",
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
          label: "missing_step",
          data: { kind: "then", targetRef: "missing_step", invalid: true },
        }),
      ]),
    );
  });
});
