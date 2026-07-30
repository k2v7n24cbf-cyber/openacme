import type { WorkflowGraphProjection } from "./graph";

export type WorkflowCanvasRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

export interface WorkflowRunOverlayStep {
  id: string;
  nodeId: string;
  attempt: number;
  status: WorkflowCanvasRunStatus;
}

export interface WorkflowRunOverlayRun {
  currentNodeId: string | null;
}

export interface WorkflowRunOverlayInput {
  run: WorkflowRunOverlayRun;
  steps: WorkflowRunOverlayStep[];
}

export function applyWorkflowRunOverlay(
  projection: WorkflowGraphProjection,
  overlay: WorkflowRunOverlayInput | null,
): WorkflowGraphProjection {
  if (!overlay) return projection;
  const latestByNode = latestStepsByNode(overlay.steps);

  return {
    ...projection,
    nodes: projection.nodes.map((node) => {
      if (node.data.kind !== "step") return node;
      const latest = latestByNode.get(node.id);
      const isCurrent = overlay.run.currentNodeId === node.id;
      if (!latest && !isCurrent) return node;
      return {
        ...node,
        data: {
          ...node.data,
          runStatus: latest?.status ?? (isCurrent ? "running" : undefined),
          runStepId: latest?.id ?? null,
          runAttempt: latest?.attempt ?? null,
          runCurrent: isCurrent,
        },
      };
    }),
  };
}

export function latestWorkflowRunStepIdForNode(
  steps: WorkflowRunOverlayStep[],
  nodeId: string,
): string | null {
  return latestStepsByNode(steps).get(nodeId)?.id ?? null;
}

function latestStepsByNode(
  steps: WorkflowRunOverlayStep[],
): Map<string, WorkflowRunOverlayStep> {
  const latest = new Map<string, WorkflowRunOverlayStep>();
  for (const step of steps) {
    const current = latest.get(step.nodeId);
    if (!current || step.attempt >= current.attempt) {
      latest.set(step.nodeId, step);
    }
  }
  return latest;
}
