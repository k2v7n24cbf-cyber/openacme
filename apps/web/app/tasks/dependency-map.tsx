import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dagre from "@dagrejs/dagre";
import {
  ExternalLink,
  Maximize,
  MessageSquare,
  Minus,
  Move,
  Plus,
  RotateCcw,
} from "lucide-react";
import {
  applyNodeChanges,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { AgentRef } from "@/app/components/ui/agent-ref";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { TabularTick } from "@/app/components/ui/tabular-tick";
import { formatTokens } from "@/app/lib/format";
import type { UsageSummaryResponse } from "@/app/lib/types";
import { cn } from "@/app/lib/utils";
import {
  STATUS_LABEL,
  STATUS_VARIANT,
  formatDate,
  formatRelativeFromIso,
  formatRelativeFromUnix,
  type Task,
  type TaskStatus,
} from "./types";
import {
  buildTaskDependencyGraph,
  buildTaskDependencyFlows,
  type TaskDependencyGraph,
  type TaskDependencyFlow,
  type TaskDependencyNode,
} from "./dependency-graph";

const NODE_W = 260;
const NODE_H = 88;
const HEADER_H = 38;
const GROUP_GAP_Y = 92;
const HEADER_GAP_Y = 16;
const INITIAL_Y = 86;
const SOURCE_SESSION_NODE_PREFIX = "source-session:";
const LANE_GAP_X = 112;
const LANE_PITCH_Y = 128;
const SOURCE_TO_LANE_GAP_X = 104;
const LANE_BAND_PAD_X = 22;
const LANE_BAND_PAD_Y = 16;
const TIMELINE_OFFSET_X = 168;
const COMPACT_INDEPENDENT_LANE_THRESHOLD = 5;
const COMPACT_INDEPENDENT_LANE_MAX_COLS = 4;
const COMPACT_INDEPENDENT_COLUMN_W = NODE_W + TIMELINE_OFFSET_X + 44;
const MANUAL_OFFSET_STORAGE_PREFIX = "openacme.tasks.dependencyMap.offsets.v1:";
const OFFSET_EPSILON = 1;
const TASK_HOVER_DETAIL_DELAY_MS = 1000;

interface TaskDependencyNodeData extends Record<string, unknown> {
  node: TaskDependencyNode;
  selected: boolean;
  related: boolean;
  dimmed: boolean;
  arrangeMode: boolean;
  startedAtMs: number | null;
}

interface FlowHeaderNodeData extends Record<string, unknown> {
  group: TaskDependencyFlow;
  title: string;
  subtitle: string;
  active: boolean;
  dimmed: boolean;
  width: number;
}

interface SourceSessionNodeData extends Record<string, unknown> {
  sessionId: string;
  title: string | null;
  agentId: string | null;
  agentName: string | null;
  href: string | null;
  active: boolean;
  dimmed: boolean;
}

export interface SourceSessionCard {
  id: string;
  title: string | null;
  agentId: string | null;
  agentName: string | null;
  href: string | null;
}

interface GroupLayout {
  positions: Map<string, { x: number; y: number }>;
  lanes: ExecutionLaneLayout[];
}

interface LayoutNodeBasePosition {
  groupId: string;
  x: number;
  y: number;
}

interface LayoutOffset {
  dx: number;
  dy: number;
}

type ManualLayoutOffsets = Record<string, Record<string, LayoutOffset>>;

type TaskUsageState =
  | { status: "loading" }
  | {
      status: "ready";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      events: number;
    }
  | { status: "error" };

interface ExecutionLaneLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TimelineScale {
  mode: "actual" | "created";
  min: number;
  max: number;
}

interface SessionLane {
  rootId: string;
  nodeIds: string[];
}

interface TaskDependencyMapContextValue {
  onPick: (id: string) => void;
  taskUsage: Map<string, TaskUsageState>;
  loadTaskUsage: (id: string) => void;
  usageAvailable: boolean;
}

const TaskDependencyMapContext =
  createContext<TaskDependencyMapContextValue | null>(null);

function useTaskDependencyMapContext(): TaskDependencyMapContextValue {
  const ctx = useContext(TaskDependencyMapContext);
  if (!ctx) throw new Error("TaskDependencyMapContext missing");
  return ctx;
}

function statusDot(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "bg-signal-blue";
    case "blocked":
      return "bg-signal-amber";
    case "done":
      return "bg-signal-green";
    case "canceled":
      return "bg-ink-faint";
    case "open":
    default:
      return "bg-ink";
  }
}

function TaskNode({ data }: NodeProps & { data: TaskDependencyNodeData }) {
  const { onPick, taskUsage, loadTaskUsage, usageAvailable } =
    useTaskDependencyMapContext();
  const { node, selected, related } = data;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const task = node.task;

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current === null) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  if (!task) {
    return (
      <div className="flex h-[88px] w-[260px] items-center border border-dashed border-destructive/60 bg-paper-sunk px-3">
        <Handle type="source" position={Position.Right} isConnectable={false} />
        <div className="min-w-0">
          <div className="font-mono text-[12px] tabular-nums text-destructive">
            #{node.id}
          </div>
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            missing from view
          </div>
        </div>
      </div>
    );
  }

  const terminal = task.status === "done" || task.status === "canceled";
  const waiting = node.unmetDepIds.length;
  const usage = taskUsage.get(task.id);
  const scheduleDetails = () => {
    if (data.arrangeMode) return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setDetailsOpen(true);
      loadTaskUsage(task.id);
      hoverTimerRef.current = null;
    }, TASK_HOVER_DETAIL_DELAY_MS);
  };
  const hideDetails = () => {
    clearHoverTimer();
    setDetailsOpen(false);
  };

  return (
    <div
      className={cn(
        "relative h-[88px] w-[260px]",
        !data.arrangeMode && "nodrag",
      )}
      onMouseEnter={scheduleDetails}
      onMouseLeave={hideDetails}
      onFocus={scheduleDetails}
      onBlur={hideDetails}
    >
      <button
        type="button"
        onClick={() => onPick(task.id)}
        className={cn(
          "flex h-[88px] w-[260px] flex-col justify-between border bg-paper px-3 py-2 text-left transition-colors hover:bg-paper-sunk focus-visible:outline focus-visible:outline-1 focus-visible:outline-plot-red",
          data.arrangeMode && "cursor-grab active:cursor-grabbing",
          selected
            ? "border-plot-red bg-paper-sunk"
            : related
              ? "border-ink-faint"
              : "border-paper-rule",
          terminal && "text-ink-soft",
          data.dimmed && "opacity-40",
        )}
      >
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <Handle type="source" position={Position.Right} isConnectable={false} />
        <div className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              statusDot(task.status),
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">
              {task.title}
            </div>
          </div>
          <Badge variant={STATUS_VARIANT[task.status]}>
            {STATUS_LABEL[task.status]}
          </Badge>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums text-ink-faint">
          <span>#{task.id}</span>
          <AgentRef id={task.assignee} />
          {waiting > 0 ? (
            <span className="text-signal-amber">{waiting} waiting</span>
          ) : node.dependsOnIds.length > 0 ? (
            <span>{node.dependsOnIds.length} deps</span>
          ) : null}
          {node.dependentIds.length > 0 && (
            <span>{node.dependentIds.length} blocks</span>
          )}
        </div>
      </button>
      {detailsOpen && !data.arrangeMode && (
        <TaskHoverDetails
          task={task}
          startedAtMs={data.startedAtMs}
          usage={usage}
          usageAvailable={usageAvailable}
          onGoTo={() => onPick(task.id)}
        />
      )}
    </div>
  );
}

function TaskHoverDetails({
  task,
  startedAtMs,
  usage,
  usageAvailable,
  onGoTo,
}: {
  task: Task;
  startedAtMs: number | null;
  usage: TaskUsageState | undefined;
  usageAvailable: boolean;
  onGoTo: () => void;
}) {
  const closed = task.closed_at
    ? isoDetail(task.closed_at)
    : terminalTask(task.status)
      ? { value: "Missing close time", detail: null }
      : { value: "Still open", detail: null };
  const started =
    startedAtMs !== null
      ? unixMsDetail(startedAtMs)
      : task.status === "open" || task.status === "blocked"
        ? { value: "Not started", detail: null }
        : { value: "No start event", detail: null };
  const duration = durationDetail(startedAtMs, task);
  const comments = commentDetail(task.comment_count);
  return (
    <div
      role="tooltip"
      className={cn(
        "nodrag nopan pointer-events-auto absolute left-1/2 top-0 z-50 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-full border border-paper-rule bg-paper px-3 py-3 text-left shadow-[0_18px_50px_rgba(0,0,0,0.18)]",
        "animate-in fade-in-0 zoom-in-95 duration-150",
      )}
    >
      <div className="mb-2 flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            #{task.id} details
          </div>
          <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">
            {task.title}
          </div>
        </div>
        <Badge variant={STATUS_VARIANT[task.status]}>
          {STATUS_LABEL[task.status]}
        </Badge>
      </div>
      <div className="grid grid-cols-6 gap-x-2 gap-y-2">
        <TaskDetailMetric
          label="Created"
          detail={isoDetail(task.created_at)}
          className="col-span-2"
          roomy
        />
        <TaskDetailMetric
          label="Started"
          detail={started}
          className="col-span-2"
          roomy
        />
        <TaskDetailMetric
          label="Closed"
          detail={closed}
          className="col-span-2"
          roomy
        />
        <TaskDetailMetric
          label="Duration"
          detail={duration}
          className="col-span-2"
          emphasize
        />
        <TaskDetailMetric
          label="Comments"
          detail={comments}
          className="col-span-2"
        />
        <TaskUsageBreakdown
          usage={usage}
          usageAvailable={usageAvailable}
          className="col-span-2"
        />
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-paper-rule pt-2">
        <div className="min-w-0 flex-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          <span className="truncate">@{task.assignee}</span>
          {task.session_id && (
            <span className="ml-2 truncate">{task.session_id}</span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="group pointer-events-auto transition-transform duration-150 hover:-translate-y-0.5 hover:border-plot-red hover:text-plot-red active:translate-y-0"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onGoTo();
          }}
        >
          <ExternalLink
            className="size-3 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
          Go to
        </Button>
      </div>
    </div>
  );
}

function TaskUsageBreakdown({
  usage,
  usageAvailable,
  className,
}: {
  usage: TaskUsageState | undefined;
  usageAvailable: boolean;
  className?: string;
}) {
  if (!usageAvailable) {
    return (
      <TaskDetailMetric
        label="Tokens"
        detail={{ value: "Unavailable", detail: null }}
        className={className}
      />
    );
  }
  if (!usage || usage.status === "loading") {
    return (
      <TaskDetailMetric
        label="Tokens"
        detail={{ value: "Reading", detail: null }}
        className={className}
      />
    );
  }
  if (usage.status === "error") {
    return (
      <TaskDetailMetric
        label="Tokens"
        detail={{ value: "Unavailable", detail: null }}
        className={className}
      />
    );
  }

  const cached = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteTokens;
  const fresh = Math.max(0, usage.totalTokens - cached);
  const calls = usage.events === 1 ? "1 call" : `${usage.events} calls`;

  return (
    <div
      className={cn(
        "min-w-0 border border-paper-rule bg-paper-sunk px-2 py-1.5",
        className,
      )}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-faint">
        Tokens
      </div>
      <div className="mt-0.5 grid grid-cols-3 gap-x-2 gap-y-1 font-mono tabular-nums">
        <TokenBreakdownCell
          label="Total"
          value={usage.totalTokens}
          emphasize
          title={`${formatTokens(usage.inputTokens)} input + ${formatTokens(
            usage.outputTokens,
          )} output`}
        />
        <TokenBreakdownCell
          label="Fresh"
          value={fresh}
          title="Total minus cache-read tokens"
        />
        <TokenBreakdownCell
          label="Cached"
          value={cached}
          title="Cache-read input tokens"
        />
      </div>
      <div className="mt-1 truncate font-mono text-[10px] tabular-nums text-ink-faint">
        {calls}
        {cacheWrite > 0 && ` · ${formatTokens(cacheWrite)} cache write`}
      </div>
    </div>
  );
}

function TokenBreakdownCell({
  label,
  value,
  title,
  emphasize = false,
}: {
  label: string;
  value: number;
  title: string;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div
        className={cn(
          "truncate text-[12px] text-ink",
          emphasize && "text-signal-blue",
        )}
      >
        {formatTokens(value)}
      </div>
      <div className="truncate text-[9px] uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </div>
    </div>
  );
}

function TaskDetailMetric({
  label,
  detail,
  emphasize = false,
  className,
  roomy = false,
}: {
  label: string;
  detail: { value: string; detail: string | null };
  emphasize?: boolean;
  className?: string;
  roomy?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border border-paper-rule bg-paper-sunk px-2 py-1.5",
        className,
      )}
    >
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[12px] tabular-nums text-ink",
          roomy ? "whitespace-nowrap leading-snug" : "truncate",
          emphasize && "text-signal-blue",
        )}
        title={detail.detail ?? detail.value}
      >
        {detail.value}
      </div>
      {detail.detail && (
        <div
          className={cn(
            "font-mono text-[10px] tabular-nums text-ink-faint",
            roomy ? "whitespace-nowrap leading-snug" : "truncate",
          )}
        >
          {detail.detail}
        </div>
      )}
    </div>
  );
}

function isoDetail(iso: string): { value: string; detail: string | null } {
  return {
    value: formatDate(iso),
    detail: formatRelativeFromIso(iso),
  };
}

function unixMsDetail(ms: number): { value: string; detail: string | null } {
  return {
    value: formatUnixMs(ms),
    detail: formatRelativeFromUnix(Math.floor(ms / 1000)),
  };
}

function formatUnixMs(ms: number): string {
  try {
    return new Date(ms).toLocaleString("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ms);
  }
}

function durationDetail(
  startedAtMs: number | null,
  task: Task,
): { value: string; detail: string | null } {
  if (startedAtMs === null) return { value: "—", detail: null };
  const closedAtMs = task.closed_at ? Date.parse(task.closed_at) : null;
  const endMs =
    closedAtMs !== null && Number.isFinite(closedAtMs)
      ? closedAtMs
      : Date.now();
  const minutes = Math.max(0, Math.round((endMs - startedAtMs) / 60_000));
  return {
    value: `${minutes} min`,
    detail: task.closed_at ? "start to close" : "running so far",
  };
}

function commentDetail(count: number | undefined): {
  value: string;
  detail: string | null;
} {
  if (count === undefined) return { value: "—", detail: null };
  return {
    value: String(count),
    detail: count === 1 ? "comment" : "comments",
  };
}

function terminalTask(status: TaskStatus): boolean {
  return status === "done" || status === "canceled";
}

function FlowHeaderNode({ data }: NodeProps & { data: FlowHeaderNodeData }) {
  return (
    <div
      style={{ width: data.width }}
      className={cn(
        "pointer-events-none flex h-[38px] items-center justify-between gap-3 border-b border-paper-rule bg-paper/95 px-1 font-mono",
        data.active && "border-plot-red",
        data.dimmed && "opacity-40",
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-[11px] uppercase tracking-[0.08em] text-ink">
          {data.title}
        </div>
        <div className="truncate text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          {data.subtitle}
        </div>
      </div>
      {data.group.gatedCount > 0 && (
        <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-signal-amber">
          <TabularTick value={data.group.gatedCount} /> gated
        </span>
      )}
    </div>
  );
}

function SourceSessionNode({
  data,
}: NodeProps & { data: SourceSessionNodeData }) {
  const title =
    data.title?.trim() || `Session ${shortSessionId(data.sessionId)}`;
  const agentLabel = data.agentName || data.agentId || "Unknown agent";
  return (
    <div
      className={cn(
        "pointer-events-auto flex h-[88px] w-[260px] items-center gap-3 border bg-paper-sunk px-3 font-mono",
        data.active ? "border-plot-red" : "border-signal-blue/60",
        data.dimmed && "opacity-40",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center border border-signal-blue/50 bg-paper text-signal-blue">
        <MessageSquare className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          Source session
        </div>
        <div className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">
          {title}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] tabular-nums text-ink-faint">
          <span className="truncate">{agentLabel}</span>
          <span className="shrink-0">{shortSessionId(data.sessionId)}</span>
        </div>
      </div>
      {data.href && (
        <a
          href={data.href}
          className="nodrag nopan pointer-events-auto relative z-10 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center text-ink-faint transition-colors hover:bg-paper hover:text-plot-red"
          aria-label="Open source session"
          title="Open source session"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = {
  taskDependency: TaskNode,
  flowHeader: FlowHeaderNode,
  sourceSession: SourceSessionNode,
};

function ChartControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Zoom in"
        onClick={() => void zoomIn({ duration: 150 })}
      >
        <Plus className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Zoom out"
        onClick={() => void zoomOut({ duration: 150 })}
      >
        <Minus className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Fit map"
        onClick={() =>
          void fitView({ padding: 0.18, maxZoom: 1, duration: 200 })
        }
      >
        <Maximize className="size-4" />
      </Button>
    </div>
  );
}

function ArrangeControls({
  arrangeMode,
  hasOffsets,
  activeGroupId,
  onArrangeModeChange,
  onResetGroup,
  onResetAll,
}: {
  arrangeMode: boolean;
  hasOffsets: boolean;
  activeGroupId: string | null;
  onArrangeModeChange: (enabled: boolean) => void;
  onResetGroup: () => void;
  onResetAll: () => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      <Button
        variant={arrangeMode ? "default" : "outline"}
        size="icon-sm"
        aria-label={arrangeMode ? "Finish arranging" : "Arrange cards"}
        title={arrangeMode ? "Finish arranging" : "Arrange cards"}
        onClick={() => onArrangeModeChange(!arrangeMode)}
      >
        <Move className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Reset active group layout"
        title="Reset active group layout"
        disabled={!hasOffsets || activeGroupId === null}
        onClick={onResetGroup}
      >
        <RotateCcw className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Reset all layout changes"
        title="Reset all layout changes"
        disabled={!hasOffsets}
        onClick={onResetAll}
      >
        <RotateCcw className="size-3" />
      </Button>
    </div>
  );
}

function Legend({ graph }: { graph: TaskDependencyGraph }) {
  const waiting = graph.nodes.filter((n) => n.unmetDepIds.length > 0).length;
  return (
    <div className="flex items-center gap-3 border border-paper-rule bg-paper px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-px w-5 bg-signal-green" />
        ready
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-px w-5 bg-signal-amber" />
        waiting
      </span>
      {waiting > 0 && (
        <span>
          <TabularTick value={waiting} /> gated
        </span>
      )}
    </div>
  );
}

function FlowNavigator({
  groups,
  activeGroupId,
  onActiveGroupChange,
}: {
  groups: TaskDependencyFlow[];
  activeGroupId: string | null;
  onActiveGroupChange: (id: string | null) => void;
}) {
  const { fitBounds, fitView, getNodes } = useReactFlow();

  const focusAll = () => {
    onActiveGroupChange(null);
    void fitView({ padding: 0.18, maxZoom: 1, duration: 200 });
  };

  const focusGroup = (group: TaskDependencyFlow) => {
    onActiveGroupChange(group.id);
    const ids = new Set(mapNodeIdsForGroup(group));
    const nodes = getNodes().filter((node) => ids.has(node.id));
    if (nodes.length === 0) return;
    void fitBounds(boundsForNodes(nodes), {
      padding: 0.24,
      duration: 220,
    });
  };

  const showAll = groups.length > 1;

  return (
    <div className="flex max-w-[min(42rem,calc(100vw-7rem))] items-center gap-1 overflow-x-auto border border-paper-rule bg-paper p-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
      {showAll && (
        <button
          type="button"
          onClick={focusAll}
          className={cn(
            "shrink-0 px-2 py-1 transition-colors hover:bg-paper-sunk hover:text-ink",
            activeGroupId === null &&
              "bg-ink text-paper hover:bg-ink hover:text-paper",
          )}
        >
          All
        </button>
      )}
      {groups.map((group, index) => {
        const active = activeGroupId === group.id || !showAll;
        const label = navigatorGroupLabel(group, index);
        const origin =
          group.kind === "flow" && group.createdInSessionIds.length === 1
            ? shortSessionId(group.createdInSessionIds[0])
            : null;
        return (
          <button
            key={group.id}
            type="button"
            onClick={() => focusGroup(group)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 px-2 py-1 transition-colors hover:bg-paper-sunk hover:text-ink",
              active && "bg-ink text-paper hover:bg-ink hover:text-paper",
            )}
          >
            <span>{label}</span>
            {origin && <span className="text-current/70">{origin}</span>}
            <span>
              <TabularTick value={group.taskIds.length} /> tasks
            </span>
            {group.gatedCount > 0 && (
              <span className={active ? "text-paper" : "text-signal-amber"}>
                <TabularTick value={group.gatedCount} /> gated
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function navigatorGroupLabel(group: TaskDependencyFlow, index: number): string {
  if (group.kind === "standalone") return "Standalone";
  if (group.kind === "session") {
    return `Session ${shortSessionId(group.createdInSessionIds[0])}`;
  }
  return `Flow ${index + 1}`;
}

function TaskDependencyMapInner({
  tasks,
  selectedId,
  onPick,
  focusSessionId,
  sourceSessions,
  taskStartTimes,
  layoutStorageKey,
  apiUrl,
}: {
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
  focusSessionId?: string | null;
  sourceSessions?: Map<string, SourceSessionCard>;
  taskStartTimes?: Map<string, number>;
  layoutStorageKey?: string;
  apiUrl?: (path: string) => string;
}) {
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [arrangeMode, setArrangeMode] = useState(false);
  const [taskUsage, setTaskUsage] = useState<Map<string, TaskUsageState>>(
    new Map(),
  );
  const storageKey = useMemo(
    () => manualLayoutStorageKey(layoutStorageKey ?? "default"),
    [layoutStorageKey],
  );
  const [manualOffsets, setManualOffsets] = useState<ManualLayoutOffsets>(() =>
    readManualLayoutOffsets(storageKey),
  );
  const [renderNodes, setRenderNodes] = useState<Node[]>([]);
  const graph = useMemo(() => buildTaskDependencyGraph(tasks), [tasks]);
  const groups = useMemo(() => buildTaskDependencyFlows(graph), [graph]);
  const selectedRelated = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const related = new Set<string>([selectedId]);
    for (const edge of graph.edges) {
      if (edge.source === selectedId) related.add(edge.target);
      if (edge.target === selectedId) related.add(edge.source);
    }
    return related;
  }, [graph, selectedId]);
  useEffect(() => {
    setManualOffsets(readManualLayoutOffsets(storageKey));
  }, [storageKey]);

  useEffect(() => {
    writeManualLayoutOffsets(storageKey, manualOffsets);
  }, [manualOffsets, storageKey]);

  const { nodes, edges, basePositions } = useMemo(
    () =>
      layoutTaskDependencyGraph(
        graph,
        groups,
        sourceSessions ?? new Map(),
        taskStartTimes ?? new Map(),
        manualOffsets,
        arrangeMode,
        selectedId,
        selectedRelated,
        activeGroupId,
      ),
    [
      graph,
      groups,
      sourceSessions,
      taskStartTimes,
      manualOffsets,
      arrangeMode,
      selectedId,
      selectedRelated,
      activeGroupId,
    ],
  );
  const hasOffsets = useMemo(
    () => !manualOffsetsEmpty(manualOffsets),
    [manualOffsets],
  );
  const loadTaskUsage = useCallback(
    (taskId: string) => {
      if (!apiUrl) return;
      const existing = taskUsage.get(taskId);
      if (existing) return;
      setTaskUsage((current) => {
        const currentExisting = current.get(taskId);
        if (currentExisting) return current;
        const next = new Map(current);
        next.set(taskId, { status: "loading" });
        return next;
      });
      const to = Math.ceil(Date.now() / 1000) + 86_400;
      void fetch(
        apiUrl(
          `/api/usage/summary?taskId=${encodeURIComponent(
            taskId,
          )}&from=0&to=${to}`,
        ),
      )
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as UsageSummaryResponse;
          setTaskUsage((current) => {
            const next = new Map(current);
            next.set(taskId, {
              status: "ready",
              inputTokens: json.totals.inputTokens,
              outputTokens: json.totals.outputTokens,
              cachedInputTokens: json.totals.cachedInputTokens,
              cacheWriteTokens: json.totals.cacheWriteTokens,
              totalTokens: json.totals.totalTokens,
              events: json.totals.events,
            });
            return next;
          });
        })
        .catch(() => {
          setTaskUsage((current) => {
            const next = new Map(current);
            next.set(taskId, { status: "error" });
            return next;
          });
        });
    },
    [apiUrl, taskUsage],
  );

  useEffect(() => {
    setRenderNodes(nodes);
  }, [nodes]);

  const onNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      if (!arrangeMode) return;
      setRenderNodes((current) => applyNodeChanges(changes, current));
    },
    [arrangeMode],
  );

  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_event, node) => {
      const base = basePositions.get(node.id);
      if (!base) return;
      const dx = Math.round(node.position.x - base.x);
      const dy = Math.round(node.position.y - base.y);
      setManualOffsets((current) =>
        setManualOffset(current, base.groupId, node.id, dx, dy),
      );
    },
    [basePositions],
  );

  const resetActiveGroup = useCallback(() => {
    if (!activeGroupId) return;
    setManualOffsets((current) =>
      removeManualOffsetGroup(current, activeGroupId),
    );
  }, [activeGroupId]);

  const resetAllOffsets = useCallback(() => {
    setManualOffsets({});
  }, []);

  return (
    <TaskDependencyMapContext.Provider
      value={{
        onPick,
        taskUsage,
        loadTaskUsage,
        usageAvailable: !!apiUrl,
      }}
    >
      <ReactFlow
        nodes={renderNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        nodesDraggable={arrangeMode}
        nodesConnectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        minZoom={0.08}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        className="task-dependency-map"
      >
        <Panel position="top-left">
          <FlowNavigator
            groups={groups}
            activeGroupId={activeGroupId}
            onActiveGroupChange={setActiveGroupId}
          />
        </Panel>
        <AutoFocusGroup
          groups={groups}
          focusSessionId={focusSessionId ?? null}
          onActiveGroupChange={setActiveGroupId}
        />
        <Panel position="top-right">
          <ChartControls />
          <ArrangeControls
            arrangeMode={arrangeMode}
            hasOffsets={hasOffsets}
            activeGroupId={activeGroupId}
            onArrangeModeChange={setArrangeMode}
            onResetGroup={resetActiveGroup}
            onResetAll={resetAllOffsets}
          />
        </Panel>
        <Panel position="bottom-left" className="hidden md:block">
          <Legend graph={graph} />
        </Panel>
      </ReactFlow>
    </TaskDependencyMapContext.Provider>
  );
}

export function TaskDependencyMap(props: {
  tasks: Task[];
  selectedId: string | null;
  onPick: (id: string) => void;
  focusSessionId?: string | null;
  sourceSessions?: Map<string, SourceSessionCard>;
  taskStartTimes?: Map<string, number>;
  layoutStorageKey?: string;
  apiUrl?: (path: string) => string;
}) {
  return (
    <ReactFlowProvider>
      <TaskDependencyMapInner {...props} />
    </ReactFlowProvider>
  );
}

function AutoFocusGroup({
  groups,
  focusSessionId,
  onActiveGroupChange,
}: {
  groups: TaskDependencyFlow[];
  focusSessionId: string | null;
  onActiveGroupChange: (id: string | null) => void;
}) {
  const { fitBounds, getNodes } = useReactFlow();
  const appliedFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusSessionId) {
      appliedFocusRef.current = null;
      return;
    }
    if (appliedFocusRef.current === focusSessionId) return;

    const group = groups.find((candidate) =>
      candidate.createdInSessionIds.includes(focusSessionId),
    );
    if (!group) return;

    appliedFocusRef.current = focusSessionId;
    onActiveGroupChange(group.id);
    window.requestAnimationFrame(() => {
      const ids = new Set(mapNodeIdsForGroup(group));
      const nodes = getNodes().filter((node) => ids.has(node.id));
      if (nodes.length === 0) return;
      void fitBounds(boundsForNodes(nodes), {
        padding: 0.24,
        duration: 220,
      });
    });
  }, [fitBounds, focusSessionId, getNodes, groups, onActiveGroupChange]);

  return null;
}

function layoutTaskDependencyGraph(
  graph: TaskDependencyGraph,
  groups: TaskDependencyFlow[],
  sourceSessions: Map<string, SourceSessionCard>,
  taskStartTimes: Map<string, number>,
  manualOffsets: ManualLayoutOffsets,
  arrangeMode: boolean,
  selectedId: string | null,
  selectedRelated: Set<string>,
  activeGroupId: string | null,
): {
  nodes: Node[];
  edges: Edge[];
  basePositions: Map<string, LayoutNodeBasePosition>;
} {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const groupByNode = new Map<string, TaskDependencyFlow>();
  for (const group of groups) {
    for (const id of group.nodeIds) groupByNode.set(id, group);
    const sourceId = sourceSessionNodeId(group);
    if (sourceId) groupByNode.set(sourceId, group);
  }

  const nodes: Node[] = [];
  const basePositions = new Map<string, LayoutNodeBasePosition>();
  let y = INITIAL_Y;
  for (const group of groups) {
    const local = layoutGroup(group, graph, taskStartTimes);
    const displayLocal = applyManualOffsets(local, group.id, manualOffsets);
    const bounds = boundsForLayout(displayLocal);
    const headerWidth = Math.max(bounds.width, NODE_W);
    const dimmed = activeGroupId !== null && group.id !== activeGroupId;
    const labels = flowLabels(group, nodeById);

    nodes.push({
      id: `group:${group.id}`,
      type: "flowHeader",
      position: { x: 0, y },
      data: {
        group,
        title: labels.title,
        subtitle: labels.subtitle,
        active: activeGroupId === group.id,
        dimmed,
        width: headerWidth,
      } satisfies FlowHeaderNodeData,
      selectable: false,
      draggable: false,
    });

    const bodyY = y + HEADER_H + HEADER_GAP_Y;
    for (const [id, basePosition] of local.positions) {
      const displayPosition = displayLocal.positions.get(id) ?? basePosition;
      basePositions.set(id, {
        groupId: group.id,
        x: basePosition.x,
        y: bodyY + basePosition.y,
      });
      const sourceSessionId = sessionIdFromSourceNodeId(id);
      if (sourceSessionId) {
        const sourceSession = sourceSessions.get(sourceSessionId) ?? null;
        nodes.push({
          id,
          type: "sourceSession",
          position: {
            x: displayPosition.x,
            y: bodyY + displayPosition.y,
          },
          data: {
            sessionId: sourceSessionId,
            title: sourceSession?.title ?? null,
            agentId: sourceSession?.agentId ?? null,
            agentName: sourceSession?.agentName ?? null,
            href: sourceSession?.href ?? null,
            active: activeGroupId === group.id,
            dimmed,
          } satisfies SourceSessionNodeData,
          selectable: false,
          draggable: arrangeMode,
          zIndex: 2,
          style: { pointerEvents: "all" },
        });
        continue;
      }

      const node = nodeById.get(id);
      if (!node) continue;
      nodes.push({
        id: node.id,
        type: "taskDependency",
        position: {
          x: displayPosition.x,
          y: bodyY + displayPosition.y,
        },
        data: {
          node,
          selected: node.id === selectedId,
          related: selectedRelated.has(node.id),
          dimmed,
          arrangeMode,
          startedAtMs: taskStartTimes.get(node.id) ?? null,
        } satisfies TaskDependencyNodeData,
        selectable: false,
        draggable: arrangeMode,
        zIndex: 2,
        style: { pointerEvents: "all" },
      });
    }

    y = bodyY + bounds.height + GROUP_GAP_Y;
  }

  const edges: Edge[] = graph.edges.map((edge) => {
    const related =
      selectedRelated.has(edge.source) && selectedRelated.has(edge.target);
    const sourceGroup = groupByNode.get(edge.source);
    const targetGroup = groupByNode.get(edge.target);
    const dimmed =
      activeGroupId !== null &&
      sourceGroup?.id !== activeGroupId &&
      targetGroup?.id !== activeGroupId;
    const stroke = related
      ? "var(--plot-red)"
      : edge.satisfied
        ? "var(--signal-green)"
        : "var(--signal-amber)";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      style: {
        stroke,
        strokeWidth: related ? 1.8 : 1.2,
        strokeDasharray: edge.satisfied ? undefined : "5 4",
        opacity: dimmed ? 0.22 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: stroke,
        width: 14,
        height: 14,
      },
    };
  });

  for (const group of groups) {
    const sourceId = sourceSessionNodeId(group);
    if (!sourceId) continue;
    const dimmed = activeGroupId !== null && group.id !== activeGroupId;
    for (const rootId of rootTaskIds(group, nodeById)) {
      edges.push({
        id: `source:${sourceId}->${rootId}`,
        source: sourceId,
        target: rootId,
        type: "smoothstep",
        style: {
          stroke: "var(--signal-blue)",
          strokeWidth: 1.4,
          strokeDasharray: "3 4",
          opacity: dimmed ? 0.22 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "var(--signal-blue)",
          width: 14,
          height: 14,
        },
      });
    }
  }

  return { nodes, edges, basePositions };
}

function layoutGroup(
  group: TaskDependencyFlow,
  graph: TaskDependencyGraph,
  taskStartTimes: Map<string, number>,
): GroupLayout {
  const sourceId = sourceSessionNodeId(group);
  if (group.kind === "session" && sourceId) {
    return layoutSessionGroup(group, graph, sourceId, taskStartTimes);
  }
  if (group.kind === "standalone" || (group.edgeCount === 0 && !sourceId)) {
    return layoutStandaloneGroup(group);
  }

  const ids = new Set(group.nodeIds);
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    ranksep: 92,
    nodesep: 36,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));

  if (sourceId) g.setNode(sourceId, { width: NODE_W, height: NODE_H });
  for (const id of group.nodeIds) {
    g.setNode(id, { width: NODE_W, height: NODE_H });
  }
  for (const edge of graph.edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }
  if (sourceId) {
    for (const rootId of rootTaskIds(group, graphNodeById(graph))) {
      g.setEdge(sourceId, rootId);
    }
  }
  dagre.layout(g);

  const out = new Map<string, { x: number; y: number }>();
  for (const id of sourceId ? [sourceId, ...group.nodeIds] : group.nodeIds) {
    const laid = g.node(id);
    out.set(id, {
      x: laid.x - NODE_W / 2,
      y: laid.y - NODE_H / 2,
    });
  }
  return { positions: normalizeLayout(out), lanes: [] };
}

function layoutSessionGroup(
  group: TaskDependencyFlow,
  graph: TaskDependencyGraph,
  sourceId: string,
  taskStartTimes: Map<string, number>,
): GroupLayout {
  const nodeById = graphNodeById(graph);
  const groupIds = new Set(group.nodeIds);
  const groupTaskIds = new Set(group.taskIds);
  const groupEdges = graph.edges.filter(
    (edge) => groupIds.has(edge.source) && groupIds.has(edge.target),
  );
  const outgoing = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();
  for (const edge of groupEdges) {
    const next = outgoing.get(edge.source) ?? [];
    next.push(edge.target);
    outgoing.set(edge.source, sortTaskIds(next));
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  const outcomeIds = group.leafIds.filter(
    (id) => groupTaskIds.has(id) && (incomingCount.get(id) ?? 0) > 1,
  );
  const outcomeIdSet = new Set(outcomeIds);
  const roots = rootTaskIds(group, nodeById).filter(
    (id) => !outcomeIdSet.has(id),
  );

  const lanes: SessionLane[] = [];
  const assigned = new Set<string>(outcomeIds);
  for (const rootId of roots) {
    const nodeIds = collectLaneNodes(
      rootId,
      outgoing,
      incomingCount,
      outcomeIdSet,
      assigned,
    );
    if (nodeIds.length === 0) continue;
    for (const id of nodeIds) assigned.add(id);
    lanes.push({ rootId, nodeIds });
  }

  for (const id of group.taskIds) {
    if (assigned.has(id)) continue;
    lanes.push({ rootId: id, nodeIds: [id] });
    assigned.add(id);
  }

  const firstTaskX = NODE_W + SOURCE_TO_LANE_GAP_X;
  const columnW = NODE_W + LANE_GAP_X;
  const compactIndependentLanes = lanes.filter((lane) =>
    sessionLaneIsIndependent(lane, outgoing, incomingCount),
  );
  const shouldCompactIndependent =
    compactIndependentLanes.length >= COMPACT_INDEPENDENT_LANE_THRESHOLD;
  const compactLaneIds = new Set(
    shouldCompactIndependent
      ? compactIndependentLanes.map((lane) => lane.rootId)
      : [],
  );
  const linearLanes = lanes.filter((lane) => !compactLaneIds.has(lane.rootId));
  const compactCols = shouldCompactIndependent
    ? Math.min(
        COMPACT_INDEPENDENT_LANE_MAX_COLS,
        Math.max(1, Math.ceil(Math.sqrt(compactIndependentLanes.length))),
      )
    : 1;
  const compactRows = shouldCompactIndependent
    ? Math.ceil(compactIndependentLanes.length / compactCols)
    : 0;
  const maxLaneDepth = Math.max(
    1,
    ...linearLanes.map((lane) => lane.nodeIds.length),
  );
  let outcomeX = firstTaskX + maxLaneDepth * columnW;
  const timelineByDepth = new Map<number, TimelineScale | null>();
  for (let depth = 0; depth < maxLaneDepth; depth += 1) {
    timelineByDepth.set(
      depth,
      timelineScale(
        linearLanes
          .map((lane) => lane.nodeIds[depth])
          .filter((id): id is string => !!id),
        nodeById,
        taskStartTimes,
      ),
    );
  }
  const outcomeTimeline = timelineScale(outcomeIds, nodeById, taskStartTimes);
  const compactTimeline = shouldCompactIndependent
    ? timelineScale(
        compactIndependentLanes.map((lane) => lane.rootId),
        nodeById,
        taskStartTimes,
      )
    : null;
  const out = new Map<string, { x: number; y: number }>();
  const laneLayouts: ExecutionLaneLayout[] = [];
  const bandX = firstTaskX - LANE_BAND_PAD_X;

  let nextLaneY = 0;
  let maxX = firstTaskX + (maxLaneDepth - 1) * columnW + NODE_W;
  for (const lane of linearLanes) {
    const laneY = nextLaneY;
    nextLaneY += LANE_PITCH_Y;
    laneLayouts.push({
      id: lane.rootId,
      x: bandX,
      y: laneY - LANE_BAND_PAD_Y,
      width: NODE_W,
      height: NODE_H + LANE_BAND_PAD_Y * 2,
    });
    lane.nodeIds.forEach((id, depth) => {
      const x =
        firstTaskX +
        depth * columnW +
        timelineOffsetX(
          id,
          nodeById,
          taskStartTimes,
          timelineByDepth.get(depth) ?? null,
        );
      out.set(id, {
        x,
        y: laneY,
      });
      maxX = Math.max(maxX, x + NODE_W);
    });
  }

  if (shouldCompactIndependent) {
    if (linearLanes.length > 0) nextLaneY += Math.round(LANE_PITCH_Y / 2);
    const compactStartY = nextLaneY;
    compactIndependentLanes.forEach((lane, index) => {
      const id = lane.rootId;
      const col = index % compactCols;
      const row = Math.floor(index / compactCols);
      const x =
        firstTaskX +
        col * COMPACT_INDEPENDENT_COLUMN_W +
        timelineOffsetX(id, nodeById, taskStartTimes, compactTimeline);
      out.set(id, {
        x,
        y: compactStartY + row * LANE_PITCH_Y,
      });
      maxX = Math.max(maxX, x + NODE_W);
    });
  }

  if (outcomeIds.length > 0) {
    outcomeX = Math.max(outcomeX, maxX + LANE_GAP_X);
  }
  const sourceY = verticalCenter(out);
  out.set(sourceId, { x: 0, y: sourceY });
  maxX = Math.max(maxX, outcomeIds.length > 0 ? outcomeX + NODE_W : maxX);

  const bandWidth = maxX - bandX + LANE_BAND_PAD_X;
  for (const lane of laneLayouts) lane.width = bandWidth;

  const outcomeBaseY = sourceY - ((outcomeIds.length - 1) * LANE_PITCH_Y) / 2;
  outcomeIds.forEach((id, index) => {
    out.set(id, {
      x:
        outcomeX +
        timelineOffsetX(id, nodeById, taskStartTimes, outcomeTimeline),
      y: outcomeBaseY + index * LANE_PITCH_Y,
    });
  });

  return normalizeGroupLayout({ positions: out, lanes: laneLayouts });
}

function collectLaneNodes(
  rootId: string,
  outgoing: Map<string, string[]>,
  incomingCount: Map<string, number>,
  outcomeIds: Set<string>,
  assigned: Set<string>,
): string[] {
  const lane: string[] = [];
  const seen = new Set<string>();
  let current: string | null = rootId;

  while (current && !seen.has(current) && !outcomeIds.has(current)) {
    lane.push(current);
    seen.add(current);
    const nexts: string[] = (outgoing.get(current) ?? []).filter(
      (id) => !outcomeIds.has(id),
    );
    if (nexts.length !== 1) break;
    const next: string = nexts[0]!;
    if ((incomingCount.get(next) ?? 0) > 1 || assigned.has(next)) break;
    current = next;
  }

  return lane;
}

function sessionLaneIsIndependent(
  lane: SessionLane,
  outgoing: Map<string, string[]>,
  incomingCount: Map<string, number>,
): boolean {
  if (lane.nodeIds.length !== 1) return false;
  const id = lane.nodeIds[0]!;
  return (
    (incomingCount.get(id) ?? 0) === 0 && (outgoing.get(id)?.length ?? 0) === 0
  );
}

function verticalCenter(
  positions: Map<string, { x: number; y: number }>,
): number {
  if (positions.size === 0) return 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const position of positions.values()) {
    minY = Math.min(minY, position.y);
    maxY = Math.max(maxY, position.y + NODE_H);
  }
  return Math.round((minY + maxY - NODE_H) / 2);
}

function layoutStandaloneGroup(group: TaskDependencyFlow): GroupLayout {
  const out = new Map<string, { x: number; y: number }>();
  const cols = Math.min(3, Math.max(1, group.nodeIds.length));
  for (let i = 0; i < group.nodeIds.length; i++) {
    const id = group.nodeIds[i]!;
    out.set(id, {
      x: (i % cols) * (NODE_W + 32),
      y: Math.floor(i / cols) * (NODE_H + 24),
    });
  }
  return { positions: out, lanes: [] };
}

function applyManualOffsets(
  layout: GroupLayout,
  groupId: string,
  offsets: ManualLayoutOffsets,
): GroupLayout {
  const groupOffsets = offsets[groupId];
  if (!groupOffsets) return layout;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, position] of layout.positions) {
    const offset = groupOffsets[id];
    positions.set(
      id,
      offset
        ? { x: position.x + offset.dx, y: position.y + offset.dy }
        : position,
    );
  }
  return { positions, lanes: layout.lanes };
}

function normalizeLayout(
  positions: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const bounds = boundsForLayout({ positions, lanes: [] });
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of positions) {
    out.set(id, { x: p.x - bounds.x, y: p.y - bounds.y });
  }
  return out;
}

function normalizeGroupLayout(layout: GroupLayout): GroupLayout {
  const bounds = boundsForLayout(layout);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, p] of layout.positions) {
    positions.set(id, { x: p.x - bounds.x, y: p.y - bounds.y });
  }
  return {
    positions,
    lanes: layout.lanes.map((lane) => ({
      ...lane,
      x: lane.x - bounds.x,
      y: lane.y - bounds.y,
    })),
  };
}

function boundsForLayout(layout: GroupLayout) {
  if (layout.positions.size === 0 && layout.lanes.length === 0)
    return { x: 0, y: 0, width: NODE_W, height: NODE_H };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of layout.positions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  for (const lane of layout.lanes) {
    minX = Math.min(minX, lane.x);
    minY = Math.min(minY, lane.y);
    maxX = Math.max(maxX, lane.x + lane.width);
    maxY = Math.max(maxY, lane.y + lane.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boundsForNodes(nodes: Node[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + NODE_W);
    maxY = Math.max(maxY, node.position.y + NODE_H);
  }
  return {
    x: minX - 48,
    y: minY - 72,
    width: maxX - minX + 96,
    height: maxY - minY + 120,
  };
}

function flowLabels(
  group: TaskDependencyFlow,
  nodeById: Map<string, TaskDependencyNode>,
): { title: string; subtitle: string } {
  const taskCount = group.taskIds.length;
  const taskWord = taskCount === 1 ? "task" : "tasks";
  if (group.kind === "standalone") {
    return {
      title: "Standalone",
      subtitle: `${taskCount} ${taskWord} with no dependencies`,
    };
  }

  if (group.kind === "session") {
    const sessionId = group.createdInSessionIds[0];
    const rootCount = group.rootIds.length;
    const leafCount = group.leafIds.length;
    const dependencySummary =
      group.edgeCount > 0
        ? `${rootCount} roots · ${leafCount} outcomes`
        : "no explicit deps";
    return {
      title: sessionId
        ? `Coordination session ${shortSessionId(sessionId)}`
        : "Coordination session",
      subtitle: `${taskCount} ${taskWord} created together · ${dependencySummary}`,
    };
  }

  const leaf = firstTask(group.leafIds, nodeById);
  const root = firstTask(group.rootIds, nodeById);
  const title = leaf?.title ?? root?.title ?? "Flow";
  const rootCount = group.rootIds.length;
  const leafCount = group.leafIds.length;
  const sessionSuffix =
    group.createdInSessionIds.length === 1
      ? ` · session ${shortSessionId(group.createdInSessionIds[0])}`
      : "";
  return {
    title,
    subtitle: `${taskCount} ${taskWord} · ${rootCount} roots · ${leafCount} outcomes${sessionSuffix}`,
  };
}

function shortSessionId(id: string | undefined): string {
  return id ? id.slice(0, 8) : "?";
}

function timelineScale(
  ids: string[],
  nodeById: Map<string, TaskDependencyNode>,
  taskStartTimes: Map<string, number>,
): TimelineScale | null {
  const actualTimes = ids
    .map((id) => taskActualStartMs(id, taskStartTimes))
    .filter((time): time is number => time !== null);
  if (actualTimes.length > 0) {
    return {
      mode: "actual",
      min: Math.min(...actualTimes),
      max: Math.max(...actualTimes),
    };
  }

  const times = ids
    .map((id) => taskCreatedMs(id, nodeById))
    .filter((time): time is number => time !== null);
  if (times.length < 2) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  return max > min ? { mode: "created", min, max } : null;
}

function timelineOffsetX(
  id: string,
  nodeById: Map<string, TaskDependencyNode>,
  taskStartTimes: Map<string, number>,
  timeline: TimelineScale | null,
): number {
  if (!timeline) return 0;
  const time =
    timeline.mode === "actual"
      ? taskActualTimelineMs(id, nodeById, taskStartTimes)
      : taskCreatedMs(id, nodeById);
  if (time === null) return 0;
  if (timeline.max <= timeline.min) {
    return timeline.mode === "actual" && isTaskWaitingToStart(id, nodeById)
      ? TIMELINE_OFFSET_X
      : 0;
  }
  const ratio = (time - timeline.min) / (timeline.max - timeline.min);
  return Math.round(Math.max(0, Math.min(1, ratio)) * TIMELINE_OFFSET_X);
}

function taskActualTimelineMs(
  id: string,
  nodeById: Map<string, TaskDependencyNode>,
  taskStartTimes: Map<string, number>,
): number | null {
  const startedAt = taskActualStartMs(id, taskStartTimes);
  if (startedAt !== null) return startedAt;
  if (isTaskWaitingToStart(id, nodeById)) return Number.POSITIVE_INFINITY;
  return taskCreatedMs(id, nodeById);
}

function taskActualStartMs(
  id: string,
  taskStartTimes: Map<string, number>,
): number | null {
  const time = taskStartTimes.get(id);
  return typeof time === "number" && Number.isFinite(time) ? time : null;
}

function taskCreatedMs(
  id: string,
  nodeById: Map<string, TaskDependencyNode>,
): number | null {
  const task = nodeById.get(id)?.task;
  if (!task) return null;
  const parsed = Date.parse(task.created_at);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTaskWaitingToStart(
  id: string,
  nodeById: Map<string, TaskDependencyNode>,
): boolean {
  const status = nodeById.get(id)?.task?.status;
  return status === "open" || status === "blocked";
}

function manualLayoutStorageKey(scope: string): string {
  return `${MANUAL_OFFSET_STORAGE_PREFIX}${scope}`;
}

function readManualLayoutOffsets(key: string): ManualLayoutOffsets {
  if (typeof window === "undefined") return {};
  try {
    return parseManualLayoutOffsets(window.localStorage.getItem(key));
  } catch {
    return {};
  }
}

function writeManualLayoutOffsets(
  key: string,
  offsets: ManualLayoutOffsets,
): void {
  if (typeof window === "undefined") return;
  try {
    if (manualOffsetsEmpty(offsets)) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(offsets));
    }
  } catch {
    // Best-effort UI preference; storage failures should not break the map.
  }
}

function parseManualLayoutOffsets(raw: string | null): ManualLayoutOffsets {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainRecord(parsed)) return {};

  const out: ManualLayoutOffsets = {};
  for (const [groupId, groupValue] of Object.entries(parsed)) {
    if (!groupId || !isPlainRecord(groupValue)) continue;
    const groupOffsets: Record<string, LayoutOffset> = {};
    for (const [nodeId, value] of Object.entries(groupValue)) {
      if (!nodeId || !isPlainRecord(value)) continue;
      const dx = value["dx"];
      const dy = value["dy"];
      if (typeof dx !== "number" || typeof dy !== "number") continue;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      groupOffsets[nodeId] = {
        dx: Math.round(dx),
        dy: Math.round(dy),
      };
    }
    if (Object.keys(groupOffsets).length > 0) out[groupId] = groupOffsets;
  }
  return out;
}

function setManualOffset(
  offsets: ManualLayoutOffsets,
  groupId: string,
  nodeId: string,
  dx: number,
  dy: number,
): ManualLayoutOffsets {
  const next: ManualLayoutOffsets = { ...offsets };
  const group = { ...(next[groupId] ?? {}) };
  if (Math.abs(dx) <= OFFSET_EPSILON && Math.abs(dy) <= OFFSET_EPSILON) {
    delete group[nodeId];
  } else {
    group[nodeId] = { dx, dy };
  }

  if (Object.keys(group).length === 0) {
    delete next[groupId];
  } else {
    next[groupId] = group;
  }
  return next;
}

function removeManualOffsetGroup(
  offsets: ManualLayoutOffsets,
  groupId: string,
): ManualLayoutOffsets {
  if (!offsets[groupId]) return offsets;
  const next = { ...offsets };
  delete next[groupId];
  return next;
}

function manualOffsetsEmpty(offsets: ManualLayoutOffsets): boolean {
  return Object.values(offsets).every(
    (group) => Object.keys(group).length === 0,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sortTaskIds(ids: string[]): string[] {
  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

function firstTask(ids: string[], nodeById: Map<string, TaskDependencyNode>) {
  for (const id of ids) {
    const task = nodeById.get(id)?.task;
    if (task) return task;
  }
  return null;
}

function sourceSessionNodeId(group: TaskDependencyFlow): string | null {
  if (group.kind !== "session") return null;
  const sessionId = group.createdInSessionIds[0];
  return sessionId ? `${SOURCE_SESSION_NODE_PREFIX}${sessionId}` : null;
}

function sessionIdFromSourceNodeId(id: string): string | null {
  return id.startsWith(SOURCE_SESSION_NODE_PREFIX)
    ? id.slice(SOURCE_SESSION_NODE_PREFIX.length)
    : null;
}

function mapNodeIdsForGroup(group: TaskDependencyFlow): string[] {
  const sourceId = sourceSessionNodeId(group);
  return sourceId ? [sourceId, ...group.nodeIds] : group.nodeIds;
}

function graphNodeById(
  graph: TaskDependencyGraph,
): Map<string, TaskDependencyNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function rootTaskIds(
  group: TaskDependencyFlow,
  nodeById: Map<string, TaskDependencyNode>,
): string[] {
  const roots = group.rootIds.filter((id) => nodeById.get(id)?.task);
  return roots.length > 0 ? roots : group.taskIds;
}
