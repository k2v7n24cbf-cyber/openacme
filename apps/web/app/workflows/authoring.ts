export type WorkflowPaletteKind =
  | "set"
  | "transform"
  | "if"
  | "if_else"
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
  return [...nodes, createWorkflowNodeTemplate(kind, nodes.length + 1, tool)];
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
    };
  }
  if (kind === "if_else") {
    return {
      id: `if_else_${suffix}`,
      type: "builtin.if_else",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
