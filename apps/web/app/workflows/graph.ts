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
  kind: "trigger" | "step" | "missing" | "group";
  type: string;
  index: number | null;
  canvasWidth?: number;
  canvasHeight?: number;
  groupRailY?: number;
  groupRailWidth?: number;
  flowDirection?: "vertical" | "horizontal";
  targetSide?: "top" | "left";
  badges: string[];
  summary?: string;
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
  id: string;
  label: string;
  offsetPx?: number;
  color?: string;
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

const STEP_W = 250;
const STEP_BRANCH_HANDLE_SLOT_W = 92;
const STEP_H = 86;
const STEP_RENDERED_H = 120;
const PARALLEL_LANE_GAP = 132;
const PARALLEL_TRACK_X_GAP = 150;
const PARALLEL_TRACK_NODE_GAP = 120;
const PARALLEL_NEXT_Y_GAP = 92;
const FOREACH_BODY_X_GAP = 150;
const FOREACH_BODY_NODE_GAP = 38;
const FOREACH_NEXT_Y_GAP = 92;
const FOREACH_BODY_GROUP_PAD_LEFT = 48;
const FOREACH_BODY_GROUP_PAD_RIGHT = 28;
const FOREACH_BODY_GROUP_PAD_Y = 22;
const TRIGGER_W = 190;
const TRIGGER_H = 64;
const MISSING_W = 190;
const MISSING_H = 56;
const DEFAULT_RANK_SEP = 145;
const DEFAULT_NODE_SEP = 120;
const DEFAULT_ROUTE_GAP = 315;
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
    ranksep: DEFAULT_RANK_SEP,
    nodesep: DEFAULT_NODE_SEP,
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
  const referenceGroups = workflowReferenceGroups(nodes, hiddenNodeIds);
  const workflowNodeById = new Map(nodes.map((node) => [node.id, node]));
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
        summary: triggerSummary(trigger),
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
    const canvasWidth = workflowNodeCanvasWidth(workflowNode);
    const canvasHeight = workflowNodeCanvasHeight(workflowNode);
    graph.setNode(workflowNode.id, {
      width: canvasWidth,
      height: canvasHeight,
    });
    projectionNodes.push({
      id: workflowNode.id,
      type: "workflowStep",
      position: { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: {
        id: workflowNode.id,
        label: nodeDisplayLabel(workflowNode),
        kind: "step",
        type: workflowNode.type,
        index,
        canvasWidth,
        canvasHeight,
        badges: nodeBadges(workflowNode),
        summary: nodeSummary(workflowNode),
        sourceHandles: nodeSourceHandles(workflowNode),
        flowDirection: "vertical",
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
    if (
      isReferenceGroupNode(source.id, referenceGroups) ||
      isReferenceGroupNode(target.id, referenceGroups)
    ) {
      continue;
    }
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
        targets: firstVisibleReferenceTarget(node.then, hiddenNodeIds),
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
        targets: firstVisibleReferenceTarget(node.else, hiddenNodeIds),
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
        targets: firstVisibleReferenceTarget(node.then, hiddenNodeIds),
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
        targets: firstVisibleReferenceTarget(node.else, hiddenNodeIds),
        label: "false",
      });
    } else if (node.type === "builtin.foreach") {
      const bodyTargets = firstVisibleReferenceTarget(node.body, hiddenNodeIds);
      const firstBodyTarget = bodyTargets[0];
      if (firstBodyTarget && visibleNodeIds.has(firstBodyTarget)) {
        const groupId = foreachBodyGroupNodeId(node.id);
        graph.setNode(groupId, {
          width:
            STEP_W + FOREACH_BODY_GROUP_PAD_LEFT + FOREACH_BODY_GROUP_PAD_RIGHT,
          height: STEP_H + FOREACH_BODY_GROUP_PAD_Y * 2,
        });
        projectionNodes.push({
          id: groupId,
          type: "workflowGroup",
          position: { x: 0, y: 0 },
          targetPosition: Position.Left,
          data: {
            id: groupId,
            label: "loop body",
            kind: "group",
            type: "foreach.body",
            index: null,
            canvasWidth:
              STEP_W +
              FOREACH_BODY_GROUP_PAD_LEFT +
              FOREACH_BODY_GROUP_PAD_RIGHT,
            canvasHeight: STEP_H + FOREACH_BODY_GROUP_PAD_Y * 2,
            badges: [],
            sourceHandles: [],
          },
          selectable: false,
          draggable: false,
          zIndex: -10,
        });
        addEdge(projectionEdges, {
          id: `edge:body:${node.id}:${groupId}`,
          source: node.id,
          target: groupId,
          label: "body",
          kind: "body",
          targetRef: firstBodyTarget,
        });
        graph.setEdge(node.id, groupId);
      } else {
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
          targets: bodyTargets,
          label: "body",
        });
      }
    } else if (node.type === "builtin.switch") {
      for (const item of switchCases(node)) {
        addReferenceEdges({
          graph,
          projectionNodes,
          projectionEdges,
          missingNodeIds,
          warnings,
          visibleNodeIds,
          hiddenNodeIds,
          sourceNode: node,
          field: `case:${item.id}`,
          targets: firstVisibleReferenceTarget(item.nodes, hiddenNodeIds),
          label: item.label ?? item.id,
        });
      }
      addReferenceEdges({
        graph,
        projectionNodes,
        projectionEdges,
        missingNodeIds,
        warnings,
        visibleNodeIds,
        hiddenNodeIds,
        sourceNode: node,
        field: "default",
        targets: firstVisibleReferenceTarget(node.default, hiddenNodeIds),
        label: "default",
      });
    } else if (node.type === "builtin.parallel") {
      for (const branch of parallelBranches(node)) {
        addReferenceEdges({
          graph,
          projectionNodes,
          projectionEdges,
          missingNodeIds,
          warnings,
          visibleNodeIds,
          hiddenNodeIds,
          sourceNode: node,
          field: `branch:${branch.id}`,
          targets: firstVisibleReferenceTarget(branch.nodes, hiddenNodeIds),
          label: branch.label ?? branch.id,
        });
      }
    }
  }

  addParallelJoinEdges({
    graph,
    projectionEdges,
    visibleWorkflowNodes,
    referenceGroups,
  });

  addForeachContinuationEdges({
    graph,
    projectionEdges,
    visibleWorkflowNodes,
    referenceGroups,
  });

  addReferenceGroupSequenceEdges({
    graph,
    projectionEdges,
    visibleNodeIds,
    referenceGroups,
  });

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

  return {
    nodes: applyForeachBodyPositions({
      nodes: applyParallelTrackPositions({
        nodes: applyRouteAwareDefaultPositions({
          nodes: positioned,
          referenceGroups,
          workflowNodeById,
          layout,
        }),
        referenceGroups,
        workflowNodeById,
        layout,
      }),
      referenceGroups,
      workflowNodeById,
      layout,
    }),
    edges: projectionEdges,
    warnings,
  };
}

interface WorkflowReferenceGroup {
  parentId: string;
  groupId: string;
  nodeIds: string[];
}

function workflowReferenceGroups(
  nodes: WorkflowGraphNode[],
  hiddenNodeIds: Set<string>,
): WorkflowReferenceGroup[] {
  const groups: WorkflowReferenceGroup[] = [];
  for (const node of nodes) {
    if (node.type === "builtin.if" || node.type === "builtin.if_else") {
      groups.push(
        referenceGroup(node.id, "then", node.then, hiddenNodeIds),
        referenceGroup(node.id, "else", node.else, hiddenNodeIds),
      );
      continue;
    }
    if (node.type === "builtin.foreach") {
      groups.push(referenceGroup(node.id, "body", node.body, hiddenNodeIds));
      continue;
    }
    if (node.type === "builtin.switch") {
      for (const item of switchCases(node)) {
        groups.push(
          referenceGroup(node.id, `case:${item.id}`, item.nodes, hiddenNodeIds),
        );
      }
      groups.push(
        referenceGroup(node.id, "default", node.default, hiddenNodeIds),
      );
      continue;
    }
    if (node.type === "builtin.parallel") {
      for (const branch of parallelBranches(node)) {
        groups.push(
          referenceGroup(
            node.id,
            `branch:${branch.id}`,
            branch.nodes,
            hiddenNodeIds,
          ),
        );
      }
    }
  }
  return groups.filter((group) => group.nodeIds.length > 0);
}

function referenceGroup(
  parentId: string,
  groupId: string,
  targets: unknown,
  hiddenNodeIds: Set<string>,
): WorkflowReferenceGroup {
  return {
    parentId,
    groupId,
    nodeIds: referenceNodeIds(targets, hiddenNodeIds),
  };
}

function referenceNodeIds(
  targets: unknown,
  hiddenNodeIds: Set<string>,
): string[] {
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    (target): target is string =>
      typeof target === "string" && !hiddenNodeIds.has(target),
  );
}

function isReferenceGroupNode(
  nodeId: string,
  groups: WorkflowReferenceGroup[],
): boolean {
  return groups.some((group) => group.nodeIds.includes(nodeId));
}

function addReferenceGroupSequenceEdges({
  graph,
  projectionEdges,
  visibleNodeIds,
  referenceGroups,
}: {
  graph: DagreGraph;
  projectionEdges: WorkflowCanvasEdge[];
  visibleNodeIds: Set<string>;
  referenceGroups: WorkflowReferenceGroup[];
}) {
  for (const group of referenceGroups) {
    const visibleIds = group.nodeIds.filter((id) => visibleNodeIds.has(id));
    for (let index = 0; index < visibleIds.length - 1; index += 1) {
      const source = visibleIds[index];
      const target = visibleIds[index + 1];
      if (!source || !target) continue;
      if (!canSequenceAdjacentNodes(source, target, referenceGroups)) continue;
      if (hasEdge(projectionEdges, source, target)) continue;
      addEdge(projectionEdges, {
        id: `edge:route:${group.parentId}:${group.groupId}:${source}:${target}`,
        source,
        target,
        label: "next",
        kind: `route:${group.parentId}:${group.groupId}`,
        color: edgeStroke(group.groupId),
      });
      graph.setEdge(source, target);
    }
  }
}

function addParallelJoinEdges({
  graph,
  projectionEdges,
  visibleWorkflowNodes,
  referenceGroups,
}: {
  graph: DagreGraph;
  projectionEdges: WorkflowCanvasEdge[];
  visibleWorkflowNodes: WorkflowGraphNode[];
  referenceGroups: WorkflowReferenceGroup[];
}) {
  for (const node of visibleWorkflowNodes) {
    if (node.type !== "builtin.parallel") continue;
    const sourceIndex = visibleWorkflowNodes.findIndex(
      (item) => item.id === node.id,
    );
    if (sourceIndex < 0) continue;
    const target = parallelContinuationTarget({
      sourceId: node.id,
      sourceIndex,
      visibleWorkflowNodes,
      referenceGroups,
    });
    if (!target || hasEdge(projectionEdges, node.id, target.id)) continue;
    addEdge(projectionEdges, {
      id: `edge:sequence:${node.id}:${target.id}`,
      source: node.id,
      target: target.id,
      label: "next",
      kind: "sequence",
    });
    graph.setEdge(node.id, target.id);
  }
}

function addForeachContinuationEdges({
  graph,
  projectionEdges,
  visibleWorkflowNodes,
  referenceGroups,
}: {
  graph: DagreGraph;
  projectionEdges: WorkflowCanvasEdge[];
  visibleWorkflowNodes: WorkflowGraphNode[];
  referenceGroups: WorkflowReferenceGroup[];
}) {
  for (const node of visibleWorkflowNodes) {
    if (node.type !== "builtin.foreach") continue;
    const sourceIndex = visibleWorkflowNodes.findIndex(
      (item) => item.id === node.id,
    );
    if (sourceIndex < 0) continue;
    const target = foreachContinuationTarget({
      sourceId: node.id,
      sourceIndex,
      visibleWorkflowNodes,
      referenceGroups,
    });
    if (!target || hasEdge(projectionEdges, node.id, target.id)) continue;
    addEdge(projectionEdges, {
      id: `edge:sequence:${node.id}:${target.id}`,
      source: node.id,
      target: target.id,
      label: "next",
      kind: "sequence",
    });
    graph.setEdge(node.id, target.id);
  }
}

function canSequenceAdjacentNodes(
  sourceId: string,
  targetId: string,
  groups: WorkflowReferenceGroup[],
): boolean {
  const parents = new Set(
    groups
      .filter(
        (group) =>
          group.nodeIds.includes(sourceId) || group.nodeIds.includes(targetId),
      )
      .map((group) => group.parentId),
  );
  for (const parentId of parents) {
    const sourceGroups = groups.filter(
      (group) =>
        group.parentId === parentId && group.nodeIds.includes(sourceId),
    );
    const targetGroups = groups.filter(
      (group) =>
        group.parentId === parentId && group.nodeIds.includes(targetId),
    );
    if (sourceGroups.length === 0 || targetGroups.length === 0) continue;
    if (
      !sourceGroups.some((sourceGroup) =>
        targetGroups.some(
          (targetGroup) => targetGroup.groupId === sourceGroup.groupId,
        ),
      )
    ) {
      return false;
    }
  }
  return true;
}

function hasEdge(
  edges: WorkflowCanvasEdge[],
  source: string,
  target: string,
): boolean {
  return edges.some((edge) => edge.source === source && edge.target === target);
}

function applyRouteAwareDefaultPositions({
  nodes,
  referenceGroups,
  workflowNodeById,
  layout,
}: {
  nodes: WorkflowCanvasNode[];
  referenceGroups: WorkflowReferenceGroup[];
  workflowNodeById: Map<string, WorkflowGraphNode>;
  layout?: WorkflowCanvasLayout | null;
}): WorkflowCanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const persistedNodeIds = new Set(Object.keys(layout?.nodes ?? {}));
  const nextById = new Map(nodeById);
  const membershipCounts = referenceGroupMembershipCounts(referenceGroups);
  const groupsByParent = new Map<string, WorkflowReferenceGroup[]>();
  for (const group of referenceGroups) {
    const groups = groupsByParent.get(group.parentId) ?? [];
    groups.push(group);
    groupsByParent.set(group.parentId, groups);
  }

  for (const [parentId, groups] of groupsByParent) {
    const parentNode = nextById.get(parentId);
    const parentDefinition = workflowNodeById.get(parentId);
    if (!parentNode || !parentDefinition) continue;
    const offsets = routeGroupOffsets(parentDefinition, groups);
    if (offsets.size === 0) continue;
    const parentCenter =
      parentNode.position.x + workflowCanvasNodeWidth(parentNode) / 2;

    for (const group of groups) {
      const offset = offsets.get(group.groupId);
      if (offset === undefined) continue;
      const visibleGroupNodeIds = group.nodeIds.filter((id) =>
        nextById.has(id),
      );
      const firstNodeId = visibleGroupNodeIds[0];
      if (!firstNodeId) continue;
      const firstNode = nextById.get(firstNodeId);
      if (!firstNode) continue;
      const desiredFirstX =
        parentCenter + offset - workflowCanvasNodeWidth(firstNode) / 2;
      const dx = desiredFirstX - firstNode.position.x;
      if (!Number.isFinite(dx) || Math.abs(dx) < 0.5) continue;

      for (const nodeId of visibleGroupNodeIds) {
        if (persistedNodeIds.has(nodeId)) continue;
        if ((membershipCounts.get(nodeId) ?? 0) > 1) continue;
        const current = nextById.get(nodeId);
        if (!current) continue;
        const position = {
          x: current.position.x + dx,
          y: current.position.y,
        };
        nextById.set(nodeId, {
          ...current,
          position,
          data: { ...current.data, canvasPosition: position },
        });
      }
    }
  }

  return nodes.map((node) => nextById.get(node.id) ?? node);
}

function applyParallelTrackPositions({
  nodes,
  referenceGroups,
  workflowNodeById,
  layout,
}: {
  nodes: WorkflowCanvasNode[];
  referenceGroups: WorkflowReferenceGroup[];
  workflowNodeById: Map<string, WorkflowGraphNode>;
  layout?: WorkflowCanvasLayout | null;
}): WorkflowCanvasNode[] {
  const persistedNodeIds = new Set(Object.keys(layout?.nodes ?? {}));
  const nextById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const definition = workflowNodeById.get(node.id);
    if (!definition || definition.type !== "builtin.parallel") continue;
    const branches = parallelBranches(definition);
    if (branches.length === 0) continue;
    const parentWidth = workflowCanvasNodeWidth(node);
    const trackX = node.position.x + parentWidth + PARALLEL_TRACK_X_GAP;
    branches.forEach((branch, branchIndex) => {
      const group = referenceGroups.find(
        (item) =>
          item.parentId === node.id && item.groupId === `branch:${branch.id}`,
      );
      if (!group) return;
      const laneCenterY =
        node.position.y + parallelBranchHandleTop(branchIndex);
      group.nodeIds.forEach((nodeId, routeIndex) => {
        const current = nextById.get(nodeId);
        if (!current) return;
        const horizontalNode = {
          ...current,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            ...current.data,
            flowDirection: "horizontal" as const,
          },
        };
        if (persistedNodeIds.has(nodeId)) {
          nextById.set(nodeId, horizontalNode);
          return;
        }
        const width = workflowCanvasNodeWidth(current);
        const height = workflowCanvasNodeHeight(current);
        const position = {
          x: trackX + routeIndex * (STEP_W + PARALLEL_TRACK_NODE_GAP),
          y: laneCenterY - height / 2,
        };
        nextById.set(nodeId, {
          ...horizontalNode,
          position,
          data: {
            ...horizontalNode.data,
            canvasPosition: position,
          },
        });
      });
    });
    const sourceIndex = nodes.findIndex((item) => item.id === node.id);
    const target = parallelContinuationTarget({
      sourceId: node.id,
      sourceIndex,
      visibleWorkflowNodes: nodes.map((item) => ({
        id: item.id,
        type: String(item.data.type),
      })),
      referenceGroups,
    });
    if (target && !persistedNodeIds.has(target.id)) {
      const current = nextById.get(target.id);
      if (current) {
        const width = workflowCanvasNodeWidth(current);
        const position = {
          x: node.position.x + parentWidth / 2 - width / 2,
          y:
            node.position.y +
            parallelBranchVisualHeight(branches.length) +
            PARALLEL_NEXT_Y_GAP,
        };
        nextById.set(target.id, {
          ...current,
          position,
          data: { ...current.data, canvasPosition: position },
        });
      }
    }
  }
  return nodes.map((node) => nextById.get(node.id) ?? node);
}

function applyForeachBodyPositions({
  nodes,
  referenceGroups,
  workflowNodeById,
  layout,
}: {
  nodes: WorkflowCanvasNode[];
  referenceGroups: WorkflowReferenceGroup[];
  workflowNodeById: Map<string, WorkflowGraphNode>;
  layout?: WorkflowCanvasLayout | null;
}): WorkflowCanvasNode[] {
  const persistedNodeIds = new Set(Object.keys(layout?.nodes ?? {}));
  const membershipCounts = referenceGroupMembershipCounts(referenceGroups);
  const nextById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    const definition = workflowNodeById.get(node.id);
    if (!definition || definition.type !== "builtin.foreach") continue;
    const group = referenceGroups.find(
      (item) => item.parentId === node.id && item.groupId === "body",
    );
    if (!group || group.nodeIds.length === 0) continue;
    const parentWidth = workflowCanvasNodeWidth(node);
    const trackX = node.position.x + parentWidth + FOREACH_BODY_X_GAP;
    let cursorY = node.position.y;

    for (const [routeIndex, nodeId] of group.nodeIds.entries()) {
      const current = nextById.get(nodeId);
      if (!current) continue;
      const height = workflowCanvasNodeHeight(current);
      if (
        !persistedNodeIds.has(nodeId) &&
        (membershipCounts.get(nodeId) ?? 0) <= 1
      ) {
        const position = {
          x: trackX,
          y: cursorY,
        };
        nextById.set(nodeId, {
          ...current,
          targetPosition: routeIndex === 0 ? Position.Left : Position.Top,
          position,
          data: {
            ...current.data,
            canvasPosition: position,
            targetSide: routeIndex === 0 ? "left" : "top",
          },
        });
      }
      cursorY += height + FOREACH_BODY_NODE_GAP;
    }

    const groupNode = nextById.get(foreachBodyGroupNodeId(node.id));
    if (groupNode) {
      const bodyNodes = group.nodeIds
        .map((nodeId) => nextById.get(nodeId))
        .filter((item): item is WorkflowCanvasNode => Boolean(item));
      if (bodyNodes.length > 0) {
        const left =
          Math.min(...bodyNodes.map((item) => item.position.x)) -
          FOREACH_BODY_GROUP_PAD_LEFT;
        const top =
          Math.min(...bodyNodes.map((item) => item.position.y)) -
          FOREACH_BODY_GROUP_PAD_Y;
        const right = Math.max(
          ...bodyNodes.map(
            (item) => item.position.x + workflowCanvasNodeWidth(item),
          ),
        );
        const bottom = Math.max(
          ...bodyNodes.map(
            (item) => item.position.y + renderedBodyHeight(item),
          ),
        );
        const firstBodyNode = bodyNodes[0];
        const width = right - left + FOREACH_BODY_GROUP_PAD_RIGHT;
        const height = bottom - top + FOREACH_BODY_GROUP_PAD_Y;
        const position = { x: left, y: top };
        const groupRailY = firstBodyNode
          ? firstBodyNode.position.y +
            renderedBodyHeight(firstBodyNode) / 2 -
            top
          : height / 2;
        const groupRailWidth = firstBodyNode
          ? Math.max(0, firstBodyNode.position.x - left)
          : 0;
        nextById.set(groupNode.id, {
          ...groupNode,
          targetPosition: Position.Left,
          position,
          data: {
            ...groupNode.data,
            canvasPosition: position,
            canvasWidth: width,
            canvasHeight: height,
            groupRailY,
            groupRailWidth,
          },
          style: { width, height },
        });
      }
    }

    const sourceIndex = nodes.findIndex((item) => item.id === node.id);
    const target = foreachContinuationTarget({
      sourceId: node.id,
      sourceIndex,
      visibleWorkflowNodes: nodes.map((item) => ({
        id: item.id,
        type: String(item.data.type),
      })),
      referenceGroups,
    });
    if (target && !persistedNodeIds.has(target.id)) {
      const current = nextById.get(target.id);
      if (current) {
        const width = workflowCanvasNodeWidth(current);
        const bodyHeight =
          group.nodeIds.length * STEP_H +
          Math.max(0, group.nodeIds.length - 1) * FOREACH_BODY_NODE_GAP;
        const position = {
          x: node.position.x + parentWidth / 2 - width / 2,
          y:
            node.position.y + Math.max(STEP_H, bodyHeight) + FOREACH_NEXT_Y_GAP,
        };
        nextById.set(target.id, {
          ...current,
          position,
          data: { ...current.data, canvasPosition: position },
        });
      }
    }
  }

  return nodes.map((node) => nextById.get(node.id) ?? node);
}

function parallelContinuationTarget({
  sourceId,
  sourceIndex,
  visibleWorkflowNodes,
  referenceGroups,
}: {
  sourceId: string;
  sourceIndex: number;
  visibleWorkflowNodes: Pick<WorkflowGraphNode, "id" | "type">[];
  referenceGroups: WorkflowReferenceGroup[];
}): Pick<WorkflowGraphNode, "id" | "type"> | undefined {
  if (sourceIndex < 0) return undefined;
  const candidate = visibleWorkflowNodes[sourceIndex + 1];
  if (!candidate) return undefined;
  if (isReferenceGroupNode(candidate.id, referenceGroups)) return undefined;
  const branchNodeIds = new Set(
    referenceGroups
      .filter(
        (group) =>
          group.parentId === sourceId && group.groupId.startsWith("branch:"),
      )
      .flatMap((group) => group.nodeIds),
  );
  return branchNodeIds.has(candidate.id) ? undefined : candidate;
}

function foreachContinuationTarget({
  sourceId,
  sourceIndex,
  visibleWorkflowNodes,
  referenceGroups,
}: {
  sourceId: string;
  sourceIndex: number;
  visibleWorkflowNodes: Pick<WorkflowGraphNode, "id" | "type">[];
  referenceGroups: WorkflowReferenceGroup[];
}): Pick<WorkflowGraphNode, "id" | "type"> | undefined {
  if (sourceIndex < 0) return undefined;
  const bodyNodeIds = new Set(
    referenceGroups
      .filter(
        (group) => group.parentId === sourceId && group.groupId === "body",
      )
      .flatMap((group) => group.nodeIds),
  );
  return visibleWorkflowNodes
    .slice(sourceIndex + 1)
    .find((candidate) => !bodyNodeIds.has(candidate.id));
}

function referenceGroupMembershipCounts(
  groups: WorkflowReferenceGroup[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const nodeId of group.nodeIds) {
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    }
  }
  return counts;
}

function routeGroupOffsets(
  parent: WorkflowGraphNode,
  groups: WorkflowReferenceGroup[],
): Map<string, number> {
  const offsets = new Map<string, number>();
  if (parent.type === "builtin.if" || parent.type === "builtin.if_else") {
    offsets.set("then", -DEFAULT_ROUTE_GAP);
    offsets.set("else", DEFAULT_ROUTE_GAP);
    return offsets;
  }
  if (parent.type === "builtin.parallel") {
    const branchGroupIds = parallelBranches(parent).map(
      (branch) => `branch:${branch.id}`,
    );
    if (branchGroupIds.length <= 1) return offsets;
    branchGroupIds.forEach((groupId, index) => {
      offsets.set(
        groupId,
        (index - (branchGroupIds.length - 1) / 2) * DEFAULT_ROUTE_GAP,
      );
    });
  }
  if (parent.type === "builtin.switch") {
    const caseGroupIds = switchCaseGroupIds(parent);
    if (caseGroupIds.length <= 1) return offsets;
    caseGroupIds.forEach((groupId, index) => {
      offsets.set(
        groupId,
        (index - (caseGroupIds.length - 1) / 2) * DEFAULT_ROUTE_GAP,
      );
    });
  }
  return offsets;
}

function workflowCanvasNodeWidth(node: WorkflowCanvasNode): number {
  if (node.data.kind === "trigger") return TRIGGER_W;
  if (node.data.kind === "missing") return MISSING_W;
  if (node.data.kind === "group") return node.data.canvasWidth ?? STEP_W;
  return node.data.canvasWidth ?? STEP_W;
}

function workflowCanvasNodeHeight(node: WorkflowCanvasNode): number {
  if (node.data.kind === "trigger") return TRIGGER_H;
  if (node.data.kind === "missing") return MISSING_H;
  if (node.data.kind === "group") return node.data.canvasHeight ?? STEP_H;
  return node.data.canvasHeight ?? STEP_H;
}

function workflowNodeCanvasWidth(node: WorkflowGraphNode): number {
  if (node.type === "builtin.parallel") return STEP_W;
  const sourceHandleCount = nodeSourceHandles(node).length;
  return Math.max(STEP_W, sourceHandleCount * STEP_BRANCH_HANDLE_SLOT_W);
}

function workflowNodeCanvasHeight(node: WorkflowGraphNode): number {
  return STEP_H;
}

function renderedBodyHeight(node: WorkflowCanvasNode): number {
  if (node.data.kind === "step") return STEP_RENDERED_H;
  return workflowCanvasNodeHeight(node);
}

function parallelBranchHandleTop(index: number): number {
  return STEP_H / 2 + index * PARALLEL_LANE_GAP;
}

function parallelBranchVisualHeight(branchCount: number): number {
  if (branchCount <= 1) return STEP_H;
  return parallelBranchHandleTop(branchCount - 1) + STEP_H / 2;
}

function foreachBodyGroupNodeId(parentId: string): string {
  return `group:${parentId}:body`;
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
  targets,
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
  field: string;
  targets?: unknown;
  label: string;
}) {
  const targetList = targets ?? sourceNode[field];
  if (!Array.isArray(targetList)) return;
  for (const target of targetList) {
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
      label: target,
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
    color?: string;
  },
) {
  const stroke = input.invalid
    ? "var(--destructive)"
    : (input.color ?? edgeStroke(input.kind));
  edges.push({
    id: input.id,
    source: input.source,
    target: input.target,
    sourceHandle:
      input.kind === "then" ||
      input.kind === "else" ||
      input.kind === "body" ||
      input.kind === "default" ||
      input.kind.startsWith("branch:") ||
      input.kind.startsWith("case:")
        ? input.kind
        : "source",
    targetHandle: "target",
    type: "smoothstep",
    label:
      input.invalid && input.kind !== "sequence" && input.kind !== "trigger"
        ? input.label
        : undefined,
    data: {
      kind: input.kind,
      targetRef: input.targetRef ?? input.target,
      invalid: input.invalid === true,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: stroke,
      width: 14,
      height: 14,
    },
    style: {
      stroke,
      strokeWidth:
        input.kind === "sequence" || input.kind.startsWith("route:")
          ? 1.6
          : 1.8,
      strokeDasharray:
        input.kind === "sequence" || input.kind.startsWith("route:")
          ? undefined
          : "4 3",
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
  if (kind.startsWith("branch:")) return parallelBranchColor(kind);
  if (kind.startsWith("case:")) return "var(--signal-blue)";
  if (kind === "default") return "var(--warn-ochre)";
  if (kind === "trigger") return "var(--ink-soft)";
  return "var(--ink-faint)";
}

function parallelBranchColor(kind: string): string {
  const colors = [
    "var(--signal-blue)",
    "var(--plot-red)",
    "var(--signal-green)",
    "var(--warn-ochre)",
  ];
  const branchId = kind.slice("branch:".length);
  const lastChar = branchId.at(-1) ?? "";
  return colors[lastChar.charCodeAt(0) % colors.length] ?? "var(--signal-blue)";
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
  if (triggerKind(trigger) === "manual") return "Manual trigger";
  return humanizeIdentifier(`${triggerKind(trigger)} ${id}`);
}

function triggerBadges(trigger: WorkflowGraphTrigger): string[] {
  const badges = [humanizeIdentifier(triggerKind(trigger))];
  if (trigger.enabled === false) badges.push("Disabled");
  else badges.push("Enabled");
  return badges;
}

function triggerSummary(trigger: WorkflowGraphTrigger): string {
  if (triggerKind(trigger) === "manual") {
    return "Starts when you run it manually";
  }
  return "Starts from an incoming event";
}

function nodeBadges(node: WorkflowGraphNode): string[] {
  const badges: string[] = [nodeTypeLabel(node)];
  if (node.type === "builtin.parallel") {
    const branches = parallelBranches(node);
    badges.push(
      `${branches.length} ${branches.length === 1 ? "branch" : "branches"}`,
    );
  }
  if (node.type === "builtin.switch") {
    const cases = switchCases(node);
    badges.push(`${cases.length} ${cases.length === 1 ? "case" : "cases"}`);
  }
  if (isRecord(node.assign)) badges.push("Stores output");
  return badges;
}

function nodeSummary(node: WorkflowGraphNode): string | undefined {
  if (node.type === "builtin.set") {
    return assignmentSummary(node.assign, "Save");
  }
  if (node.type === "builtin.transform") {
    return assignmentSummary(node.assign, "Transform into");
  }
  if (node.type === "builtin.if" || node.type === "builtin.if_else") {
    const condition =
      typeof node["condition"] === "string" ? node["condition"] : "";
    return condition
      ? `If ${readableExpression(condition)}`
      : "Route to true or false";
  }
  if (node.type === "builtin.switch") {
    const value = readableExpression(node["value"]);
    return value
      ? `Choose a case from ${value}`
      : "Choose one of the configured cases";
  }
  if (node.type === "builtin.foreach") {
    const items = readableExpression(node["items"]);
    const itemVar =
      typeof node["itemVar"] === "string" ? node["itemVar"] : "item";
    if (items) return `Loop over ${items} as ${readableExpression(itemVar)}`;
  }
  if (node.type === "builtin.parallel") {
    const branches = parallelBranches(node);
    return `Run ${branches.length} ${branches.length === 1 ? "branch" : "branches"} in parallel`;
  }
  if (node.type.startsWith("builtin.log.")) {
    const message = readableExpression(node["message"]);
    return message ? `Log ${message}` : "Write a workflow log";
  }
  if (node.type === "builtin.throw_error") {
    const message = readableExpression(node["message"]);
    return message ? `Stop with error: ${message}` : "Stop with an error";
  }
  if (node.type === "builtin.sleep") {
    const delayMs = typeof node["delayMs"] === "number" ? node["delayMs"] : 0;
    return delayMs > 0
      ? `Wait ${formatDelay(delayMs)}`
      : "Wait before next step";
  }
  if (node.type === "builtin.python") {
    return (
      assignmentSummary(node.assign, "Run Python into") ?? "Run Python code"
    );
  }
  if (node.type === "mcp.tool") {
    const server = typeof node["server"] === "string" ? node["server"] : "";
    const tool = typeof node["tool"] === "string" ? node["tool"] : "";
    return server && tool
      ? `Run ${humanizeIdentifier(tool)} on ${humanizeIdentifier(server)}`
      : "Call an MCP tool";
  }
  if (node.type === "agent.call") {
    const agentId = typeof node["agentId"] === "string" ? node["agentId"] : "";
    const prompt = typeof node["prompt"] === "string" ? node["prompt"] : "";
    if (agentId && prompt)
      return `Ask ${humanizeIdentifier(agentId)}: ${readableExpression(prompt)}`;
    if (agentId) return `Ask ${humanizeIdentifier(agentId)}`;
    return "Call an agent";
  }
  return undefined;
}

function nodeDisplayLabel(node: WorkflowGraphNode): string {
  if (typeof node.label === "string" && node.label.trim()) return node.label;
  if (node.type === "mcp.tool" && typeof node["tool"] === "string") {
    return humanizeIdentifier(node["tool"]);
  }
  if (node.type === "agent.call" && typeof node["agentId"] === "string") {
    return `Ask ${humanizeIdentifier(node["agentId"])}`;
  }
  return humanizeIdentifier(node.id);
}

function nodeTypeLabel(node: WorkflowGraphNode): string {
  if (node.type === "builtin.set") return "Set variable";
  if (node.type === "builtin.transform") return "Transform";
  if (node.type === "builtin.if" || node.type === "builtin.if_else") {
    return "If";
  }
  if (node.type === "builtin.switch") return "Switch";
  if (node.type === "builtin.foreach") return "For each";
  if (node.type === "builtin.parallel") return "Parallel";
  if (node.type === "builtin.throw_error") return "Throw error";
  if (node.type === "builtin.sleep") return "Sleep";
  if (node.type === "builtin.python") return "Python";
  if (node.type === "mcp.tool") return "MCP tool";
  if (node.type === "agent.call") return "Agent";
  if (node.type.startsWith("builtin.log.")) {
    return humanizeIdentifier(node.type.slice("builtin.".length));
  }
  return humanizeIdentifier(node.type.replace(/^builtin\./, ""));
}

function assignmentSummary(value: unknown, prefix: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const targets = Object.keys(value);
  if (targets.length === 0) return undefined;
  if (targets.length === 1)
    return `${prefix} ${readableExpression(targets[0])}`;
  return `${prefix} ${targets.length} variables`;
}

function readableExpression(value: unknown): string {
  if (typeof value === "string") {
    return value
      .trim()
      .replace(/^\{\{\s*/, "")
      .replace(/\s*\}\}$/, "")
      .replace(/\$\.?/g, "")
      .replace(/\s+/g, " ");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1000) return `${delayMs} ms`;
  const seconds = delayMs / 1000;
  if (seconds < 60)
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} sec`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

function humanizeIdentifier(value: string): string {
  const cleaned = value
    .replace(/^builtin\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return value;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
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
  if (node.type === "builtin.switch") {
    return [
      ...switchCases(node).map((item) => ({
        id: `case:${item.id}`,
        label: item.label ?? item.id,
      })),
      { id: "default", label: "default" },
    ];
  }
  if (node.type === "builtin.parallel") {
    return parallelBranches(node).map((branch, index) => ({
      id: `branch:${branch.id}`,
      label: branch.label ?? branch.id,
      offsetPx: parallelBranchHandleTop(index),
      color: parallelBranchColor(`branch:${branch.id}`),
    }));
  }
  return [];
}

function switchCases(
  node: WorkflowGraphNode,
): Array<{ id: string; label?: string; value: unknown; nodes: unknown }> {
  if (!Array.isArray(node["cases"])) return [];
  const cases: Array<{
    id: string;
    label?: string;
    value: unknown;
    nodes: unknown;
  }> = [];
  for (const item of node["cases"]) {
    if (!isRecord(item) || typeof item["id"] !== "string") continue;
    cases.push({
      id: item["id"],
      label: typeof item["label"] === "string" ? item["label"] : undefined,
      value: item["value"],
      nodes: item["nodes"],
    });
  }
  return cases;
}

function switchCaseGroupIds(node: WorkflowGraphNode): string[] {
  return [...switchCases(node).map((item) => `case:${item.id}`), "default"];
}

function parallelBranches(
  node: WorkflowGraphNode,
): Array<{ id: string; label?: string; nodes: unknown }> {
  if (!Array.isArray(node["branches"])) return [];
  const branches: Array<{ id: string; label?: string; nodes: unknown }> = [];
  for (const branch of node["branches"]) {
    if (!isRecord(branch) || typeof branch["id"] !== "string") continue;
    branches.push({
      id: branch["id"],
      label: typeof branch["label"] === "string" ? branch["label"] : undefined,
      nodes: branch["nodes"],
    });
  }
  return branches;
}

function firstVisibleReferenceTarget(
  targets: unknown,
  hiddenNodeIds: Set<string>,
): string[] {
  if (!Array.isArray(targets)) return [];
  for (const target of targets) {
    if (typeof target !== "string") continue;
    if (hiddenNodeIds.has(target)) continue;
    return [target];
  }
  return [];
}

function isCanvasVisibleWorkflowNode(node: WorkflowGraphNode): boolean {
  return node.type !== "builtin.exit";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
