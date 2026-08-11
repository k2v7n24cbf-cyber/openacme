import { describe, expect, it } from "vitest";
import {
  OBJECTIVE_STATUSES,
  type ObjectiveDetailResponse,
  type ObjectiveEventsResponse,
  type ObjectivesListResponse,
} from "@/app/objectives/types";

describe("objective API DTO mirrors", () => {
  it("lists every V1 objective status exactly once", () => {
    expect(new Set(OBJECTIVE_STATUSES).size).toBe(OBJECTIVE_STATUSES.length);
    expect(OBJECTIVE_STATUSES).toEqual([
      "active",
      "waiting_on_tasks",
      "ready_for_closeout",
      "completed",
      "failed",
      "canceled",
    ]);
  });

  it("types list, detail, and ledger response shapes", () => {
    const list = {
      objectives: [
        {
          id: "objective-1",
          title: "Ship objective layer",
          description: "Read-only web visibility",
          status: "ready_for_closeout",
          ownerAgentId: "agent-1",
          ownerSessionId: "session-1",
          createdBy: "agent-1",
          createdInSessionId: "session-1",
          closeoutPrompt: "Check all linked tasks.",
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          completedAt: null,
          completionSummary: null,
          lastCloseoutFingerprint: "fingerprint-1",
          lastCloseoutBriefJson: null,
          lastCloseoutBriefAt: null,
          rollup: {
            linked_task_count: 1,
            terminal_task_count: 1,
            nonterminal_task_count: 0,
          },
        },
      ],
    } satisfies ObjectivesListResponse;

    const objective = list.objectives[0]!;
    const detail = {
      objective,
      rollup: objective.rollup,
      tasks: [
        {
          id: "1",
          title: "Wire DTOs",
          status: "done",
          assignee: "agent-1",
          session_id: "session-1",
          objective_id: "objective-1",
          created_by: "agent-1",
          created_in_session_id: "session-1",
          parent_id: null,
          depends_on: [],
          start_at: null,
          due_at: null,
          created_at: "2026-08-11T00:00:00.000Z",
          updated_at: "2026-08-11T00:00:00.000Z",
          closed_at: "2026-08-11T00:00:00.000Z",
          recurrence: null,
          runs: 0,
          last_run_at: null,
          team: null,
        },
      ],
    } satisfies ObjectiveDetailResponse;

    const events = {
      events: [
        {
          id: "event-1",
          objectiveId: "objective-1",
          eventType: "owner_wake_requested",
          actor: "system:objective-closeout",
          summary: "Owner wake requested for objective closeout",
          details: { fingerprint: "fingerprint-1" },
          createdAt: 1786470000,
        },
      ],
    } satisfies ObjectiveEventsResponse;

    expect(detail.tasks[0]?.objective_id).toBe("objective-1");
    expect(events.events[0]?.eventType).toBe("owner_wake_requested");
  });
});
