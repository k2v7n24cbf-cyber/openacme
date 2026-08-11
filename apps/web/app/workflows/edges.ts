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
  next?: unknown;
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
  preserveTargets?: Record<string, string[]>;
}

export interface WorkflowRouteContinuationEdgeInput {
  sourceId: string;
  targetId: string;
  preserveTargets?: Record<string, string[]>;
}

export type WorkflowReferenceMutationResult =
  | { ok: true; nodes: WorkflowReferenceNode[] }
  | { ok: false; reason: string };

export function firstWorkflowSequenceTarget(
  nodes: WorkflowReferenceNode[],
  sourceId: string,
): string | null {
  const source = nodes.find((node) => node.id === sourceId);
  return source ? (nodeIdList(source.next)[0] ?? null) : null;
}

export function insertWorkflowSequenceEdgeTarget(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateSequenceEdge(nodes, input, (source, target) => {
    const current = nodeIdList(source.next);
    const suffix = current.filter((item) => item !== input.targetId);
    return {
      source: { ...source, next: [input.targetId] },
      target:
        suffix.length > 0 && nodeIdList(target.next).length === 0
          ? { ...target, next: suffix }
          : target,
    };
  });
}

export function overwriteWorkflowSequenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateSequenceEdge(nodes, input, (source) => ({
    source: { ...source, next: [input.targetId] },
  }));
}

export function removeWorkflowSequenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateSequenceSource(nodes, input.sourceId, (source) => ({
    ...source,
    next: nodeIdList(source.next).filter((target) => target !== input.targetId),
  }));
}

export function connectWorkflowReferenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateReferenceList(nodes, input, (current) => {
    if (current.includes(input.targetId)) return current;
    return [...current, input.targetId];
  });
}

export function insertWorkflowReferenceEdgeTarget(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateReferenceEdge(nodes, input, (source, target) => {
    const current = referenceTargets(source, input.kind) ?? [];
    if (current.includes(input.targetId)) {
      return { source };
    }
    const suffix = current.filter((item) => item !== input.targetId);
    const nextSource = setReferenceTargets(source, input.kind, [input.targetId]);
    if (!nextSource) return null;
    return {
      source: nextSource,
      target:
        suffix.length > 0 && nodeIdList(target.next).length === 0
          ? { ...target, next: suffix }
          : target,
    };
  });
}

export function overwriteWorkflowReferenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateReferenceList(nodes, input, () => [input.targetId]);
}

export function firstWorkflowReferenceTarget(
  nodes: WorkflowReferenceNode[],
  input: Omit<WorkflowReferenceEdgeInput, "targetId">,
): string | null {
  const source = nodes.find((node) => node.id === input.sourceId);
  if (!source || !canUseReferenceKind(source, input.kind)) return null;
  return referenceTargets(source, input.kind)?.[0] ?? null;
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
  return mutateSequenceEdge(nodes, input, (source) => {
    const current = nodeIdList(source.next);
    return {
      source: current.includes(input.targetId)
        ? source
        : { ...source, next: [...current, input.targetId] },
    };
  });
}

export function overwriteWorkflowRouteContinuationEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateSequenceEdge(nodes, input, (source) => {
    return { source: { ...source, next: [input.targetId] } };
  });
}

export function removeWorkflowRouteContinuationEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
): WorkflowReferenceMutationResult {
  return mutateSequenceSource(nodes, input.sourceId, (source) => ({
    ...source,
    next: nodeIdList(source.next).filter((target) => target !== input.targetId),
  }));
}

function mutateSequenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowRouteContinuationEdgeInput,
  mutate: (
    source: WorkflowReferenceNode,
    target: WorkflowReferenceNode,
  ) => { source: WorkflowReferenceNode; target?: WorkflowReferenceNode },
): WorkflowReferenceMutationResult {
  const sourceIndex = nodes.findIndex((node) => node.id === input.sourceId);
  if (sourceIndex < 0) return { ok: false, reason: "source_node_not_found" };
  const targetIndex = nodes.findIndex((node) => node.id === input.targetId);
  if (targetIndex < 0) return { ok: false, reason: "target_node_not_found" };
  if (input.sourceId === input.targetId) {
    return { ok: false, reason: "self_reference_not_supported" };
  }
  const result = mutate(nodes[sourceIndex]!, nodes[targetIndex]!);
  const nextNodes = [...nodes];
  nextNodes[sourceIndex] = result.source;
  if (result.target) nextNodes[targetIndex] = result.target;
  return { ok: true, nodes: nextNodes };
}

function mutateSequenceSource(
  nodes: WorkflowReferenceNode[],
  sourceId: string,
  mutate: (source: WorkflowReferenceNode) => WorkflowReferenceNode,
): WorkflowReferenceMutationResult {
  const sourceIndex = nodes.findIndex((node) => node.id === sourceId);
  if (sourceIndex < 0) return { ok: false, reason: "source_node_not_found" };
  const nextNodes = [...nodes];
  nextNodes[sourceIndex] = mutate(nodes[sourceIndex]!);
  return { ok: true, nodes: nextNodes };
}

function mutateReferenceEdge(
  nodes: WorkflowReferenceNode[],
  input: WorkflowReferenceEdgeInput,
  mutate: (
    source: WorkflowReferenceNode,
    target: WorkflowReferenceNode,
  ) => { source: WorkflowReferenceNode; target?: WorkflowReferenceNode } | null,
): WorkflowReferenceMutationResult {
  const sourceIndex = nodes.findIndex((node) => node.id === input.sourceId);
  if (sourceIndex < 0) return { ok: false, reason: "source_node_not_found" };
  const targetIndex = nodes.findIndex((node) => node.id === input.targetId);
  if (targetIndex < 0) return { ok: false, reason: "target_node_not_found" };
  if (input.sourceId === input.targetId) {
    return { ok: false, reason: "self_reference_not_supported" };
  }
  const source = nodes[sourceIndex]!;
  if (!canUseReferenceKind(source, input.kind)) {
    return { ok: false, reason: "edge_kind_not_supported" };
  }
  const result = mutate(source, nodes[targetIndex]!);
  if (!result) return { ok: false, reason: "edge_kind_not_supported" };
  const nextNodes = [...nodes];
  nextNodes[sourceIndex] = result.source;
  if (result.target) nextNodes[targetIndex] = result.target;
  return { ok: true, nodes: nextNodes };
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
