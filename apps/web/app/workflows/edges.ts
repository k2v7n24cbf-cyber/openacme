export type WorkflowReferenceEdgeKind = "then" | "else" | "body";

export interface WorkflowReferenceNode {
  id: string;
  type: string;
  then?: unknown;
  else?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

export interface WorkflowReferenceEdgeInput {
  sourceId: string;
  targetId: string;
  kind: WorkflowReferenceEdgeKind;
}

export type WorkflowReferenceMutationResult =
  | { ok: true; nodes: WorkflowReferenceNode[] }
  | { ok: false; reason: string };

export function connectWorkflowReferenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateReferenceList(nodes, input, (current) =>
    current.includes(input.targetId) ? current : [...current, input.targetId],
  );
}

export function reconnectWorkflowReferenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput & { previousTargetId: string },
): WorkflowReferenceMutationResult {
  return mutateReferenceList(nodes, input, (current) => {
    const withoutPrevious = current.filter(
      (target) => target !== input.previousTargetId,
    );
    return withoutPrevious.includes(input.targetId)
      ? withoutPrevious
      : [...withoutPrevious, input.targetId];
  });
}

export function removeWorkflowReferenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateReferenceList(nodes, input, (current) =>
    current.filter((target) => target !== input.targetId),
  );
}

function mutateReferenceList(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
  mutate: (current: string[]) => string[],
): WorkflowReferenceMutationResult {
  const sourceIndex = nodes.findIndex((node) => node.id === input.sourceId);
  if (sourceIndex < 0) {
    return { ok: false, reason: "source_node_not_found" };
  }
  if (!nodes.some((node) => node.id === input.targetId)) {
    return { ok: false, reason: "target_node_not_found" };
  }
  if (input.sourceId === input.targetId) {
    return { ok: false, reason: "self_reference_not_supported" };
  }

  const source = nodes[sourceIndex]!;
  if (!canUseReferenceKind(source, input.kind)) {
    return { ok: false, reason: "edge_kind_not_supported" };
  }

  const current = nodeIdList(source[input.kind]);
  const nextTargets = mutate(current);
  const nextSource = { ...source, [input.kind]: nextTargets };
  const nextNodes = [...nodes];
  nextNodes[sourceIndex] = nextSource;
  return { ok: true, nodes: nextNodes };
}

function canUseReferenceKind(
  node: WorkflowReferenceNode,
  kind: WorkflowReferenceEdgeKind,
): boolean {
  if (kind === "then") {
    return node.type === "builtin.if" || node.type === "builtin.if_else";
  }
  if (kind === "else") return node.type === "builtin.if_else";
  return node.type === "builtin.foreach";
}

function nodeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];
}
