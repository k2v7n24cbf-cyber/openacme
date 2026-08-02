export type WorkflowReferenceEdgeKind =
  | "then"
  | "else"
  | "body"
  | "default"
  | `case:${string}`
  | `branch:${string}`;

export interface WorkflowReferenceNode {
  id: string;
  type: string;
  then?: unknown;
  else?: unknown;
  body?: unknown;
  cases?: unknown;
  default?: unknown;
  branches?: unknown;
  [key: string]: unknown;
}

export interface WorkflowReferenceEdgeInput {
  sourceId: string;
  targetId: string;
  kind: WorkflowReferenceEdgeKind;
}

export interface WorkflowRouteContinuationEdgeInput {
  sourceId: string;
  targetId: string;
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

export function connectWorkflowRouteContinuationEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateRouteContinuation(nodes, input, (current, sourceIndex) => {
    if (current.includes(input.targetId)) return current;
    return [
      ...current.slice(0, sourceIndex + 1),
      input.targetId,
      ...current.slice(sourceIndex + 1),
    ];
  });
}

export function removeWorkflowRouteContinuationEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateRouteContinuation(nodes, input, (current) =>
    current.filter((target) => target !== input.targetId),
  );
}

function mutateRouteContinuation(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
  mutate: (current: string[], sourceIndex: number) => string[],
): WorkflowReferenceMutationResult {
  if (!nodes.some((node) => node.id === input.sourceId)) {
    return { ok: false, reason: "source_node_not_found" };
  }
  if (!nodes.some((node) => node.id === input.targetId)) {
    return { ok: false, reason: "target_node_not_found" };
  }
  if (input.sourceId === input.targetId) {
    return { ok: false, reason: "self_reference_not_supported" };
  }

  const memberships = routeMemberships(nodes, input.sourceId);
  if (memberships.length === 0) {
    return { ok: false, reason: "route_source_not_found" };
  }
  if (memberships.length > 1) {
    return { ok: false, reason: "ambiguous_route_source" };
  }
  const membership = memberships[0]!;
  const source = nodes[membership.nodeIndex]!;
  const current = referenceTargets(source, membership.kind);
  if (!current) return { ok: false, reason: "edge_kind_not_supported" };
  const nextTargets = mutate(current, membership.sourceIndex);
  const nextSource = setReferenceTargets(source, membership.kind, nextTargets);
  if (!nextSource) return { ok: false, reason: "edge_kind_not_supported" };
  const nextNodes = [...nodes];
  nextNodes[membership.nodeIndex] = nextSource;
  return { ok: true, nodes: nextNodes };
}

function routeMemberships(
  nodes: WorkflowReferenceNode[],
  sourceId: string,
): Array<{
  nodeIndex: number;
  kind: WorkflowReferenceEdgeKind;
  sourceIndex: number;
}> {
  const memberships: Array<{
    nodeIndex: number;
    kind: WorkflowReferenceEdgeKind;
    sourceIndex: number;
  }> = [];
  nodes.forEach((node, nodeIndex) => {
    for (const kind of referenceKindsForNode(node)) {
      const targets = referenceTargets(node, kind);
      if (!targets) continue;
      const sourceIndex = targets.indexOf(sourceId);
      if (sourceIndex >= 0) memberships.push({ nodeIndex, kind, sourceIndex });
    }
  });
  return memberships;
}

function referenceKindsForNode(
  node: WorkflowReferenceNode,
): WorkflowReferenceEdgeKind[] {
  if (node.type === "builtin.if" || node.type === "builtin.if_else") {
    return ["then", "else"];
  }
  if (node.type === "builtin.foreach") return ["body"];
  if (node.type === "builtin.switch" && Array.isArray(node.cases)) {
    return [
      ...node.cases
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => item["id"])
        .filter((id): id is string => typeof id === "string" && !!id)
        .map((id) => `case:${id}` as const),
      "default",
    ];
  }
  if (node.type !== "builtin.parallel" || !Array.isArray(node.branches)) {
    return [];
  }
  return node.branches
    .filter((branch): branch is Record<string, unknown> => isRecord(branch))
    .map((branch) => branch["id"])
    .filter((id): id is string => typeof id === "string" && !!id)
    .map((id) => `branch:${id}` as const);
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

  const current = referenceTargets(source, input.kind);
  if (!current) return { ok: false, reason: "edge_kind_not_supported" };
  const nextTargets = mutate(current);
  const nextSource = setReferenceTargets(source, input.kind, nextTargets);
  if (!nextSource) return { ok: false, reason: "edge_kind_not_supported" };
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
  if (kind === "else") {
    return node.type === "builtin.if" || node.type === "builtin.if_else";
  }
  if (kind === "body") return node.type === "builtin.foreach";
  if (kind === "default") return node.type === "builtin.switch";
  if (kind.startsWith("case:")) {
    return (
      node.type === "builtin.switch" &&
      caseIdFromKind(kind) !== null &&
      referenceTargets(node, kind) !== null
    );
  }
  return (
    node.type === "builtin.parallel" &&
    branchIdFromKind(kind) !== null &&
    referenceTargets(node, kind) !== null
  );
}

function referenceTargets(
  node: WorkflowReferenceNode,
  kind: WorkflowReferenceEdgeKind,
): string[] | null {
  if (
    kind === "then" ||
    kind === "else" ||
    kind === "body" ||
    kind === "default"
  ) {
    return nodeIdList(node[kind]);
  }
  const caseId = caseIdFromKind(kind);
  if (caseId && Array.isArray(node.cases)) {
    const item = node.cases.find(
      (entry) => isRecord(entry) && entry["id"] === caseId,
    );
    if (!isRecord(item)) return null;
    return nodeIdList(item["nodes"]);
  }
  const branchId = branchIdFromKind(kind);
  if (!branchId || !Array.isArray(node.branches)) return null;
  const branch = node.branches.find(
    (item) => isRecord(item) && item["id"] === branchId,
  );
  if (!isRecord(branch)) return null;
  return nodeIdList(branch["nodes"]);
}

function setReferenceTargets(
  node: WorkflowReferenceNode,
  kind: WorkflowReferenceEdgeKind,
  targets: string[],
): WorkflowReferenceNode | null {
  if (
    kind === "then" ||
    kind === "else" ||
    kind === "body" ||
    kind === "default"
  ) {
    return { ...node, [kind]: targets };
  }
  const caseId = caseIdFromKind(kind);
  if (caseId && Array.isArray(node.cases)) {
    let found = false;
    const cases = node.cases.map((item) => {
      if (!isRecord(item) || item["id"] !== caseId) return item;
      found = true;
      return { ...item, nodes: targets };
    });
    if (!found) return null;
    return { ...node, cases };
  }
  const branchId = branchIdFromKind(kind);
  if (!branchId || !Array.isArray(node.branches)) return null;
  let found = false;
  const branches = node.branches.map((branch) => {
    if (!isRecord(branch) || branch["id"] !== branchId) return branch;
    found = true;
    return { ...branch, nodes: targets };
  });
  if (!found) return null;
  return { ...node, branches };
}

function branchIdFromKind(kind: WorkflowReferenceEdgeKind): string | null {
  if (!kind.startsWith("branch:")) return null;
  const branchId = kind.slice("branch:".length);
  return branchId ? branchId : null;
}

function caseIdFromKind(kind: WorkflowReferenceEdgeKind): string | null {
  if (!kind.startsWith("case:")) return null;
  const caseId = kind.slice("case:".length);
  return caseId ? caseId : null;
}

function nodeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
