import { z } from "zod";

/**
 * Schema for a tool's parameter definition (maps to JSON Schema).
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: z.ZodType;
}

export type ToolExecutionStatus = "ok" | "error";
export type ToolResultStatus =
  | "success"
  | "failure"
  | "partial"
  | "running"
  | "unknown";
export type ToolOutcomeAttributeValue = string | number | boolean;

export interface ToolResultClassifierContext {
  toolName: string;
  toolset: string;
  args: Record<string, unknown>;
  output: string;
}

export interface ToolResultClassification {
  resultStatus: ToolResultStatus;
  resultClassifier: string;
  failureKind?: string;
  failureMessage?: string;
  exitCode?: number;
  processStatus?: string;
  successFlag?: boolean;
  okFlag?: boolean;
  parsedJson?: boolean;
  outcomeAttributes?: Record<string, ToolOutcomeAttributeValue>;
}

export type ToolResultClassifier = (
  context: ToolResultClassifierContext,
) => ToolResultClassification;

export type ToolSource = {
  kind: "hosted_integration";
  familyId: string;
  familyName: string;
  generationId: string;
};

/**
 * A registered tool entry — mirrors Hermes tools/registry.py ToolEntry.
 */
export interface ToolEntry {
  /** Unique tool name (e.g. "shell", "read_file", "mcp-github__create_issue") */
  name: string;
  /** Group name (e.g. "terminal", "filesystem", "mcp-github") */
  toolset: string;
  /** Tool description for the LLM */
  description: string;
  /** Zod schema for parameters */
  parameters: z.ZodType;
  /** Handler function — takes parsed args, returns result string */
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** Optional domain-specific classifier for observability-only tool
   *  outcomes. The registry invokes this after the handler returns; it must
   *  not mutate output or drive application behavior. */
  classifyResult?: ToolResultClassifier;
  /** Optional: check if tool is available (e.g. Docker installed) */
  checkFn?: () => boolean;
  /** Emoji for display */
  emoji?: string;
  /** Structured source metadata for dynamically surfaced tool families. */
  source?: ToolSource;
  /** Whether this tool is safe to run in parallel with other tools */
  parallelSafe?: boolean;
  /** Execution locality. `"worker"` routes the call to the per-agent
   *  sandboxed tool-host process when one is bound (raw filesystem /
   *  process-spawning tools); absent or `"daemon"` runs the handler
   *  in-process (mediated platform-API tools). Handlers stay identical
   *  either way — the worker imports the same module. */
  runtime?: "daemon" | "worker";
  /** Max result size in characters before the registry spills the result to
   *  a file in the agent's workspace and returns a preview + path. Defaults
   *  to the spill module's `DEFAULT_SPILL_THRESHOLD` when unset. */
  maxResultSizeChars?: number;
  /** Result isn't grep-friendly text (base64 PNG, opaque binary). Skips the
   *  spill-to-file intercept; the handler's own result flows through. */
  binaryResult?: boolean;
  /**
   * Optional translator that converts the handler's string result into
   * the AI SDK's `ToolResultOutput` shape. Use to emit vision / document
   * content parts that the active provider can deliver natively (image
   * inside `tool_result.content` on Anthropic, OpenAI Responses, Google
   * for images). When unset, the SDK's default kicks in (text/json).
   *
   * Returns `unknown` to keep `@ai-sdk/provider-utils` out of the tools
   * package; the SDK validates the runtime shape downstream.
   */
  toModelOutput?: (opts: {
    toolCallId: string;
    input: Record<string, unknown>;
    output: string;
  }) => unknown;
}

/**
 * OpenAI-format tool definition for the LLM API.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Serializable tool description suitable for sending to UI clients.
 * Mirrors the subset of {@link ToolEntry} fields that are safe to expose.
 */
export interface ToolInfo {
  name: string;
  description: string;
  toolset: string;
  emoji?: string;
  source?: ToolSource;
  /** Always-on tool merged into every agent regardless of config; the agent
   *  picker should not present it as toggleable. */
  system?: boolean;
}
