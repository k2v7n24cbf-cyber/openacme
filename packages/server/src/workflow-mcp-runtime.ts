import * as path from "node:path";
import type { Config } from "@openacme/config";
import { loadGlobalMcpServers } from "@openacme/config";
import { MCPClient, FileMCPTokenStore } from "@openacme/mcp-client";
import { ToolRegistry } from "@openacme/tools";
import type {
  JsonValue,
  McpExecutionPort,
  McpToolCallRequest,
  McpToolCallResult,
  McpToolSummary,
} from "@openacme/workflows";

type JsonObject = Record<string, JsonValue>;

export class WorkflowMcpRuntime implements McpExecutionPort {
  private readonly client: MCPClient;
  private catalogFingerprint: string | null = null;

  constructor(private readonly config: Config) {
    this.client = new MCPClient(new ToolRegistry(), {
      tokenStore: new FileMCPTokenStore(
        path.join(this.config.dataDir, "mcp-tokens"),
      ),
    });
  }

  async initialize(): Promise<void> {
    await this.ensureConnected();
  }

  async close(): Promise<void> {
    await this.client.disconnect();
  }

  async listTools(): Promise<McpToolSummary[]> {
    await this.ensureConnected();
    const tools: McpToolSummary[] = [];
    for (const status of this.client.getStatus()) {
      if (status.state !== "connected") continue;
      for (const tool of this.client.getToolSchemas(status.name)) {
        tools.push({
          server: status.name,
          tool: tool.name,
          name: `mcp_${status.name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return tools.sort((a, b) =>
      a.server === b.server
        ? a.tool.localeCompare(b.tool)
        : a.server.localeCompare(b.server),
    );
  }

  async callTool(req: McpToolCallRequest): Promise<McpToolCallResult> {
    await this.ensureConnected();
    const args = jsonObjectInput(req.input);
    const raw = await rejectOnAbort(
      this.client.callToolDirect(
        req.server,
        req.tool,
        args,
        req.timeoutMs === undefined
          ? undefined
          : Math.ceil(req.timeoutMs / 1000),
      ),
      req.signal,
    );
    const output = parseMcpOutput(raw);
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      typeof output["error"] === "string"
    ) {
      throw new Error(output["error"]);
    }
    return { output };
  }

  private async ensureConnected(): Promise<void> {
    const servers = loadGlobalMcpServers(this.config.dataDir);
    const fingerprint = JSON.stringify(servers);
    if (fingerprint === this.catalogFingerprint) return;
    await this.client.disconnect();
    this.catalogFingerprint = fingerprint;
    if (Object.keys(servers).length === 0) return;
    await this.client.connect(servers, { skipOAuth: true });
  }
}

function rejectOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Workflow MCP canceled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Workflow MCP canceled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function jsonObjectInput(input: JsonValue): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("MCP tool input must resolve to a JSON object");
  }
  return input as JsonObject;
}

function parseMcpOutput(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}
