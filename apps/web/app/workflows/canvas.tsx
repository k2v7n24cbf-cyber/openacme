import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  AlertCircle,
  Bot,
  Braces,
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  GitBranch,
  ListRestart,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
  Workflow as WorkflowIcon,
  Wrench,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { cn } from "@/app/lib/utils";
import type {
  WorkflowCanvasNode,
  WorkflowCanvasNodeData,
  WorkflowGraphProjection,
} from "./graph";
import { isWorkflowTransformNodeType } from "./authoring";

export interface WorkflowCanvasConnection {
  sourceId: string;
  targetId: string;
  sourceHandle: string | null;
}

export interface WorkflowCanvasEdgeSelection {
  id: string;
  sourceId: string;
  targetId: string;
  sourceHandle: string | null;
  targetRef: string | null;
  kind: string | null;
}

export interface WorkflowCanvasAddPlacement {
  position: { x: number; y: number };
}

interface WorkflowCanvasPendingConnection {
  sourceId: string;
  sourceHandle: string;
}

interface WorkflowCanvasConnectionContextValue {
  readOnly: boolean;
  pending: WorkflowCanvasPendingConnection | null;
  beginConnection: (connection: WorkflowCanvasPendingConnection) => void;
  completeConnection: (targetId: string) => void;
  openAddStepAfterNode: (
    nodeId: string | null,
    sourceHandle?: string,
    placement?: WorkflowCanvasAddPlacement,
  ) => void;
  cloneNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  makeForeachBodyFirst: (foreachNodeId: string, bodyNodeId: string) => void;
  removeEdge?: (edge: WorkflowCanvasEdgeSelection) => void;
}

const WorkflowCanvasConnectionContext =
  createContext<WorkflowCanvasConnectionContextValue | null>(null);

const EDGE_TYPES = {
  workflowCanvasEdge: WorkflowCanvasEdge,
};

function WorkflowCanvasEdge({
  id,
  source,
  target,
  sourceHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  selected,
  data,
}: EdgeProps) {
  const connection = useContext(WorkflowCanvasConnectionContext);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeSelection: WorkflowCanvasEdgeSelection = {
    id,
    sourceId: source,
    targetId: target,
    sourceHandle: sourceHandleId ?? null,
    targetRef: edgeTargetRef(data),
    kind: edgeKind(data),
  };
  const removable =
    selected &&
    !!connection?.removeEdge &&
    isRemovableCanvasEdge(edgeSelection);

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {(label || removable) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            {label && (
              <span className="rounded border border-paper-rule bg-paper px-1.5 py-0.5 font-mono text-[9px] uppercase leading-none text-ink-faint shadow-sm">
                {label}
              </span>
            )}
            {removable && (
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="Remove selected workflow edge"
                title="Remove connection"
                className="size-6 cursor-pointer rounded-full bg-paper p-0 text-destructive shadow-sm hover:border-destructive hover:bg-destructive/10"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  connection.removeEdge?.(edgeSelection);
                }}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

function WorkflowStepNode({
  data,
  selected,
}: NodeProps & { data: WorkflowCanvasNodeData }) {
  return <WorkflowCanvasNodeCard data={data} selected={selected} />;
}

function WorkflowTriggerNode({
  data,
  selected,
}: NodeProps & { data: WorkflowCanvasNodeData }) {
  return <WorkflowCanvasNodeCard data={data} selected={selected} />;
}

function WorkflowMissingNode({
  data,
  selected,
}: NodeProps & { data: WorkflowCanvasNodeData }) {
  return <WorkflowCanvasNodeCard data={data} selected={selected} />;
}

function WorkflowGroupNode({
  data,
}: NodeProps & { data: WorkflowCanvasNodeData }) {
  const railY =
    typeof data.groupRailY === "number"
      ? data.groupRailY
      : (data.canvasHeight ?? 86) / 2;
  const railWidth =
    typeof data.groupRailWidth === "number" ? data.groupRailWidth : 0;
  return (
    <div
      aria-hidden
      data-workflow-canvas-group-id={data.id}
      className="pointer-events-none relative rounded-sm border border-dashed border-plot-red/20 bg-plot-red/[0.018]"
      style={{
        width: data.canvasWidth ?? 220,
        height: data.canvasHeight ?? 86,
      }}
    >
      {railWidth > 0 && (
        <div
          data-workflow-canvas-group-rail={data.id}
          className="absolute left-0 h-px bg-plot-red/20"
          style={{
            top: railY,
            width: railWidth,
          }}
        />
      )}
      <Handle
        id="target"
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{
          ...WORKFLOW_LEFT_TARGET_HANDLE_STYLE,
          top: railY,
          background: "var(--plot-red)",
          boxShadow: "0 0 0 3px rgb(248 113 113 / 8%)",
        }}
      />
      <div
        className="absolute flex size-6 items-center justify-center rounded-full border border-plot-red/14 bg-paper/65 text-plot-red/35 shadow-sm"
        style={{
          left: -12,
          top: 14,
        }}
      >
        <RefreshCw className="size-3.5" />
      </div>
    </div>
  );
}

function WorkflowCanvasNodeCard({
  data,
  selected,
}: {
  data: WorkflowCanvasNodeData;
  selected?: boolean;
}) {
  const isTrigger = data.kind === "trigger";
  const isMissing = data.kind === "missing";
  const isParallel = data.type === "builtin.parallel";
  const isForeach = data.type === "builtin.foreach";
  const isHorizontal = data.flowDirection === "horizontal";
  const targetOnLeft = isHorizontal || data.targetSide === "left";
  const sourceHandles = data.sourceHandles;
  const connection = useContext(WorkflowCanvasConnectionContext);
  const readOnly = connection?.readOnly ?? false;
  const canAddAfter =
    !readOnly &&
    !isMissing &&
    (data.kind === "trigger" ||
      (data.kind === "step" &&
        (sourceHandles.length === 0 || isParallel || isForeach)));
  const canAddBranchStep = !readOnly && data.kind === "step" && !isMissing;
  const canEditNode = !readOnly && data.kind === "step" && !isMissing;
  const canMakeForeachFirst =
    canEditNode &&
    typeof data.foreachParentId === "string" &&
    !data.isForeachFirstBodyStep;
  const parallelRail = parallelRailMetrics(sourceHandles);
  return (
    <div
      role="group"
      aria-label={`Workflow canvas node ${data.label}`}
      data-workflow-canvas-node-id={data.id}
      data-workflow-run-status={data.runStatus}
      className={cn(
        "relative w-[250px] cursor-grab overflow-visible rounded-md border bg-paper px-3.5 pb-4 pt-3 text-left shadow-sm transition-colors active:cursor-grabbing",
        runStatusCardClass(data.runStatus),
        selected && !data.runStatus && "border-ink",
        !selected && !data.runStatus && "border-paper-rule hover:border-ink-faint",
        selected && data.runStatus && "ring-1 ring-ink/30",
        data.runCurrent && "ring-1 ring-signal-blue",
        isTrigger && "w-[190px] cursor-default bg-paper-sunk",
        isMissing &&
          "w-[190px] cursor-default border-destructive/60 bg-destructive/5",
      )}
      title={data.warning}
      style={
        data.kind === "step" && typeof data.canvasWidth === "number"
          ? {
              width: data.canvasWidth,
              minHeight:
                typeof data.canvasHeight === "number"
                  ? data.canvasHeight
                  : undefined,
            }
          : undefined
      }
    >
      {data.runStatus && (
        <RunStatusCornerMark status={data.runStatus} current={data.runCurrent} />
      )}
      {!isMissing && (
        <Handle
          id="source"
          type="source"
          position={isHorizontal ? Position.Right : Position.Bottom}
          isConnectable={
            !readOnly &&
            data.kind === "step" &&
            (sourceHandles.length === 0 || isParallel || isForeach)
          }
          aria-label={`${data.id} source handle`}
          title="Drag to connect this step"
          style={
            isHorizontal
              ? WORKFLOW_RIGHT_SEQUENCE_SOURCE_HANDLE_STYLE
              : WORKFLOW_SEQUENCE_SOURCE_HANDLE_STYLE
          }
        />
      )}
      {!isTrigger && (
        <Handle
          id="target"
          type="target"
          position={targetOnLeft ? Position.Left : Position.Top}
          isConnectable={!readOnly && !isMissing}
          aria-label={`${data.id} target handle`}
          data-workflow-target-handle={data.id}
          style={
            targetOnLeft
              ? WORKFLOW_LEFT_TARGET_HANDLE_STYLE
              : WORKFLOW_TARGET_HANDLE_STYLE
          }
          onClick={(event: MouseEvent) => {
            if (readOnly) return;
            event.stopPropagation();
            connection?.completeConnection(data.id);
          }}
        />
      )}
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowNodeTypeIcon data={data} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[15px] font-semibold leading-5",
            isMissing && "text-destructive",
          )}
        >
          {data.label}
        </span>
        {selected && canEditNode && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {canMakeForeachFirst && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Make workflow step ${data.id} the first loop body step`}
                title="Make first in loop body"
                className="nodrag size-7 text-ink-faint hover:text-signal-blue"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  connection?.makeForeachBodyFirst(
                    data.foreachParentId as string,
                    data.id,
                  );
                }}
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Clone workflow step ${data.id}`}
              className="nodrag size-7 text-ink-faint hover:text-ink"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                connection?.cloneNode(data.id);
              }}
            >
              <Copy className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete workflow step ${data.id}`}
              className="nodrag size-7 text-ink-faint hover:text-destructive"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                connection?.deleteNode(data.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <div className="mt-2 line-clamp-2 min-h-[34px] text-[13px] leading-[17px] text-ink-soft">
        {data.summary ?? data.id}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {data.isForeachFirstBodyStep && (
          <Badge variant="outline">Loop start</Badge>
        )}
        {data.runStatus && (
          <Badge variant={runStatusBadgeVariant(data.runStatus)}>
            {data.runCurrent ? `current ${data.runStatus}` : data.runStatus}
          </Badge>
        )}
        {data.badges.slice(0, 3).map((badge) => (
          <span
            key={badge}
            className={cn(
              "inline-flex max-w-full items-center rounded border px-2 py-0.5 text-[11px] leading-4",
              isMissing
                ? "border-destructive/50 bg-destructive/10 text-destructive"
                : "border-paper-rule bg-paper-sunk text-ink-muted",
            )}
          >
            {badge}
          </span>
        ))}
      </div>
      {isParallel && parallelRail && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10">
          <div
            className="absolute h-px bg-ink-faint/65"
            style={{
              left: "100%",
              top: `${parallelRail.trunkTop}px`,
              width: PARALLEL_RAIL_OFFSET,
            }}
          />
          <div
            className="absolute w-px bg-ink-faint/65"
            style={{
              left: `calc(100% + ${PARALLEL_RAIL_OFFSET}px)`,
              top: `${parallelRail.top}px`,
              height: `${parallelRail.height}px`,
            }}
          />
        </div>
      )}
      {sourceHandles.map((handle, index) => {
        const routeLabel = workflowRouteLabel(handle.id, handle.label);
        const routeColor = handle.color ?? "var(--signal-blue)";
        if (isParallel) {
          const top =
            typeof handle.offsetPx === "number"
              ? `${handle.offsetPx}px`
              : `${sourceHandleTop(index, sourceHandles.length)}%`;
          return (
            <div key={handle.id}>
              <Handle
                id={handle.id}
                type="source"
                position={Position.Right}
                isConnectable
                aria-label={`${data.id} ${routeLabel} source handle`}
                data-workflow-source-handle={`${data.id}:${handle.id}`}
                title={`Drag to connect the ${routeLabel} route`}
                style={{
                  ...WORKFLOW_PARALLEL_SOURCE_HANDLE_STYLE,
                  ...(connection?.pending?.sourceId === data.id &&
                  connection.pending.sourceHandle === handle.id
                    ? WORKFLOW_PENDING_SOURCE_HANDLE_STYLE
                    : {}),
                  top,
                  background: routeColor,
                  boxShadow: `0 0 0 4px color-mix(in oklch, ${routeColor} 18%, transparent)`,
                }}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  connection?.beginConnection({
                    sourceId: data.id,
                    sourceHandle: handle.id,
                  });
                }}
              />
              {canAddBranchStep && (
                <div
                  className="absolute z-20 flex -translate-y-1/2 items-center gap-1"
                  style={{
                    left: `calc(100% + ${PARALLEL_RAIL_OFFSET + 16}px)`,
                    top,
                  }}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Add workflow step to ${data.id} ${routeLabel} route`}
                    data-workflow-add-branch={`${data.id}:${handle.id}`}
                    title={`Add step to ${routeLabel} route`}
                    className="nodrag size-7 cursor-cell rounded-full bg-paper p-0 text-ink-muted shadow-sm transition hover:border-signal-blue hover:bg-signal-blue/10 hover:text-signal-blue"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      connection?.openAddStepAfterNode(data.id, handle.id);
                    }}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                  <span
                    className="whitespace-nowrap rounded-full border bg-paper px-2 py-0.5 font-mono text-[10px] leading-none text-ink-muted shadow-sm"
                    style={{
                      borderColor: `color-mix(in oklch, ${routeColor} 45%, var(--paper-rule))`,
                    }}
                  >
                    {routeLabel}
                  </span>
                </div>
              )}
            </div>
          );
        }
        if (isHorizontal) {
          const top = sourceHandleTop(index, sourceHandles.length);
          return (
            <div key={handle.id}>
              <Handle
                id={handle.id}
                type="source"
                position={Position.Right}
                isConnectable
                aria-label={`${data.id} ${routeLabel} source handle`}
                data-workflow-source-handle={`${data.id}:${handle.id}`}
                title={`Drag to connect the ${routeLabel} route`}
                style={{
                  ...WORKFLOW_RIGHT_SEQUENCE_SOURCE_HANDLE_STYLE,
                  ...(connection?.pending?.sourceId === data.id &&
                  connection.pending.sourceHandle === handle.id
                    ? WORKFLOW_PENDING_SOURCE_HANDLE_STYLE
                    : {}),
                  top: `${top}%`,
                }}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  connection?.beginConnection({
                    sourceId: data.id,
                    sourceHandle: handle.id,
                  });
                }}
              />
              {canAddBranchStep && (
                <div
                  className="absolute right-[-92px] z-20 flex -translate-y-1/2 items-center gap-1"
                  style={{ top: `${top}%` }}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Add workflow step to ${data.id} ${routeLabel} route`}
                    data-workflow-add-branch={`${data.id}:${handle.id}`}
                    title={`Add step to ${routeLabel} route`}
                    className="nodrag size-7 cursor-cell rounded-full bg-paper p-0 text-ink-muted shadow-sm transition hover:border-signal-blue hover:bg-signal-blue/10 hover:text-signal-blue"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      connection?.openAddStepAfterNode(data.id, handle.id);
                    }}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                  <span className="rounded-full border border-paper-rule bg-paper px-2 py-0.5 font-mono text-[10px] leading-none text-ink-muted shadow-sm">
                    {routeLabel}
                  </span>
                </div>
              )}
            </div>
          );
        }
        if (isForeach) {
          const top = sourceHandleTop(index, sourceHandles.length);
          return (
            <div key={handle.id}>
              <Handle
                id={handle.id}
                type="source"
                position={Position.Right}
                isConnectable
                aria-label={`${data.id} ${routeLabel} source handle`}
                data-workflow-source-handle={`${data.id}:${handle.id}`}
                title={`Drag to connect the ${routeLabel} loop body`}
                style={{
                  ...WORKFLOW_RIGHT_SEQUENCE_SOURCE_HANDLE_STYLE,
                  ...(connection?.pending?.sourceId === data.id &&
                  connection.pending.sourceHandle === handle.id
                    ? WORKFLOW_PENDING_SOURCE_HANDLE_STYLE
                    : {}),
                  top: `${top}%`,
                  background: "var(--plot-red)",
                  boxShadow: "0 0 0 4px rgb(248 113 113 / 16%)",
                }}
                onClick={(event: MouseEvent) => {
                  event.stopPropagation();
                  connection?.beginConnection({
                    sourceId: data.id,
                    sourceHandle: handle.id,
                  });
                }}
              />
              {canAddBranchStep && (
                <div
                  className="absolute right-[-68px] z-20 flex -translate-y-1/2 items-center gap-1"
                  style={{ top: `${top}%` }}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Add workflow step to ${data.id} ${routeLabel} loop body`}
                    data-workflow-add-branch={`${data.id}:${handle.id}`}
                    title={`Add step to ${routeLabel} loop body`}
                    className="nodrag size-6 cursor-cell rounded-full border border-transparent bg-transparent p-0 text-plot-red shadow-none transition hover:bg-paper-sunk/70"
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      connection?.openAddStepAfterNode(data.id, handle.id);
                    }}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          );
        }
        const left = sourceHandleLeft(index, sourceHandles.length);
        return (
          <div key={handle.id}>
            <Handle
              id={handle.id}
              type="source"
              position={Position.Bottom}
              isConnectable
              aria-label={`${data.id} ${routeLabel} source handle`}
              data-workflow-source-handle={`${data.id}:${handle.id}`}
              title={`Drag to connect the ${routeLabel} route`}
              style={{
                ...WORKFLOW_SOURCE_HANDLE_STYLE,
                ...(connection?.pending?.sourceId === data.id &&
                connection.pending.sourceHandle === handle.id
                  ? WORKFLOW_PENDING_SOURCE_HANDLE_STYLE
                  : {}),
                left: `${left}%`,
              }}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                connection?.beginConnection({
                  sourceId: data.id,
                  sourceHandle: handle.id,
                });
              }}
            />
            {canAddBranchStep && (
              <div
                className="absolute bottom-[-58px] z-20 flex -translate-x-1/2 flex-col items-center gap-1"
                style={{ left: `${left}%` }}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Add workflow step to ${data.id} ${routeLabel} route`}
                  data-workflow-add-branch={`${data.id}:${handle.id}`}
                  title={`Add step to ${routeLabel} route`}
                  className="nodrag size-7 cursor-cell rounded-full bg-paper p-0 text-ink-muted shadow-sm transition hover:border-signal-blue hover:bg-signal-blue/10 hover:text-signal-blue"
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    connection?.openAddStepAfterNode(data.id, handle.id);
                  }}
                >
                  <Plus className="size-3.5" />
                </Button>
                <span className="rounded-full border border-paper-rule bg-paper px-2 py-0.5 font-mono text-[10px] leading-none text-ink-muted shadow-sm">
                  {routeLabel}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {canAddAfter && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Add workflow step after ${data.id}`}
          data-workflow-add-after={data.id}
          title="Add step after this card"
          className={cn(
            "nodrag absolute z-20 size-7 cursor-cell rounded-full bg-paper p-0 text-ink-muted shadow-sm transition hover:border-signal-blue hover:bg-signal-blue/10 hover:text-signal-blue",
            isHorizontal
              ? "right-[-36px] top-1/2 -translate-y-1/2"
              : "bottom-[-36px] left-1/2 -translate-x-1/2",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            connection?.openAddStepAfterNode(data.id);
          }}
        >
          <Plus className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function WorkflowNodeTypeIcon({ data }: { data: WorkflowCanvasNodeData }) {
  const Icon = workflowNodeIcon(data);
  const label = workflowNodeIconLabel(data);
  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded border bg-paper-sunk",
        workflowNodeIconClass(data),
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

function workflowNodeIcon(data: WorkflowCanvasNodeData): LucideIcon {
  if (data.kind === "missing") return AlertCircle;
  if (data.kind === "trigger") return WorkflowIcon;
  if (data.type === "agent.call") return Bot;
  if (data.type === "mcp.tool") return Wrench;
  if (data.type === "builtin.if" || data.type === "builtin.switch") {
    return GitBranch;
  }
  if (data.type === "builtin.foreach") return RefreshCw;
  if (data.type === "builtin.parallel") return ListRestart;
  if (data.type === "builtin.set") return Braces;
  if (isWorkflowTransformNodeType(data.type) || data.type === "builtin.python") {
    return Code2;
  }
  if (data.type?.startsWith("builtin.log.")) return ScrollText;
  if (data.type === "builtin.throw_error") return XCircle;
  if (data.type === "builtin.sleep") return Clock3;
  if (data.type === "builtin.exit") return CheckCircle2;
  return WorkflowIcon;
}

function workflowNodeIconLabel(data: WorkflowCanvasNodeData): string {
  if (data.kind === "missing") return "Missing workflow step";
  if (data.kind === "trigger") return "Workflow trigger";
  if (data.type === "agent.call") return "Agent step";
  if (data.type === "mcp.tool") return "MCP tool step";
  if (data.type === "builtin.if" || data.type === "builtin.switch") {
    return "Branch step";
  }
  if (data.type === "builtin.foreach") return "Loop step";
  if (data.type === "builtin.parallel") return "Parallel step";
  if (data.type === "builtin.set") return "Set variable step";
  if (isWorkflowTransformNodeType(data.type)) return "Transformer step";
  if (data.type === "builtin.python") return "Python step";
  if (data.type?.startsWith("builtin.log.")) return "Log step";
  if (data.type === "builtin.throw_error") return "Error step";
  if (data.type === "builtin.sleep") return "Delay step";
  if (data.type === "builtin.exit") return "Exit step";
  return "Workflow step";
}

function workflowNodeIconClass(data: WorkflowCanvasNodeData): string {
  if (data.kind === "missing") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (data.kind === "trigger") {
    return "border-signal-green/30 bg-signal-green/10 text-signal-green";
  }
  if (
    data.type === "builtin.if" ||
    data.type === "builtin.switch" ||
    data.type === "builtin.foreach" ||
    data.type === "builtin.parallel"
  ) {
    return "border-plot-red/35 bg-plot-red/10 text-plot-red";
  }
  if (
    data.type === "agent.call" ||
    data.type === "mcp.tool" ||
    data.type === "builtin.python"
  ) {
    return "border-signal-blue/30 bg-signal-blue/10 text-signal-blue";
  }
  if (data.type?.startsWith("builtin.log.")) {
    return "border-signal-green/30 bg-signal-green/10 text-signal-green";
  }
  if (data.type === "builtin.throw_error") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (data.type === "builtin.sleep") {
    return "border-signal-amber/35 bg-signal-amber/10 text-signal-amber";
  }
  if (data.type === "builtin.exit") {
    return "border-signal-green/30 bg-signal-green/10 text-signal-green";
  }
  return "border-paper-rule text-ink-muted";
}

const NODE_TYPES = {
  workflowStep: WorkflowStepNode,
  workflowTrigger: WorkflowTriggerNode,
  workflowMissing: WorkflowMissingNode,
  workflowGroup: WorkflowGroupNode,
};

const PARALLEL_RAIL_OFFSET = 56;

const WORKFLOW_TARGET_HANDLE_STYLE = {
  width: 8,
  height: 8,
  top: -4,
  border: "none",
  borderRadius: 9999,
  background: "var(--ink-faint)",
  boxShadow: "0 0 0 4px rgb(148 163 184 / 14%)",
  cursor: "crosshair",
  zIndex: 30,
};

const WORKFLOW_LEFT_TARGET_HANDLE_STYLE = {
  ...WORKFLOW_TARGET_HANDLE_STYLE,
  left: -4,
  top: "50%",
};

const WORKFLOW_SOURCE_HANDLE_STYLE = {
  width: 8,
  height: 8,
  bottom: -4,
  border: "none",
  borderRadius: 9999,
  background: "var(--ink-faint)",
  boxShadow: "0 0 0 4px rgb(148 163 184 / 14%)",
  cursor: "crosshair",
  zIndex: 30,
};

const WORKFLOW_SEQUENCE_SOURCE_HANDLE_STYLE = {
  ...WORKFLOW_SOURCE_HANDLE_STYLE,
  left: "50%",
};

const WORKFLOW_RIGHT_SEQUENCE_SOURCE_HANDLE_STYLE = {
  ...WORKFLOW_SOURCE_HANDLE_STYLE,
  right: -4,
  left: "auto",
  bottom: "auto",
  top: "50%",
};

const WORKFLOW_PARALLEL_SOURCE_HANDLE_STYLE = {
  ...WORKFLOW_SOURCE_HANDLE_STYLE,
  right: -(PARALLEL_RAIL_OFFSET + 4),
  left: "auto",
  bottom: "auto",
};

const WORKFLOW_PENDING_SOURCE_HANDLE_STYLE = {
  background: "var(--signal-blue)",
};

function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Zoom in"
        onClick={() => void zoomIn({ duration: 150 })}
      >
        <Plus className="size-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Zoom out"
        onClick={() => void zoomOut({ duration: 150 })}
      >
        <Minus className="size-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Fit workflow canvas"
        onClick={() =>
          void fitView({ padding: 0.18, maxZoom: 1, duration: 200 })
        }
      >
        <Maximize className="size-4" />
      </Button>
    </div>
  );
}

function CanvasLayoutControls({
  disabled,
  onBeautifyLayout,
}: {
  disabled?: boolean;
  onBeautifyLayout?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="Beautify workflow layout"
      title="Beautify workflow layout"
      disabled={disabled || !onBeautifyLayout}
      className="rounded-full bg-paper text-ink-muted shadow-sm transition hover:border-signal-blue hover:bg-signal-blue/10 hover:text-signal-blue"
      onClick={onBeautifyLayout}
    >
      <RefreshCw className="size-4" />
    </Button>
  );
}

function CanvasAddControls({
  nodes,
  onAddStep,
}: {
  nodes: WorkflowCanvasNode[];
  onAddStep?: (
    afterNodeId: string | null,
    sourceHandle?: string,
    placement?: WorkflowCanvasAddPlacement,
  ) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="Add workflow step"
      title="Add a new card in the visible canvas"
      className="cursor-cell rounded-full bg-paper text-ink-muted shadow-sm transition hover:border-signal-blue hover:bg-signal-blue/10 hover:text-signal-blue"
      onClick={(event) =>
        onAddStep?.(
          null,
          undefined,
          workflowViewportAddPlacement(
            event.currentTarget,
            nodes,
            screenToFlowPosition,
          ),
        )
      }
    >
      <Plus className="size-4" />
    </Button>
  );
}

function CanvasOrderControls({
  selectedIndex,
  totalSteps,
  onMoveSelectedUp,
  onMoveSelectedDown,
}: {
  selectedIndex: number | null;
  totalSteps: number;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Move selected workflow node up"
        disabled={
          selectedIndex === null || selectedIndex <= 0 || !onMoveSelectedUp
        }
        onClick={onMoveSelectedUp}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Move selected workflow node down"
        disabled={
          selectedIndex === null ||
          selectedIndex >= totalSteps - 1 ||
          !onMoveSelectedDown
        }
        onClick={onMoveSelectedDown}
      >
        <ArrowDown className="size-4" />
      </Button>
    </div>
  );
}

function CanvasEdgeControls({
  selectedEdge,
  onRemoveSelectedEdge,
}: {
  selectedEdge: WorkflowCanvasEdgeSelection | null;
  onRemoveSelectedEdge?: (edge: WorkflowCanvasEdgeSelection) => void;
}) {
  if (!selectedEdge) return null;
  const removable =
    isRemovableCanvasEdge(selectedEdge) && !!onRemoveSelectedEdge;

  return (
    <div className="border border-paper-rule bg-paper px-2.5 py-2">
      <SectionEyebrow>Edge</SectionEyebrow>
      <div className="mt-1 max-w-36 truncate font-mono text-[10px] text-ink-faint">
        {selectedEdge?.kind ?? "none"}
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="mt-2"
        aria-label="Remove selected workflow edge"
        disabled={!removable}
        onClick={() => {
          if (selectedEdge) onRemoveSelectedEdge?.(selectedEdge);
        }}
      >
        Remove
      </Button>
    </div>
  );
}

function WorkflowCanvasInner({
  projection,
  readOnly = false,
  allowNodeRelocation = !readOnly,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onConnectReference,
  onRemoveSelectedEdge,
  onMoveSelectedUp,
  onMoveSelectedDown,
  onCloneNode,
  onDeleteNode,
  onMakeForeachBodyFirst,
  onNodePositionChange,
  onBeautifyLayout,
  onAddStep,
}: {
  projection: WorkflowGraphProjection;
  readOnly?: boolean;
  allowNodeRelocation?: boolean;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge?: (edge: WorkflowCanvasEdgeSelection | null) => void;
  onConnectReference?: (connection: WorkflowCanvasConnection) => void;
  onRemoveSelectedEdge?: (edge: WorkflowCanvasEdgeSelection) => void;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
  onCloneNode?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onMakeForeachBodyFirst?: (foreachNodeId: string, bodyNodeId: string) => void;
  onNodePositionChange?: (
    nodeId: string,
    position: { x: number; y: number },
  ) => void;
  onBeautifyLayout?: () => void;
  onAddStep?: (
    afterNodeId: string | null,
    sourceHandle?: string,
    placement?: WorkflowCanvasAddPlacement,
  ) => void;
}) {
  const [pendingConnection, setPendingConnection] =
    useState<WorkflowCanvasPendingConnection | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const projectedNodes: WorkflowCanvasNode[] = useMemo(
    () =>
      projection.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
      })),
    [projection.nodes, selectedNodeId],
  );
  const [localNodes, setLocalNodes] =
    useState<WorkflowCanvasNode[]>(projectedNodes);
  useEffect(() => {
    if (draggingNodeId) return;
    setLocalNodes(projectedNodes);
  }, [draggingNodeId, projectedNodes]);
  const nodes = draggingNodeId ? localNodes : projectedNodes;
  const edges = projection.edges.map((edge) =>
    edge.id === selectedEdgeId
      ? {
          ...edge,
          type: "workflowCanvasEdge",
          selected: true,
          style: {
            ...edge.style,
            strokeWidth: 2.4,
          },
        }
      : { ...edge, type: "workflowCanvasEdge" },
  );
  const selectedEdge = selectedEdgeId
    ? edgeSelectionFromEdge(
        projection.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
      )
    : null;
  const stepNodes = projection.nodes.filter(
    (node) => node.data.kind === "step",
  );
  const visibleCanvasNodeCount = projection.nodes.filter(
    (node) => node.data.kind !== "group",
  ).length;
  const selectedStepIndex = selectedNodeId
    ? stepNodes.findIndex((node) => node.id === selectedNodeId)
    : -1;
  const connectionContext = useMemo<WorkflowCanvasConnectionContextValue>(
    () => ({
      readOnly,
      pending: pendingConnection,
      beginConnection: (connection) => setPendingConnection(connection),
      completeConnection: (targetId) => {
        if (readOnly) return;
        if (!pendingConnection) return;
        onConnectReference?.({
          sourceId: pendingConnection.sourceId,
          targetId,
          sourceHandle: pendingConnection.sourceHandle,
        });
        setPendingConnection(null);
      },
      openAddStepAfterNode: (nodeId, sourceHandle, placement) =>
        !readOnly &&
        onAddStep?.(
            nodeId,
            sourceHandle,
            placement ?? workflowNodeAddPlacement(nodes, nodeId, sourceHandle),
        ),
      cloneNode: (nodeId) => !readOnly && onCloneNode?.(nodeId),
      deleteNode: (nodeId) => !readOnly && onDeleteNode?.(nodeId),
      makeForeachBodyFirst: (foreachNodeId, bodyNodeId) =>
        !readOnly && onMakeForeachBodyFirst?.(foreachNodeId, bodyNodeId),
      removeEdge: readOnly ? undefined : onRemoveSelectedEdge,
    }),
    [
      nodes,
      onAddStep,
      onCloneNode,
      onConnectReference,
      onDeleteNode,
      onMakeForeachBodyFirst,
      onRemoveSelectedEdge,
      pendingConnection,
      readOnly,
    ],
  );

  return (
    <WorkflowCanvasConnectionContext.Provider value={connectionContext}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={allowNodeRelocation}
        nodesConnectable={!readOnly}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        minZoom={0.08}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        onNodeClick={(_, node) => {
          onSelectNode(node.id);
          onSelectEdge?.(null);
        }}
        onNodesChange={(changes) => {
          setLocalNodes(
            (current) =>
              applyNodeChanges(changes, current) as WorkflowCanvasNode[],
          );
        }}
        onNodeDragStart={(_, node) => {
          if (!allowNodeRelocation) return;
          if (node.data.kind !== "step") return;
          setDraggingNodeId(node.id);
        }}
        onNodeDragStop={(_, node) => {
          if (!allowNodeRelocation) return;
          if (node.data.kind !== "step") return;
          setDraggingNodeId(null);
          onNodePositionChange?.(node.id, node.position);
        }}
        onEdgeClick={(_, edge) => onSelectEdge?.(edgeSelectionFromEdge(edge))}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge?.(null);
        }}
        onConnect={(connection) => {
          const next = connectionFromReactFlow(connection);
          if (!readOnly && next) onConnectReference?.(next);
          setPendingConnection(null);
        }}
        className="workflow-canvas"
      >
        <Panel position="top-left">
          <div className="border border-paper-rule bg-paper px-2.5 py-2">
            <SectionEyebrow>Workflow Canvas</SectionEyebrow>
            <div className="mt-1 flex gap-1.5">
              <Badge variant="outline">{visibleCanvasNodeCount} nodes</Badge>
              <Badge variant="outline">{projection.edges.length} edges</Badge>
              {projection.warnings.length > 0 && (
                <Badge variant="destructive">
                  {projection.warnings.length} warnings
                </Badge>
              )}
            </div>
          </div>
        </Panel>
        <Panel position="top-right">
          <div className="flex flex-col gap-2">
            <CanvasLayoutControls
              disabled={stepNodes.length === 0}
              onBeautifyLayout={onBeautifyLayout}
            />
            <CanvasControls />
            {!readOnly && (
              <>
                <CanvasOrderControls
                  selectedIndex={
                    selectedStepIndex >= 0 ? selectedStepIndex : null
                  }
                  totalSteps={stepNodes.length}
                  onMoveSelectedUp={onMoveSelectedUp}
                  onMoveSelectedDown={onMoveSelectedDown}
                />
                <CanvasEdgeControls
                  selectedEdge={selectedEdge}
                  onRemoveSelectedEdge={onRemoveSelectedEdge}
                />
              </>
            )}
          </div>
        </Panel>
        {!readOnly && (
          <Panel position="bottom-left">
            <CanvasAddControls nodes={nodes} onAddStep={onAddStep} />
          </Panel>
        )}
      </ReactFlow>
    </WorkflowCanvasConnectionContext.Provider>
  );
}

export function WorkflowCanvas(props: {
  projection: WorkflowGraphProjection;
  readOnly?: boolean;
  allowNodeRelocation?: boolean;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge?: (edge: WorkflowCanvasEdgeSelection | null) => void;
  onConnectReference?: (connection: WorkflowCanvasConnection) => void;
  onRemoveSelectedEdge?: (edge: WorkflowCanvasEdgeSelection) => void;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
  onCloneNode?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onMakeForeachBodyFirst?: (foreachNodeId: string, bodyNodeId: string) => void;
  onNodePositionChange?: (
    nodeId: string,
    position: { x: number; y: number },
  ) => void;
  onBeautifyLayout?: () => void;
  onAddStep?: (
    afterNodeId: string | null,
    sourceHandle?: string,
    placement?: WorkflowCanvasAddPlacement,
  ) => void;
}) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function sourceHandleLeft(index: number, total: number): number {
  if (total <= 1) return 50;
  return 22 + index * (56 / Math.max(1, total - 1));
}

function sourceHandleTop(index: number, total: number): number {
  if (total <= 1) return 50;
  return ((index + 0.5) / total) * 100;
}

function parallelRailMetrics(
  handles: WorkflowCanvasNodeData["sourceHandles"],
): { top: number; height: number; trunkTop: number } | null {
  const offsets = handles
    .map((handle) => handle.offsetPx)
    .filter((offset): offset is number => typeof offset === "number");
  if (offsets.length === 0) return null;
  const top = Math.min(...offsets);
  const bottom = Math.max(...offsets);
  return {
    top,
    height: Math.max(1, bottom - top),
    trunkTop: offsets[0] ?? top,
  };
}

function workflowRouteLabel(handleId: string, fallback: string): string {
  if (handleId === "then") return "true";
  if (handleId === "else") return "false";
  if (handleId === "default") return "default";
  if (handleId.startsWith("case:")) return fallback;
  return fallback;
}

function connectionFromReactFlow(
  connection: Connection,
): WorkflowCanvasConnection | null {
  if (!connection.source || !connection.target) return null;
  return {
    sourceId: connection.source,
    targetId: connection.target,
    sourceHandle: connection.sourceHandle ?? null,
  };
}

function edgeSelectionFromEdge(
  edge: Edge | null,
): WorkflowCanvasEdgeSelection | null {
  if (!edge) return null;
  return {
    id: edge.id,
    sourceId: edge.source,
    targetId: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetRef: edgeTargetRef(edge.data),
    kind: edgeKind(edge.data),
  };
}

function isRemovableCanvasEdge(edge: WorkflowCanvasEdgeSelection): boolean {
  return (
    edge.kind === "sequence" ||
    edge.kind === "then" ||
    edge.kind === "else" ||
    edge.kind === "body" ||
    edge.kind === "default" ||
    edge.kind?.startsWith("case:") === true ||
    edge.kind?.startsWith("branch:") === true ||
    edge.kind?.startsWith("route:") === true
  );
}

function edgeKind(data: unknown): string | null {
  return isRecord(data) && typeof data["kind"] === "string"
    ? data["kind"]
    : null;
}

function edgeTargetRef(data: unknown): string | null {
  return isRecord(data) && typeof data["targetRef"] === "string"
    ? data["targetRef"]
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKFLOW_NODE_WIDTH = 220;
const WORKFLOW_NODE_HEIGHT = 132;
const WORKFLOW_NODE_ADD_X_GAP = 120;
const WORKFLOW_PARALLEL_BRANCH_ADD_X_GAP = 150;
const WORKFLOW_VIEWPORT_PADDING = 44;
const WORKFLOW_VIEWPORT_ADD_Y_GAP = 84;

function workflowNodeAddPlacement(
  nodes: WorkflowCanvasNode[],
  nodeId: string | null,
  sourceHandle?: string,
): WorkflowCanvasAddPlacement | undefined {
  if (!nodeId) return undefined;
  const source = nodes.find((node) => node.id === nodeId);
  if (!source) return undefined;

  if (source.data.type === "builtin.parallel" && sourceHandle) {
    const handle = source.data.sourceHandles.find(
      (item) => item.id === sourceHandle,
    );
    if (typeof handle?.offsetPx === "number") {
      return workflowRowAddPlacement(nodes, {
        x:
          source.position.x +
          workflowCanvasNodeWidth(source) +
          WORKFLOW_PARALLEL_BRANCH_ADD_X_GAP,
        y:
          source.position.y +
          handle.offsetPx -
          workflowCanvasNodeHeight(source) / 2,
      });
    }
  }

  if (source.data.flowDirection === "horizontal") {
    return workflowRowAddPlacement(nodes, {
      x:
        source.position.x +
        workflowCanvasNodeWidth(source) +
        WORKFLOW_NODE_ADD_X_GAP,
      y: source.position.y,
    });
  }

  return undefined;
}

function workflowRowAddPlacement(
  nodes: WorkflowCanvasNode[],
  start: { x: number; y: number },
): WorkflowCanvasAddPlacement {
  let x = start.x;
  const y = start.y;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    if (!overlapsAnyNode(x, y, nodes)) return { position: { x, y } };
    x += WORKFLOW_NODE_WIDTH + WORKFLOW_NODE_ADD_X_GAP;
  }
  return { position: { x, y } };
}

function workflowViewportAddPlacement(
  control: HTMLElement,
  nodes: WorkflowCanvasNode[],
  screenToFlowPosition: (position: { x: number; y: number }) => {
    x: number;
    y: number;
  },
): WorkflowCanvasAddPlacement | undefined {
  const canvas = control.closest(".workflow-canvas");
  if (!(canvas instanceof HTMLElement)) return undefined;
  const rect = canvas.getBoundingClientRect();
  const topLeft = screenToFlowPosition({ x: rect.left, y: rect.top });
  const bottomRight = screenToFlowPosition({
    x: rect.left + rect.width,
    y: rect.top + rect.height,
  });
  const minX = Math.min(topLeft.x, bottomRight.x);
  const maxX = Math.max(topLeft.x, bottomRight.x);
  const minY = Math.min(topLeft.y, bottomRight.y);
  const maxY = Math.max(topLeft.y, bottomRight.y);
  const centerX = (minX + maxX) / 2;
  const visibleNodes = nodes.filter((node) =>
    boxesOverlap(
      node.position.x,
      node.position.y,
      WORKFLOW_NODE_WIDTH,
      WORKFLOW_NODE_HEIGHT,
      minX,
      minY,
      maxX - minX,
      maxY - minY,
    ),
  );
  const firstY =
    visibleNodes.length > 0
      ? Math.max(
          ...visibleNodes.map(
            (node) =>
              node.position.y +
              WORKFLOW_NODE_HEIGHT +
              WORKFLOW_VIEWPORT_ADD_Y_GAP,
          ),
        )
      : minY + WORKFLOW_VIEWPORT_PADDING;
  const x = clamp(
    centerX - WORKFLOW_NODE_WIDTH / 2,
    minX + WORKFLOW_VIEWPORT_PADDING,
    maxX - WORKFLOW_NODE_WIDTH - WORKFLOW_VIEWPORT_PADDING,
  );
  let y = Math.max(firstY, minY + WORKFLOW_VIEWPORT_PADDING);
  for (let attempt = 0; attempt < 18; attempt += 1) {
    if (!overlapsAnyNode(x, y, nodes)) return { position: { x, y } };
    y += WORKFLOW_NODE_HEIGHT + WORKFLOW_VIEWPORT_ADD_Y_GAP;
  }
  return { position: { x, y } };
}

function overlapsAnyNode(
  x: number,
  y: number,
  nodes: WorkflowCanvasNode[],
): boolean {
  return nodes.some((node) =>
    boxesOverlap(
      x,
      y,
      WORKFLOW_NODE_WIDTH,
      WORKFLOW_NODE_HEIGHT,
      node.position.x,
      node.position.y,
      WORKFLOW_NODE_WIDTH,
      WORKFLOW_NODE_HEIGHT,
    ),
  );
}

function workflowCanvasNodeWidth(node: WorkflowCanvasNode): number {
  return typeof node.data.canvasWidth === "number"
    ? node.data.canvasWidth
    : WORKFLOW_NODE_WIDTH;
}

function workflowCanvasNodeHeight(node: WorkflowCanvasNode): number {
  return typeof node.data.canvasHeight === "number"
    ? node.data.canvasHeight
    : WORKFLOW_NODE_HEIGHT;
}

function boxesOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return value;
  return Math.min(Math.max(value, min), max);
}

function runStatusBadgeVariant(
  status: NonNullable<WorkflowCanvasNodeData["runStatus"]>,
): "healthy" | "destructive" | "working" | "attention" | "outline" {
  if (status === "succeeded") return "healthy";
  if (status === "failed") return "destructive";
  if (status === "running" || status === "queued") return "working";
  if (status === "canceled" || status === "skipped") return "attention";
  return "outline";
}

function runStatusCardClass(
  status: WorkflowCanvasNodeData["runStatus"],
): string | false {
  if (status === "succeeded")
    return "border-signal-green shadow-[0_0_0_1px_rgb(16_185_129_/_35%)]";
  if (status === "failed")
    return "border-destructive shadow-[0_0_0_1px_rgb(239_68_68_/_35%)]";
  if (status === "running" || status === "queued")
    return "border-signal-blue shadow-[0_0_0_1px_rgb(59_130_246_/_35%)]";
  if (status === "canceled" || status === "skipped")
    return "border-signal-amber shadow-[0_0_0_1px_rgb(245_158_11_/_25%)]";
  return false;
}

function RunStatusCornerMark({
  status,
  current,
}: {
  status: NonNullable<WorkflowCanvasNodeData["runStatus"]>;
  current?: boolean;
}) {
  const iconClass = "size-4";
  if (status === "succeeded") {
    return (
      <span
        aria-label="Step succeeded"
        className="absolute -right-2 -top-2 z-20 flex size-6 items-center justify-center rounded-full bg-signal-green text-paper shadow-sm"
      >
        <CheckCircle2 className={iconClass} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-label="Step failed"
        className="absolute -right-2 -top-2 z-20 flex size-6 items-center justify-center rounded-full bg-destructive text-paper shadow-sm"
      >
        <XCircle className={iconClass} />
      </span>
    );
  }
  if (status === "running" || status === "queued") {
    return (
      <span
        aria-label={current ? "Current step running" : "Step running"}
        className="absolute -right-2 -top-2 z-20 flex size-6 items-center justify-center rounded-full border border-signal-blue bg-paper shadow-sm"
      >
        <span className="relative size-4 rounded-full border-2 border-signal-blue bg-paper">
          <span className="absolute inset-y-0 left-0 w-1/2 rounded-l-full bg-signal-blue" />
        </span>
      </span>
    );
  }
  return (
    <span
      aria-label={`Step ${status}`}
      className="absolute -right-2 -top-2 z-20 flex size-6 items-center justify-center rounded-full bg-signal-amber text-paper shadow-sm"
    >
      <AlertCircle className={iconClass} />
    </span>
  );
}
