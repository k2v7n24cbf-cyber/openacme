import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Braces,
  Bot,
  CheckCircle2,
  Clock3,
  Circle,
  Code2,
  Download,
  Edit3,
  GitBranch,
  ListRestart,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Send,
  Settings,
  Search,
  Square,
  Trash2,
  Upload,
  Workflow,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "@/app/components/Sidebar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import { Textarea } from "@/app/components/ui/textarea";
import { API_BASE } from "@/app/lib/api";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import { cn } from "@/app/lib/utils";
import {
  cloneWorkflowNodeAfter,
  insertWorkflowNodeAfter,
  insertWorkflowNodeFirst,
  isAgentSummary,
  isMcpToolSummary,
  moveWorkflowNode,
  removeWorkflowNode,
  setWorkflowForeachBodyFirst,
  workflowTransformPresetById,
  WORKFLOW_TRANSFORM_PRESETS,
  type WorkflowPaletteKind,
} from "@/app/workflows/authoring";
import {
  WorkflowCanvas,
  type WorkflowCanvasAddPlacement,
  type WorkflowCanvasConnection,
  type WorkflowCanvasEdgeSelection,
} from "@/app/workflows/canvas";
import {
  connectWorkflowReferenceEdge,
  connectWorkflowRouteContinuationEdge,
  firstWorkflowReferenceTarget,
  insertWorkflowReferenceEdgeTarget,
  overwriteWorkflowReferenceEdge,
  overwriteWorkflowRouteContinuationEdge,
  removeWorkflowReferenceEdge,
  removeWorkflowRouteContinuationEdge,
  type WorkflowReferenceEdgeKind,
} from "@/app/workflows/edges";
import {
  buildWorkflowGraphProjection,
  type WorkflowCanvasNodeData,
  type WorkflowGraphProjection,
  type WorkflowGraphTrigger,
} from "@/app/workflows/graph";
import {
  beautifyWorkflowCanvasPositions,
  normalizeWorkflowDefinitionUi,
  parseWorkflowDefinitionUi,
  updateWorkflowCanvasNodePosition,
  type WorkflowDefinitionUi,
  type WorkflowCanvasPosition,
} from "@/app/workflows/layout";
import {
  applyWorkflowRunOverlay,
  latestWorkflowRunStepIdForNode,
  type WorkflowRunOverlayInput,
} from "@/app/workflows/run-overlay";

const RUN_DETAIL_AUTO_REFRESH_MS = 1000;
const WORKFLOW_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ASSIGNMENT_TARGET_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
] as const;
type RunStatus = (typeof RUN_STATUSES)[number];
type RunMode = "test" | "live";
type WorkflowDesignerView = "edit" | "runs";

export const Route = createFileRoute("/workflows")({
  validateSearch: z.object({
    id: z.coerce.string().optional(),
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
  component: WorkflowsPage,
});

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface WorkflowDefinition {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  triggers: JsonValue[];
  nodes: WorkflowNode[];
  ui?: WorkflowDefinitionUi;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowNode {
  id: string;
  type: string;
  label?: string;
  [key: string]: JsonValue | undefined;
}

type NodeReferenceValidation =
  | { ok: true; message: "" }
  | { ok: false; message: string };

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
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "skipped"
    | "canceled";
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

interface McpToolSummary {
  server: string;
  tool: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface AgentSummary {
  id: string;
  name: string;
  role?: string;
  instantMessagesEnabled?: boolean;
}

interface WorkflowTriggerSummary {
  id: string;
  kind: string;
  enabled?: boolean;
  runnable: boolean;
  inputSchema?: JsonValue;
  [key: string]: JsonValue | boolean | undefined;
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

interface ScopedRunFilters {
  workflowId: string;
  mode: "all" | RunMode;
  status: "all" | RunStatus;
  triggerId: string;
  createdFrom: string;
  createdTo: string;
}

const EVENT_LEVELS = [
  "all",
  "debug",
  "info",
  "warn",
  "error",
  "system",
] as const;
type EventLevelFilter = (typeof EVENT_LEVELS)[number];
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const EXIT_STATUSES = ["succeeded", "failed", "canceled"] as const;
type ExitStatus = (typeof EXIT_STATUSES)[number];
const RUN_CONSOLE_PAGE_SIZE = 25;
const WORKFLOW_PALETTE_MIME = "application/x-openacme-workflow-node";

interface WorkflowPalettePayload {
  kind: WorkflowPaletteKind;
  server?: string;
  tool?: string;
  agentId?: string;
}

interface WorkflowTriggerPalettePayload {
  kind: "manual_trigger";
}

type WorkflowAddPayload =
  | WorkflowPalettePayload
  | WorkflowTriggerPalettePayload;

const DEFAULT_NODES: WorkflowNode[] = [
  {
    id: "set_customer",
    type: "builtin.set",
    assign: { customer: "$.input.customer" },
  },
  {
    id: "normalize",
    type: "builtin.transform",
    input: { customer: "$.context.customer" },
    transform: {
      kind: "object_pick",
      source: "customer",
      fields: ["id", "name"],
    },
    assign: {
      customer: {
        from: "$.steps.normalize.output",
        mode: "replace",
      },
    },
  },
  {
    id: "exit",
    type: "builtin.exit",
    status: "succeeded",
    output: "$.context.customer",
  },
];

const DEFAULT_TRIGGERS: JsonValue[] = [];

const DEFAULT_INPUT = {
  customer: {
    id: "cust_1",
    name: "Ada",
    riskScore: 42,
  },
};

function WorkflowsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows" });
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selected, setSelected] = useState<WorkflowDefinition | null>(null);
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<
    string | null
  >(null);
  const [selectedCanvasEdgeId, setSelectedCanvasEdgeId] = useState<
    string | null
  >(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [nextRunOffset, setNextRunOffset] = useState<number | null>(null);
  const [designerView, setDesignerView] = useState<WorkflowDesignerView>(
    search.run ? "runs" : "edit",
  );
  const [addStepTargetNodeId, setAddStepTargetNodeId] = useState<
    string | null | undefined
  >(undefined);
  const [addStepTargetSourceHandle, setAddStepTargetSourceHandle] =
    useState<WorkflowReferenceEdgeKind | null>(null);
  const [addStepPlacement, setAddStepPlacement] =
    useState<WorkflowCanvasAddPlacement | null>(null);
  const [nameDraft, setNameDraftState] = useState("");
  const [descriptionDraft, setDescriptionDraftState] = useState("");
  const [inputSchemaDraft, setInputSchemaDraftState] = useState("null");
  const [nodesDraft, setNodesDraftState] = useState(formatJson(DEFAULT_NODES));
  const [triggersDraft, setTriggersDraftState] = useState(
    formatJson(DEFAULT_TRIGGERS),
  );
  const [uiDraft, setUiDraftState] = useState<WorkflowDefinitionUi | null>(
    null,
  );
  const [inputDraft, setInputDraft] = useState(formatJson(DEFAULT_INPUT));
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTriggerSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const suppressedRunSearchReload = useRef<string | null>(null);
  const mode = search.mode ?? "all";
  const status = search.status ?? "all";
  const triggerId = search.triggerId ?? "";
  const createdFrom = search.createdFrom ?? "";
  const createdTo = search.createdTo ?? "";
  const nameDraftRef = useRef(nameDraft);
  const descriptionDraftRef = useRef(descriptionDraft);
  const inputSchemaDraftRef = useRef(inputSchemaDraft);
  const nodesDraftRef = useRef(nodesDraft);
  const triggersDraftRef = useRef(triggersDraft);
  const uiDraftRef = useRef(uiDraft);

  function setNameDraft(value: string) {
    nameDraftRef.current = value;
    setNameDraftState(value);
  }

  function setDescriptionDraft(value: string) {
    descriptionDraftRef.current = value;
    setDescriptionDraftState(value);
  }

  function setInputSchemaDraft(value: string) {
    inputSchemaDraftRef.current = value;
    setInputSchemaDraftState(value);
  }

  function setNodesDraft(value: string) {
    nodesDraftRef.current = value;
    setNodesDraftState(value);
  }

  function setTriggersDraft(value: string) {
    triggersDraftRef.current = value;
    setTriggersDraftState(value);
  }

  function setUiDraft(
    value:
      | WorkflowDefinitionUi
      | null
      | ((current: WorkflowDefinitionUi | null) => WorkflowDefinitionUi | null),
  ) {
    const next = typeof value === "function" ? value(uiDraftRef.current) : value;
    uiDraftRef.current = next;
    setUiDraftState(next);
  }

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/workflows",
        entityType: "workflow" as const,
        entityId: selected?.id ?? null,
        content: selected,
      }),
      [selected],
    ),
  );

  useEffect(() => {
    void loadWorkflows(search.id);
    void loadMcpTools();
    void loadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!search.id) return;
    const searchKey = runSearchKey({
      workflowId: search.id,
      mode,
      status,
      triggerId,
      createdFrom,
      createdTo,
      runId: search.run,
    });
    if (suppressedRunSearchReload.current === searchKey) {
      suppressedRunSearchReload.current = null;
      return;
    }
    const workflow = workflows.find((item) => item.id === search.id);
    if (workflow) selectWorkflow(workflow, search.run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    search.id,
    search.run,
    mode,
    status,
    triggerId,
    createdFrom,
    createdTo,
    workflows,
  ]);

  useEffect(() => {
    if (!detail || !selected || isTerminalRunStatus(detail.run.status)) return;
    const runId = detail.run.id;
    const workflowId = selected.id;
    const timer = window.setInterval(() => {
      void loadRunDetail(runId, workflowId);
    }, RUN_DETAIL_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.run.id, detail?.run.status, selected?.id]);

  useEffect(() => {
    if (search.run) setDesignerView("runs");
  }, [search.run]);

  const parsedNodes = useMemo(
    () => parseNodesDraft(nodesDraftRef.current),
    [nodesDraft],
  );
  const parsedTriggersForCanvas = useMemo(() => {
    const parsed = parseTriggersDraft(triggersDraftRef.current);
    return parsed.ok
      ? (parsed.value.filter(isRecord) as WorkflowGraphTrigger[])
      : [];
  }, [triggersDraft]);
  const effectiveTriggersForCanvas = useMemo(() => {
    if (
      designerView !== "runs" ||
      parsedTriggersForCanvas.length > 0 ||
      !detail
    ) {
      return parsedTriggersForCanvas;
    }
    return runTriggerCanvasFallback(detail.run);
  }, [designerView, detail, parsedTriggersForCanvas]);
  const workflowRunOverlay = useMemo<WorkflowRunOverlayInput | null>(
    () =>
      detail
        ? {
            run: { currentNodeId: detail.run.currentNodeId },
            steps: detail.steps,
          }
        : null,
    [detail],
  );
  const workflowGraphProjection = useMemo(
    () =>
      applyWorkflowRunOverlay(
        buildWorkflowGraphProjection({
          nodes: parsedNodes.ok ? parsedNodes.value : [],
          triggers: effectiveTriggersForCanvas,
          layout: uiDraft?.canvas,
        }),
        workflowRunOverlay,
      ),
    [parsedNodes, effectiveTriggersForCanvas, uiDraft, workflowRunOverlay],
  );
  const workflowBeautifiedGraphProjection = useMemo(
    () =>
      buildWorkflowGraphProjection({
        nodes: parsedNodes.ok ? parsedNodes.value : [],
        triggers: effectiveTriggersForCanvas,
        layout: null,
      }),
    [parsedNodes, effectiveTriggersForCanvas],
  );
  const nodeReferences = useMemo(
    () =>
      parsedNodes.ok
        ? validateNodeReferences(parsedNodes.value)
        : ({ ok: true, message: "" } as NodeReferenceValidation),
    [parsedNodes],
  );
  useEffect(() => {
    if (
      selectedCanvasNodeId &&
      !workflowGraphProjection.nodes.some(
        (node) => node.id === selectedCanvasNodeId,
      )
    ) {
      setSelectedCanvasNodeId(null);
    }
  }, [selectedCanvasNodeId, workflowGraphProjection.nodes]);
  useEffect(() => {
    if (
      selectedCanvasEdgeId &&
      !workflowGraphProjection.edges.some(
        (edge) => edge.id === selectedCanvasEdgeId,
      )
    ) {
      setSelectedCanvasEdgeId(null);
    }
  }, [selectedCanvasEdgeId, workflowGraphProjection.edges]);
  const selectedStep =
    detail?.steps.find((step) => step.id === selectedStepId) ??
    detail?.steps[0] ??
    null;

  async function loadWorkflows(preferredId?: string) {
    setLoading(true);
    try {
      const data = await api<{ workflows: WorkflowDefinition[] }>(
        "/api/workflows",
      );
      setWorkflows(data.workflows);
      const next =
        data.workflows.find((item) => item.id === preferredId) ??
        data.workflows[0] ??
        null;
      if (next)
        selectWorkflow(next, next.id === search.id ? search.run : undefined);
      else {
        setSelected(null);
        setRuns([]);
        setDetail(null);
        setTriggers([]);
        setHasMoreRuns(false);
        setNextRunOffset(null);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function selectWorkflow(workflow: WorkflowDefinition, runId?: string) {
    setSelected(workflow);
    setSelectedCanvasNodeId(null);
    setSelectedCanvasEdgeId(null);
    setNameDraft(workflow.name);
    setDescriptionDraft(workflow.description ?? "");
    setInputSchemaDraft(formatOptionalJson(workflow.inputSchema));
    setNodesDraft(formatJson(workflow.nodes));
    setTriggersDraft(formatJson(workflow.triggers));
    setUiDraft(workflow.ui ?? null);
    setTriggers(deriveTriggerSummaries(workflow.triggers));
    void navigate({
      search: workflowSearch({ id: workflow.id, run: runId }),
      replace: true,
    });
    await Promise.all([
      loadTriggers(workflow.id, workflow.triggers),
      loadRuns(workflow.id, runId),
    ]);
  }

  async function loadTriggers(workflowId: string, fallback: JsonValue[] = []) {
    try {
      const data = await api<{ triggers: WorkflowTriggerSummary[] }>(
        `/api/workflows/${encodeURIComponent(workflowId)}/triggers`,
      );
      setTriggers(mergeAuthoringTriggerFields(data.triggers, fallback));
    } catch {
      setTriggers(deriveTriggerSummaries(fallback));
    }
  }

  async function loadRuns(workflowId: string, preferredRunId?: string) {
    try {
      const data = await api<RunListPage>(runListPath(workflowId, 0));
      setRuns(data.runs);
      setHasMoreRuns(data.hasMore);
      setNextRunOffset(data.nextOffset);
      const runId = preferredRunId ?? data.runs[0]?.id;
      if (runId) {
        const loaded = await loadRunDetail(runId, workflowId);
        if (loaded) return;
      }
      setDetail(null);
      setSelectedStepId(null);
      void navigate({
        search: workflowSearch({ id: workflowId, run: undefined }),
        replace: true,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function loadMoreRuns() {
    if (!selected || nextRunOffset === null) return;
    setLoadingMoreRuns(true);
    try {
      const data = await api<RunListPage>(
        runListPath(selected.id, nextRunOffset),
      );
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
      setLoadingMoreRuns(false);
    }
  }

  async function loadMcpTools() {
    try {
      const data = await api<{ tools: McpToolSummary[] }>(
        "/api/workflows/mcp/tools",
      );
      setMcpTools(data.tools);
    } catch {
      setMcpTools([]);
    }
  }

  function runListPath(workflowId: string, offset: number) {
    const params = new URLSearchParams();
    params.set("limit", String(RUN_CONSOLE_PAGE_SIZE));
    if (offset > 0) params.set("offset", String(offset));
    if (mode !== "all") params.set("mode", mode);
    if (status !== "all") params.set("status", status);
    if (triggerId) params.set("triggerId", triggerId);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    return `/api/workflows/${encodeURIComponent(workflowId)}/runs?${params.toString()}`;
  }

  function runFilters(): ScopedRunFilters {
    return {
      workflowId: selected?.id ?? search.id ?? "",
      mode,
      status,
      triggerId,
      createdFrom,
      createdTo,
    };
  }

  function workflowSearch(
    patch: Partial<{
      id: string;
      mode: "all" | RunMode;
      status: "all" | RunStatus;
      triggerId: string;
      createdFrom: string;
      createdTo: string;
      run: string;
    }>,
  ) {
    const next = {
      id: "id" in patch ? patch.id : (selected?.id ?? search.id),
      mode: "mode" in patch ? patch.mode : mode,
      status: "status" in patch ? patch.status : status,
      triggerId: "triggerId" in patch ? patch.triggerId : triggerId,
      createdFrom: "createdFrom" in patch ? patch.createdFrom : createdFrom,
      createdTo: "createdTo" in patch ? patch.createdTo : createdTo,
      run: "run" in patch ? patch.run : search.run,
    };
    return {
      id: next.id,
      mode: next.mode === "all" ? undefined : next.mode,
      status: next.status === "all" ? undefined : next.status,
      triggerId: next.triggerId || undefined,
      createdFrom: next.createdFrom || undefined,
      createdTo: next.createdTo || undefined,
      run: next.run || undefined,
    };
  }

  function updateRunFilters(
    patch: Partial<{
      mode: "all" | RunMode;
      status: "all" | RunStatus;
      triggerId: string;
      createdFrom: string;
      createdTo: string;
    }>,
  ) {
    void navigate({
      search: workflowSearch({ ...patch, run: undefined }),
    });
  }

  async function loadAgents() {
    try {
      const data = await api<{ agents: AgentSummary[] }>(
        "/api/workflows/agents",
      );
      setAgents(data.agents);
    } catch {
      setAgents([]);
    }
  }

  async function loadRunDetail(
    runId: string,
    expectedWorkflowId?: string,
  ): Promise<boolean> {
    try {
      const data = await api<RunDetail>(
        `/api/workflow-runs/${encodeURIComponent(runId)}`,
      );
      if (expectedWorkflowId && data.run.workflowId !== expectedWorkflowId) {
        return false;
      }
      setDetail(data);
      setPendingRunId(null);
      setRuns((current) =>
        reconcileWorkflowRunInLoadedList(current, data.run, {
          ...runFilters(),
          workflowId: data.run.workflowId,
        }),
      );
      setSelectedStepId((current) => retainedStepId(data.steps, current));
      void navigate({
        search: workflowSearch({ id: data.run.workflowId, run: data.run.id }),
        replace: true,
      });
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      setPendingRunId(null);
      return false;
    }
  }

  async function createWorkflow() {
    setBusy("create");
    try {
      const id = `wf_${Date.now().toString(36)}`;
      const data = await api<{ workflow: WorkflowDefinition }>(
        "/api/workflows",
        {
          method: "POST",
          body: {
            id,
            name: "New workflow",
            triggers: DEFAULT_TRIGGERS,
            nodes: [],
          },
        },
      );
      toast.success("Workflow created");
      void navigate({ search: { id: data.workflow.id }, replace: true });
      await loadWorkflows(data.workflow.id);
      openAddStepDialog(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteWorkflow(workflow: WorkflowDefinition) {
    if (
      !confirm(
        `Delete workflow "${workflow.name}"? Run history will stay available.`,
      )
    ) {
      return;
    }
    setBusy(`delete:${workflow.id}`);
    try {
      await api<{ workflow: WorkflowDefinition }>(
        `/api/workflows/${encodeURIComponent(workflow.id)}`,
        { method: "DELETE" },
      );
      toast.success("Workflow deleted");
      const remaining = workflows.filter((item) => item.id !== workflow.id);
      const next = remaining.find((item) => item.id !== workflow.id) ?? null;
      if (selected?.id === workflow.id) {
        setSelected(next);
        setDetail(null);
        setRuns([]);
        setSelectedStepId(null);
        if (next) {
          void navigate({ search: { id: next.id }, replace: true });
          await loadWorkflows(next.id);
        } else {
          void navigate({ search: {}, replace: true });
          await loadWorkflows();
        }
      } else {
        await loadWorkflows(selected?.id);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function importWorkflowFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy("import");
    try {
      const parsed = parseWorkflowImport(await file.text());
      if (!parsed.ok) {
        toast.error(parsed.error);
        return;
      }
      const importedId = `wf_import_${Date.now().toString(36)}`;
      const data = await api<{ workflow: WorkflowDefinition }>(
        "/api/workflows",
        {
          method: "POST",
          body: {
            id: importedId,
            name: parsed.value.name,
            description: parsed.value.description,
            inputSchema: parsed.value.inputSchema,
            triggers: parsed.value.triggers,
            nodes: parsed.value.nodes,
            ui:
              normalizeWorkflowDefinitionUi(
                parsed.value.ui,
                parsed.value.nodes,
              ) ?? undefined,
          },
        },
      );
      toast.success("Workflow imported as new draft");
      void navigate({ search: { id: data.workflow.id }, replace: true });
      await loadWorkflows(data.workflow.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    if (!selected) return;
    setBusy("save");
    try {
      const workflow = await saveCurrentDraft(selected.id);
      toast.success("Draft saved");
      setSelected(workflow);
      await loadWorkflows(workflow.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveCurrentDraft(workflowId: string) {
    const body = currentDraftUpdateBody();
    const data = await api<{ workflow: WorkflowDefinition }>(
      `/api/workflows/${encodeURIComponent(workflowId)}`,
      {
        method: "PATCH",
        body,
      },
    );
    return data.workflow;
  }

  function currentDraftUpdateBody() {
    const nodes = parseNodesDraft(nodesDraftRef.current);
    if (!nodes.ok) {
      throw new Error(nodes.error);
    }
    const references = validateNodeReferences(nodes.value);
    if (!references.ok) {
      throw new Error(references.message);
    }
    const nodeShape = validateExportedNodeShape(nodes.value);
    if (!nodeShape.ok) {
      throw new Error(nodeShape.message);
    }
    const triggerDraft = parseTriggersDraft(triggersDraftRef.current);
    if (!triggerDraft.ok) {
      throw new Error(triggerDraft.error);
    }
    const triggerShape = validateTriggerShape(triggerDraft.value);
    if (!triggerShape.ok) {
      throw new Error(triggerShape.message);
    }
    const triggerIdentity = validateTriggerIdentity(triggerDraft.value);
    if (!triggerIdentity.ok) {
      throw new Error(triggerIdentity.message);
    }
    const inputSchema = parseOptionalJsonDraft(inputSchemaDraftRef.current);
    if (!inputSchema.ok) {
      throw new Error(inputSchema.error);
    }
    const name = nameDraftRef.current.trim();
    if (!name) {
      throw new Error("Workflow needs a name");
    }

    return {
      name,
      description: descriptionDraftRef.current.trim() || null,
      inputSchema: inputSchema.value,
      triggers: triggerDraft.value,
      nodes: nodes.value,
      ui: normalizeWorkflowDefinitionUi(uiDraftRef.current, nodes.value) ?? null,
    };
  }

  function currentDraftHasChanges(workflow: WorkflowDefinition) {
    const body = currentDraftUpdateBody();
    return (
      body.name !== workflow.name ||
      (body.description ?? "") !== (workflow.description ?? "") ||
      !jsonEquivalent(body.inputSchema, workflow.inputSchema) ||
      !jsonEquivalent(body.triggers, workflow.triggers) ||
      !jsonEquivalent(body.nodes, workflow.nodes) ||
      !jsonEquivalent(body.ui, workflow.ui ?? null)
    );
  }

  async function publishWorkflow() {
    if (!selected) return;
    if (!validateCurrentNodeReferences()) return;
    const triggerDraft = parseTriggersDraft(triggersDraftRef.current);
    if (!triggerDraft.ok) {
      toast.error(triggerDraft.error);
      return;
    }
    const triggerShape = validateTriggerShape(triggerDraft.value);
    if (!triggerShape.ok) {
      toast.error(triggerShape.message);
      return;
    }
    const triggerIdentity = validateTriggerIdentity(triggerDraft.value);
    if (!triggerIdentity.ok) {
      toast.error(triggerIdentity.message);
      return;
    }
    setBusy("publish");
    try {
      const data = await api<{ workflow: WorkflowDefinition }>(
        `/api/workflows/${encodeURIComponent(selected.id)}/publish`,
        { method: "POST", body: {} },
      );
      toast.success(`Published v${data.workflow.version}`);
      await loadWorkflows(data.workflow.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function exportWorkflowDefinition() {
    if (!selected) return;
    const nodes = parseNodesDraft(nodesDraftRef.current);
    if (!nodes.ok) {
      toast.error(nodes.error);
      return;
    }
    const references = validateNodeReferences(nodes.value);
    if (!references.ok) {
      toast.error(references.message);
      return;
    }
    const nodeShape = validateExportedNodeShape(nodes.value);
    if (!nodeShape.ok) {
      toast.error(nodeShape.message);
      return;
    }
    const triggerDraft = parseTriggersDraft(triggersDraftRef.current);
    if (!triggerDraft.ok) {
      toast.error(triggerDraft.error);
      return;
    }
    const triggerShape = validateTriggerShape(triggerDraft.value);
    if (!triggerShape.ok) {
      toast.error(triggerShape.message);
      return;
    }
    const triggerIdentity = validateTriggerIdentity(triggerDraft.value);
    if (!triggerIdentity.ok) {
      toast.error(triggerIdentity.message);
      return;
    }
    const inputSchema = parseOptionalJsonDraft(inputSchemaDraftRef.current);
    if (!inputSchema.ok) {
      toast.error(inputSchema.error);
      return;
    }
    const name = nameDraftRef.current.trim();
    if (!name) {
      toast.error("Workflow needs a name");
      return;
    }

    const description = descriptionDraftRef.current.trim();
    const ui = normalizeWorkflowDefinitionUi(uiDraftRef.current, nodes.value);
    const payload = {
      format: "openacme.workflow.definition.v1",
      exportedAt: new Date().toISOString(),
      workflow: {
        id: selected.id,
        version: selected.version,
        status: selected.status,
        name,
        ...(description ? { description } : {}),
        inputSchema: inputSchema.value ?? undefined,
        triggers: triggerDraft.value,
        nodes: nodes.value,
        ...(ui ? { ui } : {}),
      },
    };
    const blob = new Blob([`${formatJson(payload)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = workflowExportFileName(selected, name);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast.success("Workflow exported");
  }

  async function runWorkflow(mode: "test" | "live") {
    if (!selected) return;
    if (!validateCurrentNodeReferences()) return;
    if (!validateCurrentTriggerDraft()) return;
    const input = parseJsonDraft(inputDraft);
    if (!input.ok) {
      toast.error(input.error);
      return;
    }
    setBusy(mode);
    try {
      const runWorkflow =
        mode === "test" && currentDraftHasChanges(selected)
          ? await saveCurrentDraft(selected.id)
          : selected;
      if (runWorkflow !== selected) {
        setSelected(runWorkflow);
        setWorkflows((current) =>
          current.map((workflow) =>
            workflow.id === runWorkflow.id ? runWorkflow : workflow,
          ),
        );
      }
      const data = await api<RunDetail>(
        `/api/workflows/${encodeURIComponent(runWorkflow.id)}/runs/${mode}`,
        {
          method: "POST",
          body: { input: input.value, async: true },
        },
      );
      toast.success(
        mode === "test" ? "Test run started" : "Live run started",
      );
      setDetail(data);
      setSelectedStepId((current) => retainedStepId(data.steps, current));
      setRuns((current) =>
        reconcileWorkflowRunInLoadedList(current, data.run, runFilters()),
      );
      suppressedRunSearchReload.current = runSearchKey({
        ...runFilters(),
        runId: data.run.id,
      });
      void navigate({
        search: workflowSearch({ id: runWorkflow.id, run: data.run.id }),
        replace: true,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTrigger(trigger: WorkflowTriggerSummary) {
    if (!selected) return;
    if (!validateCurrentTriggerDraft()) return;
    const input = parseJsonDraft(inputDraft);
    if (!input.ok) {
      toast.error(input.error);
      return;
    }
    const busyKey = `trigger:${trigger.id}`;
    setBusy(busyKey);
    try {
      const runWorkflow = currentDraftHasChanges(selected)
        ? await saveCurrentDraft(selected.id)
        : selected;
      if (runWorkflow !== selected) {
        setSelected(runWorkflow);
        setWorkflows((current) =>
          current.map((workflow) =>
            workflow.id === runWorkflow.id ? runWorkflow : workflow,
          ),
        );
      }
      const data = await api<RunDetail>(
        `/api/workflows/${encodeURIComponent(runWorkflow.id)}/triggers/${encodeURIComponent(trigger.id)}/runs`,
        {
          method: "POST",
          body: { input: input.value, async: true },
        },
      );
      toast.success("Trigger run started");
      setDetail(data);
      setSelectedStepId((current) => retainedStepId(data.steps, current));
      setRuns((current) =>
        reconcileWorkflowRunInLoadedList(current, data.run, runFilters()),
      );
      suppressedRunSearchReload.current = runSearchKey({
        ...runFilters(),
        runId: data.run.id,
      });
      void navigate({
        search: workflowSearch({ id: runWorkflow.id, run: data.run.id }),
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
      const selectedWorkflowId = selected?.id ?? detail.run.workflowId;
      setRuns((current) =>
        reconcileWorkflowRunInLoadedList(current, data.run, {
          ...runFilters(),
          workflowId: selectedWorkflowId,
        }),
      );
      suppressedRunSearchReload.current = runSearchKey({
        ...runFilters(),
        workflowId: selectedWorkflowId,
        runId: data.run.id,
      });
      void navigate({
        search: workflowSearch({ id: selectedWorkflowId, run: data.run.id }),
        replace: true,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
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
      const selectedWorkflowId = selected?.id ?? detail.run.workflowId;
      setRuns((current) =>
        reconcileWorkflowRunInLoadedList(current, data.run, {
          ...runFilters(),
          workflowId: selectedWorkflowId,
        }),
      );
      void navigate({
        search: workflowSearch({ id: selectedWorkflowId, run: data.run.id }),
        replace: true,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function insertNode(
    kind: WorkflowPaletteKind,
    afterNodeId: string | null,
    sourceHandle?: WorkflowReferenceEdgeKind | null,
    tool?: McpToolSummary | AgentSummary,
    placement?: WorkflowCanvasAddPlacement | null,
  ) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    if (kind === "mcp" && !isMcpToolSummary(tool)) {
      toast.error("No MCP tools available");
      return;
    }
    if (kind === "agent" && !isAgentSummary(tool)) {
      toast.error("No agents available");
      return;
    }
    const existingIds = new Set(parsed.value.map((node) => node.id));
    const hasReferenceTarget =
      afterNodeId && !isTriggerCanvasNodeId(afterNodeId) && sourceHandle
        ? firstWorkflowReferenceTarget(parsed.value, {
            sourceId: afterNodeId,
            kind: sourceHandle,
          }) !== null
        : false;
    const insertionAnchor =
      sourceHandle && !hasReferenceTarget ? null : afterNodeId;
    const inserted = isTriggerCanvasNodeId(afterNodeId)
      ? insertWorkflowNodeFirst(parsed.value, kind, tool)
      : insertWorkflowNodeAfter(parsed.value, insertionAnchor, kind, tool);
    const addedNode = inserted.find((node) => !existingIds.has(node.id));
    let next = inserted;
    if (
      afterNodeId &&
      !isTriggerCanvasNodeId(afterNodeId) &&
      sourceHandle &&
      addedNode
    ) {
      const connected = insertWorkflowReferenceEdgeTarget(inserted, {
        sourceId: afterNodeId,
        targetId: addedNode.id,
        kind: sourceHandle,
      });
      if (connected.ok) {
        next = connected.nodes as WorkflowNode[];
      } else {
        toast.error(referenceMutationMessage(connected.reason));
      }
    } else if (
      afterNodeId &&
      !isTriggerCanvasNodeId(afterNodeId) &&
      addedNode
    ) {
      const connected = connectWorkflowRouteContinuationEdge(inserted, {
        sourceId: afterNodeId,
        targetId: addedNode.id,
      });
      if (connected.ok) {
        next = connected.nodes as WorkflowNode[];
      } else if (
        connected.reason !== "route_source_not_found" &&
        connected.reason !== "ambiguous_route_source"
      ) {
        toast.error(referenceMutationMessage(connected.reason));
      }
    }
    setNodesDraft(formatJson(next));
    if (addedNode && placement?.position) {
      setUiDraft((current) =>
        updateWorkflowCanvasNodePosition(
          current,
          addedNode.id,
          placement.position,
        ),
      );
    }
    setSelectedCanvasNodeId(addedNode?.id ?? next.at(-1)?.id ?? null);
  }

  function openAddStepDialog(
    afterNodeId: string | null,
    sourceHandle?: string,
    placement?: WorkflowCanvasAddPlacement,
  ) {
    setDesignerView("edit");
    void loadMcpTools();
    void loadAgents();
    setAddStepTargetNodeId(afterNodeId);
    setAddStepTargetSourceHandle(referenceEdgeKind(sourceHandle));
    setAddStepPlacement(placement ?? null);
  }

  function closeAddStepDialog() {
    setAddStepTargetNodeId(undefined);
    setAddStepTargetSourceHandle(null);
    setAddStepPlacement(null);
  }

  function addManualTriggerFromPalette() {
    const parsed = parseTriggersDraft(triggersDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    if (parsed.value.length > 0) {
      toast.error("Workflow already has a trigger");
      return;
    }
    const next = [{ id: "manual", kind: "manual", enabled: true }];
    setTriggersDraft(formatJson(next));
    setTriggers(deriveTriggerSummaries(next));
    setSelectedCanvasNodeId("trigger:manual");
  }

  function insertNodeFromPalette(payload: WorkflowAddPayload) {
    if (payload.kind === "manual_trigger") {
      addManualTriggerFromPalette();
      closeAddStepDialog();
      return;
    }
    const targetNodeId =
      addStepTargetNodeId === undefined
        ? selectedCanvasNodeId
        : addStepTargetNodeId;
    insertNode(
      payload.kind,
      targetNodeId,
      addStepTargetSourceHandle,
      toolForPalettePayload(payload),
      addStepPlacement,
    );
    closeAddStepDialog();
  }

  function handlePaletteDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const payload = parseWorkflowPalettePayload(
      event.dataTransfer.getData(WORKFLOW_PALETTE_MIME),
    );
    if (!payload) return;
    insertNode(
      payload.kind,
      selectedCanvasNodeId,
      null,
      toolForPalettePayload(payload),
    );
  }

  function toolForPalettePayload(
    payload: WorkflowPalettePayload,
  ): McpToolSummary | AgentSummary | undefined {
    if (payload.kind === "mcp") {
      if (payload.server && payload.tool) {
        return mcpTools.find(
          (tool) =>
            tool.server === payload.server && tool.tool === payload.tool,
        );
      }
      return firstMcpTool;
    }
    if (payload.kind === "agent") {
      if (payload.agentId) {
        return agents.find((agent) => agent.id === payload.agentId);
      }
      return firstAvailableAgent;
    }
    return undefined;
  }

  function moveNode(index: number, direction: -1 | 1) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const target = index + direction;
    if (target < 0 || target >= parsed.value.length) return;
    setNodesDraft(formatJson(moveWorkflowNode(parsed.value, index, direction)));
  }

  function moveSelectedCanvasNode(direction: -1 | 1) {
    if (!selectedCanvasNodeId) return;
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const index = parsed.value.findIndex(
      (node) => node.id === selectedCanvasNodeId,
    );
    if (index < 0) return;
    moveNode(index, direction);
  }

  function cloneSelectedCanvasNode(nodeId: string) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const result = cloneWorkflowNodeAfter(parsed.value, nodeId);
    if (!result) return;
    setNodesDraft(formatJson(result.nodes));
    setSelectedCanvasNodeId(result.clonedId);
    setSelectedCanvasEdgeId(null);
  }

  function makeForeachBodyFirst(foreachNodeId: string, bodyNodeId: string) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const nextNodes = setWorkflowForeachBodyFirst(
      parsed.value,
      foreachNodeId,
      bodyNodeId,
    );
    if (!nextNodes) return;
    setNodesDraft(formatJson(nextNodes));
    setSelectedCanvasNodeId(bodyNodeId);
    setSelectedCanvasEdgeId(null);
    toast.success("Loop body start updated");
  }

  function connectCanvasReferenceEdge(connection: WorkflowCanvasConnection) {
    const kind = referenceEdgeKind(connection.sourceHandle);
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const result = kind
      ? overwriteWorkflowReferenceEdge(parsed.value, {
          sourceId: connection.sourceId,
          targetId: connection.targetId,
          kind,
        })
      : overwriteWorkflowRouteContinuationEdge(parsed.value, {
          sourceId: connection.sourceId,
          targetId: connection.targetId,
        });
    if (!result.ok) {
      toast.error(referenceMutationMessage(result.reason));
      return;
    }
    setNodesDraft(formatJson(result.nodes));
    setSelectedCanvasNodeId(connection.sourceId);
    setSelectedCanvasEdgeId(
      kind
        ? `edge:${kind}:${connection.sourceId}:${connection.targetId}`
        : null,
    );
  }

  function removeSelectedCanvasReferenceEdge(
    edge: WorkflowCanvasEdgeSelection,
  ) {
    const kind = referenceEdgeKind(edge.kind);
    const targetId = edge.targetRef ?? edge.targetId;
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    if (!kind) {
      const result = removeWorkflowRouteContinuationEdge(parsed.value, {
        sourceId: edge.sourceId,
        targetId,
      });
      if (!result.ok) {
        toast.error(referenceMutationMessage(result.reason));
        return;
      }
      setNodesDraft(formatJson(result.nodes));
      setSelectedCanvasEdgeId(null);
      setSelectedCanvasNodeId(edge.sourceId);
      return;
    }
    const result = removeWorkflowReferenceEdge(parsed.value, {
      sourceId: edge.sourceId,
      targetId,
      kind,
    });
    if (!result.ok) {
      toast.error(referenceMutationMessage(result.reason));
      return;
    }
    setNodesDraft(formatJson(result.nodes));
    setSelectedCanvasEdgeId(null);
    setSelectedCanvasNodeId(edge.sourceId);
  }

  function selectCanvasNode(nodeId: string) {
    setSelectedCanvasNodeId(nodeId);
    setSelectedCanvasEdgeId(null);
    if (!detail) return;
    const stepId = latestWorkflowRunStepIdForNode(detail.steps, nodeId);
    if (stepId) setSelectedStepId(stepId);
  }

  function updateCanvasNodePosition(
    nodeId: string,
    position: WorkflowCanvasPosition,
  ) {
    setUiDraft((current) =>
      updateWorkflowCanvasNodePosition(current, nodeId, position),
    );
  }

  function beautifyCanvasLayout() {
    if (!parsedNodes.ok) {
      toast.error(parsedNodes.error);
      return;
    }
    setUiDraft((current) =>
      beautifyWorkflowCanvasPositions(
        current,
        workflowBeautifiedGraphProjection.nodes,
      ),
    );
    toast.success("Canvas layout refreshed");
  }

  function selectRunConsoleStep(stepId: string) {
    setSelectedStepId(stepId);
    const step = detail?.steps.find((item) => item.id === stepId);
    if (!step) return;
    setSelectedCanvasNodeId(step.nodeId);
    setSelectedCanvasEdgeId(null);
  }

  function selectRunFromHistory(runId: string) {
    if (detail?.run.id === runId && pendingRunId === null) return;
    setPendingRunId(runId);
    void loadRunDetail(runId, selected?.id);
  }

  function deleteNode(index: number) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const node = parsed.value[index];
    if (!node) return;
    deleteWorkflowNode(node.id);
  }

  function deleteWorkflowNode(nodeId: string) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setNodesDraft(formatJson(removeWorkflowNode(parsed.value, nodeId)));
    setSelectedCanvasNodeId((current) => (current === nodeId ? null : current));
    setSelectedCanvasEdgeId(null);
  }

  function validateCurrentNodeReferences() {
    const nodes = parseNodesDraft(nodesDraftRef.current);
    if (!nodes.ok) {
      toast.error(nodes.error);
      return false;
    }
    const references = validateNodeReferences(nodes.value);
    if (!references.ok) {
      toast.error(references.message);
      return false;
    }
    const nodeShape = validateExportedNodeShape(nodes.value);
    if (!nodeShape.ok) {
      toast.error(nodeShape.message);
      return false;
    }
    return true;
  }

  function validateCurrentTriggerDraft() {
    const triggers = parseTriggersDraft(triggersDraftRef.current);
    if (!triggers.ok) {
      toast.error(triggers.error);
      return false;
    }
    const shape = validateTriggerShape(triggers.value);
    if (!shape.ok) {
      toast.error(shape.message);
      return false;
    }
    const identity = validateTriggerIdentity(triggers.value);
    if (!identity.ok) {
      toast.error(identity.message);
      return false;
    }
    return true;
  }

  function updateNode(
    index: number,
    updater: (node: WorkflowNode) => WorkflowNode,
  ) {
    const parsed = parseNodesDraft(nodesDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setNodesDraft(
      formatJson(
        parsed.value.map((node, item) =>
          item === index ? updater(node) : node,
        ),
      ),
    );
  }

  function updateNodeLabel(index: number, value: string) {
    const label = value.trim();
    updateNode(index, (node) =>
      label ? { ...node, label } : omitNodeKey(node, "label"),
    );
  }

  function updateAssignmentTarget(
    index: number,
    currentTarget: string,
    nextTarget: string,
  ) {
    const target = nextTarget.trim();
    if (!target) return;
    if (!ASSIGNMENT_TARGET_PATTERN.test(target)) return;
    updateNode(index, (node) => {
      if (!isRecord(node.assign)) return node;
      const nextAssign = { ...node.assign };
      const value = nextAssign[currentTarget];
      if (value === undefined) return node;
      delete nextAssign[currentTarget];
      nextAssign[target] = value;
      return { ...node, assign: nextAssign };
    });
  }

  function updateAssignmentSource(
    index: number,
    target: string,
    source: string,
  ) {
    if (!source) return;
    updateNode(index, (node) => {
      if (!isRecord(node.assign)) return node;
      const current = node.assign[target];
      const nextAssign = { ...node.assign };
      if (isRecord(current)) {
        nextAssign[target] = { ...current, from: source };
      } else {
        nextAssign[target] = source;
      }
      return { ...node, assign: nextAssign };
    });
  }

  function updateAssignmentMode(index: number, target: string, mode: string) {
    updateNode(index, (node) => {
      if (!isRecord(node.assign)) return node;
      const current = node.assign[target];
      const source =
        isRecord(current) && typeof current["from"] === "string"
          ? current["from"]
          : typeof current === "string"
            ? current
            : formatJson(current);
      return {
        ...node,
        assign: {
          ...node.assign,
          [target]: { from: source, mode },
        },
      };
    });
  }

  function updateTransformConfig(
    index: number,
    field: "input" | "transform",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.transform") return node;
      if (field === "input") {
        const parsed = parseJsonObjectDraft(value);
        if (!parsed.ok) return node;
        return { ...node, input: parsed.value };
      }
      const parsed = parseJsonDraft(value);
      if (!parsed.ok) return node;
      return { ...node, transform: parsed.value };
    });
  }

  function updateBranchConfig(
    index: number,
    field: "condition" | "then" | "else",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.if" && node.type !== "builtin.if_else") {
        return node;
      }
      if (field === "condition") {
        if (!value) return node;
        return { ...node, condition: value };
      }
      return { ...node, [field]: parseNodeIdList(value) };
    });
  }

  function updateSwitchConfig(
    index: number,
    field:
      | "value"
      | "caseId"
      | "caseLabel"
      | "caseValue"
      | "caseNodes"
      | "defaultNodes"
      | "addCase"
      | "removeCase",
    value: string,
    caseIndex?: number,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.switch") return node;
      const cases = normalizeSwitchCaseDrafts(node.cases);
      if (field === "value") {
        const parsed = parseJsonDraft(value);
        return parsed.ok ? { ...node, value: parsed.value } : node;
      }
      if (field === "defaultNodes") {
        return { ...node, default: parseNodeIdList(value) };
      }
      if (field === "addCase") {
        const nextIndex = cases.length + 1;
        return {
          ...node,
          cases: [
            ...cases,
            {
              id: uniqueSwitchCaseId(cases, `case_${nextIndex}`),
              label: `Case ${nextIndex}`,
              value: `case_${nextIndex}`,
              nodes: [],
            },
          ],
        };
      }
      if (field === "removeCase") {
        if (typeof caseIndex !== "number" || cases.length <= 1) return node;
        return {
          ...node,
          cases: cases.filter((_, index) => index !== caseIndex),
        };
      }
      if (typeof caseIndex !== "number" || !cases[caseIndex]) return node;
      const nextCases = cases.map((item, index) => {
        if (index !== caseIndex) return item;
        if (field === "caseId") {
          const id = safeRouteId(value);
          return id ? { ...item, id } : item;
        }
        if (field === "caseLabel") {
          const label = value.trim();
          return label ? { ...item, label } : { ...item, label: undefined };
        }
        if (field === "caseValue") {
          const parsed = parseJsonDraft(value);
          return parsed.ok ? { ...item, value: parsed.value } : item;
        }
        return { ...item, nodes: parseNodeIdList(value) };
      });
      return { ...node, cases: nextCases };
    });
  }

  function updateLogConfig(
    index: number,
    field: "level" | "message" | "payload",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (!isLogNodeType(node.type)) return node;
      if (field === "level") {
        if (!isLogLevel(value)) return node;
        return { ...node, type: `builtin.log.${value}` };
      }
      if (field === "message" && !value) return node;
      return { ...node, [field]: value };
    });
  }

  function updateThrowErrorConfig(
    index: number,
    field: "message" | "code" | "details",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.throw_error") return node;
      if (field === "message") {
        if (!value) return node;
        return { ...node, message: value };
      }
      if (field === "code") {
        const code = value.trim();
        if (!code) return omitNodeKey(node, "code");
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(code)) return node;
        return { ...node, code };
      }
      const details = value.trim();
      return details ? { ...node, details } : omitNodeKey(node, "details");
    });
  }

  function updateSleepConfig(
    index: number,
    field: "delayMs" | "reason",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.sleep") return node;
      if (field === "delayMs") {
        const delayMs = Number.parseInt(value, 10);
        if (!Number.isFinite(delayMs) || delayMs < 1 || delayMs > 300_000) {
          return node;
        }
        return { ...node, delayMs };
      }
      const reason = value.trim();
      return reason ? { ...node, reason } : omitNodeKey(node, "reason");
    });
  }

  function updateExitConfig(
    index: number,
    field: "status" | "output",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.exit") return node;
      if (field === "status") {
        if (!isExitStatus(value)) return node;
        return { ...node, status: value };
      }
      return { ...node, output: value };
    });
  }

  function updateForeachConfig(
    index: number,
    field: "items" | "itemVar" | "body" | "concurrency",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.foreach") return node;
      if (field === "body") return { ...node, body: parseNodeIdList(value) };
      if (field === "concurrency") {
        const concurrency = Number.parseInt(value, 10);
        if (
          !Number.isFinite(concurrency) ||
          concurrency < 1 ||
          concurrency > 1
        ) {
          const nextNode = { ...node };
          delete nextNode.concurrency;
          return nextNode;
        }
        return { ...node, concurrency };
      }
      if ((field === "items" || field === "itemVar") && !value) return node;
      return { ...node, [field]: value };
    });
  }

  function updateParallelConfig(
    index: number,
    field:
      | "concurrency"
      | "failFast"
      | "branchId"
      | "branchLabel"
      | "branchNodes"
      | "addBranch"
      | "removeBranch",
    value: string | boolean,
    branchIndex?: number,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.parallel") return node;
      const branches = normalizeParallelBranchDrafts(node.branches);
      if (field === "concurrency") {
        const concurrency = Number.parseInt(String(value), 10);
        if (
          !Number.isFinite(concurrency) ||
          concurrency < 1 ||
          concurrency > 16
        ) {
          const nextNode = { ...node };
          delete nextNode.concurrency;
          return nextNode;
        }
        return { ...node, concurrency };
      }
      if (field === "failFast") {
        return { ...node, failFast: value === true };
      }
      if (field === "addBranch") {
        const nextIndex = branches.length + 1;
        return {
          ...node,
          branches: [
            ...branches,
            {
              id: uniqueParallelBranchId(branches, `branch_${nextIndex}`),
              label: `Branch ${nextIndex}`,
              nodes: [],
            },
          ],
        };
      }
      if (field === "removeBranch") {
        if (typeof branchIndex !== "number" || branches.length <= 1) {
          return node;
        }
        return {
          ...node,
          branches: branches.filter((_, index) => index !== branchIndex),
        };
      }
      if (typeof branchIndex !== "number" || !branches[branchIndex]) {
        return node;
      }
      const nextBranches = branches.map((branch, index) => {
        if (index !== branchIndex) return branch;
        if (field === "branchId") {
          const id = safeParallelBranchId(String(value));
          if (!id) return branch;
          return { ...branch, id };
        }
        if (field === "branchLabel") {
          const label = String(value).trim();
          return label ? { ...branch, label } : { ...branch, label: undefined };
        }
        return { ...branch, nodes: parseNodeIdList(String(value)) };
      });
      return { ...node, branches: nextBranches };
    });
  }

  function updatePythonConfig(
    index: number,
    field: "input" | "code" | "timeoutMs" | "reset",
    value: string | boolean,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "builtin.python") return node;
      if (field === "timeoutMs") {
        const timeoutMs =
          typeof value === "string"
            ? parseOptionalTimeoutMs(value, 100, 300_000)
            : null;
        return timeoutMs === null
          ? omitNodeKey(node, "timeoutMs")
          : { ...node, timeoutMs };
      }
      if (field === "reset") {
        return value === true
          ? { ...node, reset: true }
          : omitNodeKey(node, "reset");
      }
      if (field === "input" && typeof value === "string") {
        const parsed = parseJsonObjectDraft(value);
        if (!parsed.ok) return node;
        return { ...node, input: parsed.value };
      }
      if (field === "code" && value === "") return node;
      return { ...node, [field]: value };
    });
  }

  function updateMcpToolConfig(
    index: number,
    field: "server" | "tool" | "input" | "timeoutMs",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "mcp.tool") return node;
      if (field === "input") {
        const parsed = parseJsonObjectDraft(value);
        if (!parsed.ok) return node;
        return { ...node, input: parsed.value };
      }
      if (field === "timeoutMs") {
        const timeoutMs = parseOptionalTimeoutMs(value, 100, 300_000);
        return timeoutMs === null
          ? omitNodeKey(node, "timeoutMs")
          : { ...node, timeoutMs };
      }
      if ((field === "server" || field === "tool") && !value) return node;
      return { ...node, [field]: value };
    });
  }

  function updateMcpToolSelection(index: number, server: string, tool: string) {
    updateNode(index, (node) => {
      if (node.type !== "mcp.tool") return node;
      return { ...node, server, tool };
    });
  }

  function updateMcpSchemaInput(index: number, key: string, value: string) {
    updateNode(index, (node) => {
      if (node.type !== "mcp.tool") return node;
      const input = isRecord(node.input) ? { ...node.input } : {};
      const next = value.trim();
      if (next) input[key] = next;
      else delete input[key];
      return Object.keys(input).length === 0
        ? omitNodeKey(node, "input")
        : { ...node, input };
    });
  }

  function updateAgentConfig(
    index: number,
    field: "agentId" | "prompt" | "input" | "timeoutMs",
    value: string,
  ) {
    updateNode(index, (node) => {
      if (node.type !== "agent.call") return node;
      if (field === "input") {
        const parsed = parseJsonObjectDraft(value);
        if (!parsed.ok) return node;
        return { ...node, input: parsed.value };
      }
      if (field === "timeoutMs") {
        const timeoutMs = parseOptionalTimeoutMs(value, 1, 300_000);
        return timeoutMs === null
          ? omitNodeKey(node, "timeoutMs")
          : { ...node, timeoutMs };
      }
      if ((field === "agentId" || field === "prompt") && !value) return node;
      return { ...node, [field]: value };
    });
  }

  function updateTriggerInputSchema(triggerId: string, value: string) {
    updateTrigger(triggerId, (trigger) => {
      const schema = parseOptionalJsonDraft(value);
      if (!schema.ok) return trigger;
      if (schema.value === null) {
        const nextTrigger = { ...trigger };
        delete nextTrigger.inputSchema;
        return nextTrigger;
      }
      return { ...trigger, inputSchema: schema.value };
    });
  }

  function updateScheduledTrigger(
    triggerId: string,
    field: "expr" | "tz",
    value: string,
  ) {
    updateTrigger(triggerId, (trigger) => {
      if (trigger["kind"] !== "scheduled") return trigger;
      const currentSchedule = isRecord(trigger["schedule"])
        ? trigger["schedule"]
        : {};
      const schedule: Record<string, JsonValue> = {
        kind: "cron",
        expr:
          typeof currentSchedule["expr"] === "string"
            ? currentSchedule["expr"]
            : "",
        ...(typeof currentSchedule["tz"] === "string"
          ? { tz: currentSchedule["tz"] }
          : {}),
      };
      if (field === "expr") {
        if (!value) return trigger;
        schedule.expr = value;
      } else if (value.trim()) {
        schedule.tz = value.trim();
      } else {
        delete schedule.tz;
      }
      return { ...trigger, schedule };
    });
  }

  function updateScheduledTriggerInput(triggerId: string, value: string) {
    updateTrigger(triggerId, (trigger) => {
      if (trigger["kind"] !== "scheduled") return trigger;
      const parsed = parseOptionalJsonDraft(value);
      if (!parsed.ok) return trigger;
      const nextTrigger: { [key: string]: JsonValue } = { ...trigger };
      if (parsed.value === null) delete nextTrigger.input;
      else nextTrigger.input = parsed.value;
      return nextTrigger;
    });
  }

  function updateTriggerEnabled(triggerId: string, enabled: boolean) {
    updateTrigger(triggerId, (trigger) => {
      if (trigger["kind"] === "manual") return { ...trigger, enabled: true };
      if (trigger["kind"] === "task") return { ...trigger, enabled: false };
      if (trigger["kind"] === "scheduled" || trigger["kind"] === "webhook") {
        return { ...trigger, enabled };
      }
      return trigger;
    });
  }

  function updateWebhookTriggerPath(triggerId: string, value: string) {
    updateTrigger(triggerId, (trigger) => {
      if (trigger["kind"] !== "webhook") return trigger;
      const nextTrigger: { [key: string]: JsonValue } = {
        ...trigger,
      };
      const path = value.trim();
      if (path) nextTrigger.path = path;
      else delete nextTrigger.path;
      return nextTrigger;
    });
  }

  function updateWebhookTriggerSecretSha256(triggerId: string, value: string) {
    updateTrigger(triggerId, (trigger) => {
      if (trigger["kind"] !== "webhook") return trigger;
      const nextTrigger: { [key: string]: JsonValue } = {
        ...trigger,
      };
      const secretSha256 = value.trim();
      if (!secretSha256) delete nextTrigger.secretSha256;
      else if (/^[a-f0-9]{64}$/i.test(secretSha256)) {
        nextTrigger.secretSha256 = secretSha256;
      } else {
        return trigger;
      }
      return nextTrigger;
    });
  }

  function updateTaskTriggerFilter(triggerId: string, value: string) {
    updateTrigger(triggerId, (trigger) => {
      if (trigger["kind"] !== "task") return trigger;
      const parsed = parseJsonDraft(value);
      if (!parsed.ok) return trigger;
      return { ...trigger, enabled: false, filter: parsed.value };
    });
  }

  function updateTrigger(
    triggerId: string,
    updater: (trigger: { [key: string]: JsonValue }) => {
      [key: string]: JsonValue;
    },
  ) {
    const parsed = parseTriggersDraft(triggersDraftRef.current);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    const next = parsed.value.map((trigger) => {
      if (!isRecord(trigger) || trigger["id"] !== triggerId) return trigger;
      return updater(trigger as { [key: string]: JsonValue });
    });
    setTriggersDraft(formatJson(next));
    setTriggers(deriveTriggerSummaries(next));
  }

  function nodeCardProps(
    node: WorkflowNode,
    index: number,
    nodeCount: number,
  ): NodeCardProps {
    return {
      node,
      index,
      canMoveUp: index > 0,
      canMoveDown: index < nodeCount - 1,
      onMoveUp: () => moveNode(index, -1),
      onMoveDown: () => moveNode(index, 1),
      onDelete: () => deleteNode(index),
      onLabelChange: (value) => updateNodeLabel(index, value),
      onAssignmentTargetChange: (target, value) =>
        updateAssignmentTarget(index, target, value),
      onAssignmentSourceChange: (target, value) =>
        updateAssignmentSource(index, target, value),
      onAssignmentModeChange: (target, value) =>
        updateAssignmentMode(index, target, value),
      onTransformConfigChange: (field, value) =>
        updateTransformConfig(index, field, value),
      onBranchConfigChange: (field, value) =>
        updateBranchConfig(index, field, value),
      onSwitchConfigChange: (field, value, caseIndex) =>
        updateSwitchConfig(index, field, value, caseIndex),
      onLogConfigChange: (field, value) => updateLogConfig(index, field, value),
      onThrowErrorConfigChange: (field, value) =>
        updateThrowErrorConfig(index, field, value),
      onSleepConfigChange: (field, value) =>
        updateSleepConfig(index, field, value),
      onExitConfigChange: (field, value) =>
        updateExitConfig(index, field, value),
      onForeachConfigChange: (field, value) =>
        updateForeachConfig(index, field, value),
      onParallelConfigChange: (field, value, branchIndex) =>
        updateParallelConfig(index, field, value, branchIndex),
      onPythonConfigChange: (field, value) =>
        updatePythonConfig(index, field, value),
      mcpTools,
      agents,
      onMcpToolConfigChange: (field, value) =>
        updateMcpToolConfig(index, field, value),
      onMcpToolSelect: (server, tool) =>
        updateMcpToolSelection(index, server, tool),
      onMcpSchemaInputChange: (key, value) =>
        updateMcpSchemaInput(index, key, value),
      onAgentConfigChange: (field, value) =>
        updateAgentConfig(index, field, value),
    };
  }

  const firstMcpTool = mcpTools[0];
  const firstAvailableAgent = agents.find(
    (agent) => agent.instantMessagesEnabled !== false,
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-paper text-ink">
        {loading && <LoadingHairline />}
        <header className="flex shrink-0 flex-col gap-3 border-b border-paper-rule bg-paper px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-sm text-ink-faint">
              <span>Workflows</span>
              <span aria-hidden="true">›</span>
              <h1 className="truncate text-sm font-semibold text-ink">
                {selected?.name ?? "Workflow console"}
              </h1>
            </div>
            {selected && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={
                    selected.status === "published" ? "healthy" : "outline"
                  }
                >
                  {selected.status}
                </Badge>
                <Badge variant="outline">v{selected.version}</Badge>
                {parsedNodes.ok && (
                  <Badge
                    variant={nodeReferences.ok ? "outline" : "destructive"}
                  >
                    {parsedNodes.value.length} nodes
                  </Badge>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {workflows.length > 0 && (
              <Select
                value={selected?.id ?? ""}
                onValueChange={(workflowId) => {
                  const workflow = workflows.find(
                    (item) => item.id === workflowId,
                  );
                  if (workflow) void selectWorkflow(workflow);
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Open workflow"
                  className="w-[190px]"
                >
                  <SelectValue placeholder="Open workflow" />
                </SelectTrigger>
                <SelectContent>
                  {workflows.map((workflow) => (
                    <SelectItem key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={createWorkflow}
              disabled={busy !== null}
            >
              <Plus className="size-4" />
              New
            </Button>
            <input
              ref={importInputRef}
              aria-label="Import workflow file"
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => void importWorkflowFile(event)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => importInputRef.current?.click()}
              disabled={busy !== null}
            >
              <Upload className="size-4" />
              Import
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={saveDraft}
              disabled={!selected || busy !== null}
            >
              <Save className="size-4" />
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={publishWorkflow}
              disabled={!selected || busy !== null}
            >
              <Send className="size-4" />
              Publish
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={exportWorkflowDefinition}
              disabled={!selected || busy !== null}
            >
              <Download className="size-4" />
              Export
            </Button>
            <Button
              type="button"
              variant="ghost-destructive"
              size="sm"
              onClick={() => selected && void deleteWorkflow(selected)}
              disabled={!selected || busy !== null}
            >
              {selected && busy === `delete:${selected.id}` ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
            <Button asChild type="button" variant="ghost" size="sm">
              <Link to="/workflow-runs">
                <ScrollText className="size-4" />
                Runs
              </Link>
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void runWorkflow("test")}
              disabled={!selected || busy !== null}
            >
              {busy === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Test
            </Button>
            <Button
              type="button"
              variant="signal"
              size="sm"
              onClick={() => void runWorkflow("live")}
              disabled={!selected || busy !== null}
            >
              <Circle className="size-3 fill-current" />
              Live
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[260px_minmax(0,1fr)_420px]">
          <WorkflowList
            workflows={workflows}
            selectedId={selected?.id ?? null}
            onCreate={createWorkflow}
            onSelect={(workflow) => void selectWorkflow(workflow)}
            onDelete={(workflow) => void deleteWorkflow(workflow)}
            busy={busy}
          />
          <section className="flex min-h-0 flex-col border-r border-paper-rule">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-paper-rule bg-paper px-4 py-2">
              <div
                role="tablist"
                aria-label="Workflow designer views"
                className="inline-flex overflow-hidden border border-paper-rule bg-paper-sunk"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={designerView === "edit"}
                  className={cn(
                    "flex h-9 items-center gap-2 px-3 text-sm",
                    designerView === "edit"
                      ? "bg-paper text-signal-blue"
                      : "text-ink-faint hover:text-ink",
                  )}
                  onClick={() => setDesignerView("edit")}
                >
                  <Edit3 className="size-4" />
                  Edit
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={designerView === "runs"}
                  className={cn(
                    "flex h-9 items-center gap-2 border-l border-paper-rule px-3 text-sm",
                    designerView === "runs"
                      ? "bg-paper text-signal-blue"
                      : "text-ink-faint hover:text-ink",
                  )}
                  onClick={() => setDesignerView("runs")}
                >
                  <Clock3 className="size-4" />
                  Run History
                </button>
              </div>
              <div className="flex items-center gap-2">
                {!nodeReferences.ok && (
                  <Badge variant="destructive">reference issue</Badge>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Workflow settings"
                  onClick={() => {
                    setSelectedCanvasNodeId(null);
                    setSelectedCanvasEdgeId(null);
                    setDesignerView("edit");
                  }}
                >
                  <Settings className="size-4" />
                </Button>
              </div>
            </div>

            {selected ? (
              <section
                aria-label="Workflow Canvas"
                className="workflow-designer-grid relative min-h-0 flex-1 overflow-hidden bg-paper-sunk"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handlePaletteDrop}
              >
                {parsedNodes.ok ? (
                  <WorkflowCanvas
                    projection={workflowGraphProjection}
                    selectedNodeId={selectedCanvasNodeId}
                    selectedEdgeId={selectedCanvasEdgeId}
                    onSelectNode={selectCanvasNode}
                    onSelectEdge={(edge) =>
                      setSelectedCanvasEdgeId(edge?.id ?? null)
                    }
                    onConnectReference={connectCanvasReferenceEdge}
                    onRemoveSelectedEdge={removeSelectedCanvasReferenceEdge}
                    onMoveSelectedUp={() => moveSelectedCanvasNode(-1)}
                    onMoveSelectedDown={() => moveSelectedCanvasNode(1)}
                    onCloneNode={cloneSelectedCanvasNode}
                    onDeleteNode={deleteWorkflowNode}
                    onMakeForeachBodyFirst={makeForeachBodyFirst}
                    onNodePositionChange={updateCanvasNodePosition}
                    onBeautifyLayout={beautifyCanvasLayout}
                    onAddStep={openAddStepDialog}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-sm text-ink-soft">
                    Invalid node JSON
                  </div>
                )}
              </section>
            ) : (
              <div className="flex h-full items-center justify-center p-8">
                <Button type="button" onClick={createWorkflow}>
                  <Plus className="size-4" />
                  New workflow
                </Button>
              </div>
            )}
          </section>

          <section className="flex min-h-0 flex-col bg-paper">
            {designerView === "edit" ? (
              <WorkflowInspector
                workflow={selected}
                projection={workflowGraphProjection}
                selectedNodeId={selectedCanvasNodeId}
                nodeReferences={nodeReferences}
                nodes={parsedNodes.ok ? parsedNodes.value : []}
                nodeCardProps={nodeCardProps}
                nameDraft={nameDraft}
                descriptionDraft={descriptionDraft}
                inputSchemaDraft={inputSchemaDraft}
                inputDraft={inputDraft}
                triggers={triggers}
                onNameChange={setNameDraft}
                onDescriptionChange={setDescriptionDraft}
                onInputSchemaChange={setInputSchemaDraft}
                onInputDraftChange={setInputDraft}
                onRunTest={() => void runWorkflow("test")}
                onRunTrigger={(trigger) => void runTrigger(trigger)}
                triggerBusy={busy}
                selectedStatus={selected?.status ?? null}
                updateTriggerEnabled={updateTriggerEnabled}
                updateTriggerInputSchema={updateTriggerInputSchema}
                updateScheduledTrigger={updateScheduledTrigger}
                updateScheduledTriggerInput={updateScheduledTriggerInput}
                updateWebhookTriggerPath={updateWebhookTriggerPath}
                updateWebhookTriggerSecretSha256={
                  updateWebhookTriggerSecretSha256
                }
                updateTaskTriggerFilter={updateTaskTriggerFilter}
              />
            ) : (
              <>
                <div className="flex shrink-0 items-center justify-end border-b border-paper-rule px-4 py-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDesignerView("edit")}
                  >
                    <XCircle className="size-4" />
                    Exit Run History
                  </Button>
                </div>
                <RunConsole
                  workflowName={selected?.name ?? null}
                  detail={detail}
                  runs={runs}
                  selectedStep={selectedStep}
                  pendingRunId={pendingRunId}
                  busy={busy}
                  hasMoreRuns={hasMoreRuns}
                  loadingMoreRuns={loadingMoreRuns}
                  filters={{
                    mode,
                    status,
                    triggerId,
                    createdFrom,
                    createdTo,
                  }}
                  onFiltersChange={updateRunFilters}
                  onSelectRun={selectRunFromHistory}
                  onLoadMoreRuns={() => void loadMoreRuns()}
                  onRefresh={() => {
                    if (!detail) return;
                    void loadRunDetail(detail.run.id, selected?.id);
                  }}
                  onSelectStep={selectRunConsoleStep}
                  onRerun={() => void rerun()}
                  onCancel={() => void cancelRun()}
                />
              </>
            )}
          </section>
        </div>
        <AddStepDialog
          open={addStepTargetNodeId !== undefined}
          targetNodeId={addStepTargetNodeId ?? null}
          triggerOnly={
            addStepTargetNodeId === null &&
            parsedNodes.ok &&
            parsedNodes.value.length === 0 &&
            triggers.length === 0
          }
          mcpTools={mcpTools}
          agents={agents}
          triggers={triggers}
          onOpenChange={(open) => {
            if (!open) closeAddStepDialog();
          }}
          onAdd={insertNodeFromPalette}
        />
      </main>
    </div>
  );
}

function WorkflowList({
  workflows,
  selectedId,
  onCreate,
  onSelect,
  onDelete,
  busy,
}: {
  workflows: WorkflowDefinition[];
  selectedId: string | null;
  onCreate: () => void;
  onSelect: (workflow: WorkflowDefinition) => void;
  onDelete: (workflow: WorkflowDefinition) => void;
  busy: string | null;
}) {
  return (
    <aside
      aria-label="Workflow List"
      className="hidden min-h-0 flex-col overflow-hidden border-r border-paper-rule bg-paper lg:flex"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-paper-rule px-3 py-2">
        <div className="flex items-center gap-2">
          <Workflow className="size-4 text-ink-faint" />
          <SectionEyebrow>Workflows</SectionEyebrow>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Create workflow"
          onClick={onCreate}
        >
          <Plus className="size-3" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {workflows.length > 0 ? (
          <div className="space-y-1">
            {workflows.map((workflow) => {
              const active = workflow.id === selectedId;
              return (
                <div
                  key={workflow.id}
                  className={cn(
                    "group flex items-start gap-1 border transition",
                    active
                      ? "border-signal-blue bg-signal-blue/10"
                      : "border-transparent hover:border-paper-rule hover:bg-paper-sunk",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 px-2.5 py-2 text-left transition",
                      active
                        ? "text-ink"
                        : "text-ink-soft group-hover:text-ink",
                    )}
                    onClick={() => onSelect(workflow)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {workflow.name}
                      </span>
                      <Badge
                        variant={
                          workflow.status === "published"
                            ? "healthy"
                            : "outline"
                        }
                      >
                        {workflow.status}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-faint">
                      <span>v{workflow.version}</span>
                      <span>{shortDate(workflow.updatedAt)}</span>
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost-destructive"
                    size="icon-xs"
                    aria-label={`Delete workflow ${workflow.name}`}
                    title="Delete workflow"
                    className="mt-2 mr-2 opacity-70 group-hover:opacity-100"
                    disabled={busy !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(workflow);
                    }}
                  >
                    {busy === `delete:${workflow.id}` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-ink-soft">
            No workflows yet.
          </div>
        )}
      </div>
    </aside>
  );
}

function WorkflowInspector({
  workflow,
  projection,
  selectedNodeId,
  nodeReferences,
  nodes,
  nodeCardProps,
  nameDraft,
  descriptionDraft,
  inputSchemaDraft,
  inputDraft,
  triggers,
  onNameChange,
  onDescriptionChange,
  onInputSchemaChange,
  onInputDraftChange,
  onRunTest,
  onRunTrigger,
  triggerBusy,
  selectedStatus,
  updateTriggerEnabled,
  updateTriggerInputSchema,
  updateScheduledTrigger,
  updateScheduledTriggerInput,
  updateWebhookTriggerPath,
  updateWebhookTriggerSecretSha256,
  updateTaskTriggerFilter,
}: {
  workflow: WorkflowDefinition | null;
  projection: WorkflowGraphProjection;
  selectedNodeId: string | null;
  nodeReferences: NodeReferenceValidation;
  nodes: WorkflowNode[];
  nodeCardProps: (
    node: WorkflowNode,
    index: number,
    nodeCount: number,
  ) => NodeCardProps;
  nameDraft: string;
  descriptionDraft: string;
  inputSchemaDraft: string;
  inputDraft: string;
  triggers: WorkflowTriggerSummary[];
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onInputSchemaChange: (value: string) => void;
  onInputDraftChange: (value: string) => void;
  onRunTest: () => void;
  onRunTrigger: (trigger: WorkflowTriggerSummary) => void;
  triggerBusy: string | null;
  selectedStatus: WorkflowDefinition["status"] | null;
  updateTriggerEnabled: (triggerId: string, enabled: boolean) => void;
  updateTriggerInputSchema: (triggerId: string, value: string) => void;
  updateScheduledTrigger: (
    triggerId: string,
    field: "expr" | "tz",
    value: string,
  ) => void;
  updateScheduledTriggerInput: (triggerId: string, value: string) => void;
  updateWebhookTriggerPath: (triggerId: string, value: string) => void;
  updateWebhookTriggerSecretSha256: (triggerId: string, value: string) => void;
  updateTaskTriggerFilter: (triggerId: string, value: string) => void;
}) {
  const selectedNode = selectedNodeId
    ? (projection.nodes.find((node) => node.id === selectedNodeId) ?? null)
    : null;
  const data = selectedNode?.data as WorkflowCanvasNodeData | undefined;
  const inspectedNodeIndex =
    data?.kind === "step" ? nodes.findIndex((node) => node.id === data.id) : -1;
  const inspectedNode =
    inspectedNodeIndex >= 0 ? (nodes[inspectedNodeIndex] ?? null) : null;
  const [workflowInspectorTab, setWorkflowInspectorTab] = useState<
    "workflow" | "test"
  >("test");
  const visibleCanvasNodeCount = projection.nodes.filter((node) => {
    const nodeData = node.data as WorkflowCanvasNodeData | undefined;
    return nodeData?.kind !== "group";
  }).length;

  return (
    <aside
      aria-label="Workflow Inspector"
      className="min-h-0 flex-1 overflow-y-auto bg-paper px-4 py-4"
    >
      <div className="flex items-center justify-between gap-2">
        <SectionEyebrow>Inspector</SectionEyebrow>
        <Badge variant={nodeReferences.ok ? "healthy" : "destructive"}>
          {nodeReferences.ok ? "refs ok" : "refs issue"}
        </Badge>
      </div>

      {data ? (
        <div className="mt-3 space-y-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{data.label}</div>
            <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
              {data.id}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge
              variant={data.kind === "missing" ? "destructive" : "outline"}
            >
              {data.kind}
            </Badge>
            {data.badges.map((badge) => (
              <Badge key={badge} variant="secondary">
                {badge}
              </Badge>
            ))}
          </div>
          <dl className="grid gap-2 text-xs">
            <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
              <dt className="font-mono uppercase text-ink-faint">Type</dt>
              <dd className="min-w-0 truncate text-ink-soft">{data.type}</dd>
            </div>
            {typeof data.index === "number" && (
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
                <dt className="font-mono uppercase text-ink-faint">Order</dt>
                <dd className="text-ink-soft">{data.index + 1}</dd>
              </div>
            )}
          </dl>
          {data.warning && (
            <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {data.warning}
            </div>
          )}
          {inspectedNode && (
            <div
              aria-label={`Inspector settings ${inspectedNode.id}`}
              className="pt-1"
            >
              <NodeCard
                {...nodeCardProps(
                  inspectedNode,
                  inspectedNodeIndex,
                  nodes.length,
                )}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="text-sm font-semibold">
            {workflow?.name ?? "No workflow selected"}
          </div>
          {workflow && (
            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant={
                  workflow.status === "published" ? "healthy" : "outline"
                }
              >
                {workflow.status}
              </Badge>
              <Badge variant="outline">v{workflow.version}</Badge>
              <Badge variant="outline">{visibleCanvasNodeCount} nodes</Badge>
              <Badge variant="outline">{projection.edges.length} edges</Badge>
            </div>
          )}
          {workflow && (
            <>
              <div
                role="tablist"
                aria-label="Workflow configuration views"
                className="flex gap-5 border-b border-paper-rule"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={workflowInspectorTab === "workflow"}
                  className={cn(
                    "border-b-2 px-0 pb-2 text-sm font-medium",
                    workflowInspectorTab === "workflow"
                      ? "border-signal-blue text-signal-blue"
                      : "border-transparent text-ink-soft hover:text-ink",
                  )}
                  onClick={() => setWorkflowInspectorTab("workflow")}
                >
                  Workflow Configuration
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={workflowInspectorTab === "test"}
                  className={cn(
                    "border-b-2 px-0 pb-2 text-sm font-medium",
                    workflowInspectorTab === "test"
                      ? "border-signal-blue text-signal-blue"
                      : "border-transparent text-ink-soft hover:text-ink",
                  )}
                  onClick={() => setWorkflowInspectorTab("test")}
                >
                  Test Configuration
                </button>
              </div>

              {workflowInspectorTab === "workflow" ? (
                <div className="grid gap-3">
                  <InspectorSection title="Workflow Basics" defaultOpen>
                    <label className="grid gap-1">
                      <span className="text-sm font-medium text-ink-soft">
                        Name
                      </span>
                      <Input
                        aria-label="Workflow name"
                        value={nameDraft}
                        onChange={(event) => onNameChange(event.target.value)}
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="text-sm font-medium text-ink-soft">
                        Description
                      </span>
                      <Input
                        aria-label="Workflow description"
                        value={descriptionDraft}
                        onChange={(event) =>
                          onDescriptionChange(event.target.value)
                        }
                      />
                    </label>
                  </InspectorSection>
                  <InspectorSection title="Input Contract">
                    <label className="grid gap-1">
                      <span className="text-sm font-medium text-ink-soft">
                        Input Schema JSON
                      </span>
                      <Textarea
                        aria-label="Input Schema JSON"
                        value={inputSchemaDraft}
                        rows={9}
                        spellCheck={false}
                        onChange={(event) =>
                          onInputSchemaChange(event.target.value)
                        }
                        className="min-h-48 font-mono text-xs leading-relaxed"
                      />
                    </label>
                  </InspectorSection>
                  <InspectorSection
                    title="Triggers"
                    badge={`${triggers.length}`}
                    defaultOpen
                  >
                    <div className="text-xs text-ink-faint">
                      Manual now; scheduled/webhook/task ready for later.
                    </div>
                    <div className="grid gap-2">
                      {triggers.map((trigger) => {
                        const busyKey = `trigger:${trigger.id}`;
                        const canRun =
                          trigger.runnable &&
                          selectedStatus === "published" &&
                          triggerBusy === null;
                        return (
                          <div
                            key={trigger.id}
                            role="group"
                            aria-label={`Trigger ${trigger.id}`}
                            className="grid gap-2 border border-paper-rule bg-paper-sunk px-3 py-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <label className="flex shrink-0 items-center gap-1 text-xs text-ink-soft">
                                <input
                                  aria-label={`${trigger.id} trigger enabled`}
                                  type="checkbox"
                                  checked={triggerEnabledChecked(trigger)}
                                  disabled={!triggerEnabledEditable(trigger)}
                                  onChange={(event) =>
                                    updateTriggerEnabled(
                                      trigger.id,
                                      event.target.checked,
                                    )
                                  }
                                />
                                On
                              </label>
                              <Badge
                                variant={
                                  trigger.runnable ? "healthy" : "outline"
                                }
                              >
                                {trigger.kind}
                              </Badge>
                              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">
                                {trigger.id}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => onRunTrigger(trigger)}
                                disabled={!canRun}
                                title={
                                  selectedStatus === "published"
                                    ? undefined
                                    : "Publish before running a trigger"
                                }
                              >
                                {triggerBusy === busyKey ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Play className="size-3" />
                                )}
                                Run
                              </Button>
                            </div>
                            {(trigger.kind === "manual" ||
                              trigger.kind === "webhook") && (
                              <label className="grid gap-1 text-xs text-ink-soft">
                                Input Schema JSON
                                <Textarea
                                  aria-label={`${trigger.id} trigger input schema`}
                                  value={formatOptionalJson(
                                    trigger.inputSchema,
                                  )}
                                  onChange={(event) =>
                                    updateTriggerInputSchema(
                                      trigger.id,
                                      event.target.value,
                                    )
                                  }
                                  className="min-h-32 font-mono text-xs leading-relaxed"
                                />
                              </label>
                            )}
                            {trigger.kind === "scheduled" && (
                              <div className="grid gap-2">
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <label className="grid gap-1 text-xs text-ink-soft">
                                    Cron
                                    <Input
                                      aria-label={`${trigger.id} scheduled cron`}
                                      value={scheduledTriggerExpr(trigger)}
                                      onChange={(event) =>
                                        updateScheduledTrigger(
                                          trigger.id,
                                          "expr",
                                          event.target.value,
                                        )
                                      }
                                      className="font-mono text-xs"
                                    />
                                  </label>
                                  <label className="grid gap-1 text-xs text-ink-soft">
                                    TZ
                                    <Input
                                      aria-label={`${trigger.id} scheduled timezone`}
                                      value={scheduledTriggerTz(trigger)}
                                      onChange={(event) =>
                                        updateScheduledTrigger(
                                          trigger.id,
                                          "tz",
                                          event.target.value,
                                        )
                                      }
                                      className="font-mono text-xs"
                                    />
                                  </label>
                                </div>
                                <label className="grid gap-1 text-xs text-ink-soft">
                                  Input JSON
                                  <Textarea
                                    aria-label={`${trigger.id} scheduled input`}
                                    value={formatOptionalJson(trigger.input)}
                                    onChange={(event) =>
                                      updateScheduledTriggerInput(
                                        trigger.id,
                                        event.target.value,
                                      )
                                    }
                                    className="min-h-32 font-mono text-xs leading-relaxed"
                                  />
                                </label>
                              </div>
                            )}
                            {trigger.kind === "webhook" && (
                              <div className="grid gap-2">
                                <label className="grid gap-1 text-xs text-ink-soft">
                                  Path
                                  <Input
                                    aria-label={`${trigger.id} webhook path`}
                                    value={
                                      typeof trigger.path === "string"
                                        ? trigger.path
                                        : ""
                                    }
                                    onChange={(event) =>
                                      updateWebhookTriggerPath(
                                        trigger.id,
                                        event.target.value,
                                      )
                                    }
                                    className="font-mono text-xs"
                                  />
                                </label>
                                <label className="grid gap-1 text-xs text-ink-soft">
                                  Secret SHA-256
                                  <Input
                                    aria-label={`${trigger.id} webhook secret sha-256`}
                                    value={
                                      typeof trigger.secretSha256 === "string"
                                        ? trigger.secretSha256
                                        : ""
                                    }
                                    onChange={(event) =>
                                      updateWebhookTriggerSecretSha256(
                                        trigger.id,
                                        event.target.value,
                                      )
                                    }
                                    className="font-mono text-xs"
                                  />
                                </label>
                              </div>
                            )}
                            {trigger.kind === "task" && (
                              <label className="grid gap-1 text-xs text-ink-soft">
                                Filter JSON
                                <Textarea
                                  aria-label={`${trigger.id} task filter`}
                                  value={
                                    trigger.filter === undefined
                                      ? "null"
                                      : formatJson(trigger.filter)
                                  }
                                  onChange={(event) =>
                                    updateTaskTriggerFilter(
                                      trigger.id,
                                      event.target.value,
                                    )
                                  }
                                  className="min-h-32 font-mono text-xs leading-relaxed"
                                />
                              </label>
                            )}
                          </div>
                        );
                      })}
                      {triggers.length === 0 && (
                        <div className="text-sm text-ink-soft">No triggers</div>
                      )}
                    </div>
                  </InspectorSection>
                </div>
              ) : (
                <section className="grid gap-3">
                  <InspectorSection title="Test Input" defaultOpen>
                    <div className="text-sm text-ink-faint">
                      Set the payload used by the next test run.
                    </div>
                    <label className="grid gap-1">
                      <span className="text-sm font-medium text-ink-soft">
                        Test Input JSON
                      </span>
                      <Textarea
                        aria-label="Run input"
                        value={inputDraft}
                        rows={18}
                        spellCheck={false}
                        onChange={(event) =>
                          onInputDraftChange(event.target.value)
                        }
                        className="min-h-[26rem] font-mono text-xs leading-relaxed"
                      />
                    </label>
                  </InspectorSection>
                  <Button
                    type="button"
                    variant="signal"
                    size="sm"
                    className="w-fit"
                    aria-label="Run workflow test with configured input"
                    onClick={onRunTest}
                    disabled={triggerBusy !== null}
                  >
                    {triggerBusy === "test" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    Test
                  </Button>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {projection.warnings.length > 0 && (
        <div className="mt-3 border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {projection.warnings.length} reference warning
          {projection.warnings.length === 1 ? "" : "s"}
        </div>
      )}
    </aside>
  );
}

type AddStepCategory = "Trigger" | "Built-in" | "Logic" | "AI" | "Tools";

interface AddStepCatalogItem {
  id: string;
  label: string;
  ariaLabel?: string;
  category: AddStepCategory;
  description: string;
  payload: WorkflowAddPayload;
  disabled?: boolean;
  title?: string;
  inputs: string[];
  outputs: string[];
}

function AddStepDialog({
  open,
  targetNodeId,
  triggerOnly,
  mcpTools,
  agents,
  triggers,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  targetNodeId: string | null;
  triggerOnly: boolean;
  mcpTools: McpToolSummary[];
  agents: AgentSummary[];
  triggers: WorkflowTriggerSummary[];
  onOpenChange: (open: boolean) => void;
  onAdd: (payload: WorkflowAddPayload) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AddStepCategory>("Trigger");
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setCategory(triggerOnly || triggers.length === 0 ? "Trigger" : "Built-in");
    setQuery("");
    setPreviewItemId(null);
  }, [open, triggerOnly, triggers.length]);
  const catalog = useMemo(() => {
    const items = workflowStepCatalog({
      hasTrigger: triggers.length > 0,
      mcpTools,
      agents,
    });
    return triggerOnly
      ? items.filter((item) => item.category === "Trigger")
      : items;
  }, [agents, mcpTools, triggerOnly, triggers.length]);
  const normalizedQuery = query.trim().toLowerCase();
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const matchesCatalogQuery = (item: AddStepCatalogItem) => {
    if (queryTokens.length === 0) return true;
    const searchableFields = [
      item.label,
      item.description,
      item.category,
      item.ariaLabel,
      item.title,
      ...item.inputs,
      ...item.outputs,
    ].map((field) => (field ?? "").toLowerCase());
    return queryTokens.every((token) =>
      searchableFields.some((field) => field.includes(token)),
    );
  };
  const categories = useMemo(
    () =>
      (["Trigger", "Built-in", "Logic", "AI", "Tools"] as const).filter(
        (item) =>
          catalog.some(
            (step) => step.category === item && matchesCatalogQuery(step),
          ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, normalizedQuery],
  );
  useEffect(() => {
    if (categories.length === 0 || categories.includes(category)) return;
    setCategory(categories[0]!);
    setPreviewItemId(null);
  }, [categories, category]);
  useEffect(() => {
    setPreviewItemId(null);
  }, [query]);
  const filteredCatalog = catalog.filter(
    (item) => item.category === category && matchesCatalogQuery(item),
  );
  const selectedItem =
    filteredCatalog.find((item) => item.id === previewItemId) ??
    filteredCatalog[0] ??
    catalog[0];
  const catalogCount = triggerOnly ? 0 : mcpTools.length + agents.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-hidden sm:max-w-[980px]">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-8">
            <div>
              <DialogTitle>
                {triggerOnly ? "Select Trigger" : "Add Step"}
              </DialogTitle>
              <DialogDescription>
                {triggerOnly
                  ? "Choose how this workflow starts."
                  : targetNodeId
                    ? `Insert after ${targetNodeId}.`
                    : "Select a step to add to the workflow."}
              </DialogDescription>
            </div>
            {catalogCount > 0 && (
              <Badge variant="outline">{catalogCount} catalog items</Badge>
            )}
          </div>
        </DialogHeader>
        <DialogBody className="min-h-0 overflow-hidden p-0">
          <section
            aria-label="Workflow Node Palette"
            className="grid h-[min(680px,calc(100dvh-12rem))] min-h-[420px] grid-cols-[240px_minmax(260px,1fr)_minmax(280px,1fr)] overflow-hidden"
          >
            {!triggerOnly && (
              <div className="flex min-h-0 flex-col border-r border-paper-rule p-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
                  <Input
                    aria-label="Search workflow steps"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search..."
                    className="pl-9"
                  />
                </div>
                <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                  {categories.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn(
                        "flex h-9 w-full items-center gap-2 px-2 text-left text-sm",
                        category === item
                          ? "bg-signal-blue/10 text-signal-blue"
                          : "text-ink-soft hover:bg-paper-sunk hover:text-ink",
                      )}
                      onClick={() => setCategory(item)}
                      onMouseEnter={() => setPreviewItemId(null)}
                      onFocus={() => setPreviewItemId(null)}
                    >
                      <StepCategoryIcon category={item} />
                      <span>{item}</span>
                      {normalizedQuery && (
                        <span className="ml-auto text-xs text-ink-faint">
                          {
                            catalog.filter(
                              (step) =>
                                step.category === item &&
                                matchesCatalogQuery(step),
                            ).length
                          }
                        </span>
                      )}
                    </button>
                  ))}
                  {categories.length === 0 && (
                    <div className="border border-paper-rule bg-paper-sunk px-3 py-4 text-sm text-ink-soft">
                      No categories match this search.
                    </div>
                  )}
                </div>
              </div>
            )}
            <div
              className={cn(
                "min-h-0 overflow-y-auto border-r border-paper-rule p-4",
                triggerOnly && "col-span-2",
              )}
            >
              <SectionEyebrow>{category}</SectionEyebrow>
              <div className="mt-3 space-y-1">
                {filteredCatalog.map((item) => (
                  <PaletteButton
                    key={item.id}
                    item={item}
                    selected={selectedItem?.id === item.id}
                    onPreview={() => setPreviewItemId(item.id)}
                    onAdd={onAdd}
                  />
                ))}
                {filteredCatalog.length === 0 && (
                  <div className="border border-paper-rule bg-paper-sunk px-3 py-4 text-sm text-ink-soft">
                    No steps match this search.
                  </div>
                )}
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto p-5">
              {selectedItem ? (
                <StepPreview item={selectedItem} />
              ) : (
                <div className="text-sm text-ink-soft">No step selected.</div>
              )}
            </div>
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function PaletteButton({
  item,
  selected,
  onPreview,
  onAdd,
}: {
  item: AddStepCatalogItem;
  selected: boolean;
  onPreview: () => void;
  onAdd: (payload: WorkflowAddPayload) => void;
}) {
  const draggable = !item.disabled && isWorkflowPaletteKind(item.payload.kind);
  return (
    <button
      type="button"
      aria-label={item.ariaLabel ?? item.label}
      draggable={draggable}
      disabled={item.disabled}
      title={item.title ?? item.description}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors",
        item.disabled
          ? "cursor-not-allowed text-ink-faint opacity-60"
          : "text-ink-soft hover:bg-paper-sunk hover:text-ink",
        selected && "bg-paper-sunk text-ink",
      )}
      onMouseEnter={onPreview}
      onFocus={onPreview}
      onClick={() => onAdd(item.payload)}
      onDragStart={(event) => {
        if (!isWorkflowPaletteKind(item.payload.kind)) return;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          WORKFLOW_PALETTE_MIME,
          JSON.stringify(item.payload),
        );
      }}
    >
      <span className="flex size-7 shrink-0 items-center justify-center border border-paper-rule bg-paper">
        <StepKindIcon kind={item.payload.kind} />
      </span>
      <span className="min-w-0 truncate font-medium text-ink">
        {item.label}
      </span>
    </button>
  );
}

function StepPreview({ item }: { item: AddStepCatalogItem }) {
  return (
    <section aria-label="Selected workflow step preview">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center border border-paper-rule bg-paper-sunk text-signal-blue">
          <StepKindIcon kind={item.payload.kind} />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink">{item.label}</h3>
          <p className="mt-1 text-sm text-ink-soft">{item.description}</p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-3">
        <StepFieldList title="Input" fields={item.inputs} />
        <StepFieldList title="Output" fields={item.outputs} />
      </div>
    </section>
  );
}

function StepFieldList({ title, fields }: { title: string; fields: string[] }) {
  return (
    <div>
      <SectionEyebrow>{title}</SectionEyebrow>
      <div className="mt-2 min-h-32 border border-paper-rule bg-paper-sunk p-3">
        {fields.length > 0 ? (
          <ul className="space-y-2 text-sm text-ink-soft">
            {fields.map((field) => (
              <li key={field} className="font-mono text-xs">
                {field}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-ink-faint">None</div>
        )}
      </div>
    </div>
  );
}

function StepCategoryIcon({ category }: { category: AddStepCategory }) {
  if (category === "Trigger") return <Play className="size-4" />;
  if (category === "Built-in") return <Braces className="size-4" />;
  if (category === "AI") return <Bot className="size-4" />;
  if (category === "Tools") return <Workflow className="size-4" />;
  return <GitBranch className="size-4" />;
}

function StepKindIcon({ kind }: { kind: WorkflowAddPayload["kind"] }) {
  if (kind === "manual_trigger") return <Play className="size-4" />;
  if (kind === "agent") return <Bot className="size-4" />;
  if (kind === "python") return <Code2 className="size-4" />;
  if (kind === "mcp") return <Workflow className="size-4" />;
  if (kind === "set" || kind === "transform")
    return <Braces className="size-4" />;
  if (kind === "log") return <ScrollText className="size-4" />;
  if (kind === "exit") return <Square className="size-4" />;
  return <GitBranch className="size-4" />;
}

function workflowStepCatalog({
  hasTrigger,
  mcpTools,
  agents,
}: {
  hasTrigger: boolean;
  mcpTools: McpToolSummary[];
  agents: AgentSummary[];
}): AddStepCatalogItem[] {
  const builtInItems: AddStepCatalogItem[] = [
    {
      id: "manual_trigger",
      label: "Manual Trigger",
      category: "Trigger",
      description: "Start this workflow from the Test or manual run action.",
      payload: { kind: "manual_trigger" },
      disabled: hasTrigger,
      title: hasTrigger ? "Workflow already has a trigger" : undefined,
      inputs: ["input"],
      outputs: ["trigger.manual"],
    },
    {
      id: "set",
      label: "Set",
      category: "Built-in",
      description: "Save a value from input, context, or a previous step.",
      payload: { kind: "set" },
      inputs: ["assign.<variable>"],
      outputs: ["context.<variable>"],
    },
    {
      id: "transform",
      label: "Transform",
      category: "Built-in",
      description: "Transform input and optionally write it back to context.",
      payload: { kind: "transform" },
      inputs: ["input", "transform", "assign"],
      outputs: ["steps.<id>.output", "context.<variable>"],
    },
    {
      id: "python",
      label: "Python",
      category: "Built-in",
      description: "Execute a constrained Python step for data shaping.",
      payload: { kind: "python" },
      inputs: ["input", "code", "timeoutMs"],
      outputs: ["steps.<id>.output"],
    },
    {
      id: "log",
      label: "Log",
      category: "Built-in",
      description: "Write info, debug, warn, or error events into the run log.",
      payload: { kind: "log" },
      inputs: ["level", "message", "payload"],
      outputs: ["run.events"],
    },
    {
      id: "sleep",
      label: "Sleep",
      category: "Built-in",
      description: "Pause the workflow briefly before continuing.",
      payload: { kind: "sleep" },
      inputs: ["delayMs", "reason"],
      outputs: ["steps.<id>.output"],
    },
    {
      id: "throw_error",
      label: "Throw Error",
      category: "Built-in",
      description: "Fail the current route with a controlled error.",
      payload: { kind: "throw_error" },
      inputs: ["message", "code", "details"],
      outputs: ["run.status", "step.error"],
    },
    {
      id: "exit",
      label: "Exit",
      category: "Built-in",
      description: "Stop the workflow with a final status and output.",
      payload: { kind: "exit" },
      inputs: ["status", "output"],
      outputs: ["run.status", "run.output"],
    },
  ];
  const flowControlItems: AddStepCatalogItem[] = [
    {
      id: "if",
      label: "If",
      category: "Logic",
      description: "Split the flow into true and false routes.",
      payload: { kind: "if" },
      inputs: ["condition"],
      outputs: ["true", "false"],
    },
    {
      id: "foreach",
      label: "Foreach",
      category: "Logic",
      description: "Iterate over a list with a body flow.",
      payload: { kind: "foreach" },
      inputs: ["items", "itemVar", "concurrency"],
      outputs: ["body"],
    },
    {
      id: "switch",
      label: "Switch Case",
      category: "Logic",
      description: "Route the flow by matching a value against cases.",
      payload: { kind: "switch" },
      inputs: ["value", "cases", "default"],
      outputs: ["cases", "default"],
    },
    {
      id: "parallel",
      label: "Parallel",
      category: "Logic",
      description: "Run independent branches with isolated context.",
      payload: { kind: "parallel" },
      inputs: ["branches", "concurrency", "failFast"],
      outputs: ["branches", "succeededCount", "failedCount"],
    },
  ];
  const agentItems: AddStepCatalogItem[] =
    agents.length > 0
      ? agents.map((agent) => {
          const enabled = agent.instantMessagesEnabled !== false;
          const label = agent.name || agent.id;
          return {
            id: `agent:${agent.id}`,
            label,
            ariaLabel: `Agent ${label} (${agent.id})`,
            category: "AI",
            description: agent.role
              ? `${agent.role} (${agent.id})`
              : `Call OpenAcme agent ${agent.id}.`,
            payload: { kind: "agent", agentId: agent.id },
            disabled: !enabled,
            title: enabled
              ? undefined
              : "This agent is not enabled for workflow calls",
            inputs: ["agentId", "prompt", "input"],
            outputs: ["steps.<id>.output"],
          } satisfies AddStepCatalogItem;
        })
      : [
          {
            id: "agent",
            label: "Agent Call",
            category: "AI",
            description: "Call an enabled OpenAcme agent.",
            payload: { kind: "agent" },
            disabled: true,
            title: "No enabled agents are available for workflows",
            inputs: ["agentId", "prompt", "input"],
            outputs: ["steps.<id>.output"],
          },
        ];
  const mcpItems: AddStepCatalogItem[] =
    mcpTools.length > 0
      ? mcpTools.map((tool) => ({
          id: `mcp:${tool.server}:${tool.tool}`,
          label: `${tool.server}/${tool.tool}`,
          ariaLabel: `MCP tool ${tool.server}/${tool.tool}`,
          category: "Tools",
          description: tool.description || `Call ${tool.server}.${tool.tool}.`,
          payload: {
            kind: "mcp",
            server: tool.server,
            tool: tool.tool,
          },
          inputs: ["server", "tool", "input"],
          outputs: ["steps.<id>.output"],
        }))
      : [
          {
            id: "mcp",
            label: "MCP Tool",
            category: "Tools",
            description: "Call a discovered MCP tool.",
            payload: { kind: "mcp" },
            disabled: true,
            title: "No MCP tools are available for workflows",
            inputs: ["server", "tool", "input"],
            outputs: ["steps.<id>.output"],
          },
        ];
  return [...builtInItems, ...flowControlItems, ...agentItems, ...mcpItems];
}

function parseWorkflowPalettePayload(
  value: string,
): WorkflowPalettePayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const kind = parsed["kind"];
    if (!isWorkflowPaletteKind(kind)) return null;
    return {
      kind,
      ...(typeof parsed["server"] === "string"
        ? { server: parsed["server"] }
        : {}),
      ...(typeof parsed["tool"] === "string" ? { tool: parsed["tool"] } : {}),
      ...(typeof parsed["agentId"] === "string"
        ? { agentId: parsed["agentId"] }
        : {}),
    };
  } catch {
    return null;
  }
}

function isWorkflowPaletteKind(value: unknown): value is WorkflowPaletteKind {
  return (
    value === "set" ||
    value === "transform" ||
    value === "if" ||
    value === "log" ||
    value === "throw_error" ||
    value === "sleep" ||
    value === "exit" ||
    value === "foreach" ||
    value === "switch" ||
    value === "parallel" ||
    value === "python" ||
    value === "mcp" ||
    value === "agent"
  );
}

function referenceEdgeKind(value: unknown): WorkflowReferenceEdgeKind | null {
  if (
    value === "then" ||
    value === "else" ||
    value === "body" ||
    value === "default"
  ) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.startsWith("case:") &&
    value.length > "case:".length
  ) {
    return value as `case:${string}`;
  }
  if (
    typeof value === "string" &&
    value.startsWith("branch:") &&
    value.length > "branch:".length
  ) {
    return value as `branch:${string}`;
  }
  return null;
}

function isTriggerCanvasNodeId(value: string | null): boolean {
  return typeof value === "string" && value.startsWith("trigger:");
}

function referenceMutationMessage(reason: string): string {
  if (reason === "source_node_not_found") return "Source node not found";
  if (reason === "target_node_not_found") return "Target node not found";
  if (reason === "self_reference_not_supported") {
    return "A node cannot reference itself";
  }
  if (reason === "edge_kind_not_supported") {
    return "This edge cannot be represented by workflow JSON";
  }
  if (reason === "route_source_not_found") {
    return "This card is not inside an explicit route";
  }
  if (reason === "ambiguous_route_source") {
    return "This card belongs to multiple routes; connect from a branch output instead";
  }
  return "Workflow edge could not be updated";
}

type NodeCardProps = {
  node: WorkflowNode;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onLabelChange: (value: string) => void;
  onAssignmentTargetChange: (target: string, value: string) => void;
  onAssignmentSourceChange: (target: string, value: string) => void;
  onAssignmentModeChange: (target: string, value: string) => void;
  onTransformConfigChange: (
    field: "input" | "transform",
    value: string,
  ) => void;
  onBranchConfigChange: (
    field: "condition" | "then" | "else",
    value: string,
  ) => void;
  onSwitchConfigChange: (
    field:
      | "value"
      | "caseId"
      | "caseLabel"
      | "caseValue"
      | "caseNodes"
      | "defaultNodes"
      | "addCase"
      | "removeCase",
    value: string,
    caseIndex?: number,
  ) => void;
  onLogConfigChange: (
    field: "level" | "message" | "payload",
    value: string,
  ) => void;
  onThrowErrorConfigChange: (
    field: "message" | "code" | "details",
    value: string,
  ) => void;
  onSleepConfigChange: (field: "delayMs" | "reason", value: string) => void;
  onExitConfigChange: (field: "status" | "output", value: string) => void;
  onForeachConfigChange: (
    field: "items" | "itemVar" | "body" | "concurrency",
    value: string,
  ) => void;
  onParallelConfigChange: (
    field:
      | "concurrency"
      | "failFast"
      | "branchId"
      | "branchLabel"
      | "branchNodes"
      | "addBranch"
      | "removeBranch",
    value: string | boolean,
    branchIndex?: number,
  ) => void;
  onPythonConfigChange: (
    field: "input" | "code" | "timeoutMs" | "reset",
    value: string | boolean,
  ) => void;
  mcpTools: McpToolSummary[];
  agents: AgentSummary[];
  onMcpToolConfigChange: (
    field: "server" | "tool" | "input" | "timeoutMs",
    value: string,
  ) => void;
  onMcpToolSelect: (server: string, tool: string) => void;
  onMcpSchemaInputChange: (key: string, value: string) => void;
  onAgentConfigChange: (
    field: "agentId" | "prompt" | "input" | "timeoutMs",
    value: string,
  ) => void;
};

function InspectorSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border border-paper-rule bg-paper-sunk">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium text-ink hover:bg-paper"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {badge && <Badge variant="outline">{badge}</Badge>}
          {open ? (
            <ArrowUp className="size-3.5 text-ink-faint" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3.5 text-ink-faint" aria-hidden="true" />
          )}
        </span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-paper-rule px-3 py-3">
          {children}
        </div>
      )}
    </section>
  );
}

function NodeCard({
  node,
  index,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
  onLabelChange,
  onAssignmentTargetChange,
  onAssignmentSourceChange,
  onAssignmentModeChange,
  onTransformConfigChange,
  onBranchConfigChange,
  onSwitchConfigChange,
  onLogConfigChange,
  onThrowErrorConfigChange,
  onSleepConfigChange,
  onExitConfigChange,
  onForeachConfigChange,
  onParallelConfigChange,
  onPythonConfigChange,
  mcpTools,
  agents,
  onMcpToolConfigChange,
  onMcpToolSelect,
  onMcpSchemaInputChange,
  onAgentConfigChange,
}: NodeCardProps) {
  const Icon = iconForNode(node.type);
  const assignments = assignmentSummaries(node.assign);
  const primaryAssignment = primaryAssignmentControl(node.assign);
  const transform = transformControl(node);
  const branch = branchControl(node);
  const switchCase = switchControl(node);
  const log = logControl(node);
  const throwError = throwErrorControl(node);
  const sleep = sleepControl(node);
  const exit = exitControl(node);
  const foreach = foreachControl(node);
  const parallel = parallelControl(node);
  const python = pythonControl(node);
  const mcpTool = mcpToolControl(node);
  const agentCall = agentCallControl(node);
  const selectedMcpTool =
    mcpTool === null
      ? undefined
      : mcpTools.find(
          (tool) =>
            tool.server === mcpTool.server && tool.tool === mcpTool.tool,
        );
  const mcpSchemaFields = mcpSchemaInputFields(selectedMcpTool?.inputSchema);
  const label = node.label ?? node.id;
  return (
    <section className="grid gap-3">
      <div className="border border-paper-rule bg-paper px-3 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center border border-paper-rule bg-paper-sunk">
            <Icon className="size-4 text-ink-soft" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-[11px] text-ink-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="truncate text-sm font-medium">{label}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {node.label && <Badge variant="outline">{node.id}</Badge>}
              <Badge variant="secondary">{node.type}</Badge>
              {isRecord(node.assign) && <Badge variant="outline">assign</Badge>}
              {node.type.includes("log") && (
                <Badge variant="outline">log</Badge>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${label} up`}
              disabled={!canMoveUp}
              onClick={onMoveUp}
            >
              <ArrowUp className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${label} down`}
              disabled={!canMoveDown}
              onClick={onMoveDown}
            >
              <ArrowDown className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${label}`}
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </div>
        <InspectorSection title="Basics" defaultOpen>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Label
            </span>
            <Input
              aria-label={`${node.id} card label`}
              value={typeof node.label === "string" ? node.label : ""}
              onChange={(event) => onLabelChange(event.target.value)}
            />
          </label>
        </InspectorSection>
      </div>
      {assignments.length > 0 && (
        <InspectorSection
          title="Assignments"
          badge={`${assignments.length}`}
          defaultOpen
        >
          <div className="grid gap-1">
            {assignments.map((item) => (
              <div
                key={item.target}
                className="grid gap-1 font-mono text-[11px] text-ink-soft"
              >
                <span className="break-all">
                  {item.target} &lt;- {item.source}
                </span>
                {item.mode && (
                  <span className="text-[10px] text-ink-faint">
                    mode {item.mode}
                  </span>
                )}
              </div>
            ))}
          </div>
          {primaryAssignment && (
            <div className="grid gap-3">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Target
                </span>
                <Input
                  aria-label={`${label} assignment target`}
                  value={primaryAssignment.target}
                  onChange={(event) =>
                    onAssignmentTargetChange(
                      primaryAssignment.target,
                      event.target.value,
                    )
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Source
                </span>
                <Input
                  aria-label={`${label} assignment source`}
                  value={primaryAssignment.source}
                  onChange={(event) =>
                    onAssignmentSourceChange(
                      primaryAssignment.target,
                      event.target.value,
                    )
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Mode
                </span>
                <Select
                  value={primaryAssignment.mode}
                  onValueChange={(value) =>
                    onAssignmentModeChange(primaryAssignment.target, value)
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={`${label} assignment mode`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="replace">replace</SelectItem>
                    <SelectItem value="merge">merge</SelectItem>
                    <SelectItem value="append">append</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
          )}
        </InspectorSection>
      )}
      {transform && (
        <InspectorSection title="Transform" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Preset
              </span>
              <Select
                onValueChange={(presetId) => {
                  const preset = workflowTransformPresetById(presetId);
                  if (!preset) return;
                  onTransformConfigChange(
                    "transform",
                    formatJson(preset.transform),
                  );
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={`${label} transform preset`}
                >
                  <SelectValue placeholder="Select transform" />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_TRANSFORM_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Input JSON
              </span>
              <Textarea
                aria-label={`${label} transform input JSON`}
                value={transform.input}
                rows={7}
                onChange={(event) =>
                  onTransformConfigChange("input", event.target.value)
                }
                className="min-h-36 font-mono text-xs leading-relaxed"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Transform JSON
              </span>
              <Textarea
                aria-label={`${label} transform JSON`}
                value={transform.transform}
                rows={7}
                onChange={(event) =>
                  onTransformConfigChange("transform", event.target.value)
                }
                className="min-h-36 font-mono text-xs leading-relaxed"
              />
            </label>
          </div>
        </InspectorSection>
      )}
      {branch && (
        <InspectorSection title="Branch" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Condition
              </span>
              <Input
                aria-label={`${label} branch condition`}
                value={branch.condition}
                onChange={(event) =>
                  onBranchConfigChange("condition", event.target.value)
                }
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  True
                </span>
                <Input
                  aria-label={`${label} then nodes`}
                  value={branch.then}
                  onChange={(event) =>
                    onBranchConfigChange("then", event.target.value)
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  False
                </span>
                <Input
                  aria-label={`${label} else nodes`}
                  value={branch.else}
                  onChange={(event) =>
                    onBranchConfigChange("else", event.target.value)
                  }
                />
              </label>
            </div>
          </div>
        </InspectorSection>
      )}
      {switchCase && (
        <InspectorSection
          title="Switch"
          badge={`${switchCase.cases.length}`}
          defaultOpen
        >
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Value
              </span>
              <Input
                aria-label={`${label} switch value`}
                value={switchCase.value}
                onChange={(event) =>
                  onSwitchConfigChange("value", event.target.value)
                }
              />
            </label>
            <div className="grid gap-2">
              {switchCase.cases.map((item, caseIndex) => (
                <div
                  key={`${item.id}:${caseIndex}`}
                  className="grid gap-2 border border-paper-rule bg-paper p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate text-xs font-medium text-ink-soft">
                      {item.label || item.id}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove switch case ${item.id}`}
                      disabled={switchCase.cases.length <= 1}
                      onClick={() =>
                        onSwitchConfigChange("removeCase", "", caseIndex)
                      }
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        Case ID
                      </span>
                      <Input
                        aria-label={`${label} switch case ${caseIndex + 1} id`}
                        value={item.id}
                        onChange={(event) =>
                          onSwitchConfigChange(
                            "caseId",
                            event.target.value,
                            caseIndex,
                          )
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        Label
                      </span>
                      <Input
                        aria-label={`${label} switch case ${caseIndex + 1} label`}
                        value={item.label}
                        onChange={(event) =>
                          onSwitchConfigChange(
                            "caseLabel",
                            event.target.value,
                            caseIndex,
                          )
                        }
                      />
                    </label>
                  </div>
                  <label className="grid gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      Match Value
                    </span>
                    <Input
                      aria-label={`${label} switch case ${caseIndex + 1} value`}
                      value={item.value}
                      onChange={(event) =>
                        onSwitchConfigChange(
                          "caseValue",
                          event.target.value,
                          caseIndex,
                        )
                      }
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      Nodes
                    </span>
                    <Input
                      aria-label={`${label} switch case ${caseIndex + 1} nodes`}
                      value={item.nodes}
                      onChange={(event) =>
                        onSwitchConfigChange(
                          "caseNodes",
                          event.target.value,
                          caseIndex,
                        )
                      }
                    />
                  </label>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSwitchConfigChange("addCase", "")}
              >
                <Plus className="mr-2 size-3.5" />
                Add Case
              </Button>
            </div>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Default Nodes
              </span>
              <Input
                aria-label={`${label} switch default nodes`}
                value={switchCase.defaultNodes}
                onChange={(event) =>
                  onSwitchConfigChange("defaultNodes", event.target.value)
                }
              />
            </label>
          </div>
        </InspectorSection>
      )}
      {log && (
        <InspectorSection title="Log" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Level
              </span>
              <Select
                value={log.level}
                onValueChange={(value) =>
                  onLogConfigChange("level", value as LogLevel)
                }
              >
                <SelectTrigger size="sm" aria-label={`${label} log level`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="debug">debug</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                  <SelectItem value="warn">warn</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Message
              </span>
              <Input
                aria-label={`${label} log message`}
                value={log.message}
                onChange={(event) =>
                  onLogConfigChange("message", event.target.value)
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Payload
              </span>
              <Input
                aria-label={`${label} log payload`}
                value={log.payload}
                onChange={(event) =>
                  onLogConfigChange("payload", event.target.value)
                }
              />
            </label>
          </div>
        </InspectorSection>
      )}
      {throwError && (
        <InspectorSection title="Throw Error" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Message
              </span>
              <Input
                aria-label={`${label} throw error message`}
                value={throwError.message}
                onChange={(event) =>
                  onThrowErrorConfigChange("message", event.target.value)
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Code
              </span>
              <Input
                aria-label={`${label} throw error code`}
                value={throwError.code}
                onChange={(event) =>
                  onThrowErrorConfigChange("code", event.target.value)
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Details
              </span>
              <Input
                aria-label={`${label} throw error details`}
                value={throwError.details}
                onChange={(event) =>
                  onThrowErrorConfigChange("details", event.target.value)
                }
              />
            </label>
          </div>
        </InspectorSection>
      )}
      {sleep && (
        <InspectorSection title="Sleep" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Delay ms
              </span>
              <Input
                aria-label={`${label} sleep delay`}
                inputMode="numeric"
                value={sleep.delayMs}
                onChange={(event) =>
                  onSleepConfigChange("delayMs", event.target.value)
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Reason
              </span>
              <Input
                aria-label={`${label} sleep reason`}
                value={sleep.reason}
                onChange={(event) =>
                  onSleepConfigChange("reason", event.target.value)
                }
              />
            </label>
          </div>
        </InspectorSection>
      )}
      {exit && (
        <InspectorSection title="Exit" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Status
              </span>
              <Select
                value={exit.status}
                onValueChange={(value) =>
                  onExitConfigChange("status", value as ExitStatus)
                }
              >
                <SelectTrigger size="sm" aria-label={`${label} exit status`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="succeeded">succeeded</SelectItem>
                  <SelectItem value="failed">failed</SelectItem>
                  <SelectItem value="canceled">canceled</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Output
              </span>
              <Input
                aria-label={`${label} exit output`}
                value={exit.output}
                onChange={(event) =>
                  onExitConfigChange("output", event.target.value)
                }
              />
            </label>
          </div>
        </InspectorSection>
      )}
      {foreach && (
        <InspectorSection title="Foreach" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Items
              </span>
              <Input
                aria-label={`${label} foreach items`}
                value={foreach.items}
                onChange={(event) =>
                  onForeachConfigChange("items", event.target.value)
                }
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Item Var
                </span>
                <Input
                  aria-label={`${label} foreach item variable`}
                  value={foreach.itemVar}
                  onChange={(event) =>
                    onForeachConfigChange("itemVar", event.target.value)
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Body
                </span>
                <Input
                  aria-label={`${label} foreach body nodes`}
                  value={foreach.body}
                  onChange={(event) =>
                    onForeachConfigChange("body", event.target.value)
                  }
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Concurrency
              </span>
              <Input
                aria-label={`${label} foreach concurrency`}
                inputMode="numeric"
                value={foreach.concurrency}
                onChange={(event) =>
                  onForeachConfigChange("concurrency", event.target.value)
                }
              />
            </label>
            <div className="grid gap-2 border border-paper-rule bg-paper-sunk p-3">
              <div className="text-xs font-medium text-ink-soft">
                Save all item results to variable
              </div>
              <code className="break-all text-[11px] text-ink-faint">
                assign.foreachSummary = $.steps.{label}.output
              </code>
              <div className="text-xs text-ink-faint">
                Append each item result to variable is not available while
                foreach runs with aggregate-only assignment.
              </div>
            </div>
          </div>
        </InspectorSection>
      )}
      {parallel && (
        <InspectorSection
          title="Parallel"
          badge={`${parallel.branches.length}`}
          defaultOpen
        >
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Concurrency
                </span>
                <Input
                  aria-label={`${label} parallel concurrency`}
                  inputMode="numeric"
                  value={parallel.concurrency}
                  onChange={(event) =>
                    onParallelConfigChange("concurrency", event.target.value)
                  }
                />
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm text-ink-soft">
                <input
                  aria-label={`${label} parallel fail fast`}
                  type="checkbox"
                  checked={parallel.failFast}
                  onChange={(event) =>
                    onParallelConfigChange("failFast", event.target.checked)
                  }
                />
                Fail fast
              </label>
            </div>
            <div className="grid gap-2">
              {parallel.branches.map((branch, branchIndex) => (
                <div
                  key={`${branch.id}:${branchIndex}`}
                  className="grid gap-2 border border-paper-rule bg-paper p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate text-xs font-medium text-ink-soft">
                      {branch.label || branch.id}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove parallel branch ${branch.id}`}
                      disabled={parallel.branches.length <= 1}
                      onClick={() =>
                        onParallelConfigChange("removeBranch", "", branchIndex)
                      }
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        Branch ID
                      </span>
                      <Input
                        aria-label={`${label} parallel branch ${branchIndex + 1} id`}
                        value={branch.id}
                        onChange={(event) =>
                          onParallelConfigChange(
                            "branchId",
                            event.target.value,
                            branchIndex,
                          )
                        }
                      />
                    </label>
                    <label className="grid gap-1">
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        Label
                      </span>
                      <Input
                        aria-label={`${label} parallel branch ${branchIndex + 1} label`}
                        value={branch.label}
                        onChange={(event) =>
                          onParallelConfigChange(
                            "branchLabel",
                            event.target.value,
                            branchIndex,
                          )
                        }
                      />
                    </label>
                  </div>
                  <label className="grid gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      Nodes
                    </span>
                    <Input
                      aria-label={`${label} parallel branch ${branchIndex + 1} nodes`}
                      value={branch.nodes}
                      onChange={(event) =>
                        onParallelConfigChange(
                          "branchNodes",
                          event.target.value,
                          branchIndex,
                        )
                      }
                    />
                  </label>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onParallelConfigChange("addBranch", "")}
              >
                <Plus className="mr-2 size-3.5" />
                Add Branch
              </Button>
            </div>
            <div className="grid gap-2 border border-paper-rule bg-paper-sunk p-3">
              <div className="text-xs font-medium text-ink-soft">
                Save branch aggregate to variable
              </div>
              <code className="break-all text-[11px] text-ink-faint">
                assign.parallelSummary = $.steps.{label}.output
              </code>
            </div>
          </div>
        </InspectorSection>
      )}
      {python && (
        <InspectorSection title="Python" defaultOpen>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Input
              </span>
              <Textarea
                aria-label={`${label} python input`}
                value={python.input}
                rows={4}
                onChange={(event) =>
                  onPythonConfigChange("input", event.target.value)
                }
                className="min-h-24 font-mono text-xs leading-relaxed"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Timeout
                </span>
                <Input
                  aria-label={`${label} python timeout`}
                  inputMode="numeric"
                  value={python.timeoutMs}
                  onChange={(event) =>
                    onPythonConfigChange("timeoutMs", event.target.value)
                  }
                />
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm text-ink-soft">
                <input
                  aria-label={`${label} python reset`}
                  type="checkbox"
                  checked={python.reset}
                  onChange={(event) =>
                    onPythonConfigChange("reset", event.target.checked)
                  }
                />
                Reset
              </label>
            </div>
          </div>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Code
            </span>
            <Textarea
              aria-label={`${label} python code`}
              value={python.code}
              rows={10}
              onChange={(event) =>
                onPythonConfigChange("code", event.target.value)
              }
              className="min-h-52 font-mono text-xs leading-relaxed"
            />
          </label>
        </InspectorSection>
      )}
      {mcpTool && (
        <InspectorSection title="MCP Tool" defaultOpen>
          <div className="grid gap-3">
            {mcpTools.length > 0 && (
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Available
                </span>
                <Select
                  value={`${mcpTool.server}:${mcpTool.tool}`}
                  onValueChange={(value) => {
                    const tool = mcpTools.find(
                      (item) => `${item.server}:${item.tool}` === value,
                    );
                    if (!tool) return;
                    onMcpToolSelect(tool.server, tool.tool);
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`${label} MCP picker`}>
                    <SelectValue placeholder="Select tool" />
                  </SelectTrigger>
                  <SelectContent>
                    {mcpTools.map((tool) => (
                      <SelectItem
                        key={`${tool.server}:${tool.tool}`}
                        value={`${tool.server}:${tool.tool}`}
                      >
                        {tool.server}/{tool.tool}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Server
                </span>
                <Input
                  aria-label={`${label} MCP server`}
                  value={mcpTool.server}
                  onChange={(event) =>
                    onMcpToolConfigChange("server", event.target.value)
                  }
                />
              </label>
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Tool
                </span>
                <Input
                  aria-label={`${label} MCP tool`}
                  value={mcpTool.tool}
                  onChange={(event) =>
                    onMcpToolConfigChange("tool", event.target.value)
                  }
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Timeout ms
              </span>
              <Input
                aria-label={`${label} MCP timeout`}
                inputMode="numeric"
                value={mcpTool.timeoutMs}
                onChange={(event) =>
                  onMcpToolConfigChange("timeoutMs", event.target.value)
                }
              />
            </label>
          </div>
          {mcpSchemaFields.length > 0 && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <SectionEyebrow>Schema Input</SectionEyebrow>
                <Badge variant="outline">{mcpSchemaFields.length} fields</Badge>
              </div>
              <div className="grid gap-2">
                {mcpSchemaFields.map((field) => (
                  <label key={field.name} className="grid gap-1">
                    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                      {field.name}
                      {field.required && (
                        <Badge variant="secondary">required</Badge>
                      )}
                      {field.type && (
                        <Badge variant="outline">{field.type}</Badge>
                      )}
                    </span>
                    <Input
                      aria-label={`${label} MCP schema ${field.name}`}
                      value={mcpTool.inputValues[field.name] ?? ""}
                      onChange={(event) =>
                        onMcpSchemaInputChange(field.name, event.target.value)
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Input JSON
            </span>
            <Textarea
              aria-label={`${label} MCP input JSON`}
              value={mcpTool.input}
              rows={8}
              onChange={(event) =>
                onMcpToolConfigChange("input", event.target.value)
              }
              className="min-h-40 font-mono text-xs leading-relaxed"
            />
          </label>
        </InspectorSection>
      )}
      {agentCall && (
        <InspectorSection title="Agent Call" defaultOpen>
          <div className="grid gap-3">
            {agents.length > 0 && (
              <label className="grid gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Available
                </span>
                <Select
                  value={agentCall.agentId}
                  onValueChange={(value) =>
                    onAgentConfigChange("agentId", value)
                  }
                >
                  <SelectTrigger size="sm" aria-label={`${label} agent picker`}>
                    <SelectValue placeholder="Select agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem
                        key={agent.id}
                        value={agent.id}
                        disabled={agent.instantMessagesEnabled === false}
                      >
                        {agent.name || agent.id}
                        {agent.instantMessagesEnabled === false && (
                          <Badge variant="outline">disabled</Badge>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Agent
              </span>
              <Input
                aria-label={`${label} agent id`}
                value={agentCall.agentId}
                onChange={(event) =>
                  onAgentConfigChange("agentId", event.target.value)
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Prompt
              </span>
              <Input
                aria-label={`${label} agent prompt`}
                value={agentCall.prompt}
                onChange={(event) =>
                  onAgentConfigChange("prompt", event.target.value)
                }
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Timeout ms
              </span>
              <Input
                aria-label={`${label} agent timeout`}
                inputMode="numeric"
                value={agentCall.timeoutMs}
                onChange={(event) =>
                  onAgentConfigChange("timeoutMs", event.target.value)
                }
              />
            </label>
          </div>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Input JSON
            </span>
            <Textarea
              aria-label={`${label} agent input JSON`}
              value={agentCall.input}
              rows={8}
              onChange={(event) =>
                onAgentConfigChange("input", event.target.value)
              }
              className="min-h-40 font-mono text-xs leading-relaxed"
            />
          </label>
        </InspectorSection>
      )}
    </section>
  );
}

function RunConsole({
  workflowName,
  detail,
  runs,
  selectedStep,
  pendingRunId,
  busy,
  hasMoreRuns,
  loadingMoreRuns,
  filters,
  onFiltersChange,
  onSelectRun,
  onLoadMoreRuns,
  onRefresh,
  onSelectStep,
  onRerun,
  onCancel,
}: {
  workflowName: string | null;
  detail: RunDetail | null;
  runs: WorkflowRun[];
  selectedStep: WorkflowStepAttempt | null;
  pendingRunId: string | null;
  busy: string | null;
  hasMoreRuns: boolean;
  loadingMoreRuns: boolean;
  filters: Omit<ScopedRunFilters, "workflowId">;
  onFiltersChange: (
    patch: Partial<Omit<ScopedRunFilters, "workflowId">>,
  ) => void;
  onSelectRun: (runId: string) => void;
  onLoadMoreRuns: () => void;
  onRefresh: () => void;
  onSelectStep: (stepId: string) => void;
  onRerun: () => void;
  onCancel: () => void;
}) {
  const [eventLevel, setEventLevel] = useState<EventLevelFilter>("all");
  const canCancel =
    detail !== null &&
    !["succeeded", "failed", "canceled"].includes(detail.run.status);
  const filteredEvents =
    detail?.events.filter(
      (event) => eventLevel === "all" || event.level === eventLevel,
    ) ?? [];
  const selectedRunId = pendingRunId ?? detail?.run.id ?? null;
  return (
    <aside
      aria-label="Run Console"
      className="min-h-0 flex-1 overflow-y-auto bg-paper"
    >
      <div className="sticky top-0 z-10 border-b border-paper-rule bg-paper px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <SectionEyebrow>Run Console</SectionEyebrow>
            <div className="mt-1 flex items-center gap-2">
              {pendingRunId ? (
                <Loader2 className="size-4 animate-spin text-ink-faint" />
              ) : detail ? (
                statusIcon(detail.run.status)
              ) : (
                <ScrollText className="size-4" />
              )}
              <span className="text-sm font-medium">
                {pendingRunId
                  ? "Loading selected run"
                  : detail
                    ? `Selected run ${detail.run.id.slice(0, 8)} · ${detail.run.status}`
                    : "No run selected"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              disabled={!detail || busy !== null}
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={!canCancel || busy !== null}
            >
              {busy === "cancel" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <XCircle className="size-4" />
              )}
              Cancel
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRerun}
              disabled={!detail || busy !== null}
            >
              <ListRestart className="size-4" />
              Rerun
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-4">
        {detail && <RunOverview workflowName={workflowName} run={detail.run} />}
        <RunHistoryPanel
          detail={detail}
          runs={runs}
          selectedRunId={selectedRunId}
          pendingRunId={pendingRunId}
          hasMoreRuns={hasMoreRuns}
          loadingMoreRuns={loadingMoreRuns}
          filters={filters}
          onFiltersChange={onFiltersChange}
          onSelectRun={onSelectRun}
          onLoadMoreRuns={onLoadMoreRuns}
        />
        {detail && (
          <>
            <RunPaneSection
              title="Steps"
              badge={`${detail.steps.length}`}
              description="Select a step to inspect the data it received and produced."
            >
              <StepList
                detail={detail}
                selectedStep={selectedStep}
                onSelectStep={onSelectStep}
              />
            </RunPaneSection>
            <RunPaneSection
              title="Step Detail"
              badge={selectedStep?.status}
              description="Focused view for the selected step."
            >
              {selectedStep ? (
                <StepDetailPanel
                  detail={detail}
                  step={selectedStep}
                  runId={detail.run.id}
                />
              ) : (
                <div className="border border-paper-rule p-3 text-sm text-ink-soft">
                  Select a step to inspect input, output, logs, error, and
                  context.
                </div>
              )}
            </RunPaneSection>
            <InspectorSection
              title="Advanced"
              badge={`${filteredEvents.length} events`}
            >
              <AdvancedRunDetails
                detail={detail}
                workflowName={workflowName}
                eventLevel={eventLevel}
                filteredEvents={filteredEvents}
                onEventLevelChange={setEventLevel}
              />
            </InspectorSection>
          </>
        )}
      </div>
    </aside>
  );
}

function RunPaneSection({
  title,
  badge,
  description,
  children,
}: {
  title: string;
  badge?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-ink-faint">{description}</p>
          )}
        </div>
        {badge && <Badge variant="outline">{badge}</Badge>}
      </div>
      {children}
    </section>
  );
}

function RunOverview({
  workflowName,
  run,
}: {
  workflowName: string | null;
  run: WorkflowRun;
}) {
  return (
    <section
      aria-label="Selected run overview"
      className="border border-paper-rule bg-paper-sunk p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {statusIcon(run.status)}
            <Badge variant={statusBadge(run.status)}>{run.status}</Badge>
            <Badge variant={run.mode === "live" ? "signal" : "outline"}>
              {run.mode}
            </Badge>
            <span className="font-mono text-[10px] text-ink-faint">
              v{run.workflowVersion}
            </span>
          </div>
          <h2 className="mt-2 truncate text-base font-semibold text-ink">
            {workflowName ?? run.workflowId}
          </h2>
          <div className="mt-1 break-all font-mono text-[11px] text-ink-faint">
            {run.id}
          </div>
        </div>
        <div className="grid shrink-0 gap-1 text-right font-mono text-[10px] text-ink-faint">
          <span>{formatDuration(runDurationMs(run))}</span>
          <span>{shortDate(run.createdAt)}</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-paper-rule pt-3 font-mono text-[10px] text-ink-faint">
        <span>trigger {runTriggerLabel(run)}</span>
        <span>source {run.definitionSource}</span>
        <span>started {formatDateTime(run.startedAt)}</span>
        <span>ended {formatDateTime(run.endedAt)}</span>
      </div>
    </section>
  );
}

function RunHistoryPanel({
  detail,
  runs,
  selectedRunId,
  pendingRunId,
  hasMoreRuns,
  loadingMoreRuns,
  filters,
  onFiltersChange,
  onSelectRun,
  onLoadMoreRuns,
}: {
  detail: RunDetail | null;
  runs: WorkflowRun[];
  selectedRunId: string | null;
  pendingRunId: string | null;
  hasMoreRuns: boolean;
  loadingMoreRuns: boolean;
  filters: Omit<ScopedRunFilters, "workflowId">;
  onFiltersChange: (
    patch: Partial<Omit<ScopedRunFilters, "workflowId">>,
  ) => void;
  onSelectRun: (runId: string) => void;
  onLoadMoreRuns: () => void;
}) {
  return (
    <RunPaneSection
      title="Recent Runs"
      badge={hasMoreRuns ? `${runs.length}+` : `${runs.length}`}
    >
      <details className="border border-paper-rule bg-paper">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-soft hover:bg-paper-sunk">
          Filters
        </summary>
        <div className="grid grid-cols-2 gap-2 border-t border-paper-rule p-3">
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Mode
            </span>
            <Select
              value={filters.mode}
              onValueChange={(value) =>
                onFiltersChange({ mode: value as "all" | RunMode })
              }
            >
              <SelectTrigger size="sm" aria-label="Mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modes</SelectItem>
                <SelectItem value="test">Test</SelectItem>
                <SelectItem value="live">Live</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Status
            </span>
            <Select
              value={filters.status}
              onValueChange={(value) =>
                onFiltersChange({ status: value as "all" | RunStatus })
              }
            >
              <SelectTrigger size="sm" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {RUN_STATUSES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Trigger
            </span>
            <Input
              aria-label="Trigger"
              value={filters.triggerId}
              onChange={(event) =>
                onFiltersChange({ triggerId: event.target.value })
              }
              placeholder="manual"
              className="h-8 font-mono text-xs"
            />
          </label>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Created from
            </span>
            <Input
              aria-label="Created from"
              type="date"
              value={filters.createdFrom}
              onChange={(event) =>
                onFiltersChange({ createdFrom: event.target.value })
              }
              className="h-8 font-mono text-xs"
            />
          </label>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              Created to
            </span>
            <Input
              aria-label="Created to"
              type="date"
              value={filters.createdTo}
              onChange={(event) =>
                onFiltersChange({ createdTo: event.target.value })
              }
              className="h-8 font-mono text-xs"
            />
          </label>
        </div>
      </details>
      <div className="max-h-36 space-y-1 overflow-y-auto border border-paper-rule p-1">
        {runs.map((run) => {
          const isPending =
            pendingRunId === run.id && detail?.run.id !== run.id;
          const isSelected = selectedRunId === run.id;
          return (
            <button
              type="button"
              key={run.id}
              aria-current={isSelected ? "true" : undefined}
              onClick={() => onSelectRun(run.id)}
              className={cn(
                "grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 border border-transparent px-3 py-2 text-left hover:bg-paper-sunk",
                isSelected &&
                  "border-paper-rule bg-paper-sunk ring-1 ring-ink/25",
              )}
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin text-ink-faint" />
              ) : (
                statusIcon(run.status)
              )}
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11px] text-ink-soft">
                  {run.id}
                </span>
                <span className="block truncate font-mono text-[10px] text-ink-faint">
                  {run.mode} · {runTriggerLabel(run)} · v{run.workflowVersion}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {isSelected && <Badge variant="healthy">selected</Badge>}
                <span className="font-mono text-[10px] text-ink-faint">
                  {shortDate(run.createdAt)}
                </span>
              </span>
            </button>
          );
        })}
        {runs.length === 0 && (
          <div className="px-3 py-2 text-sm text-ink-soft">No runs</div>
        )}
        {hasMoreRuns && (
          <div className="px-2 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onLoadMoreRuns}
              disabled={loadingMoreRuns}
            >
              {loadingMoreRuns ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ScrollText className="size-4" />
              )}
              Load more
            </Button>
          </div>
        )}
      </div>
    </RunPaneSection>
  );
}

function StepList({
  detail,
  selectedStep,
  onSelectStep,
}: {
  detail: RunDetail;
  selectedStep: WorkflowStepAttempt | null;
  onSelectStep: (stepId: string) => void;
}) {
  return (
    <div className="space-y-1 border border-paper-rule p-1">
      {detail.steps.map((step, index) => {
        const branchState = stepBranchState(detail, step);
        const selected = selectedStep?.id === step.id;
        return (
          <button
            type="button"
            key={step.id}
            aria-current={selected ? "step" : undefined}
            onClick={() => onSelectStep(step.id)}
            className={cn(
              "grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 border border-transparent px-3 py-2 text-left hover:bg-paper-sunk",
              selected && "border-paper-rule bg-paper-sunk ring-1 ring-ink/25",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="w-6 text-right font-mono text-[10px] text-ink-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              {statusIcon(step.status)}
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-sm font-medium">
                {stepNodeLabel(detail, step) ?? step.nodeId}
              </span>
              <span className="truncate font-mono text-[10px] text-ink-faint">
                {step.nodeId} · {stepNodeType(detail, step)}
                {branchState ? ` · branch ${branchState.status}` : ""}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {selected && <Badge variant="healthy">selected</Badge>}
              <span className="font-mono text-[10px] text-ink-faint">
                {formatDuration(stepDurationMs(step))}
              </span>
              <Badge variant={statusBadge(step.status)}>{step.status}</Badge>
            </span>
          </button>
        );
      })}
      {detail.steps.length === 0 && (
        <div className="px-3 py-2 text-sm text-ink-soft">No step attempts</div>
      )}
    </div>
  );
}

function AdvancedRunDetails({
  detail,
  workflowName,
  eventLevel,
  filteredEvents,
  onEventLevelChange,
}: {
  detail: RunDetail;
  workflowName: string | null;
  eventLevel: EventLevelFilter;
  filteredEvents: WorkflowRunEvent[];
  onEventLevelChange: (value: EventLevelFilter) => void;
}) {
  return (
    <Tabs defaultValue="run">
      <TabsList className="overflow-x-auto">
        <TabsTrigger value="run">Run</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="payloads">Payloads</TabsTrigger>
      </TabsList>
      <TabsContent value="run" className="pt-3">
        <section aria-label="Selected run detail" className="grid gap-3">
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={detail.run.mode === "live" ? "signal" : "outline"}
              >
                {detail.run.mode}
              </Badge>
              <Badge variant={statusBadge(detail.run.status)}>
                {detail.run.status}
              </Badge>
              <span className="font-mono text-[11px] text-ink-faint">
                v{detail.run.workflowVersion}
              </span>
            </div>
            <div className="font-mono text-[11px] text-ink-soft">
              {workflowName ?? detail.run.workflowId}
            </div>
            <div className="break-all font-mono text-[11px] text-ink">
              {detail.run.id}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-ink-faint">
            <span>created {formatDateTime(detail.run.createdAt)}</span>
            <span>duration {formatDuration(runDurationMs(detail.run))}</span>
            <span>trigger {runTriggerLabel(detail.run)}</span>
            <span>source {detail.run.definitionSource}</span>
            <span>started {formatDateTime(detail.run.startedAt)}</span>
            <span>ended {formatDateTime(detail.run.endedAt)}</span>
            <span>current {detail.run.currentNodeId ?? "none"}</span>
            <span>waiting {detail.run.waitingReason ?? "none"}</span>
          </div>
        </section>
      </TabsContent>
      <TabsContent value="timeline" className="grid gap-3 pt-3">
        <div className="flex items-center justify-between gap-2">
          <SectionEyebrow>Timeline</SectionEyebrow>
          <Select
            value={eventLevel}
            onValueChange={(value) =>
              onEventLevelChange(value as EventLevelFilter)
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
                      event.level === "error" ? "destructive" : "secondary"
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
                    #{event.sequence} · {formatDateTime(event.createdAt)}
                  </span>
                </div>
                {event.message && (
                  <div className="text-xs text-ink-soft">{event.message}</div>
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
      </TabsContent>
      <TabsContent value="payloads" className="grid gap-3 pt-3">
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
      </TabsContent>
    </Tabs>
  );
}

function StepDetailPanel({
  detail,
  step,
  runId,
}: {
  detail: RunDetail;
  step: WorkflowStepAttempt;
  runId: string;
}) {
  const nodeType = stepNodeType(detail, step);
  const nodeLabel = stepNodeLabel(detail, step);
  const branchState = stepBranchState(detail, step);
  const stepIndex = detail.steps.findIndex((item) => item.id === step.id);
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 border border-paper-rule bg-paper p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                Step {stepIndex >= 0 ? stepIndex + 1 : "?"}
              </span>
              <Badge variant={statusBadge(step.status)}>{step.status}</Badge>
              {branchState && (
                <Badge variant="outline">branch {branchState.status}</Badge>
              )}
            </div>
            <h3 className="mt-1 truncate text-base font-semibold text-ink">
              {nodeLabel ?? step.nodeId}
            </h3>
            <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">
              {step.nodeId} · {nodeType}
            </div>
          </div>
          <div className="grid shrink-0 gap-1 text-right font-mono text-[10px] text-ink-faint">
            <span>{formatDuration(stepDurationMs(step))}</span>
            <span>attempt {step.attempt}</span>
          </div>
        </div>
        <StepMetadata
          step={step}
          nodeType={nodeType}
          nodeLabel={nodeLabel}
          branchState={branchState}
        />
      </div>
      <Tabs defaultValue="output" className="border border-paper-rule bg-paper">
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="input">Input</TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="error">Error</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
        </TabsList>
        <TabsContent value="input" className="p-3 pt-3">
          <JsonBlock
            label="Input"
            value={step.input}
            runId={runId}
            framed={false}
          />
        </TabsContent>
        <TabsContent value="output" className="p-3 pt-3">
          <JsonBlock
            label="Output"
            value={step.output}
            runId={runId}
            framed={false}
          />
        </TabsContent>
        <TabsContent value="logs" className="p-3 pt-3">
          <JsonBlock
            label="Logs"
            value={step.logsSummary}
            runId={runId}
            framed={false}
          />
        </TabsContent>
        <TabsContent value="error" className="p-3 pt-3">
          <JsonBlock
            label="Error"
            value={step.error}
            runId={runId}
            framed={false}
          />
        </TabsContent>
        <TabsContent value="context" className="p-3 pt-3">
          <JsonBlock
            label="Context"
            value={step.contextDiff}
            runId={runId}
            framed={false}
          />
        </TabsContent>
      </Tabs>
    </div>
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
      className="grid grid-cols-2 gap-2 border border-paper-rule bg-paper-sunk p-3 font-mono text-[10px] text-ink-faint md:grid-cols-3"
    >
      <span>status {step.status}</span>
      <span>type {nodeType}</span>
      <span>attempt {step.attempt}</span>
      <span>duration {formatDuration(stepDurationMs(step))}</span>
      <span>started {formatDateTime(step.startedAt)}</span>
      <span>ended {formatDateTime(step.endedAt)}</span>
      {nodeLabel && <span className="truncate">label {nodeLabel}</span>}
      {branchState && <span>branch {branchState.status}</span>}
      {branchState?.condition && (
        <span className="truncate">condition {branchState.condition}</span>
      )}
    </div>
  );
}

function JsonBlock({
  label,
  value,
  runId,
  framed = true,
}: {
  label: string;
  value: unknown;
  runId?: string;
  framed?: boolean;
}) {
  const [open, setOpen] = useState(true);
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

  const controls =
    artifact || redacted ? (
      <div className="mb-2 flex flex-wrap items-center gap-2">
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
          <span className="border border-paper-rule px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">
            redacted
          </span>
        )}
      </div>
    ) : null;

  if (!framed) {
    return (
      <div aria-label={`${label} JSON`}>
        {controls}
        <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-relaxed text-ink-soft">
          {displayValue === undefined
            ? "undefined"
            : JSON.stringify(displayValue, null, 2)}
        </pre>
        {artifactError && (
          <div className="mt-2 text-xs text-plot-red">{artifactError}</div>
        )}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={`${label} JSON`}
      className="border border-paper-rule"
    >
      <div className="flex items-center justify-between gap-2 border-b border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${label} JSON`}
          className="flex min-w-0 items-center gap-1.5 text-left hover:text-ink"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? (
            <ArrowUp className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{label}</span>
        </button>
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
      {open && (
        <pre className="max-h-56 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
          {displayValue === undefined
            ? "undefined"
            : JSON.stringify(displayValue, null, 2)}
        </pre>
      )}
      {open && artifactError && (
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

function getRunTriggerId(run: WorkflowRun): string | null {
  if (!isRecord(run.trigger)) return null;
  const triggerId = run.trigger["triggerId"];
  return typeof triggerId === "string" ? triggerId : null;
}

function runTriggerLabel(run: WorkflowRun): string {
  return getRunTriggerId(run) ?? "unknown";
}

function runTriggerCanvasFallback(run: WorkflowRun): WorkflowGraphTrigger[] {
  if (!isRecord(run.trigger)) return [];
  const triggerId = run.trigger["triggerId"];
  const kind = run.trigger["kind"];
  return [
    {
      id: typeof triggerId === "string" && triggerId ? triggerId : "manual",
      kind: typeof kind === "string" && kind ? kind : "manual",
      enabled: true,
    },
  ];
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

function reconcileWorkflowRunInLoadedList(
  current: WorkflowRun[],
  run: WorkflowRun,
  filters: ScopedRunFilters,
): WorkflowRun[] {
  if (!workflowRunMatchesFilters(run, filters)) {
    return current.filter((item) => item.id !== run.id);
  }
  if (current.some((item) => item.id === run.id)) {
    return current.map((item) => (item.id === run.id ? run : item));
  }
  return [run, ...current];
}

function runSearchKey(filters: ScopedRunFilters & { runId?: string }): string {
  return [
    filters.workflowId,
    filters.mode,
    filters.status,
    filters.triggerId,
    filters.createdFrom,
    filters.createdTo,
    filters.runId ?? "",
  ].join(":");
}

function workflowRunMatchesFilters(
  run: WorkflowRun,
  filters: ScopedRunFilters,
): boolean {
  const createdAt = new Date(run.createdAt).getTime();
  const createdFrom = filters.createdFrom
    ? new Date(`${filters.createdFrom}T00:00:00.000Z`).getTime()
    : null;
  const createdTo = filters.createdTo
    ? new Date(`${filters.createdTo}T23:59:59.999Z`).getTime()
    : null;
  return (
    run.workflowId === filters.workflowId &&
    (filters.mode === "all" || filters.mode === run.mode) &&
    (filters.status === "all" || filters.status === run.status) &&
    (!filters.triggerId || getRunTriggerId(run) === filters.triggerId) &&
    (createdFrom === null || createdAt >= createdFrom) &&
    (createdTo === null || createdAt <= createdTo)
  );
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
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      isRecord(body) && typeof body["error"] === "string"
        ? body["error"]
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

function parseNodesDraft(
  value: string,
): { ok: true; value: WorkflowNode[] } | { ok: false; error: string } {
  const parsed = parseJsonDraft(value);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value))
    return { ok: false, error: "Nodes must be an array" };
  if (!parsed.value.every(isRecord)) {
    return { ok: false, error: "Nodes must be objects" };
  }
  return { ok: true, value: parsed.value as WorkflowNode[] };
}

function validateNodeReferences(
  nodes: WorkflowNode[],
): NodeReferenceValidation {
  const nodeIds = new Set<string>();
  const seenIds = new Set<string>();
  const errors: string[] = [];

  for (const node of nodes) {
    if (!WORKFLOW_SAFE_ID.test(node.id)) {
      errors.push(`Invalid workflow node id: ${node.id}`);
    }
    if (seenIds.has(node.id)) {
      errors.push(`Duplicate workflow node id: ${node.id}`);
      continue;
    }
    seenIds.add(node.id);
    nodeIds.add(node.id);
  }

  for (const node of nodes) {
    if (node.type === "builtin.if") {
      collectMissingNodeReferences(errors, node, "then", nodeIds);
      collectMissingNodeReferences(errors, node, "else", nodeIds);
    } else if (node.type === "builtin.if_else") {
      collectMissingNodeReferences(errors, node, "then", nodeIds);
      collectMissingNodeReferences(errors, node, "else", nodeIds);
    } else if (node.type === "builtin.foreach") {
      collectMissingNodeReferences(errors, node, "body", nodeIds);
    }
  }

  if (errors.length === 0) return { ok: true, message: "" };
  return { ok: false, message: errors.join("; ") };
}

function collectMissingNodeReferences(
  errors: string[],
  node: WorkflowNode,
  field: "then" | "else" | "body",
  nodeIds: Set<string>,
) {
  const targets = node[field];
  if (!Array.isArray(targets)) return;
  for (const targetId of targets) {
    if (typeof targetId !== "string" || nodeIds.has(targetId)) continue;
    errors.push(`Node ${node.id} ${field} references missing node ${targetId}`);
  }
}

function parseTriggersDraft(
  value: string,
): { ok: true; value: JsonValue[] } | { ok: false; error: string } {
  const parsed = parseJsonDraft(value);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) {
    return { ok: false, error: "Triggers must be an array" };
  }
  if (!parsed.value.every(isRecord)) {
    return { ok: false, error: "Triggers must be objects" };
  }
  return { ok: true, value: parsed.value };
}

interface WorkflowImportValue {
  name: string;
  description: string | null;
  inputSchema: JsonValue | null;
  triggers: JsonValue[];
  nodes: WorkflowNode[];
  ui: WorkflowDefinitionUi | null;
}

function parseWorkflowImport(
  value: string,
): { ok: true; value: WorkflowImportValue } | { ok: false; error: string } {
  const parsed = parseJsonDraft(value);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.value)) {
    return { ok: false, error: "Import file must be an object" };
  }
  if (parsed.value.format !== "openacme.workflow.definition.v1") {
    return { ok: false, error: "Unsupported workflow export format" };
  }
  const workflow = parsed.value.workflow;
  if (!isRecord(workflow)) {
    return { ok: false, error: "Import file is missing workflow metadata" };
  }
  const name = typeof workflow.name === "string" ? workflow.name.trim() : "";
  if (!name) return { ok: false, error: "Imported workflow needs a name" };
  if (
    workflow.description !== undefined &&
    typeof workflow.description !== "string"
  ) {
    return {
      ok: false,
      error: "Imported workflow description must be a string",
    };
  }
  const description =
    typeof workflow.description === "string" ? workflow.description : null;
  const inputSchema =
    workflow.inputSchema === undefined
      ? null
      : (workflow.inputSchema as JsonValue);
  const triggers = workflow.triggers;
  if (!Array.isArray(triggers) || !triggers.every(isRecord)) {
    return { ok: false, error: "Imported workflow triggers must be objects" };
  }
  const triggerShape = validateTriggerShape(triggers);
  if (!triggerShape.ok) return { ok: false, error: triggerShape.message };
  const triggerIdentity = validateTriggerIdentity(triggers);
  if (!triggerIdentity.ok) return { ok: false, error: triggerIdentity.message };
  const nodes = workflow.nodes;
  if (!Array.isArray(nodes) || !nodes.every(isRecord)) {
    return { ok: false, error: "Imported workflow nodes must be objects" };
  }
  const workflowNodes = nodes as WorkflowNode[];
  const nodeShape = validateImportedNodeShape(workflowNodes);
  if (!nodeShape.ok) return { ok: false, error: nodeShape.message };
  const references = validateNodeReferences(workflowNodes);
  if (!references.ok) return { ok: false, error: references.message };
  const ui = parseWorkflowDefinitionUi(workflow.ui);
  if (!ui.ok) return ui;
  return {
    ok: true,
    value: {
      name,
      description,
      inputSchema,
      triggers,
      nodes: workflowNodes,
      ui: ui.value,
    },
  };
}

function parseJsonDraft(
  value: string,
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(value) as JsonValue };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function parseOptionalJsonDraft(
  value: string,
): { ok: true; value: JsonValue | null } | { ok: false; error: string } {
  if (!value.trim()) return { ok: true, value: null };
  const parsed = parseJsonDraft(value);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function parseJsonObjectDraft(
  value: string,
): { ok: true; value: { [key: string]: JsonValue } } | { ok: false } {
  const parsed = parseJsonDraft(value);
  if (!parsed.ok || !isRecord(parsed.value)) return { ok: false };
  return { ok: true, value: parsed.value };
}

function validateImportedNodeShape(
  nodes: WorkflowNode[],
): { ok: true; message: "" } | { ok: false; message: string } {
  const errors: string[] = [];
  for (const node of nodes) {
    const id = typeof node.id === "string" ? node.id.trim() : "";
    const type = typeof node.type === "string" ? node.type : "";
    const displayId = id || "unknown";
    if (!id) errors.push("Imported workflow node id is required");
    if (!type) {
      errors.push(`Imported workflow node ${displayId} needs a type`);
      continue;
    }
    if (
      node.label !== undefined &&
      (typeof node.label !== "string" || !node.label.trim())
    ) {
      errors.push(`Imported workflow node ${displayId} label must be a string`);
    }

    if (type === "builtin.set") {
      validateAssignmentMap(errors, node, displayId, true);
      continue;
    }
    if (type === "builtin.transform") {
      validateInputMap(errors, node, displayId);
      validateAssignmentMap(errors, node, displayId, false);
      if (node.transform === undefined) {
        errors.push(`Imported workflow node ${displayId} needs a transform`);
      }
      continue;
    }
    if (type === "builtin.if" || type === "builtin.if_else") {
      if (typeof node.condition !== "string" || !node.condition.trim()) {
        errors.push(`Imported workflow node ${displayId} needs a condition`);
      }
      validateNodeIdArray(errors, node, displayId, "then");
      validateNodeIdArray(errors, node, displayId, "else");
      continue;
    }
    if (type === "builtin.foreach") {
      validateInputMap(errors, node, displayId);
      validateAssignmentMap(errors, node, displayId, false);
      if (typeof node.items !== "string" || !node.items.trim()) {
        errors.push(`Imported workflow node ${displayId} needs items`);
      }
      if (
        node.itemVar !== undefined &&
        (typeof node.itemVar !== "string" || !node.itemVar.trim())
      ) {
        errors.push(
          `Imported workflow node ${displayId} itemVar must be a string`,
        );
      }
      validateNodeIdArray(errors, node, displayId, "body");
      if (node.concurrency !== undefined && node.concurrency !== 1) {
        errors.push(
          `Imported workflow node ${displayId} concurrency must be 1`,
        );
      }
      continue;
    }
    if (type === "builtin.exit") {
      if (!isExitStatus(typeof node.status === "string" ? node.status : "")) {
        errors.push(`Imported workflow node ${displayId} needs an exit status`);
      }
      continue;
    }
    if (isLogNodeType(type)) {
      validateInputMap(errors, node, displayId);
      validateAssignmentMap(errors, node, displayId, false);
      if (typeof node.message !== "string" || !node.message.trim()) {
        errors.push(`Imported workflow node ${displayId} needs a message`);
      }
      continue;
    }
    if (type === "builtin.python") {
      validateInputMap(errors, node, displayId);
      validateAssignmentMap(errors, node, displayId, false);
      if (typeof node.code !== "string" || !node.code.trim()) {
        errors.push(`Imported workflow node ${displayId} needs python code`);
      }
      validateTimeout(errors, node, displayId, 100);
      if (node.reset !== undefined && typeof node.reset !== "boolean") {
        errors.push(
          `Imported workflow node ${displayId} reset must be boolean`,
        );
      }
      continue;
    }
    if (type === "mcp.tool") {
      validateInputMap(errors, node, displayId);
      validateAssignmentMap(errors, node, displayId, false);
      if (typeof node.server !== "string" || !node.server.trim()) {
        errors.push(`Imported workflow node ${displayId} needs an MCP server`);
      }
      if (typeof node.tool !== "string" || !node.tool.trim()) {
        errors.push(`Imported workflow node ${displayId} needs an MCP tool`);
      }
      validateTimeout(errors, node, displayId, 100);
      continue;
    }
    if (type === "agent.call") {
      validateInputMap(errors, node, displayId);
      validateAssignmentMap(errors, node, displayId, false);
      if (typeof node.agentId !== "string" || !node.agentId.trim()) {
        errors.push(`Imported workflow node ${displayId} needs an agent id`);
      }
      if (typeof node.prompt !== "string" || !node.prompt.trim()) {
        errors.push(
          `Imported workflow node ${displayId} needs an agent prompt`,
        );
      }
      validateTimeout(errors, node, displayId, 1);
      continue;
    }
    if (type === "agent.task") {
      errors.push(
        `Imported workflow node ${displayId} uses deferred agent.task; agent.task is not available in the first workflow release`,
      );
      continue;
    }
    errors.push(`Unsupported imported workflow node type: ${type}`);
  }
  if (errors.length === 0) return { ok: true, message: "" };
  return { ok: false, message: errors.join("; ") };
}

function validateExportedNodeShape(
  nodes: WorkflowNode[],
): { ok: true; message: "" } | { ok: false; message: string } {
  const result = validateImportedNodeShape(nodes);
  if (result.ok) return result;
  return {
    ok: false,
    message: result.message
      .replaceAll(
        "Unsupported imported workflow node",
        "Unsupported workflow node",
      )
      .replaceAll("Imported workflow node", "Workflow node"),
  };
}

function validateInputMap(
  errors: string[],
  node: WorkflowNode,
  displayId: string,
) {
  if (node.input !== undefined && !isRecord(node.input)) {
    errors.push(`Imported workflow node ${displayId} input must be an object`);
  }
}

function validateAssignmentMap(
  errors: string[],
  node: WorkflowNode,
  displayId: string,
  required: boolean,
) {
  if (node.assign === undefined) {
    if (required) {
      errors.push(`Imported workflow node ${displayId} needs assignments`);
    }
    return;
  }
  if (!isRecord(node.assign) || Object.keys(node.assign).length === 0) {
    errors.push(
      `Imported workflow node ${displayId} assignments must be an object`,
    );
    return;
  }
  for (const [target, value] of Object.entries(node.assign)) {
    if (!ASSIGNMENT_TARGET_PATTERN.test(target)) {
      errors.push(
        `Imported workflow node ${displayId} assignment target must be a dotted context path`,
      );
    }
    if (typeof value === "string") {
      if (!value.trim()) {
        errors.push(
          `Imported workflow node ${displayId} assignment source is required`,
        );
      }
      continue;
    }
    if (
      !isRecord(value) ||
      typeof value["from"] !== "string" ||
      !value["from"].trim()
    ) {
      errors.push(
        `Imported workflow node ${displayId} assignment source is required`,
      );
      continue;
    }
    if (
      value["mode"] !== undefined &&
      value["mode"] !== "replace" &&
      value["mode"] !== "merge" &&
      value["mode"] !== "append"
    ) {
      errors.push(
        `Imported workflow node ${displayId} assignment mode is invalid`,
      );
    }
  }
}

function validateNodeIdArray(
  errors: string[],
  node: WorkflowNode,
  displayId: string,
  field: "then" | "else" | "body",
) {
  const value = node[field];
  if (
    value !== undefined &&
    (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
  ) {
    errors.push(
      `Imported workflow node ${displayId} ${field} must be node ids`,
    );
  }
}

function validateTimeout(
  errors: string[],
  node: WorkflowNode,
  displayId: string,
  min: number,
) {
  const timeoutMs = node.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < min ||
      timeoutMs > 300_000)
  ) {
    errors.push(
      `Imported workflow node ${displayId} timeout must be within bounds`,
    );
  }
}

function validateTriggerIdentity(
  triggers: JsonValue[],
): { ok: true; message: "" } | { ok: false; message: string } {
  const seenIds = new Set<string>();
  const seenWebhookPaths = new Set<string>();
  const errors: string[] = [];
  for (const trigger of triggers) {
    if (!isRecord(trigger)) continue;
    const id = trigger["id"];
    if (typeof id === "string") {
      if (!WORKFLOW_SAFE_ID.test(id)) {
        errors.push(`Invalid workflow trigger id: ${id}`);
      }
      if (seenIds.has(id)) errors.push(`Duplicate workflow trigger id: ${id}`);
      else seenIds.add(id);
    }
    if (trigger["kind"] !== "webhook") continue;
    const path =
      typeof trigger["path"] === "string"
        ? normalizeWebhookPath(trigger["path"])
        : null;
    if (!path) continue;
    if (seenWebhookPaths.has(path)) {
      errors.push(`Duplicate workflow webhook path: ${path}`);
    } else {
      seenWebhookPaths.add(path);
    }
  }
  if (errors.length === 0) return { ok: true, message: "" };
  return { ok: false, message: errors.join("; ") };
}

function validateTriggerShape(
  triggers: JsonValue[],
): { ok: true; message: "" } | { ok: false; message: string } {
  const errors: string[] = [];
  for (const trigger of triggers) {
    if (!isRecord(trigger)) continue;
    const id = typeof trigger["id"] === "string" ? trigger["id"].trim() : "";
    const displayId = id || "unknown";
    if (!id) {
      errors.push("Workflow trigger id is required");
      continue;
    }
    const kind = trigger["kind"];
    if (kind === "manual") {
      if (trigger["enabled"] !== true) {
        errors.push(`Manual trigger ${displayId} must stay enabled`);
      }
      continue;
    }
    if (kind === "scheduled") {
      if (typeof trigger["enabled"] !== "boolean") {
        errors.push(`Scheduled trigger ${displayId} enabled must be boolean`);
      }
      const schedule = trigger["schedule"];
      if (
        !isRecord(schedule) ||
        schedule["kind"] !== "cron" ||
        typeof schedule["expr"] !== "string" ||
        !schedule["expr"].trim()
      ) {
        errors.push(`Scheduled trigger ${displayId} needs a cron schedule`);
      }
      continue;
    }
    if (kind === "task") {
      if (trigger["enabled"] !== false) {
        errors.push(
          `Task trigger ${displayId} must stay disabled until task dispatch is implemented`,
        );
      }
      if (trigger["filter"] === undefined) {
        errors.push(`Task trigger ${displayId} needs a filter`);
      }
      continue;
    }
    if (kind === "webhook") {
      if (typeof trigger["enabled"] !== "boolean") {
        errors.push(`Webhook trigger ${displayId} enabled must be boolean`);
      }
      const path = trigger["path"];
      if (path !== undefined && (typeof path !== "string" || !path.trim())) {
        errors.push(`Webhook trigger ${displayId} path must be a string`);
      }
      const secretSha256 = trigger["secretSha256"];
      if (
        secretSha256 !== undefined &&
        (typeof secretSha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(secretSha256))
      ) {
        errors.push(
          `Webhook trigger ${displayId} secretSha256 must be a SHA-256 hex digest`,
        );
      }
      continue;
    }
    errors.push(`Unsupported workflow trigger kind: ${String(kind)}`);
  }
  if (errors.length === 0) return { ok: true, message: "" };
  return { ok: false, message: errors.join("; ") };
}

function normalizeWebhookPath(value: string): string | null {
  const normalized = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}

function parseOptionalTimeoutMs(
  value: string,
  min: number,
  max?: number,
): number | null {
  const timeoutMs = Number.parseInt(value, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < min) return null;
  if (max !== undefined && timeoutMs > max) return null;
  return timeoutMs;
}

function deriveTriggerSummaries(
  triggers: JsonValue[],
): WorkflowTriggerSummary[] {
  return triggers.flatMap((trigger) => {
    if (!isRecord(trigger)) return [];
    const id = trigger["id"];
    const kind = trigger["kind"];
    if (typeof id !== "string" || typeof kind !== "string") return [];
    const enabled =
      typeof trigger["enabled"] === "boolean" ? trigger["enabled"] : undefined;
    return [
      {
        ...trigger,
        id,
        kind,
        enabled,
        runnable:
          (kind === "manual" || kind === "webhook") && enabled !== false,
      },
    ];
  });
}

function mergeAuthoringTriggerFields(
  summaries: WorkflowTriggerSummary[],
  authoringTriggers: JsonValue[],
): WorkflowTriggerSummary[] {
  const authoringById = new Map<string, Record<string, unknown>>();
  for (const trigger of authoringTriggers) {
    if (!isRecord(trigger) || typeof trigger["id"] !== "string") continue;
    authoringById.set(trigger["id"], trigger);
  }
  return summaries.map((summary) => {
    const authoring = authoringById.get(summary.id);
    if (
      !authoring ||
      authoring["kind"] !== "webhook" ||
      typeof authoring["secretSha256"] !== "string"
    ) {
      return summary;
    }
    return { ...summary, secretSha256: authoring["secretSha256"] };
  });
}

function scheduledTriggerExpr(trigger: WorkflowTriggerSummary): string {
  const schedule = isRecord(trigger.schedule) ? trigger.schedule : {};
  return typeof schedule["expr"] === "string" ? schedule["expr"] : "";
}

function scheduledTriggerTz(trigger: WorkflowTriggerSummary): string {
  const schedule = isRecord(trigger.schedule) ? trigger.schedule : {};
  return typeof schedule["tz"] === "string" ? schedule["tz"] : "";
}

function triggerEnabledChecked(trigger: WorkflowTriggerSummary): boolean {
  if (trigger.kind === "manual") return true;
  if (trigger.kind === "task") return false;
  return trigger.enabled !== false;
}

function triggerEnabledEditable(trigger: WorkflowTriggerSummary): boolean {
  return trigger.kind === "scheduled" || trigger.kind === "webhook";
}

function iconForNode(type: string) {
  if (type.includes("if")) return GitBranch;
  if (type.includes("log")) return ScrollText;
  if (type.includes("exit")) return Square;
  if (type.includes("transform")) return Braces;
  return Workflow;
}

function assignmentSummaries(assign: unknown): Array<{
  target: string;
  source: string;
  mode?: string;
}> {
  if (!isRecord(assign)) return [];
  return Object.entries(assign).map(([target, value]) => {
    if (typeof value === "string") return { target, source: value };
    if (isRecord(value)) {
      const from = value["from"];
      const mode = value["mode"];
      return {
        target,
        source: typeof from === "string" ? from : formatJson(value),
        mode: typeof mode === "string" ? mode : undefined,
      };
    }
    return { target, source: formatJson(value) };
  });
}

function primaryAssignmentControl(assign: unknown): {
  target: string;
  source: string;
  mode: "replace" | "merge" | "append";
} | null {
  if (!isRecord(assign)) return null;
  const [entry] = Object.entries(assign);
  if (!entry) return null;
  const [target, value] = entry;
  if (typeof value === "string")
    return { target, source: value, mode: "replace" };
  if (isRecord(value)) {
    const from = value["from"];
    const mode = value["mode"];
    return {
      target,
      source: typeof from === "string" ? from : formatJson(value),
      mode: mode === "merge" || mode === "append" ? mode : "replace",
    };
  }
  return { target, source: formatJson(value), mode: "replace" };
}

function transformControl(node: WorkflowNode): {
  input: string;
  transform: string;
} | null {
  if (node.type !== "builtin.transform") return null;
  return {
    input: formatJsonObjectInput(node.input),
    transform:
      node.transform === undefined ? "null" : formatJson(node.transform),
  };
}

function branchControl(node: WorkflowNode): {
  kind: "if" | "if_else";
  condition: string;
  then: string;
  else: string;
} | null {
  if (node.type !== "builtin.if" && node.type !== "builtin.if_else") {
    return null;
  }
  return {
    kind: node.type === "builtin.if_else" ? "if_else" : "if",
    condition: typeof node.condition === "string" ? node.condition : "",
    then: formatNodeIdList(node.then),
    else: formatNodeIdList(node.else),
  };
}

function switchControl(node: WorkflowNode): {
  value: string;
  cases: Array<{ id: string; label: string; value: string; nodes: string }>;
  defaultNodes: string;
} | null {
  if (node.type !== "builtin.switch") return null;
  const cases = normalizeSwitchCaseDrafts(node.cases);
  return {
    value: formatJson(node.value ?? "$.input.kind"),
    cases: cases.map((item) => ({
      id: item.id,
      label: item.label ?? "",
      value: formatJson(item.value),
      nodes: formatNodeIdList(item.nodes),
    })),
    defaultNodes: formatNodeIdList(node.default),
  };
}

function logControl(node: WorkflowNode): {
  level: LogLevel;
  message: string;
  payload: string;
} | null {
  if (!isLogNodeType(node.type)) return null;
  const level = node.type.replace("builtin.log.", "");
  return {
    level: isLogLevel(level) ? level : "info",
    message: typeof node.message === "string" ? node.message : "",
    payload:
      node.payload === undefined
        ? ""
        : typeof node.payload === "string"
          ? node.payload
          : formatJson(node.payload),
  };
}

function throwErrorControl(node: WorkflowNode): {
  message: string;
  code: string;
  details: string;
} | null {
  if (node.type !== "builtin.throw_error") return null;
  return {
    message: typeof node.message === "string" ? node.message : "",
    code: typeof node.code === "string" ? node.code : "",
    details:
      node.details === undefined
        ? ""
        : typeof node.details === "string"
          ? node.details
          : formatJson(node.details),
  };
}

function sleepControl(node: WorkflowNode): {
  delayMs: string;
  reason: string;
} | null {
  if (node.type !== "builtin.sleep") return null;
  return {
    delayMs: typeof node.delayMs === "number" ? String(node.delayMs) : "",
    reason: typeof node.reason === "string" ? node.reason : "",
  };
}

function exitControl(node: WorkflowNode): {
  status: ExitStatus;
  output: string;
} | null {
  if (node.type !== "builtin.exit") return null;
  const status = typeof node.status === "string" ? node.status : "";
  return {
    status: isExitStatus(status) ? status : "succeeded",
    output:
      node.output === undefined
        ? ""
        : typeof node.output === "string"
          ? node.output
          : formatJson(node.output),
  };
}

function foreachControl(node: WorkflowNode): {
  items: string;
  itemVar: string;
  body: string;
  concurrency: string;
} | null {
  if (node.type !== "builtin.foreach") return null;
  return {
    items: typeof node.items === "string" ? node.items : "",
    itemVar: typeof node.itemVar === "string" ? node.itemVar : "item",
    body: formatNodeIdList(node.body),
    concurrency:
      typeof node.concurrency === "number" ? String(node.concurrency) : "1",
  };
}

function parallelControl(node: WorkflowNode): {
  branches: Array<{ id: string; label: string; nodes: string }>;
  concurrency: string;
  failFast: boolean;
} | null {
  if (node.type !== "builtin.parallel") return null;
  const branches = normalizeParallelBranchDrafts(node.branches);
  return {
    branches: branches.map((branch) => ({
      id: branch.id,
      label: branch.label ?? "",
      nodes: formatNodeIdList(branch.nodes),
    })),
    concurrency:
      typeof node.concurrency === "number"
        ? String(node.concurrency)
        : String(Math.max(1, branches.length)),
    failFast: node.failFast !== false,
  };
}

function normalizeParallelBranchDrafts(
  branches: unknown,
): Array<{ id: string; label?: string; nodes: string[] }> {
  if (!Array.isArray(branches) || branches.length === 0) {
    return [
      { id: "branch_a", label: "Branch A", nodes: [] },
      { id: "branch_b", label: "Branch B", nodes: [] },
    ];
  }
  return branches
    .map((branch, index) => {
      if (!isRecord(branch)) {
        return { id: `branch_${index + 1}`, nodes: [] };
      }
      const id =
        typeof branch["id"] === "string" && branch["id"]
          ? branch["id"]
          : `branch_${index + 1}`;
      return {
        id,
        label:
          typeof branch["label"] === "string" ? branch["label"] : undefined,
        nodes: parseNodeIdList(formatNodeIdList(branch["nodes"])),
      };
    })
    .filter((branch) => branch.id);
}

function normalizeSwitchCaseDrafts(
  cases: unknown,
): Array<{ id: string; label?: string; value: JsonValue; nodes: string[] }> {
  if (!Array.isArray(cases) || cases.length === 0) {
    return [
      { id: "case_a", label: "Case A", value: "a", nodes: [] },
      { id: "case_b", label: "Case B", value: "b", nodes: [] },
    ];
  }
  return cases
    .map((item, index) => {
      if (!isRecord(item)) {
        return {
          id: `case_${index + 1}`,
          value: `case_${index + 1}`,
          nodes: [],
        };
      }
      const id =
        typeof item["id"] === "string" && item["id"]
          ? item["id"]
          : `case_${index + 1}`;
      return {
        id,
        label: typeof item["label"] === "string" ? item["label"] : undefined,
        value: isJsonValue(item["value"]) ? item["value"] : id,
        nodes: parseNodeIdList(formatNodeIdList(item["nodes"])),
      };
    })
    .filter((item) => item.id);
}

function uniqueSwitchCaseId(
  cases: Array<{ id: string }>,
  base: string,
): string {
  const existing = new Set(cases.map((item) => item.id));
  let candidate = safeRouteId(base) || "case";
  if (!existing.has(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = `${safeRouteId(base) || "case"}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${safeRouteId(base) || "case"}_${Date.now()}`;
}

function uniqueParallelBranchId(
  branches: Array<{ id: string }>,
  base: string,
): string {
  const existing = new Set(branches.map((branch) => branch.id));
  let candidate = safeParallelBranchId(base) || "branch";
  if (!existing.has(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = `${safeParallelBranchId(base) || "branch"}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${safeParallelBranchId(base) || "branch"}_${Date.now()}`;
}

function safeParallelBranchId(value: string): string {
  return safeRouteId(value);
}

function safeRouteId(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 64);
}

function pythonControl(node: WorkflowNode): {
  input: string;
  code: string;
  timeoutMs: string;
  reset: boolean;
} | null {
  if (node.type !== "builtin.python") return null;
  return {
    input: formatJsonObjectInput(node.input),
    code: typeof node.code === "string" ? node.code : "",
    timeoutMs: typeof node.timeoutMs === "number" ? String(node.timeoutMs) : "",
    reset: node.reset === true,
  };
}

function mcpToolControl(node: WorkflowNode): {
  server: string;
  tool: string;
  timeoutMs: string;
  input: string;
  inputValues: Record<string, string>;
} | null {
  if (node.type !== "mcp.tool") return null;
  return {
    server: typeof node.server === "string" ? node.server : "",
    tool: typeof node.tool === "string" ? node.tool : "",
    timeoutMs: typeof node.timeoutMs === "number" ? String(node.timeoutMs) : "",
    input: formatJsonObjectInput(node.input),
    inputValues: stringInputValues(node.input),
  };
}

function agentCallControl(node: WorkflowNode): {
  agentId: string;
  prompt: string;
  timeoutMs: string;
  input: string;
} | null {
  if (node.type !== "agent.call") return null;
  return {
    agentId: typeof node.agentId === "string" ? node.agentId : "",
    prompt: typeof node.prompt === "string" ? node.prompt : "",
    timeoutMs: typeof node.timeoutMs === "number" ? String(node.timeoutMs) : "",
    input: formatJsonObjectInput(node.input),
  };
}

interface McpSchemaInputField {
  name: string;
  type?: string;
  required: boolean;
}

function mcpSchemaInputFields(schema: unknown): McpSchemaInputField[] {
  if (!isRecord(schema) || schema["type"] !== "object") return [];
  const properties = schema["properties"];
  if (!isRecord(properties)) return [];
  const required = Array.isArray(schema["required"])
    ? new Set(schema["required"].filter((item) => typeof item === "string"))
    : new Set<string>();
  return Object.entries(properties).map(([name, value]) => ({
    name,
    type: schemaTypeLabel(value),
    required: required.has(name),
  }));
}

function schemaTypeLabel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const type = value["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    const labels = type.filter((item) => typeof item === "string");
    return labels.length > 0 ? labels.join("|") : undefined;
  }
  return undefined;
}

function stringInputValues(
  value: JsonValue | undefined,
): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function parseNodeIdList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatNodeIdList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item) => typeof item === "string").join(", ");
}

function omitNodeKey(node: WorkflowNode, key: string): WorkflowNode {
  const nextNode = { ...node };
  delete nextNode[key];
  return nextNode;
}

function isLogNodeType(type: string): boolean {
  return (
    type === "builtin.log.info" ||
    type === "builtin.log.debug" ||
    type === "builtin.log.warn" ||
    type === "builtin.log.error"
  );
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function isExitStatus(value: string): value is ExitStatus {
  return (EXIT_STATUSES as readonly string[]).includes(value);
}

function statusIcon(
  status: WorkflowRun["status"] | WorkflowStepAttempt["status"],
) {
  if (status === "succeeded")
    return <CheckCircle2 className="size-4 text-signal-green" />;
  if (status === "failed")
    return <XCircle className="size-4 text-destructive" />;
  if (status === "skipped") return <Circle className="size-4 text-ink-faint" />;
  if (status === "running" || status === "queued") {
    return <Loader2 className="size-4 animate-spin text-signal-blue" />;
  }
  if (status === "canceled")
    return <AlertCircle className="size-4 text-signal-amber" />;
  return <Circle className="size-4 text-ink-soft" />;
}

function statusBadge(
  status: string,
): "healthy" | "destructive" | "attention" | "working" | "outline" {
  if (status === "succeeded") return "healthy";
  if (status === "failed") return "destructive";
  if (status === "running" || status === "queued") return "working";
  if (status === "canceled" || status === "skipped") return "attention";
  return "outline";
}

function shortDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(5, 16).replace("T", " ");
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

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.max(value, 0)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function timelineEmptyMessage(level: EventLevelFilter): string {
  return level === "all" ? "No events" : `No ${level} events`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function formatOptionalJson(value: unknown): string {
  return value === undefined ? "null" : formatJson(value);
}

function workflowExportFileName(
  workflow: WorkflowDefinition,
  name: string,
): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || workflow.id;
  return `${slug}-${workflow.id}-v${workflow.version}.json`;
}

function formatJsonObjectInput(value: JsonValue | undefined): string {
  if (value === undefined || !isRecord(value)) return "{\n}";
  return formatJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function artifactErrorMessage(err: unknown): string {
  const message = errorMessage(err);
  return message === "artifact_not_found" ? "Artifact unavailable" : message;
}
