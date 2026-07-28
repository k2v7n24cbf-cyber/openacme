import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { API_BASE } from "../lib/api";
import { Button } from "@/app/components/ui/button";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { TaskListRow } from "../tasks/row";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  type Task,
  type TaskStatus,
} from "../tasks/types";

export interface TeamTasks {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  /** Open + in_progress + blocked + system_blocked — what the tab count shows. */
  activeCount: number;
  retry: () => void;
}

/** Lives in the route shell (not the tab) so the count survives tab
 *  switches and the list doesn't refetch on every tab change. */
export function useTeamTasks(teamId: string | null): TeamTasks {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!teamId) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        setLoading(true);
        setError(null);
        setTasks([]);
        const res = await fetch(
          `${API_BASE}/api/tasks?team=${encodeURIComponent(teamId)}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { tasks: Task[] };
        setTasks(json.tasks);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [teamId, reloadKey]);

  const activeCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.status === "open" ||
          t.status === "in_progress" ||
          t.status === "blocked" ||
          t.status === "system_blocked"
      ).length,
    [tasks]
  );

  return {
    tasks,
    loading,
    error,
    activeCount,
    retry: () => setReloadKey((k) => k + 1),
  };
}

export function TeamTasksTab({ data }: { data: TeamTasks }) {
  const navigate = useNavigate();
  const { tasks, loading, error, retry } = data;

  const grouped = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const t of tasks) {
      const list = m.get(t.status) ?? [];
      list.push(t);
      m.set(t.status, list);
    }
    return m;
  }, [tasks]);

  if (loading) {
    return (
      <div className="relative flex items-center gap-2 px-1 py-6">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          Reading task store
        </span>
        <LoadingHairline inline />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 border border-dashed border-paper-rule px-4 py-5">
        <p className="text-sm text-ink-faint">Failed to load tasks: {error}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="border border-dashed border-paper-rule px-4 py-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          No tasks tagged to this team
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          Agents tag tasks with <code className="font-mono">team</code> when
          filing work that belongs here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col border border-paper-rule">
      {STATUS_ORDER.map((status) => {
        const items = grouped.get(status) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={status}>
            <div className="flex items-center justify-between border-b border-paper-rule px-4 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              <span>{STATUS_LABEL[status]}</span>
              <TabularTick value={items.length} />
            </div>
            <div className="flex flex-col">
              {items.map((t) => (
                <TaskListRow
                  key={t.id}
                  task={t}
                  isActive={false}
                  onPick={() =>
                    void navigate({ to: "/tasks", search: { id: t.id } })
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
