import type { Task } from "@/app/tasks/types";

// Mirrored from OBJECTIVE_STATUSES in @openacme/db. The web bundle is static,
// so keep these DTOs node-free and in sync with the server route shapes.
export const OBJECTIVE_STATUSES = [
  "active",
  "waiting_on_tasks",
  "ready_for_closeout",
  "completed",
  "failed",
  "canceled",
] as const;

export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export interface Objective {
  id: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  ownerAgentId: string;
  ownerSessionId: string | null;
  createdBy: string;
  createdInSessionId: string | null;
  closeoutPrompt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completionSummary: string | null;
  lastCloseoutFingerprint: string | null;
  lastCloseoutBriefJson: string | null;
  lastCloseoutBriefAt: string | null;
}

export interface ObjectiveRollup {
  linked_task_count: number;
  terminal_task_count: number;
  nonterminal_task_count: number;
}

export type ObjectiveListItem = Objective & {
  rollup: ObjectiveRollup;
};

export interface ObjectivesListResponse {
  objectives: ObjectiveListItem[];
}

export interface ObjectiveDetailResponse {
  objective: Objective;
  rollup: ObjectiveRollup;
  tasks: Task[];
}

export interface ObjectiveEvent {
  id: string;
  objectiveId: string;
  eventType: string;
  actor: string;
  summary: string;
  details: unknown | null;
  createdAt: number;
}

export interface ObjectiveEventsResponse {
  events: ObjectiveEvent[];
}
