import type { Config } from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import type { ModelResolver } from "@openacme/agent-core";
import path from "node:path";
import { WorkflowManager } from "@openacme/workflows";
import {
  createFileHostedIntegrationService,
  HostedIntegrationPolicyBindingSchema,
  isHostedIntegrationToolVisibleForSelection,
  type HostedIntegrationGeneration,
  type HostedIntegrationPolicyBinding,
  type HostedIntegrationRegistryRefreshEvent,
  type HostedIntegrationService,
  JsonObjectSchema,
} from "@openacme/hosted-integrations";
import {
  HostedIntegrationToolRegistryAdapter,
  registry as toolRegistry,
  type HostedIntegrationRegistrySnapshot,
  type HostedIntegrationToolInvokeRequest,
} from "@openacme/tools";
import { jsonSchemaToZod } from "@openacme/mcp-client";
import {
  createDatabase,
  createWorkflowStore,
  type WorkflowStore,
} from "@openacme/db";
import { AgentManager } from "./agent-manager.js";
import { WorkflowAgentRuntime } from "./workflow-agent-runtime.js";
import { WorkflowMcpRuntime } from "./workflow-mcp-runtime.js";
import { WorkflowPythonRuntime } from "./workflow-python-runtime.js";
import type { WorkflowExecutionPorts } from "@openacme/workflows";
import {
  dispatchDueScheduledWorkflowTriggers as dispatchDueScheduledWorkflowTriggersForRuntime,
  type DispatchDueScheduledWorkflowTriggersOptions,
} from "./workflow-scheduler.js";

const log = createLogger("server.workflow-runtime");
const DEFAULT_WORKFLOW_DISPATCHER_INTERVAL_MS = 60_000;

export interface ServerRuntimeOptions {
  resolveModel?: ModelResolver;
  tickIntervalMs?: number;
  workflowExecutionPorts?: WorkflowExecutionPorts;
  workflowDispatcherIntervalMs?: number;
  workflowDispatcherNow?: () => Date;
  hostedIntegrationService?: HostedIntegrationService;
}

export class ServerRuntime {
  readonly agentManager: AgentManager;
  readonly workflowManager: WorkflowManager;
  readonly workflowStore: WorkflowStore;
  readonly workflowAgentRuntime: WorkflowAgentRuntime;
  readonly workflowMcpRuntime: WorkflowMcpRuntime;
  readonly workflowPythonRuntime: WorkflowPythonRuntime;
  readonly workflowExecutionPorts: WorkflowExecutionPorts;
  readonly hostedIntegrationService: HostedIntegrationService;
  readonly hostedIntegrationToolRegistry: HostedIntegrationToolRegistryAdapter;
  private readonly workflowDb: ReturnType<typeof createDatabase>;
  private readonly workflowDispatcherIntervalMs: number;
  private readonly workflowDispatcherNow: () => Date;
  private workflowDispatcherTimer: NodeJS.Timeout | null = null;
  private workflowDispatcherTickInFlight: Promise<void> | null = null;

  constructor(config: Config, opts?: ServerRuntimeOptions) {
    this.agentManager = new AgentManager(config, opts);
    this.workflowDb = createDatabase(config);
    this.workflowStore = createWorkflowStore(this.workflowDb, {
      artifactRoot: path.join(config.dataDir, "workflow-artifacts"),
    });
    this.workflowManager = new WorkflowManager();
    this.workflowAgentRuntime = new WorkflowAgentRuntime(this.agentManager);
    this.workflowMcpRuntime = new WorkflowMcpRuntime(config);
    this.workflowPythonRuntime = new WorkflowPythonRuntime(config);
    this.hostedIntegrationToolRegistry =
      new HostedIntegrationToolRegistryAdapter({
        registry: toolRegistry,
        invoke: (request) => this.invokeHostedIntegrationTool(request),
      });
    this.hostedIntegrationService =
      opts?.hostedIntegrationService ??
      createFileHostedIntegrationService({
        dataDir: config.dataDir,
        onRegistryRefresh: (event) =>
          this.refreshHostedIntegrationRegistry(event),
      });
    this.workflowExecutionPorts = {
      agent: this.workflowAgentRuntime,
      mcp: this.workflowMcpRuntime,
      python: this.workflowPythonRuntime,
      ...opts?.workflowExecutionPorts,
    };
    this.workflowDispatcherIntervalMs =
      opts?.workflowDispatcherIntervalMs ??
      DEFAULT_WORKFLOW_DISPATCHER_INTERVAL_MS;
    this.workflowDispatcherNow =
      opts?.workflowDispatcherNow ?? (() => new Date());
  }

  private async invokeHostedIntegrationTool(
    request: HostedIntegrationToolInvokeRequest,
  ): Promise<string> {
    const binding = this.hostedIntegrationBindingForTool(request);
    if (!binding.ok) {
      return this.hostedIntegrationToolFailure(request, binding.error);
    }
    const args = JsonObjectSchema.safeParse(request.args);
    if (!args.success) {
      return this.hostedIntegrationToolFailure(request, {
        code: "policy_denied",
        message: "hosted integration tool arguments must be a JSON object",
      });
    }

    const result = await this.hostedIntegrationService.gateway.invoke({
      actor: { id: request.actorId, kind: "agent", roles: ["agent"] },
      familyId: request.familyId,
      toolName: request.toolName,
      environment: binding.binding.environment,
      args: args.data,
      bindings: [binding.binding],
      generationId: request.generationId,
    });
    return JSON.stringify(result);
  }

  private hostedIntegrationBindingForTool(
    request: HostedIntegrationToolInvokeRequest,
  ):
    | { ok: true; binding: HostedIntegrationPolicyBinding }
    | { ok: false; error: { code: string; message: string } } {
    const def = this.agentManager.getAgentDef(request.actorId);
    if (!def) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "hosted integration caller agent was not found",
        },
      };
    }
    if (!def.tools.includes(request.toolName)) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "hosted integration tool is not enabled for agent",
        },
      };
    }
    const matches = (def.hostedIntegrationBindings ?? []).filter(
      (binding) =>
        binding.familyId === request.familyId &&
        binding.toolName === request.toolName,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "agent is not bound to hosted integration tool",
        },
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: {
          code: "config_missing",
          message:
            "multiple hosted integration bindings require a single default binding",
        },
      };
    }

    const parsed = HostedIntegrationPolicyBindingSchema.safeParse({
      agentId: def.id,
      ...matches[0],
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "hosted integration binding is invalid",
        },
      };
    }
    return { ok: true, binding: parsed.data };
  }

  private hostedIntegrationToolFailure(
    request: HostedIntegrationToolInvokeRequest,
    error: { code: string; message: string },
  ): string {
    return JSON.stringify({
      ok: false,
      error,
      familyId: request.familyId,
      toolName: request.toolName,
      generationId: request.generationId,
    });
  }

  async initWorkflowMCP(): Promise<void> {
    await this.workflowMcpRuntime.initialize();
  }

  async startHostedIntegrations(): Promise<void> {
    await this.hostedIntegrationService.start();
    await this.refreshHostedIntegrationRegistry();
  }

  async dispatchDueScheduledWorkflowTriggers(
    opts: Omit<DispatchDueScheduledWorkflowTriggersOptions, "ports"> = {},
  ) {
    return dispatchDueScheduledWorkflowTriggersForRuntime(
      this.workflowStore,
      this.workflowManager,
      {
        ...opts,
        ports: this.workflowExecutionPorts,
      },
    );
  }

  async startWorkflowDispatcher(): Promise<void> {
    if (this.workflowDispatcherTimer) return;
    this.workflowManager.dispatcher.start();
    await this.runWorkflowDispatcherTick();
    this.workflowDispatcherTimer = setInterval(() => {
      this.runWorkflowDispatcherTick().catch((err) =>
        log.warn({ err }, "workflow dispatcher tick threw"),
      );
    }, this.workflowDispatcherIntervalMs);
    if (typeof this.workflowDispatcherTimer.unref === "function") {
      this.workflowDispatcherTimer.unref();
    }
  }

  stopWorkflowDispatcher(): void {
    this.workflowManager.dispatcher.stop();
    if (this.workflowDispatcherTimer) {
      clearInterval(this.workflowDispatcherTimer);
    }
    this.workflowDispatcherTimer = null;
  }

  private async refreshHostedIntegrationRegistry(
    event?: HostedIntegrationRegistryRefreshEvent,
  ): Promise<void> {
    const generations = event
      ? [
          await this.hostedIntegrationService.generations.getGeneration(
            event.generationId,
          ),
        ]
      : await this.hostedIntegrationService.generations.listGenerations();
    const changedToolNames = new Set<string>();
    for (const generation of generations) {
      if (!generation || generation.status !== "active") continue;
      const snapshot = await this.hostedIntegrationRegistrySnapshot(generation);
      if (!snapshot) continue;
      const result = this.hostedIntegrationToolRegistry.syncFamily(snapshot);
      if (!result.ok) {
        log.error(
          {
            familyId: generation.familyId,
            generationId: generation.id,
            toolName: result.toolName,
            existingToolset: result.existingToolset,
          },
          "hosted integration tool registration rejected",
        );
        continue;
      }
      for (const toolName of result.registeredToolNames) {
        changedToolNames.add(toolName);
      }
      for (const toolName of result.removedToolNames) {
        changedToolNames.add(toolName);
      }
    }
    this.agentManager.evictAgentsUsingTools(changedToolNames);
  }

  private async hostedIntegrationRegistrySnapshot(
    generation: HostedIntegrationGeneration,
  ): Promise<HostedIntegrationRegistrySnapshot | null> {
    const tools = (generation.tools ?? []).filter(
      isHostedIntegrationToolVisibleForSelection,
    );
    if (tools.length === 0) {
      this.hostedIntegrationToolRegistry.removeFamily(generation.familyId);
      return null;
    }
    const family = await this.hostedIntegrationService.getFamily(
      generation.familyId,
    );
    return {
      familyId: generation.familyId,
      familyName: family?.summary.name ?? generation.familyId,
      generationId: generation.id,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: jsonSchemaToZod(tool.inputSchema),
      })),
    };
  }

  isWorkflowDispatcherRunning(): boolean {
    return this.workflowManager.dispatcher.isRunning();
  }

  async close(): Promise<void> {
    this.stopWorkflowDispatcher();
    await this.workflowDispatcherTickInFlight;
    this.hostedIntegrationToolRegistry.clear();
    await Promise.all([
      this.agentManager.close(),
      this.workflowManager.close(),
      this.workflowMcpRuntime.close(),
      this.hostedIntegrationService.close(),
    ]);
    this.workflowDb.close();
  }

  private async runWorkflowDispatcherTick(): Promise<void> {
    if (this.workflowDispatcherTickInFlight) {
      await this.workflowDispatcherTickInFlight;
      return;
    }
    this.workflowDispatcherTickInFlight =
      this.dispatchDueScheduledWorkflowTriggers({
        now: this.workflowDispatcherNow(),
      })
        .then(() => undefined)
        .finally(() => {
          this.workflowDispatcherTickInFlight = null;
        });
    await this.workflowDispatcherTickInFlight;
  }
}
