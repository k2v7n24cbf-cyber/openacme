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

export interface HostedToolCallRequest {
  toolName: string;
  input: JsonValue;
  actorId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HostedToolCallResult {
  output: JsonValue;
}

export interface HostedToolSummary {
  name: string;
  familyId: string;
  familyName?: string;
  toolName: string;
  generationId?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface HostedToolExecutionPort {
  listTools?(): Promise<HostedToolSummary[]>;
  callTool(req: HostedToolCallRequest): Promise<HostedToolCallResult>;
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
  hosted?: HostedToolExecutionPort;
  python?: PythonExecutionPort;
  events?: WorkflowEventPort;
}
