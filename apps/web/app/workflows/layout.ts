export interface WorkflowDefinitionUi {
  canvas?: WorkflowCanvasUi;
}

export interface WorkflowCanvasUi {
  nodes?: Record<string, WorkflowCanvasNodeUi | undefined>;
}

export interface WorkflowCanvasNodeUi {
  position?: WorkflowCanvasPosition;
}

export interface WorkflowCanvasPosition {
  x: number;
  y: number;
}

export interface WorkflowLayoutNode {
  id: string;
}

export interface WorkflowCanvasLayoutProjectionNode {
  id: string;
  position: WorkflowCanvasPosition;
  data?: {
    kind?: unknown;
  };
}

export function updateWorkflowCanvasNodePosition(
  ui: WorkflowDefinitionUi | null,
  nodeId: string,
  position: WorkflowCanvasPosition,
): WorkflowDefinitionUi {
  return {
    ...ui,
    canvas: {
      ...ui?.canvas,
      nodes: {
        ...ui?.canvas?.nodes,
        [nodeId]: {
          ...ui?.canvas?.nodes?.[nodeId],
          position,
        },
      },
    },
  };
}

export function beautifyWorkflowCanvasPositions(
  ui: WorkflowDefinitionUi | null,
  nodes: WorkflowCanvasLayoutProjectionNode[],
): WorkflowDefinitionUi {
  const nextNodes: Record<string, WorkflowCanvasNodeUi> = {};
  for (const node of nodes) {
    if (node.data?.kind !== "step" || !isFinitePosition(node.position)) {
      continue;
    }
    nextNodes[node.id] = {
      ...ui?.canvas?.nodes?.[node.id],
      position: {
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
      },
    };
  }
  return {
    ...ui,
    canvas: {
      ...ui?.canvas,
      nodes: nextNodes,
    },
  };
}

export function normalizeWorkflowDefinitionUi(
  ui: WorkflowDefinitionUi | null,
  nodes: WorkflowLayoutNode[],
): WorkflowDefinitionUi | undefined {
  const knownNodeIds = new Set(nodes.map((node) => node.id));
  const nextNodes: Record<string, WorkflowCanvasNodeUi> = {};
  for (const [nodeId, nodeUi] of Object.entries(ui?.canvas?.nodes ?? {})) {
    if (!knownNodeIds.has(nodeId) || !isFinitePosition(nodeUi?.position)) {
      continue;
    }
    nextNodes[nodeId] = {
      position: {
        x: nodeUi.position.x,
        y: nodeUi.position.y,
      },
    };
  }
  if (Object.keys(nextNodes).length === 0) return undefined;
  return { canvas: { nodes: nextNodes } };
}

export function parseWorkflowDefinitionUi(
  value: unknown,
):
  | { ok: true; value: WorkflowDefinitionUi | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value)) {
    return { ok: false, error: "Imported workflow ui must be an object" };
  }
  const canvas = value["canvas"];
  if (canvas === undefined) return { ok: true, value: {} };
  if (!isRecord(canvas)) {
    return {
      ok: false,
      error: "Imported workflow ui.canvas must be an object",
    };
  }
  const nodes = canvas["nodes"];
  if (nodes === undefined) return { ok: true, value: { canvas: {} } };
  if (!isRecord(nodes)) {
    return {
      ok: false,
      error: "Imported workflow ui.canvas.nodes must be an object",
    };
  }
  const nextNodes: Record<string, WorkflowCanvasNodeUi> = {};
  for (const [nodeId, nodeUi] of Object.entries(nodes)) {
    if (!isRecord(nodeUi)) {
      return {
        ok: false,
        error: `Imported workflow ui.canvas.nodes.${nodeId} must be an object`,
      };
    }
    const position = nodeUi["position"];
    if (!isFinitePosition(position)) {
      return {
        ok: false,
        error: `Imported workflow ui.canvas.nodes.${nodeId}.position must have finite x and y numbers`,
      };
    }
    nextNodes[nodeId] = { position };
  }
  return { ok: true, value: { canvas: { nodes: nextNodes } } };
}

function isFinitePosition(value: unknown): value is WorkflowCanvasPosition {
  return (
    isRecord(value) &&
    typeof value["x"] === "number" &&
    Number.isFinite(value["x"]) &&
    typeof value["y"] === "number" &&
    Number.isFinite(value["y"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
