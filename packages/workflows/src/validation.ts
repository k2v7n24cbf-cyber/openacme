import type { WorkflowNode, WorkflowTrigger } from "./schemas.js";

const WORKFLOW_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface WorkflowNodeReferenceIssue {
  nodeId: string;
  field: "id" | "then" | "else" | "body" | "branches" | "cases" | "default";
  targetId?: string;
  message: string;
}

export type WorkflowNodeReferenceValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: WorkflowNodeReferenceIssue[]; message: string };

export interface WorkflowTriggerIssue {
  triggerId: string;
  field: "id" | "path";
  message: string;
}

export type WorkflowTriggerValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: WorkflowTriggerIssue[]; message: string };

export function validateWorkflowNodeReferences(
  nodes: WorkflowNode[],
): WorkflowNodeReferenceValidation {
  const issues: WorkflowNodeReferenceIssue[] = [];
  const nodeIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const node of nodes) {
    if (!WORKFLOW_SAFE_ID.test(node.id)) {
      issues.push({
        nodeId: node.id,
        field: "id",
        message: `Invalid workflow node id: ${node.id}`,
      });
    }
    if (seenIds.has(node.id)) {
      issues.push({
        nodeId: node.id,
        field: "id",
        message: `Duplicate workflow node id: ${node.id}`,
      });
      continue;
    }
    seenIds.add(node.id);
    nodeIds.add(node.id);
  }

  for (const node of nodes) {
    switch (node.type) {
      case "builtin.if":
        collectMissingTargets(issues, node.id, "then", node.then, nodeIds);
        collectMissingTargets(issues, node.id, "else", node.else, nodeIds);
        break;
      case "builtin.if_else":
        collectMissingTargets(issues, node.id, "then", node.then, nodeIds);
        collectMissingTargets(issues, node.id, "else", node.else, nodeIds);
        break;
      case "builtin.switch":
        collectSwitchIssues(issues, node, nodeIds);
        break;
      case "builtin.foreach":
        collectMissingTargets(issues, node.id, "body", node.body, nodeIds);
        break;
      case "builtin.parallel":
        collectParallelIssues(issues, node, nodeIds);
        break;
    }
  }

  if (issues.length === 0) return { ok: true, issues: [] };
  return {
    ok: false,
    issues,
    message: issues.map((issue) => issue.message).join("; "),
  };
}

export function validateWorkflowTriggers(
  triggers: WorkflowTrigger[],
): WorkflowTriggerValidation {
  const issues: WorkflowTriggerIssue[] = [];
  const seenIds = new Set<string>();
  const seenWebhookPaths = new Map<string, string>();

  for (const trigger of triggers) {
    if (!WORKFLOW_SAFE_ID.test(trigger.id)) {
      issues.push({
        triggerId: trigger.id,
        field: "id",
        message: `Invalid workflow trigger id: ${trigger.id}`,
      });
    }
    if (seenIds.has(trigger.id)) {
      issues.push({
        triggerId: trigger.id,
        field: "id",
        message: `Duplicate workflow trigger id: ${trigger.id}`,
      });
      continue;
    }
    seenIds.add(trigger.id);

    if (trigger.kind !== "webhook") continue;
    const path = normalizeWebhookPath(trigger.path);
    if (!path) continue;
    const existing = seenWebhookPaths.get(path);
    if (existing) {
      issues.push({
        triggerId: trigger.id,
        field: "path",
        message: `Duplicate workflow webhook path: ${path}`,
      });
      continue;
    }
    seenWebhookPaths.set(path, trigger.id);
  }

  if (issues.length === 0) return { ok: true, issues: [] };
  return {
    ok: false,
    issues,
    message: issues.map((issue) => issue.message).join("; "),
  };
}

function collectMissingTargets(
  issues: WorkflowNodeReferenceIssue[],
  nodeId: string,
  field: "then" | "else" | "body" | "branches" | "cases" | "default",
  targets: string[],
  nodeIds: Set<string>,
) {
  for (const targetId of targets) {
    if (nodeIds.has(targetId)) continue;
    issues.push({
      nodeId,
      field,
      targetId,
      message: `Node ${nodeId} ${field} references missing node ${targetId}`,
    });
  }
}

function collectSwitchIssues(
  issues: WorkflowNodeReferenceIssue[],
  node: Extract<WorkflowNode, { type: "builtin.switch" }>,
  nodeIds: Set<string>,
) {
  const caseIds = new Set<string>();
  for (const item of node.cases) {
    if (caseIds.has(item.id)) {
      issues.push({
        nodeId: node.id,
        field: "cases",
        message: `Node ${node.id} has duplicate switch case id: ${item.id}`,
      });
    } else {
      caseIds.add(item.id);
    }

    for (const targetId of item.nodes) {
      if (targetId === node.id) {
        issues.push({
          nodeId: node.id,
          field: "cases",
          targetId,
          message: `Node ${node.id} switch case ${item.id} cannot reference itself`,
        });
        continue;
      }
      collectMissingTargets(issues, node.id, "cases", [targetId], nodeIds);
    }
  }
  for (const targetId of node.default) {
    if (targetId === node.id) {
      issues.push({
        nodeId: node.id,
        field: "default",
        targetId,
        message: `Node ${node.id} switch default cannot reference itself`,
      });
      continue;
    }
    collectMissingTargets(issues, node.id, "default", [targetId], nodeIds);
  }
}

function collectParallelIssues(
  issues: WorkflowNodeReferenceIssue[],
  node: Extract<WorkflowNode, { type: "builtin.parallel" }>,
  nodeIds: Set<string>,
) {
  const branchIds = new Set<string>();
  for (const branch of node.branches) {
    if (branchIds.has(branch.id)) {
      issues.push({
        nodeId: node.id,
        field: "branches",
        message: `Node ${node.id} has duplicate parallel branch id: ${branch.id}`,
      });
    } else {
      branchIds.add(branch.id);
    }

    for (const targetId of branch.nodes) {
      if (targetId === node.id) {
        issues.push({
          nodeId: node.id,
          field: "branches",
          targetId,
          message: `Node ${node.id} parallel branch ${branch.id} cannot reference itself`,
        });
        continue;
      }
      collectMissingTargets(
        issues,
        node.id,
        "branches",
        [targetId],
        nodeIds,
      );
    }
  }
}

function normalizeWebhookPath(value: string | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}
