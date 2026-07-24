import type { Task } from "./types";

export type TaskDependencyNodeKind = "task" | "missing";

export interface TaskDependencyNode {
  id: string;
  kind: TaskDependencyNodeKind;
  task: Task | null;
  dependsOnIds: string[];
  dependentIds: string[];
  unmetDepIds: string[];
}

export interface TaskDependencyEdge {
  id: string;
  source: string;
  target: string;
  satisfied: boolean;
  missingSource: boolean;
}

export interface TaskDependencyGraph {
  nodes: TaskDependencyNode[];
  edges: TaskDependencyEdge[];
}

export type TaskDependencyFlowKind = "flow" | "session" | "standalone";

export interface TaskDependencyFlow {
  id: string;
  kind: TaskDependencyFlowKind;
  nodeIds: string[];
  taskIds: string[];
  rootIds: string[];
  leafIds: string[];
  edgeCount: number;
  gatedCount: number;
  createdInSessionIds: string[];
}

export function buildTaskDependencyGraph(tasks: Task[]): TaskDependencyGraph {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const nodes = new Map<string, TaskDependencyNode>();

  const ensureNode = (id: string): TaskDependencyNode => {
    let node = nodes.get(id);
    if (node) return node;
    const task = byId.get(id) ?? null;
    node = {
      id,
      kind: task ? "task" : "missing",
      task,
      dependsOnIds: [],
      dependentIds: [],
      unmetDepIds: [],
    };
    nodes.set(id, node);
    return node;
  };

  for (const task of tasks) ensureNode(task.id);

  const edges: TaskDependencyEdge[] = [];
  for (const task of tasks) {
    const target = ensureNode(task.id);
    for (const depId of task.depends_on) {
      const source = ensureNode(depId);
      source.dependentIds.push(task.id);
      target.dependsOnIds.push(depId);
      const dep = byId.get(depId);
      const satisfied = dep?.status === "done";
      if (!satisfied) target.unmetDepIds.push(depId);
      edges.push({
        id: `dep:${depId}->${task.id}`,
        source: depId,
        target: task.id,
        satisfied,
        missingSource: !dep,
      });
    }
  }

  return {
    nodes: [...nodes.values()].sort(taskDependencyNodeSort),
    edges,
  };
}

export function buildTaskDependencyFlows(
  graph: TaskDependencyGraph,
): TaskDependencyFlow[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const groupedNodeIds = new Set<string>();
  const flows: TaskDependencyFlow[] = [];

  for (const [sessionId, taskIds] of originSessionTaskGroups(graph.nodes)) {
    const nodeIds = sortDependencyIds([
      ...taskIds,
      ...exclusiveMissingDependencyIds(taskIds, graph, nodeById),
    ]);
    const nodeIdSet = new Set(nodeIds);
    const groupEdges = graph.edges.filter(
      (edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target),
    );

    for (const id of nodeIds) groupedNodeIds.add(id);
    flows.push(
      buildFlowGroup({
        id: `session:${sessionId}`,
        kind: "session",
        nodeIds,
        edgeCount: groupEdges.length,
        nodeById,
        edges: groupEdges,
      }),
    );
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (!groupedNodeIds.has(node.id)) adjacency.set(node.id, new Set());
  }

  for (const edge of graph.edges) {
    if (groupedNodeIds.has(edge.source) || groupedNodeIds.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const visited = new Set<string>();
  const standaloneIds: string[] = [];

  for (const node of graph.nodes) {
    if (groupedNodeIds.has(node.id)) continue;
    if (visited.has(node.id)) continue;
    const component = collectComponent(node.id, adjacency, visited);
    const componentEdges = graph.edges.filter(
      (edge) => component.has(edge.source) && component.has(edge.target),
    );
    const nodeIds = sortDependencyIds([...component]);
    const taskIds = nodeIds.filter((id) => nodeById.get(id)?.task);

    if (
      nodeIds.length === 1 &&
      taskIds.length === 1 &&
      componentEdges.length === 0
    ) {
      standaloneIds.push(taskIds[0]!);
      continue;
    }

    flows.push(
      buildFlowGroup({
        id: `flow:${stableGroupId(taskIds.length > 0 ? taskIds : nodeIds)}`,
        kind: "flow",
        nodeIds,
        edgeCount: componentEdges.length,
        nodeById,
        edges: componentEdges,
      }),
    );
  }

  if (standaloneIds.length > 0) {
    flows.push(
      buildFlowGroup({
        id: "standalone",
        kind: "standalone",
        nodeIds: sortDependencyIds(standaloneIds),
        edgeCount: 0,
        nodeById,
        edges: [],
      }),
    );
  }

  return flows.sort(taskDependencyFlowSort);
}

export function taskHasUnmetDependencies(
  task: Task,
  tasksById: Map<string, Task>,
): boolean {
  return task.depends_on.some((id) => tasksById.get(id)?.status !== "done");
}

function collectComponent(
  startId: string,
  adjacency: Map<string, Set<string>>,
  visited: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const stack = [startId];
  visited.add(startId);
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push(next);
    }
  }
  return out;
}

function originSessionTaskGroups(
  nodes: TaskDependencyNode[],
): Array<[string, string[]]> {
  const buckets = new Map<string, string[]>();
  for (const node of nodes) {
    const sessionId = node.task?.created_in_session_id;
    if (!sessionId) continue;
    const bucket = buckets.get(sessionId) ?? [];
    bucket.push(node.id);
    buckets.set(sessionId, bucket);
  }

  return [...buckets.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([sessionId, ids]): [string, string[]] => [
      sessionId,
      sortDependencyIds(ids),
    ])
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
}

function exclusiveMissingDependencyIds(
  taskIds: string[],
  graph: TaskDependencyGraph,
  nodeById: Map<string, TaskDependencyNode>,
): string[] {
  const taskIdSet = new Set(taskIds);
  const incomingMissing = new Set<string>();

  for (const edge of graph.edges) {
    if (!taskIdSet.has(edge.target)) continue;
    if (nodeById.get(edge.source)?.kind !== "missing") continue;
    const targets = graph.edges
      .filter((candidate) => candidate.source === edge.source)
      .map((candidate) => candidate.target);
    if (targets.every((target) => taskIdSet.has(target))) {
      incomingMissing.add(edge.source);
    }
  }

  return sortDependencyIds([...incomingMissing]);
}

function buildFlowGroup(args: {
  id: string;
  kind: TaskDependencyFlowKind;
  nodeIds: string[];
  edgeCount: number;
  nodeById: Map<string, TaskDependencyNode>;
  edges: TaskDependencyEdge[];
}): TaskDependencyFlow {
  const component = new Set(args.nodeIds);
  const incoming = new Map(args.nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(args.nodeIds.map((id) => [id, 0]));
  for (const edge of args.edges) {
    if (!component.has(edge.source) || !component.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  const taskIds = args.nodeIds.filter((id) => args.nodeById.get(id)?.task);
  const roots = args.nodeIds.filter((id) => (incoming.get(id) ?? 0) === 0);
  const leaves = args.nodeIds.filter((id) => (outgoing.get(id) ?? 0) === 0);

  return {
    id: args.id,
    kind: args.kind,
    nodeIds: args.nodeIds,
    taskIds,
    rootIds: sortDependencyIds(roots),
    leafIds: sortDependencyIds(leaves),
    edgeCount: args.edgeCount,
    gatedCount: taskIds.filter(
      (id) => (args.nodeById.get(id)?.unmetDepIds.length ?? 0) > 0,
    ).length,
    createdInSessionIds: sortDependencyIds([
      ...new Set(
        taskIds
          .map((id) => args.nodeById.get(id)?.task?.created_in_session_id)
          .filter((id): id is string => !!id),
      ),
    ]),
  };
}

function taskDependencyNodeSort(
  a: TaskDependencyNode,
  b: TaskDependencyNode,
): number {
  if (a.kind !== b.kind) return a.kind === "task" ? -1 : 1;
  const at = a.task;
  const bt = b.task;
  if (at && bt) {
    const updated = bt.updated_at.localeCompare(at.updated_at);
    if (updated !== 0) return updated;
  }
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function taskDependencyFlowSort(
  a: TaskDependencyFlow,
  b: TaskDependencyFlow,
): number {
  if (a.kind !== b.kind) {
    return flowKindRank(a.kind) - flowKindRank(b.kind);
  }
  return stableGroupId(a.nodeIds).localeCompare(
    stableGroupId(b.nodeIds),
    undefined,
    {
      numeric: true,
    },
  );
}

function flowKindRank(kind: TaskDependencyFlowKind): number {
  switch (kind) {
    case "session":
      return 0;
    case "flow":
      return 1;
    case "standalone":
      return 2;
  }
}

function stableGroupId(ids: string[]): string {
  return sortDependencyIds(ids)[0] ?? "";
}

function sortDependencyIds(ids: string[]): string[] {
  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}
