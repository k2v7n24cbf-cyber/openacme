import type {
  JsonValue,
  WorkflowRunEventKind,
  WorkflowRunEventLevel,
} from "./schemas.js";

export interface AgentSummary {
  id: string;
  name: string;
  role?: string;
  instantMessagesEnabled?: boolean;
}

export interface AgentCallRequest {
  agentId: string;
  prompt: string;
  input: JsonValue;
  runId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentCallResult {
  output: JsonValue;
  sessionId?: string;
}

export interface AgentTaskRequest {
  agentId: string;
  title: string;
  input: JsonValue;
}

export interface AgentCallPort {
  listAgents(): AgentSummary[];
  callAgent(req: AgentCallRequest): Promise<AgentCallResult>;
  createAgentTask?(req: AgentTaskRequest): Promise<{ taskId: string }>;
}

export interface McpToolCallRequest {
  server: string;
  tool: string;
  input: JsonValue;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpToolCallResult {
  output: JsonValue;
}

export interface McpToolSummary {
  server: string;
  tool: string;
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpExecutionPort {
  listTools?(): Promise<McpToolSummary[]>;
  callTool(req: McpToolCallRequest): Promise<McpToolCallResult>;
}

export interface PythonExecutionRequest {
  code: string;
  input: JsonValue;
  reset?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PythonExecutionResult {
  output: JsonValue;
  stdout?: string;
  stderr?: string;
}

export interface PythonExecutionPort {
  execute(req: PythonExecutionRequest): Promise<PythonExecutionResult>;
}

export interface WorkflowEventPort {
  append(event: {
    runId: string;
    stepRunId?: string | null;
    level: WorkflowRunEventLevel;
    kind: WorkflowRunEventKind;
    message?: string;
    payload?: JsonValue;
  }): Promise<void>;
}

export interface WorkflowExecutionPorts {
  agent?: AgentCallPort;
  mcp?: McpExecutionPort;
  python?: PythonExecutionPort;
  events?: WorkflowEventPort;
}
