import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  Download,
  ListRestart,
  ListFilter,
  Loader2,
  RefreshCw,
  ScrollText,
  XCircle,
} from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import { Sidebar } from "@/app/components/Sidebar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { API_BASE } from "@/app/lib/api";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import { cn } from "@/app/lib/utils";

const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
] as const;
const EVENT_LEVELS = ["all", "debug", "info", "error", "system"] as const;
const RUN_HISTORY_PAGE_SIZE = 25;
const RUN_DETAIL_AUTO_REFRESH_MS = 1000;

type RunStatus = (typeof RUN_STATUSES)[number];
type RunMode = "test" | "live";
type EventLevelFilter = (typeof EVENT_LEVELS)[number];
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const Route = createFileRoute("/workflow-runs")({
  validateSearch: z.object({
    workflowId: z.coerce.string().optional(),
    mode: z.enum(["all", "test", "live"]).optional(),
    status: z
      .enum([
        "all",
        "queued",
        "running",
        "waiting",
        "succeeded",
        "failed",
        "canceled",
      ])
      .optional(),
    triggerId: z.coerce.string().optional(),
    createdFrom: z.coerce.string().optional(),
    createdTo: z.coerce.string().optional(),
    run: z.coerce.string().optional(),
  }),
  component: WorkflowRunsPage,
});

interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  version: number;
  status: string;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  definitionSource: "draft" | "published";
  mode: RunMode;
  trigger: JsonValue;
  status: RunStatus;
  input: JsonValue;
  context: JsonValue;
  currentNodeId: string | null;
  waitingReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

interface WorkflowStepAttempt {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: RunStatus | "skipped";
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  logsSummary?: JsonValue;
  contextDiff?: JsonValue;
}

interface WorkflowRunEvent {
  id: string;
  runId: string;
  stepRunId: string | null;
  sequence: number;
  level: "debug" | "info" | "error" | "system";
  kind: string;
  message?: string;
  payload?: JsonValue;
  createdAt: string;
}

interface RunDetail {
  run: WorkflowRun;
  steps: WorkflowStepAttempt[];
  events: WorkflowRunEvent[];
}

interface WorkflowArtifactReference {
  id: string;
  kind: string;
  path: string;
  preview?: string | null;
  byteLength?: number;
}

interface WorkflowArtifactContent {
  content: JsonValue;
}

interface RunListPage {
  runs: WorkflowRun[];
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

function WorkflowRunsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflow-runs" });
  const [workflows, setWorkflows] = useState<WorkflowDefinitionSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [nextRunOffset, setNextRunOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [eventLevel, setEventLevel] = useState<EventLevelFilter>("all");
  const suppressedRunSearchReload = useRef<string | null>(null);

  const mode = search.mode ?? "all";
  const status = search.status ?? "all";
  const workflowId = search.workflowId ?? "all";
  const triggerId = search.triggerId ?? "";
  const createdFrom = search.createdFrom ?? "";
  const createdTo = search.createdTo ?? "";
  const selectedStep =
    detail?.steps.find((step) => step.id === selectedStepId) ??
    detail?.steps[0] ??
    null;
  const filteredEvents =
    detail?.events.filter(
      (event) => eventLevel === "all" || event.level === eventLevel,
    ) ?? [];

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/workflow-runs",
        entityType: "workflowRun" as const,
        entityId: detail?.run.id ?? null,
        content: detail,
      }),
      [detail],
    ),
  );

  useEffect(() => {
    void loadWorkflows();
  }, []);

  useEffect(() => {
    const searchKey = globalRunSearchKey({
      workflowId,
      mode,
      status,
      triggerId,
      createdFrom,
      createdTo,
      run: search.run,
    });
    if (suppressedRunSearchReload.current === searchKey) {
      suppressedRunSearchReload.current = null;
      return;
    }
    void loadRuns(search.run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, status, workflowId, triggerId, createdFrom, createdTo, search.run]);

  useEffect(() => {
    if (!detail || isTerminalRunStatus(detail.run.status)) return;
    const runId = detail.run.id;
    const timer = window.setInterval(() => {
      void loadRunDetail(runId);
    }, RUN_DETAIL_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.run.id, detail?.run.status]);

  async function loadWorkflows() {
    try {
      const data = await api<{ workflows: WorkflowDefinitionSummary[] }>(
        "/api/workflows",
      );
      setWorkflows(data.workflows);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function loadRuns(preferredRunId?: string) {
    setLoading(true);
    try {
      const data = await api<RunListPage>(runListPath(0));
      setRuns(data.runs);
      setHasMoreRuns(data.hasMore);
      setNextRunOffset(data.nextOffset);
      const runId = preferredRunId ?? data.runs[0]?.id;
      if (runId) {
        const loaded = await loadRunDetail(runId);
        if (loaded) return;
      }
      setDetail(null);
      setSelectedStepId(null);
      void navigate({
        search: currentSearch({ run: undefined }),
        replace: true,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreRuns() {
    if (nextRunOffset === null) return;
    setLoadingMore(true);
    try {
      const data = await api<RunListPage>(runListPath(nextRunOffset));
      setRuns((current) => {
        const seen = new Set(current.map((run) => run.id));
        return [
          ...current,
          ...data.runs.filter((run) => {
            if (seen.has(run.id)) return false;
            seen.add(run.id);
            return true;
          }),
        ];
      });
      setHasMoreRuns(data.hasMore);
      setNextRunOffset(data.nextOffset);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function loadRunDetail(runId: string): Promise<boolean> {
    try {
      const data = await api<RunDetail>(
        `/api/workflow-runs/${encodeURIComponent(runId)}`,
      );
      setDetail(data);
      setRuns((current) =>
        reconcileRunInLoadedList(current, data.run, {
          workflowId,
          mode,
          status,
          triggerId,
          createdFrom,
          createdTo,
        }),
      );
      setSelectedStepId((current) => retainedStepId(data.steps, current));
      void navigate({
        search: currentSearch({ run: data.run.id }),
        replace: true,
      });
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  async function cancelRun() {
    if (!detail) return;
    setBusy("cancel");
    try {
      const data = await api<RunDetail>(
        `/api/workflow-runs/${encodeURIComponent(detail.run.id)}/cancel`,
        { method: "POST", body: {} },
      );
      toast.success("Run canceled");
      setDetail(data);
      setSelectedStepId((current) => retainedStepId(data.steps, current));
      setRuns((current) =>
        reconcileRunInLoadedList(current, data.run, {
          workflowId,
          mode,
          status,
          triggerId,
          createdFrom,
          createdTo,
        }),
      );
      void navigate({
        search: currentSearch({ run: data.run.id }),
        replace: true,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function rerun() {
    if (!detail) return;
    setBusy("rerun");
    try {
      const data = await api<RunDetail>(
        `/api/workflow-runs/${encodeURIComponent(detail.run.id)}/rerun`,
        { method: "POST", body: {} },
      );
      toast.success("Run queued from prior input");
      setDetail(data);
      setSelectedStepId((current) => retainedStepId(data.steps, current));
      if (
        runMatchesFilters(data.run, {
          workflowId,
          mode,
          status,
          triggerId,
          createdFrom,
          createdTo,
        })
      ) {
        setRuns((current) => [
          data.run,
          ...current.filter((run) => run.id !== data.run.id),
        ]);
        suppressedRunSearchReload.current = globalRunSearchKey({
          workflowId,
          mode,
          status,
          triggerId,
          createdFrom,
          createdTo,
          run: data.run.id,
        });
        void navigate({
          search: currentSearch({ run: data.run.id }),
          replace: true,
        });
      } else {
        void navigate({
          search: currentSearch({
            workflowId: workflowId === "all" ? workflowId : data.run.workflowId,
            mode: mode === "all" ? mode : data.run.mode,
            status: status === "all" ? status : data.run.status,
            triggerId: "",
            createdFrom: "",
            createdTo: "",
            run: data.run.id,
          }),
          replace: true,
        });
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function currentSearch(
    patch: Partial<{
      workflowId: string | undefined;
      mode: "all" | RunMode | undefined;
      status: "all" | RunStatus | undefined;
      triggerId: string | undefined;
      createdFrom: string | undefined;
      createdTo: string | undefined;
      run: string | undefined;
    }>,
  ) {
    const nextWorkflowId = patch.workflowId ?? workflowId;
    const nextMode = patch.mode ?? mode;
    const nextStatus = patch.status ?? status;
    const nextTriggerId = patch.triggerId ?? triggerId;
    const nextCreatedFrom = patch.createdFrom ?? createdFrom;
    const nextCreatedTo = patch.createdTo ?? createdTo;
    return {
      workflowId: nextWorkflowId === "all" ? undefined : nextWorkflowId,
      mode: nextMode === "all" ? undefined : nextMode,
      status: nextStatus === "all" ? undefined : nextStatus,
      triggerId: nextTriggerId || undefined,
      createdFrom: nextCreatedFrom || undefined,
      createdTo: nextCreatedTo || undefined,
      run: patch.run === undefined ? undefined : patch.run,
    };
  }

  function runListPath(offset: number) {
    const params = new URLSearchParams();
    if (workflowId !== "all") params.set("workflowId", workflowId);
    if (mode !== "all") params.set("mode", mode);
    if (status !== "all") params.set("status", status);
    if (triggerId) params.set("triggerId", triggerId);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    params.set("limit", String(RUN_HISTORY_PAGE_SIZE));
    if (offset > 0) params.set("offset", String(offset));
    return `/api/workflow-runs?${params.toString()}`;
  }

  const workflowNames = new Map(workflows.map((item) => [item.id, item.name]));
  const canCancel = detail !== null && !isTerminalRunStatus(detail.run.status);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-paper text-ink">
        {loading && <LoadingHairline />}
        <header className="flex shrink-0 flex-col gap-3 border-b border-paper-rule px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <SectionEyebrow>Workflow Runs</SectionEyebrow>
            <h1 className="truncate text-lg font-semibold tracking-tight">
              Global run history
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              label="Workflow"
              value={workflowId}
              onValueChange={(value) =>
                void navigate({
                  search: currentSearch({ workflowId: value, run: undefined }),
                })
              }
              items={[
                { value: "all", label: "All workflows" },
                ...workflows.map((workflow) => ({
                  value: workflow.id,
                  label: workflow.name,
                })),
              ]}
            />
            <FilterSelect
              label="Mode"
              value={mode}
              onValueChange={(value) =>
                void navigate({
                  search: currentSearch({
                    mode: value as "all" | RunMode,
                    run: undefined,
                  }),
                })
              }
              items={[
                { value: "all", label: "All modes" },
                { value: "test", label: "Test" },
                { value: "live", label: "Live" },
              ]}
            />
            <FilterSelect
              label="Status"
              value={status}
              onValueChange={(value) =>
                void navigate({
                  search: currentSearch({
                    status: value as "all" | RunStatus,
                    run: undefined,
                  }),
                })
              }
              items={[
                { value: "all", label: "All statuses" },
                ...RUN_STATUSES.map((item) => ({
                  value: item,
                  label: item,
                })),
              ]}
            />
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Trigger
              </span>
              <Input
                aria-label="Trigger"
                value={triggerId}
                onChange={(event) =>
                  void navigate({
                    search: currentSearch({
                      triggerId: event.target.value,
                      run: undefined,
                    }),
                  })
                }
                placeholder="manual"
                className="h-8 w-36 font-mono text-xs"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Created from
              </span>
              <Input
                aria-label="Created from"
                type="date"
                value={createdFrom}
                onChange={(event) =>
                  void navigate({
                    search: currentSearch({
                      createdFrom: event.target.value,
                      run: undefined,
                    }),
                  })
                }
                className="h-8 w-36 font-mono text-xs"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Created to
              </span>
              <Input
                aria-label="Created to"
                type="date"
                value={createdTo}
                onChange={(event) =>
                  void navigate({
                    search: currentSearch({
                      createdTo: event.target.value,
                      run: undefined,
                    }),
                  })
                }
                className="h-8 w-36 font-mono text-xs"
              />
            </label>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[380px_minmax(520px,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-r border-paper-rule bg-paper-sunk/50">
            <div className="flex items-center justify-between border-b border-paper-rule px-3 py-2">
              <div className="flex items-center gap-2">
                <ListFilter className="size-4 text-ink-soft" />
                <SectionEyebrow>History</SectionEyebrow>
              </div>
              <span className="font-mono text-[11px] text-ink-faint">
                {hasMoreRuns ? `${runs.length}+` : runs.length}
              </span>
            </div>
            <div className="divide-y divide-paper-rule">
              {runs.map((run) => (
                <button
                  type="button"
                  key={run.id}
                  onClick={() => void loadRunDetail(run.id)}
                  className={cn(
                    "grid w-full gap-2 px-3 py-3 text-left hover:bg-paper",
                    detail?.run.id === run.id && "bg-paper",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    {statusIcon(run.status)}
                    <Badge variant={run.mode === "live" ? "signal" : "outline"}>
                      {run.mode}
                    </Badge>
                    <Badge variant={statusBadge(run.status)}>
                      {run.status}
                    </Badge>
                    <span className="ml-auto font-mono text-[10px] text-ink-faint">
                      {shortDate(run.createdAt)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {workflowNames.get(run.workflowId) ?? run.workflowId}
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-soft">
                      {run.id}
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] text-ink-faint">
                      <span>trigger {runTriggerLabel(run)}</span>
                      <span>v{run.workflowVersion}</span>
                      <span>{run.definitionSource}</span>
                    </div>
                  </div>
                </button>
              ))}
              {runs.length === 0 && (
                <div className="px-3 py-6 text-sm text-ink-soft">No runs</div>
              )}
              {hasMoreRuns && (
                <div className="px-3 py-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void loadMoreRuns()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ListFilter className="size-4" />
                    )}
                    Load more
                  </Button>
                </div>
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-y-auto">
            {detail ? (
              <div className="space-y-4 p-4">
                <section
                  aria-label="Run detail header"
                  className="grid gap-3 border border-paper-rule bg-paper-sunk p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {statusIcon(detail.run.status)}
                    <Badge
                      variant={
                        detail.run.mode === "live" ? "signal" : "outline"
                      }
                    >
                      {detail.run.mode}
                    </Badge>
                    <Badge variant={statusBadge(detail.run.status)}>
                      {detail.run.status}
                    </Badge>
                    <span className="font-mono text-[11px] text-ink-faint">
                      v{detail.run.workflowVersion}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      disabled={busy !== null}
                      onClick={() => void loadRunDetail(detail.run.id)}
                    >
                      <RefreshCw className="size-3" />
                      Refresh
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={!canCancel || busy !== null}
                      onClick={() => void cancelRun()}
                    >
                      {busy === "cancel" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <XCircle className="size-3" />
                      )}
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void rerun()}
                    >
                      {busy === "rerun" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <ListRestart className="size-3" />
                      )}
                      Rerun
                    </Button>
                    <Button asChild type="button" variant="ghost" size="xs">
                      <Link
                        to="/workflows"
                        search={{
                          id: detail.run.workflowId,
                          run: detail.run.id,
                        }}
                      >
                        <ScrollText className="size-3" />
                        Open workflow
                      </Link>
                    </Button>
                  </div>
                  <div className="grid gap-1 font-mono text-[11px] text-ink-soft">
                    <span className="break-all">{detail.run.id}</span>
                    <span>
                      {workflowNames.get(detail.run.workflowId) ??
                        detail.run.workflowId}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-ink-faint md:grid-cols-4">
                    <span>
                      duration {formatDuration(runDurationMs(detail.run))}
                    </span>
                    <span>trigger {runTriggerLabel(detail.run)}</span>
                    <span>started {formatDateTime(detail.run.startedAt)}</span>
                    <span>ended {formatDateTime(detail.run.endedAt)}</span>
                    <span>source {detail.run.definitionSource}</span>
                    <span>current {detail.run.currentNodeId ?? "none"}</span>
                    <span>waiting {detail.run.waitingReason ?? "none"}</span>
                  </div>
                </section>

                <div className="grid gap-4 xl:grid-cols-[minmax(260px,360px)_1fr]">
                  <section className="space-y-2">
                    <SectionEyebrow>Steps</SectionEyebrow>
                    <div className="divide-y divide-paper-rule border border-paper-rule">
                      {detail.steps.map((step) => {
                        const branchState = stepBranchState(detail, step);
                        return (
                          <button
                            type="button"
                            key={step.id}
                            onClick={() => setSelectedStepId(step.id)}
                            className={cn(
                              "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-sunk",
                              selectedStep?.id === step.id && "bg-paper-sunk",
                            )}
                          >
                            {statusIcon(step.status)}
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {step.nodeId}
                            </span>
                            {branchState && (
                              <span
                                aria-label={`${step.nodeId} branch state`}
                                className="font-mono text-[10px] text-ink-faint"
                              >
                                branch {branchState.status}
                              </span>
                            )}
                            <span className="font-mono text-[10px] text-ink-faint">
                              retry {stepRetryCount(step)} ·{" "}
                              {formatDuration(stepDurationMs(step))}
                            </span>
                            <Badge variant={statusBadge(step.status)}>
                              {step.status}
                            </Badge>
                          </button>
                        );
                      })}
                      {detail.steps.length === 0 && (
                        <div className="px-3 py-2 text-sm text-ink-soft">
                          No step attempts
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <SectionEyebrow>Selected Step</SectionEyebrow>
                    {selectedStep ? (
                      <>
                        <StepMetadata
                          step={selectedStep}
                          nodeType={stepNodeType(detail, selectedStep)}
                          nodeLabel={stepNodeLabel(detail, selectedStep)}
                          branchState={stepBranchState(detail, selectedStep)}
                        />
                        <JsonBlock
                          label="Input"
                          value={selectedStep.input}
                          runId={detail.run.id}
                        />
                        <JsonBlock
                          label="Output"
                          value={selectedStep.output}
                          runId={detail.run.id}
                        />
                        <JsonBlock
                          label="Error"
                          value={selectedStep.error}
                          runId={detail.run.id}
                        />
                        <JsonBlock
                          label="Logs"
                          value={selectedStep.logsSummary}
                          runId={detail.run.id}
                        />
                        <JsonBlock
                          label="Context diff"
                          value={selectedStep.contextDiff}
                          runId={detail.run.id}
                        />
                      </>
                    ) : (
                      <div className="border border-paper-rule p-3 text-sm text-ink-soft">
                        No selected step
                      </div>
                    )}
                  </section>
                </div>

                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <SectionEyebrow>Timeline</SectionEyebrow>
                    <Select
                      value={eventLevel}
                      onValueChange={(value) =>
                        setEventLevel(value as EventLevelFilter)
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-32"
                        aria-label="Timeline level"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_LEVELS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="divide-y divide-paper-rule border border-paper-rule">
                    {filteredEvents.map((event) => {
                      const stepNodeId = eventStepNodeId(detail, event);
                      return (
                        <div key={event.id} className="grid gap-1 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={
                                event.level === "error"
                                  ? "destructive"
                                  : "secondary"
                              }
                            >
                              {event.level}
                            </Badge>
                            <span className="text-sm">{event.kind}</span>
                            {stepNodeId && (
                              <span
                                aria-label={`Event #${event.sequence} step`}
                                className="font-mono text-[10px] text-ink-faint"
                              >
                                step {stepNodeId}
                              </span>
                            )}
                            <span
                              aria-label={`Event #${event.sequence} timestamp`}
                              className="ml-auto font-mono text-[10px] text-ink-faint"
                            >
                              #{event.sequence} ·{" "}
                              {formatDateTime(event.createdAt)}
                            </span>
                          </div>
                          {event.message && (
                            <div className="text-xs text-ink-soft">
                              {event.message}
                            </div>
                          )}
                          {event.payload !== undefined && (
                            <JsonBlock
                              label={`Event #${event.sequence} payload`}
                              value={event.payload}
                              runId={detail.run.id}
                            />
                          )}
                        </div>
                      );
                    })}
                    {filteredEvents.length === 0 && (
                      <div className="px-3 py-2 text-sm text-ink-soft">
                        {timelineEmptyMessage(eventLevel)}
                      </div>
                    )}
                  </div>
                </section>

                <JsonBlock
                  label="Trigger"
                  value={detail.run.trigger}
                  runId={detail.run.id}
                />
                <JsonBlock
                  label="Run input"
                  value={detail.run.input}
                  runId={detail.run.id}
                />
                <JsonBlock
                  label="Final context"
                  value={detail.run.context}
                  runId={detail.run.id}
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-ink-soft">
                Select a run
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  items,
  onValueChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function StepMetadata({
  step,
  nodeType,
  nodeLabel,
  branchState,
}: {
  step: WorkflowStepAttempt;
  nodeType: string;
  nodeLabel: string | null;
  branchState: StepBranchState | null;
}) {
  return (
    <div
      role="group"
      aria-label="Selected step metadata"
      className="grid grid-cols-2 gap-2 border border-paper-rule bg-paper-sunk p-3 font-mono text-[10px] text-ink-faint md:grid-cols-4"
    >
      <span>node {step.nodeId}</span>
      {nodeLabel && <span>label {nodeLabel}</span>}
      <span>type {nodeType}</span>
      <span>attempt {step.attempt}</span>
      <span>status {step.status}</span>
      {branchState && <span>branch {branchState.status}</span>}
      {branchState?.condition && <span>condition {branchState.condition}</span>}
      <span>duration {formatDuration(stepDurationMs(step))}</span>
      <span>started {formatDateTime(step.startedAt)}</span>
      <span>ended {formatDateTime(step.endedAt)}</span>
    </div>
  );
}

function JsonBlock({
  label,
  value,
  runId,
}: {
  label: string;
  value: unknown;
  runId?: string;
}) {
  const artifact = artifactReference(value);
  const [artifactContent, setArtifactContent] = useState<JsonValue | undefined>(
    undefined,
  );
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const displayValue = artifactContent ?? value;
  const redacted = hasRedactedValue(displayValue);

  useEffect(() => {
    setArtifactContent(undefined);
    setArtifactError(null);
    setArtifactLoading(false);
  }, [artifact?.id, runId]);

  async function loadArtifact() {
    if (!artifact || !runId) return;
    setArtifactLoading(true);
    setArtifactError(null);
    try {
      const data = await api<WorkflowArtifactContent>(
        `/api/workflow-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(
          artifact.id,
        )}`,
      );
      setArtifactContent(data.content);
    } catch (err) {
      const message = artifactErrorMessage(err);
      setArtifactError(message);
      toast.error(message);
    } finally {
      setArtifactLoading(false);
    }
  }

  function downloadArtifact() {
    if (!artifact || !runId) return;
    const anchor = document.createElement("a");
    anchor.href = `${API_BASE}/api/workflow-runs/${encodeURIComponent(
      runId,
    )}/artifacts/${encodeURIComponent(artifact.id)}/download`;
    anchor.download = `${artifact.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  return (
    <div
      role="group"
      aria-label={`${label} JSON`}
      className="border border-paper-rule"
    >
      <div className="flex items-center justify-between gap-2 border-b border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {artifact && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-1.5 font-mono text-[9px] uppercase tracking-[0.08em]"
                disabled={artifactLoading || !runId}
                onClick={() => void loadArtifact()}
              >
                {artifactLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ScrollText className="size-3" />
                )}
                Load artifact
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-1.5 font-mono text-[9px] uppercase tracking-[0.08em]"
                disabled={!runId}
                onClick={downloadArtifact}
              >
                <Download className="size-3" />
                Download artifact
              </Button>
            </>
          )}
          {redacted && (
            <span className="border border-paper-rule px-1.5 py-0.5 text-[9px] text-ink-soft">
              redacted
            </span>
          )}
        </span>
      </div>
      <pre className="max-h-56 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
        {displayValue === undefined
          ? "undefined"
          : JSON.stringify(displayValue, null, 2)}
      </pre>
      {artifactError && (
        <div className="border-t border-paper-rule px-3 py-1.5 text-xs text-plot-red">
          {artifactError}
        </div>
      )}
    </div>
  );
}

function artifactReference(value: unknown): WorkflowArtifactReference | null {
  if (!isRecord(value) || !isRecord(value.artifact)) return null;
  const artifact = value.artifact;
  if (
    typeof artifact.id !== "string" ||
    typeof artifact.kind !== "string" ||
    typeof artifact.path !== "string"
  ) {
    return null;
  }
  return {
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    preview:
      typeof artifact.preview === "string" || artifact.preview === null
        ? artifact.preview
        : undefined,
    byteLength:
      typeof artifact.byteLength === "number" ? artifact.byteLength : undefined,
  };
}

function hasRedactedValue(value: unknown): boolean {
  if (value === "[redacted]") return true;
  if (Array.isArray(value)) return value.some((item) => hasRedactedValue(item));
  if (isRecord(value)) {
    return Object.values(value).some((item) => hasRedactedValue(item));
  }
  return false;
}

function stepNodeLabel(
  detail: RunDetail,
  step: WorkflowStepAttempt,
): string | null {
  const event = detail.events.find(
    (candidate) =>
      candidate.stepRunId === step.id && candidate.kind === "step_started",
  );
  const payload = event?.payload;
  if (isRecord(payload) && typeof payload.nodeLabel === "string") {
    return payload.nodeLabel;
  }
  return null;
}

function stepNodeType(detail: RunDetail, step: WorkflowStepAttempt): string {
  const event = detail.events.find(
    (candidate) =>
      candidate.stepRunId === step.id && candidate.kind === "step_started",
  );
  const payload = event?.payload;
  if (isRecord(payload) && typeof payload.nodeType === "string") {
    return payload.nodeType;
  }
  return "unknown";
}

type StepBranchState = {
  status: "selected" | "skipped";
  condition: string | null;
};

function stepBranchState(
  detail: RunDetail,
  step: WorkflowStepAttempt,
): StepBranchState | null {
  for (const event of detail.events) {
    if (event.kind !== "branch_selected" || !isRecord(event.payload)) continue;
    const selected = stringArray(event.payload.selected);
    const skipped = stringArray(event.payload.skipped);
    const condition =
      typeof event.payload.condition === "string"
        ? event.payload.condition
        : null;

    if (selected.includes(step.nodeId)) {
      return { status: "selected", condition };
    }
    if (skipped.includes(step.nodeId)) {
      return { status: "skipped", condition };
    }
  }
  return null;
}

function eventStepNodeId(
  detail: RunDetail,
  event: WorkflowRunEvent,
): string | null {
  if (!event.stepRunId) return null;
  return (
    detail.steps.find((step) => step.id === event.stepRunId)?.nodeId ?? null
  );
}

function isTerminalRunStatus(status: WorkflowRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function retainedStepId(
  steps: WorkflowStepAttempt[],
  current: string | null,
): string | null {
  if (current && steps.some((step) => step.id === current)) return current;
  return steps[0]?.id ?? null;
}

function reconcileRunInLoadedList(
  current: WorkflowRun[],
  run: WorkflowRun,
  filters: Parameters<typeof runMatchesFilters>[1],
): WorkflowRun[] {
  if (!runMatchesFilters(run, filters)) {
    return current.filter((item) => item.id !== run.id);
  }
  if (current.some((item) => item.id === run.id)) {
    return current.map((item) => (item.id === run.id ? run : item));
  }
  return [run, ...current];
}

function globalRunSearchKey(filters: {
  workflowId: string;
  mode: string;
  status: string;
  triggerId: string;
  createdFrom: string;
  createdTo: string;
  run?: string;
}): string {
  return [
    filters.workflowId,
    filters.mode,
    filters.status,
    filters.triggerId,
    filters.createdFrom,
    filters.createdTo,
    filters.run ?? "",
  ].join(":");
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers:
      init.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      if (!res.ok) {
        throw new Error(text.trim() || `${res.status} ${res.statusText}`);
      }
      throw new Error("Server returned an invalid JSON response");
    }
  }
  if (!res.ok) {
    const message =
      isRecord(body) && typeof body["error"] === "string"
        ? body["error"]
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

function statusIcon(
  status: WorkflowRun["status"] | WorkflowStepAttempt["status"],
) {
  if (status === "succeeded")
    return <CheckCircle2 className="size-4 text-plot-green" />;
  if (status === "failed") return <XCircle className="size-4 text-plot-red" />;
  if (status === "canceled")
    return <AlertCircle className="size-4 text-plot-amber" />;
  if (status === "waiting" || status === "queued")
    return <Clock className="size-4 text-plot-amber" />;
  return <Circle className="size-4 text-ink-faint" />;
}

function statusBadge(
  status: WorkflowRun["status"] | WorkflowStepAttempt["status"],
) {
  if (status === "succeeded") return "healthy";
  if (status === "failed") return "destructive";
  if (status === "canceled" || status === "skipped") return "attention";
  return "outline";
}

function shortDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function runDurationMs(run: WorkflowRun): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  return new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
}

function stepDurationMs(step: WorkflowStepAttempt): number | null {
  if (step.durationMs !== null) return step.durationMs;
  if (!step.startedAt || !step.endedAt) return null;
  return new Date(step.endedAt).getTime() - new Date(step.startedAt).getTime();
}

function stepRetryCount(step: WorkflowStepAttempt): number {
  return Math.max(step.attempt - 1, 0);
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.max(value, 0)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function timelineEmptyMessage(level: EventLevelFilter): string {
  return level === "all" ? "No events" : `No ${level} events`;
}

function runMatchesFilters(
  run: WorkflowRun,
  filters: {
    workflowId: string;
    mode: string;
    status: string;
    triggerId: string;
    createdFrom: string;
    createdTo: string;
  },
): boolean {
  const createdAt = new Date(run.createdAt).getTime();
  const createdFrom = filters.createdFrom
    ? new Date(`${filters.createdFrom}T00:00:00.000Z`).getTime()
    : null;
  const createdTo = filters.createdTo
    ? new Date(`${filters.createdTo}T23:59:59.999Z`).getTime()
    : null;
  return (
    (filters.workflowId === "all" || filters.workflowId === run.workflowId) &&
    (filters.mode === "all" || filters.mode === run.mode) &&
    (filters.status === "all" || filters.status === run.status) &&
    (!filters.triggerId || getRunTriggerId(run) === filters.triggerId) &&
    (createdFrom === null || createdAt >= createdFrom) &&
    (createdTo === null || createdAt <= createdTo)
  );
}

function getRunTriggerId(run: WorkflowRun): string | null {
  if (!isRecord(run.trigger)) return null;
  const triggerId = run.trigger["triggerId"];
  return typeof triggerId === "string" ? triggerId : null;
}

function runTriggerLabel(run: WorkflowRun): string {
  return getRunTriggerId(run) ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function artifactErrorMessage(err: unknown) {
  const message = errorMessage(err);
  return message === "artifact_not_found" ? "Artifact unavailable" : message;
}
