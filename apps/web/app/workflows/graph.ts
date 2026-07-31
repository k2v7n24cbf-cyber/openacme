import dagre from "@dagrejs/dagre";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

export interface WorkflowGraphNode {
  id: string;
  type: string;
  label?: string;
  [key: string]: unknown;
}

export interface WorkflowGraphTrigger {
  id?: unknown;
  kind?: unknown;
  enabled?: unknown;
  [key: string]: unknown;
}

export interface WorkflowCanvasNodeData extends Record<string, unknown> {
  id: string;
  label: string;
  kind: "trigger" | "step" | "missing";
  type: string;
  index: number | null;
  badges: string[];
  sourceHandles: WorkflowCanvasSourceHandle[];
  canvasPosition?: WorkflowCanvasPosition;
  runStatus?:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "skipped"
    | "canceled";
  runStepId?: string | null;
  runAttempt?: number | null;
  runCurrent?: boolean;
  warning?: string;
}

export interface WorkflowCanvasSourceHandle {
  id: "then" | "else" | "body";
  label: string;
}

export interface WorkflowCanvasLayout {
  nodes?: Record<string, WorkflowCanvasLayoutNode | undefined>;
}

export interface WorkflowCanvasLayoutNode {
  position?: WorkflowCanvasPosition;
}

export interface WorkflowCanvasPosition {
  x: number;
  y: number;
}

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData>;
export type WorkflowCanvasEdge = Edge;

export interface WorkflowGraphProjection {
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  warnings: string[];
}

const STEP_W = 220;
const STEP_H = 86;
const TRIGGER_W = 190;
const TRIGGER_H = 64;
const MISSING_W = 190;
const MISSING_H = 56;
type DagreGraph = InstanceType<typeof dagre.graphlib.Graph>;

export function buildWorkflowGraphProjection({
  nodes,
  triggers,
  layout,
}: {
  nodes: WorkflowGraphNode[];
  triggers: WorkflowGraphTrigger[];
  layout?: WorkflowCanvasLayout | null;
}): WorkflowGraphProjection {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    ranksep: 74,
    nodesep: 48,
    marginx: 24,
    marginy: 24,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const warnings: string[] = [];
  const visibleWorkflowNodes = nodes.filter(isCanvasVisibleWorkflowNode);
  const visibleNodeIds = new Set(visibleWorkflowNodes.map((node) => node.id));
  const hiddenNodeIds = new Set(
    nodes
      .filter((node) => !isCanvasVisibleWorkflowNode(node))
      .map((node) => node.id),
  );
  const projectionNodes: WorkflowCanvasNode[] = [];
  const projectionEdges: WorkflowCanvasEdge[] = [];
  const missingNodeIds = new Set<string>();

  for (const trigger of triggers) {
    const triggerId = triggerNodeId(trigger);
    graph.setNode(triggerId, { width: TRIGGER_W, height: TRIGGER_H });
    projectionNodes.push({
      id: triggerId,
      type: "workflowTrigger",
      position: { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      data: {
        id: triggerId,
        label: triggerLabel(trigger),
        kind: "trigger",
        type: triggerKind(trigger),
        index: null,
        badges: triggerBadges(trigger),
        sourceHandles: [],
      },
      selectable: true,
      draggable: false,
    });
    const firstStep = visibleWorkflowNodes[0];
    if (firstStep) {
      addEdge(projectionEdges, {
        id: `edge:${triggerId}:${firstStep.id}`,
        source: triggerId,
        target: firstStep.id,
        label: "starts",
        kind: "trigger",
      });
      graph.setEdge(triggerId, firstStep.id);
    }
  }

  visibleWorkflowNodes.forEach((workflowNode, index) => {
    graph.setNode(workflowNode.id, { width: STEP_W, height: STEP_H });
    projectionNodes.push({
      id: workflowNode.id,
      type: "workflowStep",
      position: { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        id: workflowNode.id,
        label: workflowNode.label ?? workflowNode.id,
        kind: "step",
        type: workflowNode.type,
        index,
        badges: nodeBadges(workflowNode),
        sourceHandles: nodeSourceHandles(workflowNode),
      },
      selectable: true,
      draggable: true,
    });
  });

  for (let index = 0; index < visibleWorkflowNodes.length - 1; index += 1) {
    const source = visibleWorkflowNodes[index];
    const target = visibleWorkflowNodes[index + 1];
    if (!source || !target) continue;
    if (nodeSourceHandles(source).length > 0) continue;
    addEdge(projectionEdges, {
      id: `edge:sequence:${source.id}:${target.id}`,
      source: source.id,
      target: target.id,
      label: "next",
      kind: "sequence",
    });
    graph.setEdge(source.id, target.id);
  }

  for (const node of nodes) {
    if (node.type === "builtin.if") {
      addReferenceEdges({
        graph,
        projectionNodes,
        projectionEdges,
        missingNodeIds,
        warnings,
        visibleNodeIds,
        hiddenNodeIds,
        sourceNode: node,
        field: "then",
        label: "true",
      });
      addReferenceEdges({
        graph,
        projectionNodes,
        projectionEdges,
        missingNodeIds,
        warnings,
        visibleNodeIds,
        hiddenNodeIds,
        sourceNode: node,
        field: "else",
        label: "false",
      });
    } else if (node.type === "builtin.if_else") {
      addReferenceEdges({
        graph,
        projectionNodes,
        projectionEdges,
        missingNodeIds,
        warnings,
        visibleNodeIds,
        hiddenNodeIds,
        sourceNode: node,
        field: "then",
        label: "true",
      });
      addReferenceEdges({
        graph,
        projectionNodes,
        projectionEdges,
        missingNodeIds,
        warnings,
        visibleNodeIds,
        hiddenNodeIds,
        sourceNode: node,
        field: "else",
        label: "false",
      });
    } else if (node.type === "builtin.foreach") {
      addReferenceEdges({
        graph,
        projectionNodes,
        projectionEdges,
        missingNodeIds,
        warnings,
        visibleNodeIds,
        hiddenNodeIds,
        sourceNode: node,
        field: "body",
        label: "body",
      });
    }
  }

  dagre.layout(graph);

  const positioned = projectionNodes.map((node) => {
    const layoutPosition =
      node.data.kind === "step" ? layout?.nodes?.[node.id]?.position : null;
    if (layoutPosition) {
      return {
        ...node,
        position: layoutPosition,
        data: { ...node.data, canvasPosition: layoutPosition },
      };
    }
    const dimensions = graph.node(node.id);
    if (!dimensions) return node;
    const position = {
      x: dimensions.x - dimensions.width / 2,
      y: dimensions.y - dimensions.height / 2,
    };
    return {
      ...node,
      position,
      data: { ...node.data, canvasPosition: position },
    };
  });

  return { nodes: positioned, edges: projectionEdges, warnings };
}

function addReferenceEdges({
  graph,
  projectionNodes,
  projectionEdges,
  missingNodeIds,
  warnings,
  visibleNodeIds,
  hiddenNodeIds,
  sourceNode,
  field,
  label,
}: {
  graph: DagreGraph;
  projectionNodes: WorkflowCanvasNode[];
  projectionEdges: WorkflowCanvasEdge[];
  missingNodeIds: Set<string>;
  warnings: string[];
  visibleNodeIds: Set<string>;
  hiddenNodeIds: Set<string>;
  sourceNode: WorkflowGraphNode;
  field: "then" | "else" | "body";
  label: string;
}) {
  const targets = sourceNode[field];
  if (!Array.isArray(targets)) return;
  for (const target of targets) {
    if (typeof target !== "string") continue;
    if (hiddenNodeIds.has(target)) continue;
    if (visibleNodeIds.has(target)) {
      addEdge(projectionEdges, {
        id: `edge:${field}:${sourceNode.id}:${target}`,
        source: sourceNode.id,
        target,
        label,
        kind: field,
      });
      graph.setEdge(sourceNode.id, target);
      continue;
    }

    const missingId = `missing:${sourceNode.id}:${field}:${target}`;
    const warning = `Node ${sourceNode.id} ${field} references missing node ${target}`;
    warnings.push(warning);
    if (!missingNodeIds.has(missingId)) {
      missingNodeIds.add(missingId);
      graph.setNode(missingId, { width: MISSING_W, height: MISSING_H });
      projectionNodes.push({
        id: missingId,
        type: "workflowMissing",
        position: { x: 0, y: 0 },
        targetPosition: Position.Top,
        data: {
          id: missingId,
          label: target,
          kind: "missing",
          type: "missing",
          index: null,
          badges: ["missing"],
          sourceHandles: [],
          warning,
        },
        selectable: true,
        draggable: false,
      });
    }
    addEdge(projectionEdges, {
      id: `edge:${field}:${sourceNode.id}:${missingId}`,
      source: sourceNode.id,
      target: missingId,
      label,
      kind: field,
      targetRef: target,
      invalid: true,
    });
    graph.setEdge(sourceNode.id, missingId);
  }
}

function addEdge(
  edges: WorkflowCanvasEdge[],
  input: {
    id: string;
    source: string;
    target: string;
    label: string;
    kind: string;
    targetRef?: string;
    invalid?: boolean;
  },
) {
  edges.push({
    id: input.id,
    source: input.source,
    target: input.target,
    sourceHandle:
      input.kind === "then" || input.kind === "else" || input.kind === "body"
        ? input.kind
        : "source",
    targetHandle: "target",
    type: "smoothstep",
    label:
      input.kind === "sequence" || input.kind === "trigger"
        ? undefined
        : input.label,
    data: {
      kind: input.kind,
      targetRef: input.targetRef ?? input.target,
      invalid: input.invalid === true,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: input.invalid ? "var(--destructive)" : edgeStroke(input.kind),
      width: 14,
      height: 14,
    },
    style: {
      stroke: input.invalid ? "var(--destructive)" : edgeStroke(input.kind),
      strokeWidth: input.kind === "sequence" ? 1.6 : 1.8,
      strokeDasharray: input.kind === "sequence" ? undefined : "4 3",
    },
    labelStyle: {
      fill: input.invalid ? "var(--destructive)" : "var(--ink-faint)",
      fontFamily: "var(--font-mono)",
      fontSize: 9,
      textTransform: "uppercase",
    },
    labelBgStyle: { fill: "var(--paper)" },
  });
}

function edgeStroke(kind: string): string {
  if (kind === "then") return "var(--signal-blue)";
  if (kind === "else") return "var(--warn-ochre)";
  if (kind === "body") return "var(--plot-red)";
  if (kind === "trigger") return "var(--ink-soft)";
  return "var(--ink-faint)";
}

function triggerNodeId(trigger: WorkflowGraphTrigger): string {
  const id =
    typeof trigger.id === "string" && trigger.id ? trigger.id : "manual";
  return `trigger:${id}`;
}

function triggerKind(trigger: WorkflowGraphTrigger): string {
  return typeof trigger.kind === "string" && trigger.kind
    ? trigger.kind
    : "manual";
}

function triggerLabel(trigger: WorkflowGraphTrigger): string {
  const id =
    typeof trigger.id === "string" && trigger.id ? trigger.id : "manual";
  return `${triggerKind(trigger)}:${id}`;
}

function triggerBadges(trigger: WorkflowGraphTrigger): string[] {
  const badges = [triggerKind(trigger)];
  if (trigger.enabled === false) badges.push("disabled");
  else badges.push("enabled");
  return badges;
}

function nodeBadges(node: WorkflowGraphNode): string[] {
  const badges: string[] = [node.type];
  if (isRecord(node.assign)) badges.push("assign");
  if (node.type.startsWith("builtin.log.")) badges.push("log");
  if (node.type === "mcp.tool") badges.push("mcp");
  if (node.type === "agent.call") badges.push("agent");
  if (node.type === "builtin.foreach") badges.push("loop");
  if (node.type === "builtin.if" || node.type === "builtin.if_else") {
    badges.push("branch");
  }
  return badges;
}

function nodeSourceHandles(
  node: WorkflowGraphNode,
): WorkflowCanvasSourceHandle[] {
  if (node.type === "builtin.if" || node.type === "builtin.if_else") {
    return [
      { id: "then", label: "then" },
      { id: "else", label: "else" },
    ];
  }
  if (node.type === "builtin.foreach") return [{ id: "body", label: "body" }];
  return [];
}

function isCanvasVisibleWorkflowNode(node: WorkflowGraphNode): boolean {
  return node.type !== "builtin.exit";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
