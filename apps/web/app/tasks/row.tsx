import { Repeat2 } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { ActiveMarker } from "@/app/components/ui/active-marker";
import { AgentRef } from "@/app/components/ui/agent-ref";
import { cn } from "@/app/lib/utils";
import {
  STATUS_LABEL,
  STATUS_VARIANT,
  dueUrgencyClass,
  formatDate,
  formatRelativeFromIso,
  recurrenceTitle,
  type Task,
} from "./types";

export function TaskListRow({
  task,
  isActive,
  onPick,
}: {
  task: Task;
  isActive: boolean;
  onPick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col items-start gap-1 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors last:border-b-0",
        isActive
          ? "bg-paper-sunk text-ink"
          : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
      )}
    >
      <ActiveMarker active={isActive} />
      <div className="flex w-full items-center gap-2">
        <Badge variant={STATUS_VARIANT[task.status]} className="shrink-0">
          {STATUS_LABEL[task.status]}
        </Badge>
        <span className="truncate text-sm font-medium text-ink">
          {task.title}
        </span>
      </div>
      {/* Same glanceable meta set as board cards — who, urgency,
          why-not-running. The rest lives in the detail pane. */}
      <div className="flex w-full flex-wrap gap-x-3 font-mono text-[11px] tabular-nums text-ink-faint">
        <span>#{task.id}</span>
        <AgentRef id={task.assignee} />
        {task.team && <span>{task.team}</span>}
        {task.due_at && (
          <span
            className={dueUrgencyClass(task.due_at)}
            title={formatDate(task.due_at)}
          >
            due {formatRelativeFromIso(task.due_at)}
          </span>
        )}
        {task.start_at && new Date(task.start_at).getTime() > Date.now() && (
          <span className="text-signal-blue" title={formatDate(task.start_at)}>
            starts {formatRelativeFromIso(task.start_at)}
          </span>
        )}
        {task.status === "blocked" && task.depends_on.length > 0 && (
          <span>
            {task.depends_on.length} dep
            {task.depends_on.length === 1 ? "" : "s"}
          </span>
        )}
        {/* Marker, not a schedule — same treatment as board cards. */}
        {task.recurrence && (
          <span
            title={
              task.runs > 0
                ? `${recurrenceTitle(task.recurrence)} · ${task.runs} runs`
                : recurrenceTitle(task.recurrence)
            }
          >
            <Repeat2 className="size-3" />
          </span>
        )}
      </div>
    </div>
  );
}
