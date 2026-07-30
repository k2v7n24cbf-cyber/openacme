import type { WorkflowNode, WorkflowTrigger } from "./schemas.js";

const WORKFLOW_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface WorkflowNodeReferenceIssue {
  nodeId: string;
  field: "id" | "then" | "else" | "body";
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
        break;
      case "builtin.if_else":
        collectMissingTargets(issues, node.id, "then", node.then, nodeIds);
        collectMissingTargets(issues, node.id, "else", node.else, nodeIds);
        break;
      case "builtin.foreach":
        collectMissingTargets(issues, node.id, "body", node.body, nodeIds);
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
  field: "then" | "else" | "body",
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

function normalizeWebhookPath(value: string | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}
