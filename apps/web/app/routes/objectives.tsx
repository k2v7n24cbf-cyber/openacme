import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ArrowUpRight, Search, Target, X } from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { API_BASE } from "../lib/api";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import { AgentRef } from "@/app/components/ui/agent-ref";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { cn } from "@/app/lib/utils";
import {
  type ObjectiveDetailResponse,
  type ObjectiveListItem,
} from "@/app/objectives/types";
import {
  OBJECTIVE_STATUS_LABEL,
  filterObjectives,
  objectiveProgressLabel,
  objectiveStatusVariant,
  sortObjectives,
} from "@/app/objectives/view-model";
import {
  STATUS_LABEL,
  STATUS_VARIANT,
  formatDate,
  formatRelativeFromIso,
  type Task,
} from "@/app/tasks/types";

export const Route = createFileRoute("/objectives")({
  validateSearch: z.object({
    id: z.coerce.string().optional(),
  }),
  component: ObjectivesPage,
});

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function ObjectivesPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const selectedId = search.id ?? null;
  const [objectives, setObjectives] = useState<ObjectiveListItem[]>([]);
  const [detail, setDetail] = useState<ObjectiveDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState("");

  const ordered = useMemo(() => sortObjectives(objectives), [objectives]);
  const visible = useMemo(
    () => filterObjectives(ordered, query),
    [ordered, query],
  );
  const selectedSummary =
    selectedId === null
      ? null
      : objectives.find((objective) => objective.id === selectedId) ?? null;
  const selectedObjective = detail?.objective ?? selectedSummary;

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/objectives",
        entityType: "objective" as const,
        entityId: selectedId,
        content: detail ?? selectedSummary,
      }),
      [detail, selectedId, selectedSummary],
    ),
  );

  useEffect(() => {
    const ctrl = new AbortController();
    async function loadObjectives() {
      try {
        setLoading(true);
        const res = await fetch(apiUrl("/api/objectives?limit=200"), {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { objectives: ObjectiveListItem[] };
        setObjectives(json.objectives);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        toast.error("Failed to load objectives");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }
    void loadObjectives();
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const id = selectedId;
    const ctrl = new AbortController();
    async function loadDetail() {
      try {
        setDetailLoading(true);
        const res = await fetch(
          apiUrl(`/api/objectives/${encodeURIComponent(id)}`),
          { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDetail((await res.json()) as ObjectiveDetailResponse);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setDetail(null);
        toast.error("Failed to load objective");
      } finally {
        if (!ctrl.signal.aborted) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => ctrl.abort();
  }, [selectedId]);

  const pickObjective = (id: string) => {
    void navigate({ to: "/objectives", search: { id } });
  };

  const clearSelection = () => {
    void navigate({ to: "/objectives", search: {} });
  };

  return (
    <div className="flex min-h-dvh bg-paper pb-mobile-tabbar text-ink md:pb-0">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-paper-rule bg-paper px-4 py-3">
          <SectionEyebrow>Objectives</SectionEyebrow>
          <div className="relative min-w-[12rem] flex-1 md:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search objective, owner, status"
              className="h-7 pl-8 pr-7 text-[13px]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 font-mono text-[11px] tabular-nums text-ink-faint">
            <TabularTick value={visible.length} />
            <span>/</span>
            <TabularTick value={objectives.length} />
          </div>
        </header>

        {loading ? (
          <div className="relative flex flex-1 items-end px-6 py-12 section-enter">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Reading objectives
            </span>
            <LoadingHairline />
          </div>
        ) : objectives.length === 0 ? (
          <EmptyObjectives />
        ) : visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <Search className="size-5 text-ink-faint/70" aria-hidden />
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              No objectives match
            </span>
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            <aside
              className={cn(
                "flex shrink-0 flex-col overflow-y-auto border-paper-rule md:w-[28rem] md:border-r",
                selectedObjective ? "hidden md:flex" : "flex w-full md:w-[28rem]",
              )}
            >
              {visible.map((objective) => (
                <ObjectiveRow
                  key={objective.id}
                  objective={objective}
                  active={selectedId === objective.id}
                  onPick={() => pickObjective(objective.id)}
                />
              ))}
            </aside>

            <section
              className={cn(
                "flex min-w-0 flex-1 flex-col overflow-hidden",
                !selectedObjective ? "hidden md:flex" : "flex",
              )}
            >
              {selectedObjective ? (
                <ObjectiveDetail
                  objective={selectedObjective}
                  rollup={detail?.rollup ?? selectedSummary?.rollup ?? null}
                  tasks={detail?.tasks ?? []}
                  loading={detailLoading}
                  onClose={clearSelection}
                />
              ) : (
                <div className="flex flex-1 items-start justify-center px-6 pt-24">
                  <div className="max-w-sm">
                    <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                      No selection
                    </div>
                    <h3 className="mt-2 text-base font-semibold text-ink">
                      Pick an objective
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                      Objectives group tasks and wake the owner when linked
                      work is terminal. This surface is read-only.
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function ObjectiveRow({
  objective,
  active,
  onPick,
}: {
  objective: ObjectiveListItem;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "relative flex w-full flex-col items-start gap-1 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors last:border-b-0",
        active
          ? "bg-paper-sunk text-ink"
          : "text-ink-soft hover:bg-paper-sunk hover:text-ink",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <Badge
          variant={objectiveStatusVariant(objective.status)}
          className="shrink-0"
        >
          {OBJECTIVE_STATUS_LABEL[objective.status]}
        </Badge>
        <span className="truncate text-sm font-medium text-ink">
          {objective.title}
        </span>
      </div>
      <div className="flex w-full flex-wrap gap-x-3 font-mono text-[11px] tabular-nums text-ink-faint">
        <span title={objective.id}>#{shortId(objective.id)}</span>
        <AgentRef id={objective.ownerAgentId} />
        <span>{objectiveProgressLabel(objective)} terminal</span>
        <span title={formatDate(objective.updatedAt)}>
          {formatRelativeFromIso(objective.updatedAt)}
        </span>
      </div>
    </button>
  );
}

function ObjectiveDetail({
  objective,
  rollup,
  tasks,
  loading,
  onClose,
}: {
  objective: ObjectiveListItem | ObjectiveDetailResponse["objective"];
  rollup: ObjectiveDetailResponse["rollup"] | null;
  tasks: Task[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-5">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex items-center justify-between gap-3 border-b border-paper-rule pb-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Objective
            </span>
            <span
              title={objective.id}
              className="font-mono text-[12px] tabular-nums text-ink-soft"
            >
              #{shortId(objective.id)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-ink-soft transition-colors hover:text-plot-red focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red md:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-5 py-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={objectiveStatusVariant(objective.status)}>
                {OBJECTIVE_STATUS_LABEL[objective.status]}
              </Badge>
              {rollup && (
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                  {rollup.terminal_task_count}/{rollup.linked_task_count} terminal
                </span>
              )}
            </div>
            <h1 className="text-2xl font-semibold leading-tight text-ink">
              {objective.title}
            </h1>
            {objective.description && (
              <p className="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                {objective.description}
              </p>
            )}
          </div>

          <div className="grid gap-x-6 gap-y-2 border-y border-paper-rule py-3 font-mono text-[12px] tabular-nums md:grid-cols-[auto_1fr_auto_1fr]">
            <Meta label="Owner">
              <AgentRef id={objective.ownerAgentId} />
            </Meta>
            <Meta label="Session">
              {objective.ownerSessionId ? (
                <span title={objective.ownerSessionId}>
                  {shortId(objective.ownerSessionId)}
                </span>
              ) : (
                <span className="text-ink-faint">None</span>
              )}
            </Meta>
            <Meta label="Created">
              <span title={formatDate(objective.createdAt)}>
                {formatRelativeFromIso(objective.createdAt)}
              </span>
            </Meta>
            <Meta label="Updated">
              <span title={formatDate(objective.updatedAt)}>
                {formatRelativeFromIso(objective.updatedAt)}
              </span>
            </Meta>
            {objective.closeoutPrompt && (
              <>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Closeout
                </span>
                <span className="min-w-0 text-ink-soft md:col-span-3">
                  {objective.closeoutPrompt}
                </span>
              </>
            )}
          </div>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <SectionEyebrow>Linked Tasks</SectionEyebrow>
              {rollup && (
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                  {rollup.linked_task_count}
                </span>
              )}
            </div>
            {loading ? (
              <div className="relative flex min-h-24 items-end border border-paper-rule px-4 py-3">
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  Reading linked tasks
                </span>
                <LoadingHairline />
              </div>
            ) : tasks.length === 0 ? (
              <div className="border border-paper-rule px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                No linked tasks
              </div>
            ) : (
              <div className="border border-paper-rule">
                {tasks.map((task) => (
                  <ObjectiveTaskRow key={task.id} task={task} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </span>
      <span className="min-w-0 text-ink-soft">{children}</span>
    </>
  );
}

function ObjectiveTaskRow({ task }: { task: Task }) {
  return (
    <Link
      to="/tasks"
      search={{ id: task.id }}
      className="flex items-center gap-3 border-b border-paper-rule/40 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-paper-sunk"
    >
      <Badge variant={STATUS_VARIANT[task.status]} className="shrink-0">
        {STATUS_LABEL[task.status]}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
        {task.title}
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
        #{task.id}
      </span>
      <ArrowUpRight className="size-3.5 shrink-0 text-ink-faint" />
    </Link>
  );
}

function EmptyObjectives() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
      <Target className="size-6 text-ink-faint/70" aria-hidden />
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
        No objectives
      </span>
    </div>
  );
}
