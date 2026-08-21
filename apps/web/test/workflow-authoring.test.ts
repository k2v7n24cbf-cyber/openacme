import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WorkflowNodeSchema } from "../../../packages/workflows/src/schemas";
import {
  appendWorkflowNode,
  cloneWorkflowNodeAfter,
  createWorkflowNodeTemplate,
  insertWorkflowNodeAfter,
  insertWorkflowNodeFirst,
  moveWorkflowNode,
  moveWorkflowNodeAfter,
  removeWorkflowNode,
  renameWorkflowNodeId,
  setWorkflowForeachBodyFirst,
  uniqueWorkflowNodeIdFromLabel,
  workflowNodeIdFromLabel,
  workflowTransformPresetById,
  WORKFLOW_TRANSFORM_PRESETS,
  type WorkflowPaletteKind,
} from "@/app/workflows/authoring";

describe("workflow authoring helpers", () => {
  it("keeps the workflow route node-shape validator aligned with supported node types", () => {
    const routeSource = readFileSync(
      new URL("../app/routes/workflows.tsx", import.meta.url),
      "utf8",
    );
    const schemaSource = readFileSync(
      new URL("../../../packages/workflows/src/schemas.ts", import.meta.url),
      "utf8",
    );
    const validatorSource = routeSource.slice(
      routeSource.indexOf("function validateImportedNodeShape"),
      routeSource.indexOf("function validateExportedNodeShape"),
    );
    const schemaTypes = workflowNodeTypesFromSchemaSource(schemaSource);
    const validatorTypes = workflowNodeTypesFromValidatorSource(validatorSource);

    expect(validatorTypes).toEqual(schemaTypes);
  });

  it("creates schema-compatible node defaults for every palette kind", () => {
    const kinds: WorkflowPaletteKind[] = [
      "set",
      "transform",
      "if",
      "switch",
      "log",
      "throw_error",
      "sleep",
      "exit",
      "foreach",
      "parallel",
      "python",
      "mcp",
      "hosted",
      "agent",
    ];

    for (const [index, kind] of kinds.entries()) {
      const transformPresetId = kind === "transform" ? "value.resolve" : undefined;
      const node = createWorkflowNodeTemplate(kind, index + 1, {
        server: "demo/server",
        tool: "echo",
        name: "hosted_demo__echo",
        id: "demo-agent",
      }, transformPresetId);
      if (kind === "if") {
        expect(node).toMatchObject({
          type: "builtin.if",
          condition: "",
        });
        continue;
      }
      if (kind === "foreach") {
        expect(node).toMatchObject({
          type: "builtin.foreach",
          items: "",
        });
        continue;
      }
      const parsed = WorkflowNodeSchema.safeParse(node);
      expect(
        parsed.success,
        `${kind} template should satisfy WorkflowNodeSchema`,
      ).toBe(true);
    }
  });

  it("creates representative node defaults", () => {
    expect(createWorkflowNodeTemplate("set", 1)).toEqual({
      id: "set_01",
      type: "builtin.set",
      assign: { value: "$.workflowTrigger.input.value" },
    });
    expect(createWorkflowNodeTemplate("if", 2)).toEqual({
      id: "if_02",
      type: "builtin.if",
      condition: "",
      then: [],
      else: [],
    });
    expect(createWorkflowNodeTemplate("foreach", 3)).toEqual({
      id: "foreach_03",
      type: "builtin.foreach",
      items: "",
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
      createWorkflowNodeTemplate("hosted", 8, {
        name: "hosted_qualys__qualys_gav_asset_count",
      }),
    ).toMatchObject({
      id: "hosted_hosted_qualys__qualys_gav_asset_count_08",
      type: "hosted.tool",
      toolName: "hosted_qualys__qualys_gav_asset_count",
    });
    expect(
      createWorkflowNodeTemplate("agent", 9, { id: "risk-review" }),
    ).toMatchObject({
      id: "agent_risk_review_09",
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
      { id: "normalize", type: "builtin.transform.object_pick" },
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
          type: "builtin.transform.object_pick",
          transform: "$.steps.transform_02.output.value",
          assign: {
            value: {
              from: "$.steps.transform_02.output.value",
              mode: "replace",
            },
          },
        },
        { id: "transform_02_copy", type: "builtin.transform.object_pick" },
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
      transform: "$.steps.transform_02_copy_2.output.value",
      assign: {
        value: {
          from: "$.steps.transform_02_copy_2.output.value",
          mode: "replace",
        },
      },
    });
  });

  it("renames a workflow step id and rewrites routes plus step references", () => {
    const renamed = renameWorkflowNodeId(
      [
        {
          id: "gate",
          type: "builtin.if",
          then: ["normalize"],
          else: ["log_done"],
        },
        {
          id: "normalize",
          type: "builtin.transform.object_pick",
          assign: {
            normalized: "$.steps.normalize.output.value",
          },
        },
        {
          id: "log_done",
          type: "builtin.log.info",
          payload: "$.steps.normalize.output.value.id",
        },
      ],
      "normalize",
      "normalize_customer",
    );

    expect(renamed).not.toBeNull();
    expect(renamed?.[0]).toMatchObject({
      then: ["normalize_customer"],
      else: ["log_done"],
    });
    expect(renamed?.[1]).toMatchObject({
      id: "normalize_customer",
      assign: {
        normalized: "$.steps.normalize_customer.output.value",
      },
    });
    expect(renamed?.[2]).toMatchObject({
      payload: "$.steps.normalize_customer.output.value.id",
    });
  });

  it("derives human-readable unique step ids from labels", () => {
    expect(workflowNodeIdFromLabel("Fetch Qualys Assets")).toBe(
      "fetch_qualys_assets",
    );
    expect(workflowNodeIdFromLabel("  Fetch Qualys Assets  ")).toBe(
      "fetch_qualys_assets",
    );
    expect(workflowNodeIdFromLabel("Normalize: Customer #1")).toBe(
      "normalize_customer_1",
    );
    expect(workflowNodeIdFromLabel("  --!!!  ")).toBe("");
    expect(
      uniqueWorkflowNodeIdFromLabel(
        [
          { id: "fetch_qualys_assets", type: "builtin.log.info" },
          { id: "fetch_qualys_assets_2", type: "builtin.log.info" },
          { id: "current", type: "builtin.log.info" },
        ],
        "current",
        "Fetch Qualys Assets",
      ),
    ).toBe("fetch_qualys_assets_3");
    expect(
      uniqueWorkflowNodeIdFromLabel(
        [{ id: "fetch_qualys_assets", type: "builtin.log.info" }],
        "fetch_qualys_assets",
        "Fetch Qualys Assets",
      ),
    ).toBe("fetch_qualys_assets");
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

  it("moves a foreach body node to the first body slot", () => {
    const changed = setWorkflowForeachBodyFirst(
      [
        {
          id: "each_asset",
          type: "builtin.foreach",
          body: ["normalize", "score", "log"],
        },
        { id: "normalize", type: "builtin.transform.object_pick" },
        { id: "score", type: "agent.call" },
        { id: "log", type: "builtin.log.info" },
      ],
      "each_asset",
      "score",
    );

    expect(changed?.[0]).toEqual({
      id: "each_asset",
      type: "builtin.foreach",
      body: ["score", "normalize", "log"],
    });
  });

  it("moves a node after another node for explicit sequence connections", () => {
    expect(
      moveWorkflowNodeAfter(
        [
          { id: "start", type: "builtin.log.info", message: "start" },
          {
            id: "branch",
            type: "builtin.if_else",
            condition: "$.workflowTrigger.input.enabled",
            then: ["then_log"],
            else: [],
          },
          { id: "target", type: "builtin.log.info", message: "target" },
          { id: "then_log", type: "builtin.log.info", message: "then" },
        ],
        "target",
        "start",
      )?.map((node) => node.id),
    ).toEqual(["start", "target", "branch", "then_log"]);
  });

  it("exposes transform operation presets with runnable default payloads", () => {
    expect(WORKFLOW_TRANSFORM_PRESETS.map((preset) => preset.id)).toEqual([
      "value.resolve",
      "object_pick",
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
    expect(workflowTransformPresetById("value.resolve")?.transform).toEqual({
      kind: "value.resolve",
      value: "$.workflowTrigger.input.value",
    });
    expect(workflowTransformPresetById("object_pick")?.transform).toEqual({
      kind: "object_pick",
      source: "value",
      fields: ["id", "name"],
    });
    expect(workflowTransformPresetById("string.replace")?.transform).toEqual({
      kind: "string.replace",
      value: "$.workflowTrigger.input.value",
      search: "old",
      replacement: "new",
      all: true,
    });
    expect(workflowTransformPresetById("csv.parse")?.transform).toEqual({
      kind: "csv.parse",
      value: "$.workflowTrigger.input.csv",
      headers: true,
      maxRows: 10000,
    });
    expect(workflowTransformPresetById("ip.in_subnet")?.transform).toEqual({
      kind: "ip.in_subnet",
      value: "$.workflowTrigger.input.ip",
      cidr: "10.0.0.0/8",
    });
    expect(workflowTransformPresetById("uri.parse")?.transform).toEqual({
      kind: "uri.parse",
      value: "$.workflowTrigger.input.url",
    });
    expect(workflowTransformPresetById("missing")).toBeUndefined();
  });
});

function workflowNodeTypesFromSchemaSource(source: string): string[] {
  const literalTypes = [...source.matchAll(/type:\s*z\.literal\("([^"]+)"\)/g)]
    .map((match) => match[1])
    .filter(isWorkflowNodeType);
  const enumTypes = [
    ...source.matchAll(/type:\s*z\.enum\(\[([\s\S]*?)\]\)/g),
  ].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/g)]
      .map((enumMatch) => enumMatch[1])
      .filter(isWorkflowNodeType),
  );
  const logTypes = [
    ...source.matchAll(/export const WorkflowLogNodeTypeValues = \[([\s\S]*?)\]/g),
  ].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/g)]
      .map((enumMatch) => enumMatch[1])
      .filter(isWorkflowNodeType),
  );
  return uniqueSorted([...literalTypes, ...enumTypes, ...logTypes]);
}

function workflowNodeTypesFromValidatorSource(source: string): string[] {
  const directTypes = [...source.matchAll(/type\s*===\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter(isWorkflowNodeType);
  const logTypes = source.includes("isLogNodeType(type)")
    ? [
        "builtin.log.debug",
        "builtin.log.error",
        "builtin.log.info",
        "builtin.log.warn",
      ]
    : [];
  return uniqueSorted([...directTypes, ...logTypes]);
}

function isWorkflowNodeType(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("builtin.") ||
      value === "mcp.tool" ||
      value === "hosted.tool" ||
      value === "agent.call")
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
