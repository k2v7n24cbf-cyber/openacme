import type { ObjectiveListItem, ObjectiveStatus } from "./types";

export const OBJECTIVE_STATUS_LABEL: Record<ObjectiveStatus, string> = {
  active: "Active",
  waiting_on_tasks: "Waiting on tasks",
  ready_for_closeout: "Ready for closeout",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export function objectiveStatusVariant(
  status: ObjectiveStatus,
):
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "working"
  | "attention" {
  switch (status) {
    case "active":
      return "default";
    case "waiting_on_tasks":
      return "attention";
    case "ready_for_closeout":
      return "working";
    case "completed":
      return "secondary";
    case "failed":
      return "destructive";
    case "canceled":
      return "outline";
  }
}

export function sortObjectives(
  objectives: ObjectiveListItem[],
): ObjectiveListItem[] {
  return [...objectives].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function filterObjectives(
  objectives: ObjectiveListItem[],
  query: string,
): ObjectiveListItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return objectives;
  return objectives.filter((objective) => {
    const haystack = [
      objective.id,
      objective.title,
      objective.description,
      objective.ownerAgentId,
      objective.ownerSessionId ?? "",
      objective.status,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function objectiveProgressLabel(objective: ObjectiveListItem): string {
  const { terminal_task_count, linked_task_count } = objective.rollup;
  return `${terminal_task_count}/${linked_task_count}`;
}
