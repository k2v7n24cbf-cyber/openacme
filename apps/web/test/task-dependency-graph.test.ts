import { describe, expect, it } from "vitest";
import {
  buildTaskDependencyGraph,
  buildTaskDependencyFlows,
  taskHasUnmetDependencies,
} from "@/app/tasks/dependency-graph";
import type { Task } from "@/app/tasks/types";

const baseTask = (patch: Partial<Task> & Pick<Task, "id" | "title">): Task => ({
  id: patch.id,
  title: patch.title,
  status: patch.status ?? "open",
  assignee: patch.assignee ?? "agent",
  session_id: patch.session_id ?? null,
  objective_id: patch.objective_id ?? null,
  created_by: patch.created_by ?? "system:user",
  created_in_session_id: patch.created_in_session_id ?? null,
  parent_id: patch.parent_id ?? null,
  depends_on: patch.depends_on ?? [],
  start_at: patch.start_at ?? null,
  due_at: patch.due_at ?? null,
  created_at: patch.created_at ?? "2026-07-23T00:00:00.000Z",
  updated_at: patch.updated_at ?? "2026-07-23T00:00:00.000Z",
  closed_at: patch.closed_at ?? null,
  recurrence: patch.recurrence ?? null,
  runs: patch.runs ?? 0,
  last_run_at: patch.last_run_at ?? null,
  team: patch.team ?? null,
  body: patch.body,
  comment_count: patch.comment_count,
});

describe("task dependency graph", () => {
  it("builds dependency edges from prerequisite to dependent", () => {
    const research = baseTask({
      id: "1",
      title: "Research",
      status: "done",
    });
    const draft = baseTask({
      id: "2",
      title: "Draft",
      depends_on: ["1"],
    });

    const graph = buildTaskDependencyGraph([research, draft]);

    expect(graph.edges).toEqual([
      {
        id: "dep:1->2",
        source: "1",
        target: "2",
        satisfied: true,
        missingSource: false,
      },
    ]);
    expect(graph.nodes.find((n) => n.id === "1")?.dependentIds).toEqual(["2"]);
    expect(graph.nodes.find((n) => n.id === "2")?.dependsOnIds).toEqual(["1"]);
    expect(graph.nodes.find((n) => n.id === "2")?.unmetDepIds).toEqual([]);
  });

  it("marks open or missing dependencies as unmet", () => {
    const build = baseTask({
      id: "3",
      title: "Build",
      depends_on: ["1", "missing"],
    });
    const spec = baseTask({ id: "1", title: "Spec", status: "open" });

    const graph = buildTaskDependencyGraph([build, spec]);
    const buildNode = graph.nodes.find((n) => n.id === "3");

    expect(buildNode?.unmetDepIds).toEqual(["1", "missing"]);
    expect(graph.nodes.find((n) => n.id === "missing")?.kind).toBe("missing");
    expect(graph.edges.find((e) => e.source === "missing")?.missingSource).toBe(
      true,
    );
    expect(taskHasUnmetDependencies(build, new Map([["1", spec]]))).toBe(true);
  });

  it("groups independent flows and standalone tasks separately", () => {
    const spec = baseTask({ id: "1", title: "Spec", status: "done" });
    const build = baseTask({
      id: "2",
      title: "Build",
      status: "blocked",
      depends_on: ["1"],
    });
    const release = baseTask({
      id: "3",
      title: "Release",
      status: "blocked",
      depends_on: ["2"],
    });
    const design = baseTask({ id: "4", title: "Design", status: "done" });
    const review = baseTask({
      id: "5",
      title: "Review",
      status: "open",
      depends_on: ["4"],
    });
    const inbox = baseTask({ id: "6", title: "Inbox triage" });
    const docs = baseTask({ id: "7", title: "Docs cleanup" });

    const graph = buildTaskDependencyGraph([
      spec,
      build,
      release,
      design,
      review,
      inbox,
      docs,
    ]);
    const groups = buildTaskDependencyFlows(graph);

    const flowGroups = groups.filter((group) => group.kind === "flow");
    expect(flowGroups.map((group) => group.taskIds)).toEqual([
      ["1", "2", "3"],
      ["4", "5"],
    ]);
    expect(flowGroups.map((group) => group.gatedCount)).toEqual([1, 0]);

    const standalone = groups.find((group) => group.kind === "standalone");
    expect(standalone?.taskIds).toEqual(["6", "7"]);
    expect(standalone?.edgeCount).toBe(0);
  });

  it("groups dependency-free tasks created by the same session", () => {
    const a = baseTask({
      id: "10",
      title: "Shard A",
      created_in_session_id: "session-1",
    });
    const b = baseTask({
      id: "11",
      title: "Shard B",
      created_in_session_id: "session-1",
    });
    const c = baseTask({
      id: "12",
      title: "Unrelated",
      created_in_session_id: "session-2",
    });

    const graph = buildTaskDependencyGraph([a, b, c]);
    const groups = buildTaskDependencyFlows(graph);

    const session = groups.find((group) => group.kind === "session");
    expect(session?.taskIds).toEqual(["10", "11"]);
    expect(session?.createdInSessionIds).toEqual(["session-1"]);

    const standalone = groups.find((group) => group.kind === "standalone");
    expect(standalone?.taskIds).toEqual(["12"]);
  });

  it("groups tasks from the same creation session before dependency components", () => {
    const prep = baseTask({
      id: "20",
      title: "Prep",
      status: "done",
      created_in_session_id: "coordinator",
    });
    const shard = baseTask({
      id: "21",
      title: "Shard",
      depends_on: ["20"],
      created_in_session_id: "coordinator",
    });
    const independent = baseTask({
      id: "22",
      title: "Independent shard",
      created_in_session_id: "coordinator",
    });
    const unrelated = baseTask({
      id: "30",
      title: "Unrelated",
      depends_on: ["31"],
    });
    const unrelatedDep = baseTask({
      id: "31",
      title: "Unrelated dep",
      status: "done",
    });

    const graph = buildTaskDependencyGraph([
      prep,
      shard,
      independent,
      unrelated,
      unrelatedDep,
    ]);
    const groups = buildTaskDependencyFlows(graph);

    const session = groups.find((group) => group.kind === "session");
    expect(session?.taskIds).toEqual(["20", "21", "22"]);
    expect(session?.edgeCount).toBe(1);
    expect(session?.createdInSessionIds).toEqual(["coordinator"]);

    const flowGroups = groups.filter((group) => group.kind === "flow");
    expect(flowGroups.map((group) => group.taskIds)).toEqual([["30", "31"]]);
  });
});
