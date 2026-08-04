export type WorkflowPaletteKind =
  | "set"
  | "transform"
  | "if"
  | "switch"
  | "log"
  | "throw_error"
  | "sleep"
  | "exit"
  | "foreach"
  | "parallel"
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

export interface WorkflowTransformPreset {
  id: string;
  label: string;
  description: string;
  transform: unknown;
}

export const WORKFLOW_TRANSFORM_PRESETS: WorkflowTransformPreset[] = [
  {
    id: "string.replace",
    label: "String Replace",
    description: "Replace text once or everywhere.",
    transform: {
      kind: "string.replace",
      value: "$.input.value",
      search: "old",
      replacement: "new",
      all: true,
    },
  },
  {
    id: "string.regex_replace",
    label: "Regex Replace",
    description: "Replace text with a regular expression.",
    transform: {
      kind: "string.regex_replace",
      value: "$.input.value",
      pattern: "old-(\\d+)",
      replacement: "new-$1",
      flags: "g",
    },
  },
  {
    id: "string.regex_match",
    label: "Regex Match",
    description: "Extract match, capture groups, and named groups.",
    transform: {
      kind: "string.regex_match",
      value: "$.input.value",
      pattern: "(?<id>[A-Za-z]+-\\d+)",
      flags: "",
    },
  },
  {
    id: "json.parse",
    label: "JSON Parse",
    description: "Parse a JSON string into an object or array.",
    transform: {
      kind: "json.parse",
      value: "$.input.json",
    },
  },
  {
    id: "json.stringify",
    label: "JSON Stringify",
    description: "Serialize a JSON value to text.",
    transform: {
      kind: "json.stringify",
      value: "$.context.value",
      pretty: true,
    },
  },
  {
    id: "csv.parse",
    label: "CSV Parse",
    description: "Parse CSV text into rows.",
    transform: {
      kind: "csv.parse",
      value: "$.input.csv",
      headers: true,
      maxRows: 10000,
    },
  },
  {
    id: "csv.stringify",
    label: "CSV Stringify",
    description: "Serialize rows to CSV text.",
    transform: {
      kind: "csv.stringify",
      value: "$.context.rows",
      headers: ["id", "name"],
      includeHeaders: true,
      maxRows: 10000,
    },
  },
  {
    id: "ip.parse",
    label: "IP Parse",
    description: "Parse an IPv4 or IPv6 address into stable metadata.",
    transform: {
      kind: "ip.parse",
      value: "$.input.ip",
    },
  },
  {
    id: "ip.is_ipv4",
    label: "Is IPv4",
    description: "Return true when the value is an IPv4 address.",
    transform: {
      kind: "ip.is_ipv4",
      value: "$.input.ip",
    },
  },
  {
    id: "ip.is_ipv6",
    label: "Is IPv6",
    description: "Return true when the value is an IPv6 address.",
    transform: {
      kind: "ip.is_ipv6",
      value: "$.input.ip",
    },
  },
  {
    id: "ip.in_subnet",
    label: "In Subnet",
    description: "Return true when the IP belongs to a CIDR subnet.",
    transform: {
      kind: "ip.in_subnet",
      value: "$.input.ip",
      cidr: "10.0.0.0/8",
    },
  },
  {
    id: "ip.netmask",
    label: "IP Netmask",
    description: "Calculate an IPv4 or IPv6 netmask from a prefix length.",
    transform: {
      kind: "ip.netmask",
      prefix: 24,
      version: 4,
    },
  },
  {
    id: "ip.network",
    label: "IP Network",
    description: "Calculate the network address for a CIDR.",
    transform: {
      kind: "ip.network",
      cidr: "10.1.2.3/24",
    },
  },
  {
    id: "uri.parse",
    label: "URI Parse",
    description: "Parse a URL into host, path, query, and fragment fields.",
    transform: {
      kind: "uri.parse",
      value: "$.input.url",
    },
  },
];

export function workflowTransformPresetById(
  id: string,
): WorkflowTransformPreset | undefined {
  return WORKFLOW_TRANSFORM_PRESETS.find((preset) => preset.id === id);
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

export function setWorkflowForeachBodyFirst(
  nodes: WorkflowAuthoringNode[],
  foreachNodeId: string,
  bodyNodeId: string,
): WorkflowAuthoringNode[] | null {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.id !== foreachNodeId || node.type !== "builtin.foreach") {
      return node;
    }
    const body = Array.isArray(node.body)
      ? node.body.filter((item): item is string => typeof item === "string")
      : [];
    const currentIndex = body.indexOf(bodyNodeId);
    if (currentIndex <= 0) return node;
    changed = true;
    return {
      ...node,
      body: [
        bodyNodeId,
        ...body.slice(0, currentIndex),
        ...body.slice(currentIndex + 1),
      ],
    };
  });
  return changed ? nextNodes : null;
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
  if (kind === "switch") {
    return {
      id: `switch_${suffix}`,
      type: "builtin.switch",
      value: "$.input.kind",
      cases: [
        { id: "case_a", label: "Case A", value: "a", nodes: [] },
        { id: "case_b", label: "Case B", value: "b", nodes: [] },
      ],
      default: [],
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
  if (kind === "throw_error") {
    return {
      id: `throw_error_${suffix}`,
      type: "builtin.throw_error",
      message: "Controlled workflow failure",
      code: "workflow_error",
      details: "$.context",
    };
  }
  if (kind === "sleep") {
    return {
      id: `sleep_${suffix}`,
      type: "builtin.sleep",
      delayMs: 1000,
      reason: "Wait before continuing",
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
  if (kind === "parallel") {
    return {
      id: `parallel_${suffix}`,
      type: "builtin.parallel",
      branches: [
        { id: "branch_a", label: "Branch A", nodes: [] },
        { id: "branch_b", label: "Branch B", nodes: [] },
      ],
      concurrency: 2,
      failFast: true,
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
  const branches = next["branches"];
  if (Array.isArray(branches)) {
    next["branches"] = branches.map((branch) => {
      if (!isRecord(branch) || !Array.isArray(branch["nodes"])) return branch;
      return {
        ...branch,
        nodes: branch["nodes"].filter((item) => item !== deletedNodeId),
      };
    });
  }
  const cases = next["cases"];
  if (Array.isArray(cases)) {
    next["cases"] = cases.map((item) => {
      if (!isRecord(item) || !Array.isArray(item["nodes"])) return item;
      return {
        ...item,
        nodes: item["nodes"].filter((nodeId) => nodeId !== deletedNodeId),
      };
    });
  }
  const defaultRoute = next["default"];
  if (Array.isArray(defaultRoute)) {
    next["default"] = defaultRoute.filter((nodeId) => nodeId !== deletedNodeId);
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
