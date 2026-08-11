import { describe, expect, it } from "vitest";
import type { ObjectiveListItem } from "@/app/objectives/types";
import {
  OBJECTIVE_STATUS_LABEL,
  filterObjectives,
  objectiveProgressLabel,
  objectiveStatusVariant,
  sortObjectives,
} from "@/app/objectives/view-model";

function objective(
  over: Partial<ObjectiveListItem> & Pick<ObjectiveListItem, "id" | "title">,
): ObjectiveListItem {
  return {
    id: over.id,
    title: over.title,
    description: over.description ?? "",
    status: over.status ?? "active",
    ownerAgentId: over.ownerAgentId ?? "agent-1",
    ownerSessionId: over.ownerSessionId ?? null,
    createdBy: over.createdBy ?? "agent-1",
    createdInSessionId: over.createdInSessionId ?? null,
    closeoutPrompt: over.closeoutPrompt ?? "",
    createdAt: over.createdAt ?? "2026-08-11T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-08-11T00:00:00.000Z",
    completedAt: over.completedAt ?? null,
    completionSummary: over.completionSummary ?? null,
    lastCloseoutFingerprint: over.lastCloseoutFingerprint ?? null,
    lastCloseoutBriefJson: over.lastCloseoutBriefJson ?? null,
    lastCloseoutBriefAt: over.lastCloseoutBriefAt ?? null,
    rollup: over.rollup ?? {
      linked_task_count: 0,
      terminal_task_count: 0,
      nonterminal_task_count: 0,
    },
  };
}

describe("objective read view model", () => {
  it("labels every objective status and maps it to a badge variant", () => {
    expect(OBJECTIVE_STATUS_LABEL.ready_for_closeout).toBe(
      "Ready for closeout",
    );
    expect(objectiveStatusVariant("ready_for_closeout")).toBe("working");
    expect(objectiveStatusVariant("failed")).toBe("destructive");
  });

  it("sorts objectives by latest update first", () => {
    expect(
      sortObjectives([
        objective({
          id: "old",
          title: "Old",
          updatedAt: "2026-08-10T00:00:00.000Z",
        }),
        objective({
          id: "new",
          title: "New",
          updatedAt: "2026-08-11T00:00:00.000Z",
        }),
      ]).map((item) => item.id),
    ).toEqual(["new", "old"]);
  });

  it("filters by id, title, description, owner, session, or status", () => {
    const objectives = [
      objective({
        id: "objective-1",
        title: "Ship UI",
        description: "Read surface",
        ownerAgentId: "agent-ui",
        ownerSessionId: "session-1",
        status: "active",
      }),
      objective({
        id: "objective-2",
        title: "Backend",
        description: "Closeout service",
        ownerAgentId: "agent-server",
        status: "completed",
      }),
    ];

    expect(filterObjectives(objectives, "server").map((item) => item.id)).toEqual([
      "objective-2",
    ]);
    expect(filterObjectives(objectives, "session-1").map((item) => item.id)).toEqual([
      "objective-1",
    ]);
  });

  it("formats terminal progress without creating completion semantics", () => {
    expect(
      objectiveProgressLabel(
        objective({
          id: "objective-1",
          title: "Closeout",
          rollup: {
            linked_task_count: 3,
            terminal_task_count: 2,
            nonterminal_task_count: 1,
          },
        }),
      ),
    ).toBe("2/3");
  });
});
