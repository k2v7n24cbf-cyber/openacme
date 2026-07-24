import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVITY_WINDOW,
  taskInActivityWindow,
  taskLastActivityMs,
  type ActivityWindow,
} from "@/app/tasks/activity-filter";
import type { Task } from "@/app/tasks/types";

const baseTask = (patch: Partial<Task> & Pick<Task, "id" | "title">): Task => ({
  id: patch.id,
  title: patch.title,
  status: patch.status ?? "done",
  assignee: patch.assignee ?? "agent",
  session_id: patch.session_id ?? null,
  created_by: patch.created_by ?? "system:user",
  created_in_session_id: patch.created_in_session_id ?? null,
  parent_id: patch.parent_id ?? null,
  depends_on: patch.depends_on ?? [],
  start_at: patch.start_at ?? null,
  due_at: patch.due_at ?? null,
  created_at: patch.created_at ?? "2026-07-23T12:00:00.000Z",
  updated_at: patch.updated_at ?? "2026-07-23T12:00:00.000Z",
  closed_at: patch.closed_at ?? null,
  recurrence: patch.recurrence ?? null,
  runs: patch.runs ?? 0,
  last_run_at: patch.last_run_at ?? null,
  team: patch.team ?? null,
  body: patch.body,
  comment_count: patch.comment_count,
  last_activity_at: patch.last_activity_at,
});

describe("task activity filter", () => {
  it("uses last_activity_at when the list response provides it", () => {
    const task = baseTask({
      id: "1",
      title: "recently commented",
      updated_at: "2026-07-23T10:00:00.000Z",
      last_activity_at: Date.parse("2026-07-23T12:15:00.000Z") / 1000,
    });

    expect(taskLastActivityMs(task)).toBe(
      Date.parse("2026-07-23T12:15:00.000Z"),
    );
  });

  it("filters relative and custom activity windows", () => {
    const now = new Date("2026-07-23T12:30:00.000Z");
    const recent = baseTask({
      id: "1",
      title: "recent",
      updated_at: "2026-07-23T12:10:00.000Z",
    });
    const old = baseTask({
      id: "2",
      title: "old",
      updated_at: "2026-07-23T11:40:00.000Z",
    });
    const custom: ActivityWindow = {
      preset: "custom",
      from: "2026-07-23T11:35:00.000Z",
      to: "2026-07-23T11:45:00.000Z",
    };

    expect(taskInActivityWindow(recent, { ...EMPTY_ACTIVITY_WINDOW })).toBe(
      true,
    );
    expect(
      taskInActivityWindow(
        recent,
        { preset: "30m", from: null, to: null },
        now,
      ),
    ).toBe(true);
    expect(
      taskInActivityWindow(old, { preset: "30m", from: null, to: null }, now),
    ).toBe(false);
    expect(taskInActivityWindow(old, custom, now)).toBe(true);
  });
});
