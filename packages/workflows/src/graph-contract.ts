import type { WorkflowDefinition, WorkflowNode } from "./schemas.js";

export function normalizeWorkflowDefinitionGraph(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  return { ...definition, nodes: normalizeWorkflowNodeGraph(definition.nodes) };
}

export function normalizeWorkflowNodeGraph(
  nodes: WorkflowNode[],
): WorkflowNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let changed = false;
  const nextById = new Map<string, string[]>();

  for (const node of nodes) nextById.set(node.id, [...node.next]);

  const normalizeRoute = (targets: string[]): string[] => {
    if (targets.length <= 1) return targets;
    changed = true;
    for (let index = 0; index < targets.length - 1; index += 1) {
      const sourceId = targets[index]!;
      const targetId = targets[index + 1]!;
      if (!byId.has(sourceId) || !byId.has(targetId)) continue;
      const current = nextById.get(sourceId) ?? [];
      if (current.length === 0) nextById.set(sourceId, [targetId]);
    }
    return [targets[0]!];
  };

  const normalized = nodes.map((node) => {
    switch (node.type) {
      case "builtin.if":
      case "builtin.if_else":
        return {
          ...node,
          then: normalizeRoute(node.then),
          else: normalizeRoute(node.else),
        };
      case "builtin.switch":
        return {
          ...node,
          cases: node.cases.map((item) => ({
            ...item,
            nodes: normalizeRoute(item.nodes),
          })),
          default: normalizeRoute(node.default),
        };
      case "builtin.foreach":
        return { ...node, body: normalizeRoute(node.body) };
      case "builtin.parallel":
        return {
          ...node,
          branches: node.branches.map((branch) => ({
            ...branch,
            nodes: normalizeRoute(branch.nodes),
          })),
        };
      default:
        return node;
    }
  });

  const withNext = normalized.map((node) => {
    const next = nextById.get(node.id) ?? node.next;
    if (next === node.next || sameStringArray(next, node.next)) return node;
    changed = true;
    return { ...node, next };
  });

  return changed ? withNext : nodes;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
