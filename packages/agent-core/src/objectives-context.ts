import type { ObjectiveRow } from "@openacme/db";
import type { Task } from "@openacme/tasks";

const DEFAULT_OBJECTIVES_PROMPT_LIMIT = 12;
const TERMINAL_TASK_STATUSES = new Set(["done", "canceled"]);

export interface RenderObjectivesForPromptInput {
  agentId: string;
  currentSessionId: string;
  objectives: ReadonlyArray<ObjectiveRow>;
  tasks: ReadonlyArray<Task>;
  limit?: number;
}

export function renderObjectivesForPrompt(
  input: RenderObjectivesForPromptInput,
): string {
  const limit = Math.max(1, input.limit ?? DEFAULT_OBJECTIVES_PROMPT_LIMIT);
  const objectiveIdsLinkedToThisSession = new Set(
    input.tasks
      .filter((task) => task.session_id === input.currentSessionId)
      .map((task) => task.objective_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const tasksByObjective = new Map<string, Task[]>();
  for (const task of input.tasks) {
    if (!task.objective_id) continue;
    const list = tasksByObjective.get(task.objective_id) ?? [];
    list.push(task);
    tasksByObjective.set(task.objective_id, list);
  }

  const relevant = input.objectives.filter(
    (objective) =>
      objective.ownerAgentId === input.agentId ||
      objective.createdInSessionId === input.currentSessionId ||
      objectiveIdsLinkedToThisSession.has(objective.id),
  );
  if (relevant.length === 0) return "";

  const rendered = relevant.slice(0, limit).map((objective) => {
    const linkedTasks = tasksByObjective.get(objective.id) ?? [];
    const terminal = linkedTasks.filter((task) =>
      TERMINAL_TASK_STATUSES.has(task.status),
    ).length;
    const nonterminal = linkedTasks.length - terminal;
    const ownerSession = objective.ownerSessionId ?? "none";
    const closeoutPrompt = objective.closeoutPrompt.trim()
      ? ` · closeout prompt "${excerpt(objective.closeoutPrompt, 120)}"`
      : "";
    return (
      `- [${objective.id}] ${excerpt(objective.title, 100)} · status ${objective.status}` +
      ` · owner_agent_id ${objective.ownerAgentId} · owner_session_id ${ownerSession}` +
      ` · linked tasks ${linkedTasks.length}, terminal ${terminal}, nonterminal ${nonterminal}` +
      ` · closeout fingerprint ${objective.lastCloseoutFingerprint ? "yes" : "no"}` +
      closeoutPrompt
    );
  });

  const remaining = relevant.length - rendered.length;
  if (remaining > 0) {
    rendered.push(
      `> ${remaining} more relevant objective${remaining === 1 ? "" : "s"} not shown (bounded snapshot).`,
    );
  }
  rendered.push(
    "NOTE: snapshot from session start and may be stale. Call objective_view, objective_list, task_list, and task_comments for fresh state before closeout decisions.",
  );
  return rendered.join("\n");
}

function excerpt(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
