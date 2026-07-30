import type { AgentManager } from "./agent-manager.js";
import type {
  AgentCallPort,
  AgentCallRequest,
  AgentCallResult,
  AgentSummary,
  JsonValue,
} from "@openacme/workflows";

export class WorkflowAgentRuntime implements AgentCallPort {
  constructor(private readonly manager: AgentManager) {}

  listAgents(): AgentSummary[] {
    return this.manager.listAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      instantMessagesEnabled: agent.instantMessagesEnabled,
    }));
  }

  async callAgent(req: AgentCallRequest): Promise<AgentCallResult> {
    const result = await this.manager.callAgentFromWorkflow({
      runId: req.runId ?? "workflow-run",
      agentId: req.agentId,
      prompt: req.prompt,
      input: req.input,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });
    return {
      sessionId: result.sessionId,
      output: {
        response: result.response,
        sessionId: result.sessionId,
        assistantMessageId: result.assistantMessageId ?? null,
      } satisfies JsonValue,
    };
  }
}
