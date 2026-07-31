export type WorkflowPaletteKind =
  | "set"
  | "transform"
  | "if"
  | "log"
  | "exit"
  | "foreach"
  | "python"
  | "mcp"
  | "agent";

export interface WorkflowAuthoringNode {
  id: string;
  type: string;
  label?: string;
  [key: string]: unknown;
}

export interface WorkflowAuthoringMcpTool {
  server: string;
  tool: string;
}

export interface WorkflowAuthoringAgent {
  id: string;
}

export function appendWorkflowNode(
  nodes: WorkflowAuthoringNode[],
  kind: WorkflowPaletteKind,
  tool?: WorkflowAuthoringMcpTool | WorkflowAuthoringAgent,
): WorkflowAuthoringNode[] {
  return insertWorkflowNodeAfter(nodes, null, kind, tool);
}

export function insertWorkflowNodeAfter(
  nodes: WorkflowAuthoringNode[],
  afterNodeId: string | null,
  kind: WorkflowPaletteKind,
  tool?: WorkflowAuthoringMcpTool | WorkflowAuthoringAgent,
): WorkflowAuthoringNode[] {
  const nextNode = createNextWorkflowNodeTemplate(nodes, kind, tool);
  if (!afterNodeId) return [...nodes, nextNode];
  const index = nodes.findIndex((node) => node.id === afterNodeId);
  if (index < 0) return [...nodes, nextNode];
  return [...nodes.slice(0, index + 1), nextNode, ...nodes.slice(index + 1)];
}

export function insertWorkflowNodeFirst(
  nodes: WorkflowAuthoringNode[],
  kind: WorkflowPaletteKind,
  tool?: WorkflowAuthoringMcpTool | WorkflowAuthoringAgent,
): WorkflowAuthoringNode[] {
  return [createNextWorkflowNodeTemplate(nodes, kind, tool), ...nodes];
}

export function moveWorkflowNode(
  nodes: WorkflowAuthoringNode[],
  index: number,
  direction: -1 | 1,
): WorkflowAuthoringNode[] {
  const target = index + direction;
  if (target < 0 || target >= nodes.length) return nodes;
  const next = [...nodes];
  const [node] = next.splice(index, 1);
  if (!node) return nodes;
  next.splice(target, 0, node);
  return next;
}

export function cloneWorkflowNodeAfter(
  nodes: WorkflowAuthoringNode[],
  nodeId: string,
): { nodes: WorkflowAuthoringNode[]; clonedId: string } | null {
  const index = nodes.findIndex((node) => node.id === nodeId);
  const source = nodes[index];
  if (!source) return null;
  const clonedId = uniqueCloneNodeId(nodes, nodeId);
  const cloned = replaceStringReferences(cloneWorkflowNode(source), {
    from: nodeId,
    to: clonedId,
  });
  cloned.id = clonedId;
  return {
    nodes: [...nodes.slice(0, index + 1), cloned, ...nodes.slice(index + 1)],
    clonedId,
  };
}

export function removeWorkflowNode(
  nodes: WorkflowAuthoringNode[],
  nodeId: string,
): WorkflowAuthoringNode[] {
  return nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => pruneNodeReferences(node, nodeId));
}

export function createWorkflowNodeTemplate(
  kind: WorkflowPaletteKind,
  index: number,
  tool?: WorkflowAuthoringMcpTool | WorkflowAuthoringAgent,
): WorkflowAuthoringNode {
  const suffix = String(index).padStart(2, "0");
  if (kind === "set") {
    return {
      id: `set_${suffix}`,
      type: "builtin.set",
      assign: { value: "$.input.value" },
    };
  }
  if (kind === "transform") {
    return {
      id: `transform_${suffix}`,
      type: "builtin.transform",
      input: { value: "$.context.value" },
      transform: "$.context.value",
      assign: {
        value: { from: `$.steps.transform_${suffix}.output`, mode: "replace" },
      },
    };
  }
  if (kind === "if") {
    return {
      id: `if_${suffix}`,
      type: "builtin.if",
      condition: "$.input.enabled == true",
      then: [],
      else: [],
    };
  }
  if (kind === "log") {
    return {
      id: `log_${suffix}`,
      type: "builtin.log.info",
      message: "Workflow log",
      payload: "$.context",
    };
  }
  if (kind === "foreach") {
    return {
      id: `foreach_${suffix}`,
      type: "builtin.foreach",
      items: "$.input.items",
      itemVar: "item",
      body: [],
      concurrency: 1,
    };
  }
  if (kind === "python") {
    return {
      id: `python_${suffix}`,
      type: "builtin.python",
      input: { value: "$.input.value" },
      code: "output = input.get('value')",
      timeoutMs: 30000,
      assign: {
        pythonResult: {
          from: `$.steps.python_${suffix}.output.value`,
          mode: "replace",
        },
      },
    };
  }
  if (kind === "mcp") {
    const mcpTool = isMcpToolSummary(tool) ? tool : undefined;
    const server = mcpTool?.server ?? "server";
    const toolName = mcpTool?.tool ?? "tool";
    const id = `mcp_${safeIdSegment(server)}_${safeIdSegment(toolName)}_${suffix}`;
    return {
      id,
      type: "mcp.tool",
      server,
      tool: toolName,
      input: {},
      assign: {
        [safeIdSegment(`${server}_${toolName}`)]: {
          from: `$.steps.${id}.output`,
          mode: "replace",
        },
      },
    };
  }
  if (kind === "agent") {
    const agent = isAgentSummary(tool) ? tool : undefined;
    const agentId = agent?.id ?? "agent";
    const id = `agent_${safeIdSegment(agentId)}_${suffix}`;
    return {
      id,
      type: "agent.call",
      agentId,
      prompt: "Review workflow input",
      input: {},
      assign: {
        [safeIdSegment(`${agentId}_result`)]: {
          from: `$.steps.${id}.output`,
          mode: "replace",
        },
      },
    };
  }
  return {
    id: `exit_${suffix}`,
    type: "builtin.exit",
    status: "succeeded",
    output: "$.context",
  };
}

export function isMcpToolSummary(
  value: unknown,
): value is WorkflowAuthoringMcpTool {
  return (
    isRecord(value) &&
    typeof value["server"] === "string" &&
    typeof value["tool"] === "string"
  );
}

export function isAgentSummary(
  value: unknown,
): value is WorkflowAuthoringAgent {
  return isRecord(value) && typeof value["id"] === "string";
}

function safeIdSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+/, "");
  return segment || "tool";
}

function createNextWorkflowNodeTemplate(
  nodes: WorkflowAuthoringNode[],
  kind: WorkflowPaletteKind,
  tool?: WorkflowAuthoringMcpTool | WorkflowAuthoringAgent,
): WorkflowAuthoringNode {
  const existingIds = new Set(nodes.map((node) => node.id));
  let index = nodes.length + 1;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const node = createWorkflowNodeTemplate(kind, index, tool);
    if (!existingIds.has(node.id)) return node;
    index += 1;
  }
  return createWorkflowNodeTemplate(kind, Date.now(), tool);
}

function uniqueCloneNodeId(
  nodes: WorkflowAuthoringNode[],
  nodeId: string,
): string {
  const existingIds = new Set(nodes.map((node) => node.id));
  const base = `${nodeId}_copy`;
  if (!existingIds.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

function pruneNodeReferences(
  node: WorkflowAuthoringNode,
  deletedNodeId: string,
): WorkflowAuthoringNode {
  const next = { ...node };
  for (const key of ["then", "else", "body"]) {
    const value = next[key];
    if (!Array.isArray(value)) continue;
    next[key] = value.filter((item) => item !== deletedNodeId);
  }
  return next;
}

function replaceStringReferences<T>(
  value: T,
  ids: { from: string; to: string },
): T {
  if (typeof value === "string") {
    return value.split(ids.from).join(ids.to) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringReferences(item, ids)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceStringReferences(item, ids),
      ]),
    ) as T;
  }
  return value;
}

function cloneWorkflowNode(node: WorkflowAuthoringNode): WorkflowAuthoringNode {
  return cloneJsonish(node);
}

function cloneJsonish<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonish(item)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonish(item)]),
    ) as T;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
