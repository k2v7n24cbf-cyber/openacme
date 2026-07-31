import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Maximize,
  Minus,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
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

interface WorkflowCanvasPendingConnection {
  sourceId: string;
  sourceHandle: string;
}

interface WorkflowCanvasPointerDrag {
  pointerId: number;
  clientX: number;
  clientY: number;
  startPosition: { x: number; y: number };
}

interface WorkflowCanvasConnectionContextValue {
  pending: WorkflowCanvasPendingConnection | null;
  beginConnection: (connection: WorkflowCanvasPendingConnection) => void;
  completeConnection: (targetId: string) => void;
  openAddStepAfterNode: (nodeId: string | null, sourceHandle?: string) => void;
  cloneNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  moveNodePosition: (
    nodeId: string,
    position: { x: number; y: number },
  ) => void;
}

const WorkflowCanvasConnectionContext =
  createContext<WorkflowCanvasConnectionContextValue | null>(null);

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

function WorkflowCanvasNodeCard({
  data,
  selected,
}: {
  data: WorkflowCanvasNodeData;
  selected?: boolean;
}) {
  const isTrigger = data.kind === "trigger";
  const isMissing = data.kind === "missing";
  const sourceHandles = data.sourceHandles;
  const connection = useContext(WorkflowCanvasConnectionContext);
  const canAddAfter =
    !isMissing &&
    (data.kind === "trigger" ||
      (data.kind === "step" && sourceHandles.length === 0));
  const canAddBranchStep = data.kind === "step" && !isMissing;
  const canEditNode = data.kind === "step" && !isMissing;
  const { getZoom } = useReactFlow();
  const dragRef = useRef<WorkflowCanvasPointerDrag | null>(null);
  return (
    <div
      role="group"
      aria-label={`Workflow canvas node ${data.label}`}
      data-workflow-canvas-node-id={data.id}
      data-workflow-run-status={data.runStatus}
      className={cn(
        "relative w-[220px] cursor-grab overflow-visible border bg-paper px-3 pb-4 pt-2.5 text-left shadow-sm transition-colors active:cursor-grabbing",
        selected ? "border-ink" : "border-paper-rule hover:border-ink-faint",
        data.runCurrent && "ring-1 ring-signal-blue",
        isTrigger && "w-[190px] cursor-default bg-paper-sunk",
        isMissing &&
          "w-[190px] cursor-default border-destructive/60 bg-destructive/5",
      )}
      title={data.warning}
      draggable={data.kind === "step"}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        if (isWorkflowHandleTarget(event.target)) {
          event.preventDefault();
          return;
        }
        if (data.kind !== "step") return;
        const startPosition = data.canvasPosition;
        if (!startPosition) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", data.id);
        dragRef.current = {
          pointerId: -2,
          clientX: event.clientX,
          clientY: event.clientY,
          startPosition,
        };
      }}
      onDragEnd={(event: DragEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== -2) return;
        const zoom = getZoom() || 1;
        connection?.moveNodePosition(data.id, {
          x: drag.startPosition.x + (event.clientX - drag.clientX) / zoom,
          y: drag.startPosition.y + (event.clientY - drag.clientY) / zoom,
        });
        dragRef.current = null;
      }}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (isWorkflowHandleTarget(event.target)) return;
        if (data.kind !== "step") return;
        const startPosition = data.canvasPosition;
        if (!startPosition) return;
        dragRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          startPosition,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const zoom = getZoom() || 1;
        connection?.moveNodePosition(data.id, {
          x: drag.startPosition.x + (event.clientX - drag.clientX) / zoom,
          y: drag.startPosition.y + (event.clientY - drag.clientY) / zoom,
        });
      }}
      onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          dragRef.current = null;
        }
      }}
      onPointerCancel={(event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) {
          dragRef.current = null;
        }
      }}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (isWorkflowHandleTarget(event.target)) return;
        if (data.kind !== "step") return;
        const startPosition = data.canvasPosition;
        if (!startPosition) return;
        dragRef.current = {
          pointerId: -1,
          clientX: event.clientX,
          clientY: event.clientY,
          startPosition,
        };
      }}
      onMouseMove={(event: MouseEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== -1) return;
        const zoom = getZoom() || 1;
        connection?.moveNodePosition(data.id, {
          x: drag.startPosition.x + (event.clientX - drag.clientX) / zoom,
          y: drag.startPosition.y + (event.clientY - drag.clientY) / zoom,
        });
      }}
      onMouseUp={() => {
        if (dragRef.current?.pointerId === -1) dragRef.current = null;
      }}
    >
      {!isMissing && (
        <Handle
          id="source"
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          aria-hidden
          style={WORKFLOW_SEQUENCE_SOURCE_HANDLE_STYLE}
        />
      )}
      {!isTrigger && (
        <Handle
          id="target"
          type="target"
          position={Position.Top}
          isConnectable={!isMissing}
          aria-label={`${data.id} target handle`}
          data-workflow-target-handle={data.id}
          style={WORKFLOW_TARGET_HANDLE_STYLE}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            connection?.completeConnection(data.id);
          }}
        />
      )}
      <div className="flex min-w-0 items-center gap-2">
        {typeof data.index === "number" && (
          <span className="font-mono text-[10px] text-ink-faint">
            {String(data.index + 1).padStart(2, "0")}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            isMissing && "text-destructive",
          )}
        >
          {data.label}
        </span>
        {selected && canEditNode && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Clone workflow step ${data.id}`}
              className="size-7 text-ink-faint hover:text-ink"
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
              className="size-7 text-ink-faint hover:text-destructive"
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
      <div className="mt-2 flex flex-wrap gap-1.5">
        {data.runStatus && (
          <Badge variant={runStatusBadgeVariant(data.runStatus)}>
            {data.runCurrent ? `current ${data.runStatus}` : data.runStatus}
          </Badge>
        )}
        {data.badges.slice(0, 3).map((badge) => (
          <Badge key={badge} variant={isMissing ? "destructive" : "outline"}>
            {badge}
          </Badge>
        ))}
      </div>
      <div className="mt-2 truncate font-mono text-[10px] text-ink-faint">
        {data.id}
      </div>
      {sourceHandles.map((handle, index) => {
        const left = sourceHandleLeft(index, sourceHandles.length);
        const routeLabel = workflowRouteLabel(handle.id, handle.label);
        return (
          <div key={handle.id}>
            <Handle
              id={handle.id}
              type="source"
              position={Position.Bottom}
              isConnectable
              aria-label={`${data.id} ${routeLabel} source handle`}
              data-workflow-source-handle={`${data.id}:${handle.id}`}
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
                  className="size-7 rounded-full bg-paper p-0 shadow-sm"
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
          className="absolute bottom-[-36px] left-1/2 z-20 size-7 -translate-x-1/2 rounded-full bg-paper p-0 shadow-sm"
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

const NODE_TYPES = {
  workflowStep: WorkflowStepNode,
  workflowTrigger: WorkflowTriggerNode,
  workflowMissing: WorkflowMissingNode,
};

const WORKFLOW_TARGET_HANDLE_STYLE = {
  width: 7,
  height: 7,
  top: -3.5,
  border: "none",
  borderRadius: 9999,
  background: "var(--ink-faint)",
};

const WORKFLOW_SOURCE_HANDLE_STYLE = {
  width: 7,
  height: 7,
  bottom: -3.5,
  border: "none",
  borderRadius: 9999,
  background: "var(--ink-faint)",
};

const WORKFLOW_SEQUENCE_SOURCE_HANDLE_STYLE = {
  ...WORKFLOW_SOURCE_HANDLE_STYLE,
  left: "50%",
  pointerEvents: "none" as const,
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

function CanvasAddControls({
  selectedNodeId,
  onAddStep,
}: {
  selectedNodeId: string | null;
  onAddStep?: (afterNodeId: string | null, sourceHandle?: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label="Add workflow step"
      className="rounded-full bg-paper shadow-sm"
      onClick={() => onAddStep?.(selectedNodeId)}
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
    (selectedEdge.kind === "then" ||
      selectedEdge.kind === "else" ||
      selectedEdge.kind === "body") &&
    !!onRemoveSelectedEdge;

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
  onNodePositionChange,
  onAddStep,
}: {
  projection: WorkflowGraphProjection;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge?: (edge: WorkflowCanvasEdgeSelection | null) => void;
  onConnectReference?: (connection: WorkflowCanvasConnection) => void;
  onRemoveSelectedEdge?: (edge: WorkflowCanvasEdgeSelection) => void;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
  onCloneNode?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onNodePositionChange?: (
    nodeId: string,
    position: { x: number; y: number },
  ) => void;
  onAddStep?: (afterNodeId: string | null, sourceHandle?: string) => void;
}) {
  const [pendingConnection, setPendingConnection] =
    useState<WorkflowCanvasPendingConnection | null>(null);
  const nodes: WorkflowCanvasNode[] = projection.nodes.map((node) => ({
    ...node,
    selected: node.id === selectedNodeId,
  }));
  const edges = projection.edges.map((edge) =>
    edge.id === selectedEdgeId
      ? {
          ...edge,
          selected: true,
          style: {
            ...edge.style,
            strokeWidth: 2.4,
          },
        }
      : edge,
  );
  const selectedEdge = selectedEdgeId
    ? edgeSelectionFromEdge(
        projection.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
      )
    : null;
  const stepNodes = projection.nodes.filter(
    (node) => node.data.kind === "step",
  );
  const selectedStepIndex = selectedNodeId
    ? stepNodes.findIndex((node) => node.id === selectedNodeId)
    : -1;
  const connectionContext = useMemo<WorkflowCanvasConnectionContextValue>(
    () => ({
      pending: pendingConnection,
      beginConnection: (connection) => setPendingConnection(connection),
      completeConnection: (targetId) => {
        if (!pendingConnection) return;
        onConnectReference?.({
          sourceId: pendingConnection.sourceId,
          targetId,
          sourceHandle: pendingConnection.sourceHandle,
        });
        setPendingConnection(null);
      },
      openAddStepAfterNode: (nodeId, sourceHandle) =>
        onAddStep?.(nodeId, sourceHandle),
      cloneNode: (nodeId) => onCloneNode?.(nodeId),
      deleteNode: (nodeId) => onDeleteNode?.(nodeId),
      moveNodePosition: (nodeId, position) =>
        onNodePositionChange?.(nodeId, position),
    }),
    [
      onAddStep,
      onCloneNode,
      onConnectReference,
      onDeleteNode,
      onNodePositionChange,
      pendingConnection,
    ],
  );

  return (
    <WorkflowCanvasConnectionContext.Provider value={connectionContext}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable
        nodesConnectable
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
          for (const change of changes) {
            const positionChange = workflowNodePositionChange(
              change,
              projection,
            );
            if (!positionChange) continue;
            onNodePositionChange?.(positionChange.id, positionChange.position);
          }
        }}
        onNodeDragStop={(_, node) => {
          if (node.data.kind !== "step") return;
          onNodePositionChange?.(node.id, node.position);
        }}
        onEdgeClick={(_, edge) => onSelectEdge?.(edgeSelectionFromEdge(edge))}
        onPaneClick={() => onSelectEdge?.(null)}
        onConnect={(connection) => {
          const next = connectionFromReactFlow(connection);
          if (next) onConnectReference?.(next);
          setPendingConnection(null);
        }}
        className="workflow-canvas"
      >
        <Panel position="top-left">
          <div className="border border-paper-rule bg-paper px-2.5 py-2">
            <SectionEyebrow>Workflow Canvas</SectionEyebrow>
            <div className="mt-1 flex gap-1.5">
              <Badge variant="outline">{projection.nodes.length} nodes</Badge>
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
            <CanvasControls />
            <CanvasOrderControls
              selectedIndex={selectedStepIndex >= 0 ? selectedStepIndex : null}
              totalSteps={stepNodes.length}
              onMoveSelectedUp={onMoveSelectedUp}
              onMoveSelectedDown={onMoveSelectedDown}
            />
            <CanvasEdgeControls
              selectedEdge={selectedEdge}
              onRemoveSelectedEdge={onRemoveSelectedEdge}
            />
          </div>
        </Panel>
        <Panel position="bottom-left">
          <CanvasAddControls
            selectedNodeId={selectedNodeId}
            onAddStep={onAddStep}
          />
        </Panel>
      </ReactFlow>
    </WorkflowCanvasConnectionContext.Provider>
  );
}

export function WorkflowCanvas(props: {
  projection: WorkflowGraphProjection;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge?: (edge: WorkflowCanvasEdgeSelection | null) => void;
  onConnectReference?: (connection: WorkflowCanvasConnection) => void;
  onRemoveSelectedEdge?: (edge: WorkflowCanvasEdgeSelection) => void;
  onMoveSelectedUp?: () => void;
  onMoveSelectedDown?: () => void;
  onCloneNode?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onNodePositionChange?: (
    nodeId: string,
    position: { x: number; y: number },
  ) => void;
  onAddStep?: (afterNodeId: string | null, sourceHandle?: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function sourceHandleLeft(index: number, total: number): number {
  if (total <= 1) return 50;
  return 35 + index * 30;
}

function workflowRouteLabel(handleId: string, fallback: string): string {
  if (handleId === "then") return "true";
  if (handleId === "else") return "false";
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

function workflowNodePositionChange(
  change: NodeChange,
  projection: WorkflowGraphProjection,
): { id: string; position: { x: number; y: number } } | null {
  if (change.type !== "position" || !change.position) return null;
  const node = projection.nodes.find((item) => item.id === change.id);
  if (node?.data.kind !== "step") return null;
  return { id: change.id, position: change.position };
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

function isWorkflowHandleTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      "[data-workflow-source-handle], [data-workflow-target-handle]",
    )
  );
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
