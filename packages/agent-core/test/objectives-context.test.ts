import { describe, expect, it } from "vitest";
import { renderObjectivesForPrompt } from "../src/objectives-context.js";

type ObjectiveFixture =
  Parameters<typeof renderObjectivesForPrompt>[0]["objectives"][number];
type TaskFixture =
  Parameters<typeof renderObjectivesForPrompt>[0]["tasks"][number];

const objective = (
  id: string,
  over: Partial<ObjectiveFixture> = {},
): ObjectiveFixture => ({
  id,
  title: `Objective ${id}`,
  description: "description body should not render",
  status: "active",
  ownerAgentId: "a1",
  ownerSessionId: "s1",
  createdBy: "a1",
  createdInSessionId: "s1",
  closeoutPrompt: "review before close",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
  completionSummary: null,
  lastCloseoutFingerprint: null,
  lastCloseoutBriefJson: null,
  lastCloseoutBriefAt: null,
  ...over,
});

const task = (
  id: string,
  objectiveId: string | null,
  over: Partial<TaskFixture> = {},
): TaskFixture => ({
  id,
  title: `Task ${id}`,
  body: "task body should not render",
  status: "open",
  assignee: "a1",
  created_by: "a1",
  session_id: "s1",
  objective_id: objectiveId,
  created_at: "2026-08-11T00:00:00.000Z",
  updated_at: "2026-08-11T00:00:00.000Z",
  closed_at: null,
  depends_on: [],
  tags: [],
  parent_id: null,
  due_at: null,
  start_at: null,
  blocked_reason: null,
  result: null,
  team: null,
  recurrence: null,
  recurrence_key: null,
  runs: 0,
  last_run_at: null,
  ...over,
});

describe("renderObjectivesForPrompt", () => {
  it("renders only relevant compact objective state", () => {
    const rendered = renderObjectivesForPrompt({
      agentId: "a1",
      currentSessionId: "s1",
      objectives: [
        objective("owned", {
          lastCloseoutFingerprint: "fingerprint-1",
          lastCloseoutBriefJson: '{"secret":"brief body"}',
        }),
        objective("linked", {
          ownerAgentId: "other",
          ownerSessionId: "other-session",
          createdBy: "other",
          createdInSessionId: "other-session",
        }),
        objective("irrelevant", {
          ownerAgentId: "other",
          ownerSessionId: "other-session",
          createdBy: "other",
          createdInSessionId: "other-session",
        }),
      ],
      tasks: [
        task("1", "owned", { status: "done" }),
        task("2", "owned", { status: "open" }),
        task("3", "linked", { session_id: "s1", status: "canceled" }),
        task("4", "irrelevant", { session_id: "other-session" }),
      ],
    });

    expect(rendered).toContain("[owned]");
    expect(rendered).toContain("linked tasks 2");
    expect(rendered).toContain("terminal 1");
    expect(rendered).toContain("closeout fingerprint yes");
    expect(rendered).toContain("[linked]");
    expect(rendered).not.toContain("[irrelevant]");
    expect(rendered).not.toContain("description body should not render");
    expect(rendered).not.toContain("task body should not render");
    expect(rendered).not.toContain("brief body");
    expect(rendered).toContain(
      "Call objective_view, objective_list, task_list, and task_comments for fresh state",
    );
  });

  it("bounds large objective sets with a truncation note", () => {
    const rendered = renderObjectivesForPrompt({
      agentId: "a1",
      currentSessionId: "s1",
      limit: 2,
      objectives: [objective("1"), objective("2"), objective("3")],
      tasks: [],
    });

    expect(rendered).toContain("[1]");
    expect(rendered).toContain("[2]");
    expect(rendered).not.toContain("[3]");
    expect(rendered).toContain("1 more relevant objective not shown");
  });
});
