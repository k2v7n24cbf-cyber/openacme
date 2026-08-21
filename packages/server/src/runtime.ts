import type { Config } from "@openacme/config";
import { resolveDeploymentMode } from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import type { ModelResolver } from "@openacme/agent-core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  JsonValueSchema,
  getWorkflowCardCatalog,
  validateWorkflowJsonSchemaValue,
  WorkflowDefinitionSchema,
  WorkflowNodeSchema,
  WorkflowNodeTypeValues,
  WorkflowManager,
  type AgentSummary,
  type HostedToolCallRequest,
  type HostedToolCallResult,
  type HostedToolSummary,
  type JsonValue,
  type McpToolSummary,
  type WorkflowDefinition,
  type WorkflowDefinitionStatus,
  type WorkflowExecutionPorts,
  type WorkflowNode,
  type WorkflowRunnerInitialStepState,
  type WorkflowRunMode,
  type WorkflowRunStatus,
} from "@openacme/workflows";
import {
  createDbHostedIntegrationService,
  createFileHostedIntegrationService,
  HostedIntegrationExampleSchema,
  FamilyManifestSchema,
  HostedIntegrationPythonRuntime,
  HostedIntegrationHostedToolBindingSchema,
  HostedIntegrationToolHelpRequestSchema,
  HostedToolContractDocumentSchema,
  buildHostedIntegrationFocusedSourceView,
  buildHostedIntegrationGenerationDiff,
  evaluateHostedIntegrationPolicy,
  evaluateHostedIntegrationPromotionApproval,
  generationFilesRoot,
  isHostedIntegrationToolVisibleForSelection,
  hostedToolContractToToolSpecs,
  listFilesUnderRoot,
  parseHostedToolName,
  readTextFileUnderRoot,
  resolveAgentHostedToolBindingReadiness,
  resolveDebugReadiness,
  resolveEnvironmentConfigReadiness,
  resolveInvocationReadiness,
  resolvePublishReadiness,
  resolveHostedIntegrationExecutionConfig,
  resolveHostedIntegrationToolHelp,
  type FamilyManifest,
  type HostedIntegrationDraft,
  type HostedIntegrationExample,
  type HostedIntegrationFailureBucketRecordedEvent,
  type HostedIntegrationGatewayError,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
  type HostedIntegrationHostedToolBinding,
  type HostedIntegrationRegistryRefreshEvent,
  type HostedIntegrationService,
  type HostedIntegrationToolSpec,
  JsonObjectSchema,
} from "@openacme/hosted-integrations";
import {
  bindHostedToolHelp,
  bindHostedToolManagement,
  bindWorkflowManagement,
  HostedIntegrationToolRegistryAdapter,
  HOSTED_TOOL_HELP_TOOL_NAME,
  registry as toolRegistry,
  type HostedIntegrationRegistrySnapshot,
  type HostedToolManagementRequest,
  type HostedIntegrationToolInvokeRequest,
  type HostedToolHelpRequest,
  type WorkflowManagementRequest,
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
import {
  dispatchDueScheduledWorkflowTriggers as dispatchDueScheduledWorkflowTriggersForRuntime,
  type DispatchDueScheduledWorkflowTriggersOptions,
} from "./workflow-scheduler.js";
import { validateHostedIntegrationRegressionClose } from "./hosted-integration-regression.js";
import {
  cancelWorkflowRun,
  executeWorkflowRun,
  getRunDetail,
  validateAuthoringDefinition,
  workflowCreateCandidate,
  workflowUpdateCandidate,
  type WorkflowCreateBody,
  type WorkflowUpdateBody,
} from "./routes/workflows.js";

const log = createLogger("server.workflow-runtime");
const DEFAULT_WORKFLOW_DISPATCHER_INTERVAL_MS = 60_000;
const HOSTED_INTEGRATION_DELETE_DRAIN_POLL_MS = 1_000;
const HOSTED_INTEGRATION_REPAIR_AGENT_ID = "tool-developer";
const HOSTED_INTEGRATION_REPAIR_TASK_CREATOR = "system:hosted-integrations";
const HOSTED_INTEGRATION_REPAIR_MARKER_PREFIX =
  "openacme:hosted-integration-repair-bucket=";

interface WorkflowToolValidationIssue {
  severity?: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
  reference?: string;
  issue?: unknown;
}

export interface ServerRuntimeOptions {
  resolveModel?: ModelResolver;
  tickIntervalMs?: number;
  workflowExecutionPorts?: WorkflowExecutionPorts;
  workflowDispatcherIntervalMs?: number;
  workflowDispatcherNow?: () => Date;
  hostedIntegrationService?: HostedIntegrationService;
  hostedIntegrationPersistenceBackend?: "file" | "db";
}

export class ServerRuntime {
  readonly agentManager: AgentManager;
  readonly workflowManager: WorkflowManager;
  readonly workflowStore: WorkflowStore;
  readonly workflowAgentRuntime: WorkflowAgentRuntime;
  readonly workflowMcpRuntime: WorkflowMcpRuntime;
  readonly workflowPythonRuntime: WorkflowPythonRuntime;
  readonly workflowExecutionPorts: WorkflowExecutionPorts;
  readonly workflowRunAbortControllers = new Map<string, AbortController>();
  readonly hostedIntegrationService: HostedIntegrationService;
  readonly hostedIntegrationPersistenceBackend: "file" | "db";
  readonly hostedIntegrationToolRegistry: HostedIntegrationToolRegistryAdapter;
  private readonly dataDir: string;
  private readonly workflowDb: ReturnType<typeof createDatabase>;
  private readonly workflowDispatcherIntervalMs: number;
  private readonly workflowDispatcherNow: () => Date;
  private workflowDispatcherTimer: NodeJS.Timeout | null = null;
  private workflowDispatcherTickInFlight: Promise<void> | null = null;
  private readonly hostedIntegrationDeleteDrainPolls = new Set<string>();

  constructor(config: Config, opts?: ServerRuntimeOptions) {
    this.dataDir = config.dataDir;
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
    if (opts?.hostedIntegrationService) {
      this.hostedIntegrationService = opts.hostedIntegrationService;
      this.hostedIntegrationPersistenceBackend =
        opts.hostedIntegrationPersistenceBackend ?? "file";
    } else {
      const hostedIntegrationRuntime = createHostedIntegrationServiceForRuntime(
        config,
        {
          onRegistryRefresh: (event) =>
            this.refreshHostedIntegrationRegistry(event),
          onFailureBucketRecorded: (event) =>
            this.createHostedIntegrationRepairTask(event),
        },
      );
      this.hostedIntegrationService = hostedIntegrationRuntime.service;
      this.hostedIntegrationPersistenceBackend =
        hostedIntegrationRuntime.backend;
    }
    bindHostedToolManagement({
      invoke: (request) => this.invokeHostedToolManagement(request),
    });
    bindHostedToolHelp({
      invoke: (request) => this.invokeHostedToolHelp(request),
    });
    bindWorkflowManagement({
      invoke: (request) => this.invokeWorkflowManagement(request),
    });
    this.workflowExecutionPorts = {
      agent: this.workflowAgentRuntime,
      mcp: this.workflowMcpRuntime,
      hosted: {
        listTools: () => this.listWorkflowHostedTools(),
        callTool: (request) => this.callWorkflowHostedTool(request),
      },
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
      environment: binding.binding.defaultEnvironment,
      args: args.data,
      hostedToolBindings: [binding.binding],
      generationId: request.generationId,
    });
    if (!result.ok) {
      return this.hostedIntegrationToolFailure(
        request,
        hostedIntegrationCallerVisibleError(result.error),
        result.runId,
      );
    }
    return JSON.stringify(result);
  }

  private hostedIntegrationBindingForTool(
    request: HostedIntegrationToolInvokeRequest,
  ):
    | { ok: true; binding: HostedIntegrationHostedToolBinding }
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
    if (!def.tools.includes(request.canonicalToolName)) {
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

    const parsed = HostedIntegrationHostedToolBindingSchema.safeParse({
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
    runId?: string,
  ): string {
    return JSON.stringify({
      ok: false,
      error,
      ...(runId ? { runId, errorArtifactRef: `${runId}/error.json` } : {}),
      familyId: request.familyId,
      toolName: request.toolName,
      canonicalToolName: request.canonicalToolName,
      generationId: request.generationId,
    });
  }

  private async invokeHostedToolHelp(
    request: HostedToolHelpRequest,
  ): Promise<unknown> {
    const def = this.agentManager.getAgentDef(request.actorId);
    if (!def || !def.tools.includes(HOSTED_TOOL_HELP_TOOL_NAME)) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "agent cannot use hosted tool help",
        },
      };
    }

    const parsedRequest = HostedIntegrationToolHelpRequestSchema.parse(
      request.params,
    );
    const parsedName = parseHostedToolName(parsedRequest.tool_name);
    if (!parsedName) {
      return {
        ok: false,
        error: {
          code: "bad_arguments",
          message:
            "tool_name must be a hosted tool name like hosted_<family>__<tool>",
        },
      };
    }

    const binding = this.hostedIntegrationBindingForTool({
      actorId: request.actorId,
      familyId: parsedName.familyId,
      canonicalToolName: parsedRequest.tool_name,
      toolName: parsedName.toolName,
      generationId: "active",
      args: {},
    });
    if (!binding.ok) {
      return {
        ok: false,
        error: binding.error,
      };
    }

    const result = await resolveHostedIntegrationToolHelp({
      dataDir: this.dataDir,
      generations: this.hostedIntegrationService.generations,
      hostedToolName: parsedRequest.tool_name,
      familyId: parsedName.familyId,
      toolName: parsedName.toolName,
      request: {
        tool_detail: parsedRequest.tool_detail,
        include_examples: parsedRequest.include_examples,
        parameters: parsedRequest.parameters,
      },
    });
    return result.ok
      ? { ok: true, help: result.help }
      : { ok: false, error: result.error };
  }

  private async createHostedIntegrationRepairTask(
    event: HostedIntegrationFailureBucketRecordedEvent,
  ): Promise<void> {
    const { bucket, log } = event;
    if (bucket.status !== "open") return;
    if (!bucket.assignedTo) {
      await this.hostedIntegrationService.failureBuckets.assignBucket({
        bucketId: bucket.id,
        assignedTo: HOSTED_INTEGRATION_REPAIR_AGENT_ID,
      });
    }

    const marker = `${HOSTED_INTEGRATION_REPAIR_MARKER_PREFIX}${bucket.id}`;
    const existing = this.agentManager.taskStore
      .list({ assignee: HOSTED_INTEGRATION_REPAIR_AGENT_ID })
      .find(
        (task) =>
          task.body.includes(marker) &&
          task.status !== "done" &&
          task.status !== "canceled",
      );
    if (existing) return;

    await this.agentManager.taskStore.create({
      title: `Repair hosted integration ${bucket.familyId}/${bucket.toolName}`,
      assignee: HOSTED_INTEGRATION_REPAIR_AGENT_ID,
      created_by: HOSTED_INTEGRATION_REPAIR_TASK_CREATOR,
      body: buildHostedIntegrationRepairTaskBody({ event, marker }),
    });
  }

  private async invokeHostedToolManagement(
    request: HostedToolManagementRequest,
  ): Promise<unknown> {
    const denied = this.hostedToolManagementDenied(request);
    if (denied) return denied;
    const p = request.params;
    switch (request.operation) {
      case "hosted_tool_family_list":
        return {
          ok: true,
          families: await this.hostedIntegrationService.listFamilies(),
        };
      case "hosted_tool_family_create": {
        const result =
          await this.hostedIntegrationService.proposedFamilies.createProposedFamily(
            {
              familyId: stringParam(p, "family_id"),
              name: stringParam(p, "name"),
              toolName: nativeHostedIntegrationToolNameParam(p, "tool_name"),
              lockedBy: request.actorId,
              ttlMs: positiveIntegerParam(p, "ttl_ms") ?? 30 * 60 * 1000,
            },
          );
        return result.ok
          ? {
              ok: true,
              family: result.family,
              lock: result.lock,
              draft: result.draft,
              sourceRevisionId: result.sourceRevisionId,
            }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_tool_family_import":
        return this.hostedIntegrationService.packages.importPackage({
          mode: hostedFamilyPackageImportModeParam(p, "mode"),
          packageDocument: p.package_document,
          importedBy: request.actorId,
          targetFamilyId:
            optionalStringParam(p, "target_family_id") ?? undefined,
          lockId: optionalStringParam(p, "lock_id") ?? undefined,
          ttlMs: positiveIntegerParam(p, "ttl_ms") ?? undefined,
          sourceRevisionId:
            optionalStringParam(p, "source_revision_id") ?? undefined,
        });
      case "hosted_tool_family_export":
        return this.hostedIntegrationService.packages.exportPackage({
          source: hostedFamilyPackageExportSourceParam(p.source),
          exportedBy: request.actorId,
          includeExamples:
            typeof p.include_examples === "boolean"
              ? p.include_examples
              : undefined,
        });
      case "hosted_tool_source_read":
        return this.readHostedIntegrationSource(p);
      case "hosted_tool_source_view":
        return this.readHostedIntegrationSourceView(p);
      case "hosted_tool_lock_acquire": {
        const result = await this.hostedIntegrationService.locks.acquireLock({
          familyId: stringParam(p, "family_id"),
          lockedBy: request.actorId,
          ttlMs: positiveIntegerParam(p, "ttl_ms") ?? 30 * 60 * 1000,
        });
        return result.ok
          ? { ok: true, lock: result.lock }
          : { ok: false, error: { code: result.reason }, lock: result.lock };
      }
      case "hosted_tool_lock_renew": {
        const result = await this.hostedIntegrationService.locks.renewLock({
          lockId: stringParam(p, "lock_id"),
          lockedBy: request.actorId,
          ttlMs: positiveIntegerParam(p, "ttl_ms") ?? 30 * 60 * 1000,
        });
        if (result.ok) return { ok: true, lock: result.lock };
        return {
          ok: false,
          error: { code: result.reason },
          ...("lock" in result ? { lock: result.lock } : {}),
        };
      }
      case "hosted_tool_lock_release": {
        const result = await this.hostedIntegrationService.locks.releaseLock({
          lockId: stringParam(p, "lock_id"),
          lockedBy: request.actorId,
        });
        if (result.ok) return { ok: true };
        return {
          ok: false,
          error: { code: result.reason },
          ...("lock" in result ? { lock: result.lock } : {}),
        };
      }
      case "hosted_tool_draft_create": {
        const familyId = stringParam(p, "family_id");
        const result = await this.hostedIntegrationService.drafts.createDraft({
          familyId,
          lockId: stringParam(p, "lock_id"),
          sourceRevisionId:
            optionalStringParam(p, "source_revision_id") ??
            (await this.hostedIntegrationService.sourceFiles.getCurrentSourceRevisionId(
              familyId,
            )) ??
            "source_current",
        });
        return result.ok
          ? { ok: true, draft: result.draft }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_tool_draft_get":
        return this.readHostedIntegrationDraft(p);
      case "hosted_tool_draft_patch": {
        const patch = await this.applyHostedIntegrationDraftPatch(p);
        if (!patch.ok) return patch;
        const result =
          await this.hostedIntegrationService.drafts.writeDraftFile({
            draftId: stringParam(p, "draft_id"),
            lockId: stringParam(p, "lock_id"),
            path: stringParam(p, "path"),
            content: patch.content,
          });
        return result.ok
          ? { ok: true, mode: patch.mode }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_tool_draft_delete": {
        const result =
          await this.hostedIntegrationService.drafts.deleteDraftFile({
            draftId: stringParam(p, "draft_id"),
            lockId: stringParam(p, "lock_id"),
            path: stringParam(p, "path"),
          });
        return result.ok
          ? { ok: true }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_tool_example_list":
        return {
          ok: true,
          examples: await this.hostedIntegrationService.examples.listExamples(
            stringParam(p, "draft_id"),
          ),
        };
      case "hosted_tool_example_upsert": {
        const result =
          await this.hostedIntegrationService.examples.upsertExample({
            draftId: stringParam(p, "draft_id"),
            lockId: stringParam(p, "lock_id"),
            example: HostedIntegrationExampleSchema.parse(p.example),
          });
        return result.ok
          ? { ok: true }
          : {
              ok: false,
              error: {
                code: result.reason,
                ...("message" in result ? { message: result.message } : {}),
              },
            };
      }
      case "hosted_tool_example_run":
        return this.runHostedIntegrationDraftExample(request);
      case "hosted_tool_validate":
        return this.hostedIntegrationService.validator.validateDraft(
          stringParam(p, "draft_id"),
        );
      case "hosted_tool_promote":
        return this.promoteHostedIntegrationDraft(request);
      case "hosted_tool_generation_list":
        return {
          ok: true,
          generations:
            await this.hostedIntegrationService.generations.listGenerations({
              familyId: optionalStringParam(p, "family_id") ?? undefined,
            }),
        };
      case "hosted_tool_generation_get": {
        const generation =
          await this.hostedIntegrationService.generations.getGeneration(
            stringParam(p, "generation_id"),
          );
        return generation
          ? { ok: true, generation }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_tool_generation_diff":
        return this.diffHostedIntegrationGenerations(p);
      case "hosted_tool_generation_rollback": {
        const generation =
          await this.hostedIntegrationService.generations.getGeneration(
            stringParam(p, "generation_id"),
          );
        if (!generation) return { ok: false, error: { code: "not_found" } };
        const result = await this.hostedIntegrationService.generations.rollback(
          {
            familyId: generation.familyId,
            generationId: generation.id,
            rolledBackBy: request.actorId,
          },
        );
        return result.ok
          ? { ok: true, activeGeneration: result.activeGeneration }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_tool_environment_config_list":
        return {
          ok: true,
          environmentConfigs:
            await this.hostedIntegrationService.environmentConfigs.listEnvironmentConfigs(),
        };
      case "hosted_tool_environment_config_get": {
        const environmentConfig =
          await this.hostedIntegrationService.environmentConfigs.getEnvironmentConfig(
            stringParam(p, "family_id"),
            stringParam(p, "environment"),
          );
        return environmentConfig
          ? { ok: true, environmentConfig }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_tool_readiness_get":
        return this.readHostedIntegrationReadiness(request);
      case "hosted_tool_debug_run":
        return this.invokeHostedIntegrationDebugRun(request);
      case "hosted_tool_run_get": {
        const run =
          await this.hostedIntegrationService.gateway.executionLogs.getRunLog(
            stringParam(p, "run_id"),
          );
        return run
          ? { ok: true, run }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_tool_artifact_get": {
        const runId = stringParam(p, "run_id");
        const run =
          await this.hostedIntegrationService.gateway.executionLogs.getRunLog(
            runId,
          );
        if (!run) return { ok: false, error: { code: "not_found" } };
        const content =
          await this.hostedIntegrationService.artifacts.readArtifact({
            familyId: run.familyId,
            runId,
            name: stringParam(p, "name"),
          });
        return { ok: true, runId, name: stringParam(p, "name"), content };
      }
      case "hosted_tool_failure_bucket_list": {
        const familyId = optionalStringParam(p, "family_id");
        const buckets =
          await this.hostedIntegrationService.failureBuckets.listBuckets();
        return {
          ok: true,
          buckets: familyId
            ? buckets.filter((bucket) => bucket.familyId === familyId)
            : buckets,
        };
      }
      case "hosted_tool_failure_bucket_get": {
        const bucket =
          await this.hostedIntegrationService.failureBuckets.getBucket(
            stringParam(p, "bucket_id"),
          );
        return bucket
          ? { ok: true, bucket }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_tool_failure_bucket_assign": {
        const result =
          await this.hostedIntegrationService.failureBuckets.assignBucket({
            bucketId: stringParam(p, "bucket_id"),
            assignedTo: stringParam(p, "assigned_to"),
          });
        return result.ok
          ? { ok: true, bucket: result.bucket }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_tool_failure_bucket_close":
        return this.closeHostedIntegrationFailureBucket(request);
      default:
        return {
          ok: false,
          error: {
            code: "not_implemented",
            message:
              "This hosted integration management operation is registered but awaits its owning control-plane slice.",
          },
        };
    }
  }

  private hostedToolManagementDenied(
    request: HostedToolManagementRequest,
  ): { ok: false; error: { code: string; message: string } } | null {
    if (request.actorId === "web-settings") return null;
    const def = this.agentManager.getAgentDef(request.actorId);
    if (!def || !def.tools.includes(request.toolName)) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "agent cannot manage hosted integrations",
        },
      };
    }
    return null;
  }

  private async invokeWorkflowManagement(
    request: WorkflowManagementRequest,
  ): Promise<unknown> {
    const denied = this.workflowManagementDenied(request);
    if (denied) return denied;
    const p = request.params;
    try {
      switch (request.operation) {
        case "workflow_help":
          return this.resolveWorkflowHelp(p);
        case "workflow_help_upsert":
          return this.upsertWorkflowHelp(request.actorId, p);
        case "workflow_tool_inventory":
          return {
            ok: true,
            tools: (await this.workflowExecutionPorts.mcp?.listTools?.()) ?? [],
            hostedTools:
              (await this.workflowExecutionPorts.hosted?.listTools?.()) ?? [],
          };
        case "workflow_agent_inventory":
          return {
            ok: true,
            agents: this.workflowExecutionPorts.agent?.listAgents() ?? [],
          };
        case "workflow_validate":
          return this.validateWorkflowManagementTarget(p);
        case "workflow_list":
          return {
            ok: true,
            workflows: this.workflowStore.listDefinitions({
              ...(optionalStringParam(p, "status")
                ? { status: workflowDefinitionStatusParam(p, "status") }
                : {}),
              ...(positiveIntegerParam(p, "limit")
                ? { limit: positiveIntegerParam(p, "limit")! }
                : {}),
            }),
          };
        case "workflow_get": {
          const workflow = this.workflowStore.getDefinition(
            stringParam(p, "workflow_id"),
          );
          return workflow
            ? { ok: true, workflow }
            : { ok: false, error: { code: "not_found" } };
        }
        case "workflow_create": {
          const candidate = workflowCreateCandidate(workflowCreateBodyParam(p));
          const validation =
            await this.validateWorkflowDefinitionForTools(candidate);
          if (!validation.ok) return validation;
          const workflow = this.workflowStore.createDraft(
            workflowCreateBodyParam(p),
          );
          return { ok: true, workflow };
        }
        case "workflow_update": {
          const workflowId = stringParam(p, "workflow_id");
          const current = this.workflowStore.getDefinition(workflowId);
          if (!current) return { ok: false, error: { code: "not_found" } };
          const patch = workflowUpdateBodyParam(p);
          const candidate = workflowUpdateCandidate(current, patch);
          const validation =
            await this.validateWorkflowDefinitionForTools(candidate);
          if (!validation.ok) return validation;
          const workflow = this.workflowStore.updateDraft(workflowId, patch);
          return { ok: true, workflow };
        }
        case "workflow_delete":
          return {
            ok: true,
            workflow: this.workflowStore.archiveDefinition(
              stringParam(p, "workflow_id"),
            ),
          };
        case "workflow_publish": {
          const workflowId = stringParam(p, "workflow_id");
          const current = this.workflowStore.getDefinition(workflowId);
          if (!current) return { ok: false, error: { code: "not_found" } };
          const validation =
            await this.validateWorkflowDefinitionForTools(current);
          if (!validation.ok) return validation;
          const promotionGate = this.validateWorkflowPublishGate(current);
          if (!promotionGate.ok) return promotionGate;
          return { ok: true, workflow: this.workflowStore.publish(workflowId) };
        }
        case "workflow_export": {
          const workflow = this.workflowStore.getDefinition(
            stringParam(p, "workflow_id"),
          );
          if (!workflow) return { ok: false, error: { code: "not_found" } };
          return {
            ok: true,
            package: {
              format: "openacme.workflow.definition.v1",
              exportedAt: new Date().toISOString(),
              workflow: {
                id: workflow.id,
                version: workflow.version,
                status: workflow.status,
                name: workflow.name,
                ...(workflow.description
                  ? { description: workflow.description }
                  : {}),
                ...(workflow.inputSchema !== undefined
                  ? { inputSchema: workflow.inputSchema }
                  : {}),
                ...(workflow.outputSchema !== undefined
                  ? { outputSchema: workflow.outputSchema }
                  : {}),
                triggers: workflow.triggers,
                nodes: workflow.nodes,
                ...(workflow.ui ? { ui: workflow.ui } : {}),
              },
            },
          };
        }
        case "workflow_import": {
          const body = workflowImportPackageParam(p.package_document);
          const candidate = workflowCreateCandidate(body);
          const validation =
            await this.validateWorkflowDefinitionForTools(candidate);
          if (!validation.ok) return validation;
          return { ok: true, workflow: this.workflowStore.createDraft(body) };
        }
        case "workflow_callable_list": {
          return {
            ok: true,
            workflows: this.workflowStore
              .listDefinitions({
                status: "published",
                limit:
                  typeof p.limit === "number"
                    ? Math.min(Math.max(Math.trunc(p.limit), 1), 500)
                    : 100,
              })
              .map(workflowCallableSummary),
          };
        }
        case "workflow_callable_get": {
          const workflow = this.workflowStore.getDefinition(
            stringParam(p, "workflow_id"),
          );
          if (!workflow) return { ok: false, error: { code: "not_found" } };
          if (workflow.status !== "published") {
            return { ok: false, error: { code: "not_published" } };
          }
          return { ok: true, workflow: workflowCallableSummary(workflow) };
        }
        case "workflow_run": {
          const workflowId = stringParam(p, "workflow_id");
          const current = this.workflowStore.getDefinition(workflowId);
          if (!current) return { ok: false, error: { code: "not_found" } };
          if (current.status !== "published") {
            return { ok: false, error: { code: "not_published" } };
          }
          const definition = this.workflowStore.getVersion(
            workflowId,
            current.version,
          );
          if (!definition) {
            return {
              ok: false,
              error: { code: "published_version_not_found" },
            };
          }
          const requestedTriggerId =
            optionalStringParam(p, "trigger_id") ?? undefined;
          const trigger =
            (requestedTriggerId
              ? definition.triggers.find((item) => item.id === requestedTriggerId)
              : definition.triggers.find(
                  (item) => item.kind === "manual",
                )) ?? null;
          if (!trigger || trigger.kind !== "manual") {
            return {
              ok: false,
              error: {
                code: "trigger_not_runnable",
                message:
                  "workflow_run requires an enabled manual trigger on a published workflow",
              },
            };
          }
          const input = jsonParam(p, "input") ?? {};
          const detail = await executeWorkflowRun(this.workflowStore, {
            definition,
            mode: "live",
            definitionSource: "published",
            input,
            trigger: {
              kind: "manual",
              triggerId: trigger.id,
              requestedBy: request.actorId,
              input,
            },
            ports: this.workflowExecutionPorts,
            runAbortControllers: this.workflowRunAbortControllers,
            waitForCompletion: p.async !== true,
          });
          const summary = getRunDetail(this.workflowStore, detail.run.id, {
            detail: "summary",
          });
          const output = (detail as { output?: unknown }).output;
          return {
            ok: true,
            ...(summary ?? detail),
            ...(output === undefined ? {} : { output }),
          };
        }
        case "workflow_card_test_run":
          return this.runWorkflowCardTest(p);
        case "workflow_test_run": {
          const workflow = this.workflowStore.getDefinition(
            stringParam(p, "workflow_id"),
          );
          if (!workflow) return { ok: false, error: { code: "not_found" } };
          const validation =
            await this.validateWorkflowDefinitionForTools(workflow);
          if (!validation.ok) return validation;
          const input = jsonParam(p, "input") ?? {};
          const assertions = workflowTestAssertionsParam(p, "assertions");
          const draftHash = workflowDefinitionHash(workflow);
          const stopAfterStepId =
            optionalStringParam(p, "stop_after_step_id") ?? undefined;
          const detail = await executeWorkflowRun(this.workflowStore, {
            definition: workflow,
            mode: "test",
            definitionSource: "draft",
            input,
            trigger: {
              kind: "manual",
              triggerId: "manual",
              input,
              draftHash,
              ...(stopAfterStepId ? { stopAfterStepId } : {}),
              ...(assertions ? { testAssertions: assertions } : {}),
            },
            ports: this.workflowExecutionPorts,
            runAbortControllers: this.workflowRunAbortControllers,
            waitForCompletion: p.async !== true,
            stopAfterStepId,
          });
          const response = {
            ok: true,
            ...detail,
            draftHash,
          };
          if (!assertions) return response;
          if (workflowRunDetailIsTerminal(detail)) {
            return {
              ...response,
              assertionResults: evaluateWorkflowTestAssertions(
                detail,
                assertions,
              ),
            };
          }
          return {
            ...response,
            acceptedAssertions: assertions,
          };
        }
        case "workflow_run_list":
          return {
            ok: true,
            ...this.workflowStore.listRunsPage({
              ...(optionalStringParam(p, "workflow_id")
                ? { workflowId: optionalStringParam(p, "workflow_id")! }
                : {}),
              ...(optionalStringParam(p, "mode")
                ? { mode: workflowRunModeParam(p, "mode") }
                : {}),
              ...(optionalStringParam(p, "status")
                ? { status: workflowRunStatusParam(p, "status") }
                : {}),
              ...(optionalStringParam(p, "trigger_id")
                ? { triggerId: optionalStringParam(p, "trigger_id")! }
                : {}),
              ...(optionalStringParam(p, "created_from")
                ? { createdFrom: optionalStringParam(p, "created_from")! }
                : {}),
              ...(optionalStringParam(p, "created_to")
                ? { createdTo: optionalStringParam(p, "created_to")! }
                : {}),
              ...(positiveIntegerParam(p, "limit")
                ? { limit: positiveIntegerParam(p, "limit")! }
                : {}),
              ...(nonNegativeIntegerParam(p, "offset") !== null
                ? { offset: nonNegativeIntegerParam(p, "offset")! }
                : {}),
            }),
          };
        case "workflow_run_get": {
          const runId = stringParam(p, "run_id");
          const detail = getRunDetail(
            this.workflowStore,
            runId,
            {
              detail:
                optionalStringParam(p, "detail") === null
                  ? "summary"
                  : workflowRunDetailModeParam(p, "detail"),
              stepId: optionalStringParam(p, "step_id"),
              include: workflowRunStepIncludeParam(p, "include"),
            },
          );
          if (!detail) return { ok: false, error: { code: "not_found" } };
          return {
            ok: true,
            ...detail,
            ...this.workflowRunAssertionResponse(runId, detail),
          };
        }
        case "workflow_run_cancel":
          return {
            ok: true,
            ...cancelWorkflowRun(
              this.workflowStore,
              stringParam(p, "run_id"),
              this.workflowRunAbortControllers,
            ),
          };
        case "workflow_run_rerun": {
          const previous = this.workflowStore.getRun(stringParam(p, "run_id"));
          if (!previous) return { ok: false, error: { code: "not_found" } };
          const definition =
            previous.definitionSource === "published"
              ? this.workflowStore.getVersion(
                  previous.workflowId,
                  previous.workflowVersion,
                )
              : this.workflowStore.getDefinition(previous.workflowId);
          if (!definition) {
            return {
              ok: false,
              error: { code: "workflow_definition_not_found" },
            };
          }
          const detail = await executeWorkflowRun(this.workflowStore, {
            definition,
            mode: previous.mode,
            definitionSource: previous.definitionSource,
            input: previous.input,
            trigger: previous.trigger,
            ports: this.workflowExecutionPorts,
            runAbortControllers: this.workflowRunAbortControllers,
          });
          return { ok: true, ...detail };
        }
        case "workflow_artifact_get": {
          const runId = stringParam(p, "run_id");
          if (!this.workflowStore.getRun(runId)) {
            return { ok: false, error: { code: "not_found" } };
          }
          const artifact = this.workflowStore.readArtifactContent(
            runId,
            stringParam(p, "artifact_id"),
          );
          return artifact
            ? { ok: true, ...artifact }
            : { ok: false, error: { code: "artifact_not_found" } };
        }
        default:
          return {
            ok: false,
            error: {
              code: "not_implemented",
              message: "This workflow management operation is not implemented.",
            },
          };
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "runtime_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private workflowManagementDenied(
    request: WorkflowManagementRequest,
  ): { ok: false; error: { code: string; message: string } } | null {
    if (request.actorId === "web-settings") return null;
    const def = this.agentManager.getAgentDef(request.actorId);
    if (!def || !def.tools.includes(request.toolName)) {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "agent cannot manage workflows",
        },
      };
    }
    return null;
  }

  private workflowRunAssertionResponse(
    runId: string,
    detail: unknown,
  ): Record<string, unknown> {
    const assertions = workflowAssertionsFromRunDetail(detail);
    if (!assertions) return {};
    if (!workflowRunDetailIsTerminal(detail)) {
      return { acceptedAssertions: assertions };
    }
    const fullDetail = getRunDetail(this.workflowStore, runId, {
      detail: "full",
    });
    return {
      assertionResults: evaluateWorkflowTestAssertions(
        fullDetail ?? detail,
        assertions,
      ),
    };
  }

  private validateWorkflowPublishGate(
    definition: WorkflowDefinition,
  ):
    | { ok: true; draftHash: string; runId: string }
    | {
        ok: false;
        error: { code: string; message: string };
        issues: WorkflowToolValidationIssue[];
      } {
    const draftHash = workflowDefinitionHash(definition);
    const runs = this.workflowStore.listRunsPage({
      workflowId: definition.id,
      mode: "test",
      status: "succeeded",
      limit: 500,
    }).runs;
    const fullCurrentDraftRun = runs.find((run) => {
      if (run.trigger.kind !== "manual") return false;
      if (run.trigger.draftHash !== draftHash) return false;
      return !run.trigger.stopAfterStepId;
    });
    if (fullCurrentDraftRun) {
      return {
        ok: true,
        draftHash,
        runId: fullCurrentDraftRun.id,
      };
    }
    return {
      ok: false,
      error: {
        code: "publish_gate_failed",
        message:
          "Workflow publish requires a successful full test run for the current draft",
      },
      issues: [
        {
          code: "missing_successful_current_draft_test",
          path: "$.runs",
          message:
            "Run workflow_test_run without stop_after_step_id after the latest draft change before publishing",
        },
      ],
    };
  }

  private async resolveWorkflowHelp(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const target = workflowHelpTargetParam(params);
    const detail = workflowHelpDetailParam(params);
    const includeExamples = params.include_examples === true;
    const persisted = await this.readWorkflowHelpEntry(target);
    if (target.kind === "overview") {
      const overlay = persisted?.help;
      return {
        ok: true,
        target,
        detail,
        summary:
          overlay?.summary ??
          "Discover workflow cards, validate drafts, test individual cards, run full workflows, inspect evidence, and publish only after validation.",
        ...(overlay?.whenToUse ? { whenToUse: overlay.whenToUse } : {}),
        ...(overlay?.whenNotToUse
          ? { whenNotToUse: overlay.whenNotToUse }
          : {}),
        recommendedLoop: [
          "workflow_help",
          "workflow_card_catalog",
          "workflow_validate",
          "workflow_card_test_run",
          "workflow_test_run",
          "workflow_run_get",
          "workflow_publish",
        ],
        ...(detail === "full"
          ? {
              full:
                overlay?.full ??
                "Use workflow_help before unfamiliar cards or references. Prefer deterministic cards before agent.call, validate before save/publish, run card-level tests for risky configs, run full or stop-after workflow tests, inspect summaries first, then drill into one step with workflow_run_get(detail:'step').",
            }
          : {}),
        ...(includeExamples
          ? {
              examples: overlay?.examples ?? [
                {
                  tool: "workflow_run_get",
                  args: {
                    run_id: "run_123",
                    detail: "step",
                    step_id: "normalize_asset",
                    include: ["input", "output", "logs"],
                  },
                },
              ],
            }
          : {}),
      };
    }
    if (target.kind === "card_type") {
      return workflowCardTypeHelp(target.card_type, {
        detail,
        includeExamples,
        parameters: workflowHelpParameterRequests(params),
        persistedHelp: persisted?.help,
      });
    }
    return workflowStaticHelp(target, {
      detail,
      includeExamples,
      persistedHelp: persisted?.help,
    });
  }

  private async upsertWorkflowHelp(
    actorId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (actorId !== "web-settings" && actorId !== "workflow-engineer") {
      return {
        ok: false,
        error: {
          code: "policy_denied",
          message: "agent cannot update workflow help",
        },
      };
    }
    const target = workflowHelpTargetParam(params);
    const help = workflowHelpValueParam(params.help);
    const store = await this.readWorkflowHelpStore();
    const key = workflowHelpTargetKey(target);
    const updatedAt = new Date().toISOString();
    store.entries[key] = {
      target: normalizeWorkflowHelpTarget(target),
      help,
      updatedBy: actorId,
      updatedAt,
    };
    await this.writeWorkflowHelpStore(store);
    return {
      ok: true,
      target: normalizeWorkflowHelpTarget(target),
      help,
      updatedBy: actorId,
      updatedAt,
    };
  }

  private async readWorkflowHelpEntry(
    target: WorkflowHelpTarget,
  ): Promise<WorkflowHelpStoreEntry | null> {
    const store = await this.readWorkflowHelpStore();
    return store.entries[workflowHelpTargetKey(target)] ?? null;
  }

  private async readWorkflowHelpStore(): Promise<WorkflowHelpStore> {
    try {
      const raw = await readFile(this.workflowHelpStorePath(), "utf8");
      return workflowHelpStoreFromUnknown(JSON.parse(raw));
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  private async writeWorkflowHelpStore(store: WorkflowHelpStore): Promise<void> {
    const filePath = this.workflowHelpStorePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  private workflowHelpStorePath(): string {
    return path.join(this.dataDir, "workflow-help.json");
  }

  private async runWorkflowCardTest(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const mode = stringParam(params, "mode");
    const now = new Date().toISOString();
    let sourceWorkflowId: string | undefined;
    let sourceRunId: string | undefined;
    let node: WorkflowNode;
    let input: JsonValue = jsonParam(params, "input") ?? {};
    let initialContext = jsonObjectParam(params, "context") ?? {};
    let initialSteps: Record<string, WorkflowRunnerInitialStepState> = {};

    if (mode === "candidate") {
      const parsed = WorkflowNodeSchema.safeParse(params.node);
      if (!parsed.success) {
        return invalidWorkflowDefinitionResult(parsed.error.issues);
      }
      node = parsed.data;
    } else if (mode === "from_workflow") {
      sourceWorkflowId = stringParam(params, "workflow_id");
      const workflow = this.workflowStore.getDefinition(sourceWorkflowId);
      if (!workflow) return { ok: false, error: { code: "not_found" } };
      const found = workflow.nodes.find(
        (candidate) => candidate.id === stringParam(params, "step_id"),
      );
      if (!found) {
        return { ok: false, error: { code: "step_not_found" } };
      }
      node = found;
    } else if (mode === "from_run") {
      sourceRunId = stringParam(params, "run_id");
      const previous = this.workflowStore.getRun(sourceRunId);
      if (!previous) return { ok: false, error: { code: "not_found" } };
      sourceWorkflowId = previous.workflowId;
      const definition =
        previous.definitionSnapshot ??
        (previous.definitionSource === "published"
          ? this.workflowStore.getVersion(
              previous.workflowId,
              previous.workflowVersion,
            )
          : this.workflowStore.getDefinition(previous.workflowId));
      if (!definition) {
        return {
          ok: false,
          error: { code: "workflow_definition_not_found" },
        };
      }
      const stepId = stringParam(params, "step_id");
      const found = definition.nodes.find((candidate) => candidate.id === stepId);
      if (!found) {
        return { ok: false, error: { code: "step_not_found" } };
      }
      node = found;
      input = jsonParam(params, "input") ?? previous.input;
      initialContext = jsonObjectParam(params, "context") ?? jsonObject(previous.context);
      initialSteps = workflowInitialStepsFromRun(
        this.workflowStore.listStepAttempts(sourceRunId),
      );
    } else {
      return {
        ok: false,
        error: {
          code: "bad_arguments",
          message:
            "workflow_card_test_run mode must be candidate, from_workflow, or from_run",
        },
      };
    }

    const syntheticDefinition: WorkflowDefinition = {
      id: `card_test_${safeWorkflowId(node.id)}`,
      version: 1,
      status: "draft",
      name: `Card test: ${node.label ?? node.id}`,
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [singleCardTestNode(node)],
      createdAt: now,
      updatedAt: now,
    };
    const detail = await executeWorkflowRun(this.workflowStore, {
      definition: syntheticDefinition,
      mode: "test",
      definitionSource: "draft",
      input,
      trigger: {
        kind: "manual",
        triggerId: "card_test",
        input,
      },
      ports: this.workflowExecutionPorts,
      runAbortControllers: this.workflowRunAbortControllers,
      waitForCompletion: true,
      initialContext,
      initialSteps,
    });
    const summary = getRunDetail(this.workflowStore, detail.run.id, {
      detail: "summary",
    });
    return {
      ok: true,
      ...(summary ?? detail),
      cardTest: {
        mode,
        stepId: node.id,
        ...(sourceWorkflowId ? { sourceWorkflowId } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
      },
    };
  }

  private async validateWorkflowManagementTarget(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const mode = stringParam(params, "mode");
    if (mode === "saved") {
      const workflowId = stringParam(params, "workflow_id");
      const workflow = this.workflowStore.getDefinition(workflowId);
      if (!workflow) return { ok: false, error: { code: "not_found" } };
      return this.validateWorkflowDefinitionForTools(workflow);
    }
    if (mode === "definition") {
      const parsed = parseWorkflowDefinitionForToolValidation(
        params.definition,
      );
      if (!parsed.ok) return parsed;
      return this.validateWorkflowDefinitionForTools(parsed.definition);
    }
    if (mode === "candidate") {
      const parsed = parseWorkflowCreateCandidateForToolValidation(
        params.candidate,
      );
      if (!parsed.ok) return parsed;
      return this.validateWorkflowDefinitionForTools(parsed.definition);
    }
    return {
      ok: false,
      error: {
        code: "bad_arguments",
        message:
          "workflow_validate mode must be one of saved, definition, or candidate",
      },
    };
  }

  private async validateWorkflowDefinitionForTools(
    definition: WorkflowDefinition,
  ): Promise<
    | { ok: true; issues: []; warnings: WorkflowToolValidationIssue[] }
    | {
        ok: false;
        error: { code: string; message: string };
        issues: WorkflowToolValidationIssue[];
        warnings: WorkflowToolValidationIssue[];
      }
  > {
    const warnings = collectWorkflowAuthoringWarnings(definition);
    const authoring = validateAuthoringDefinition(definition);
    if (!authoring.ok) {
      return {
        ok: false,
        error: { code: "validation_failed", message: authoring.message },
        issues: authoring.issues.map((issue) => ({
          severity: "error",
          code: "validation_failed",
          message: issue.message,
          issue,
        })),
        warnings,
      };
    }

    const issues = [
      ...collectWorkflowCardConfigSchemaIssues(definition),
      ...collectWorkflowReferenceExpressionIssues(definition),
      ...collectWorkflowOutputCoverageIssues(definition),
      ...collectWorkflowRouteScopeIssues(definition),
      ...(await this.collectWorkflowExternalReferenceIssues(definition)),
    ];
    if (issues.length > 0) {
      return {
        ok: false,
        error: { code: issues[0]!.code, message: issues[0]!.message },
        issues: issues.map((issue) => ({ severity: "error", ...issue })),
        warnings,
      };
    }

    return { ok: true, issues: [], warnings };
  }

  private async collectWorkflowExternalReferenceIssues(
    definition: WorkflowDefinition,
  ): Promise<WorkflowToolValidationIssue[]> {
    const issues: WorkflowToolValidationIssue[] = [];
    const mcpNodes = definition.nodes.filter(
      (node) => node.type === "mcp.tool",
    );
    if (mcpNodes.length > 0) {
      const listTools = this.workflowExecutionPorts.mcp?.listTools;
      if (!listTools) {
        issues.push({
          code: "mcp_inventory_unavailable",
          message: "MCP workflow tool inventory is unavailable",
        });
      } else {
        const tools = await listTools.call(this.workflowExecutionPorts.mcp);
        const known = new Set(
          tools.map((tool) => workflowMcpToolKey(tool.server, tool.tool)),
        );
        for (const node of mcpNodes) {
          const key = workflowMcpToolKey(node.server, node.tool);
          if (!known.has(key)) {
            issues.push({
              code: "unknown_mcp_tool",
              nodeId: node.id,
              message: `Unknown MCP workflow tool: ${node.server}/${node.tool}`,
            });
          }
        }
      }
    }

    const agentNodes = definition.nodes.filter(
      (node) => node.type === "agent.call",
    );
    if (agentNodes.length > 0) {
      const agents = this.workflowExecutionPorts.agent?.listAgents() ?? [];
      const known = new Set(agents.map((agent) => agent.id));
      for (const node of agentNodes) {
        if (!known.has(node.agentId)) {
          issues.push({
            code: "unknown_agent",
            nodeId: node.id,
            message: `Unknown workflow agent: ${node.agentId}`,
          });
        }
      }
    }

    const hostedNodes = definition.nodes.filter(
      (node) => node.type === "hosted.tool",
    );
    if (hostedNodes.length > 0) {
      const listTools = this.workflowExecutionPorts.hosted?.listTools;
      if (!listTools) {
        issues.push({
          code: "hosted_inventory_unavailable",
          message: "Hosted workflow tool inventory is unavailable",
        });
      } else {
        const tools = await listTools.call(this.workflowExecutionPorts.hosted);
        const known = new Set(tools.map((tool) => tool.name));
        for (const node of hostedNodes) {
          if (!known.has(node.toolName)) {
            issues.push({
              code: "unknown_hosted_tool",
              nodeId: node.id,
              message: `Unknown hosted workflow tool: ${node.toolName}`,
            });
          }
        }
      }
    }

    return issues;
  }

  private async listWorkflowHostedTools(): Promise<HostedToolSummary[]> {
    const tools: HostedToolSummary[] = [];
    for (const name of toolRegistry.getAllToolNames()) {
      const entry = toolRegistry.get(name);
      if (entry?.source?.kind !== "hosted_integration") continue;
      tools.push({
        name: entry.name,
        familyId: entry.source.familyId,
        familyName: entry.source.familyName,
        toolName: entry.source.toolName,
        generationId: entry.source.generationId,
        description: entry.description,
        inputSchema: z.toJSONSchema(entry.parameters, {
          target: "draft-07",
        }),
        outputSchema: entry.outputSchema,
        annotations: entry.annotations,
      });
    }
    return tools.sort((a, b) =>
      a.familyId === b.familyId
        ? a.toolName.localeCompare(b.toolName)
        : a.familyId.localeCompare(b.familyId),
    );
  }

  private async callWorkflowHostedTool(
    request: HostedToolCallRequest,
  ): Promise<HostedToolCallResult> {
    const entry = toolRegistry.get(request.toolName);
    if (entry?.source?.kind !== "hosted_integration") {
      throw new Error(`Unknown hosted workflow tool: ${request.toolName}`);
    }
    const parts = parseHostedToolName(request.toolName);
    if (!parts) {
      throw new Error(`Invalid hosted workflow tool name: ${request.toolName}`);
    }
    const input = JsonObjectSchema.parse(request.input ?? {});
    const raw = await rejectWorkflowHostedToolOnAbortOrTimeout(
      this.invokeWorkflowHostedIntegrationTool({
        actorId: request.actorId ?? "workflow-runtime",
        familyId: entry.source.familyId,
        canonicalToolName: entry.name,
        toolName: entry.source.toolName,
        generationId: entry.source.generationId,
        args: input,
      }),
      request.signal,
      request.timeoutMs,
    );
    const output = parseWorkflowHostedToolOutput(raw);
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      output["ok"] === false &&
      output["error"] &&
      typeof output["error"] === "object"
    ) {
      const message =
        typeof (output["error"] as Record<string, unknown>)["message"] ===
        "string"
          ? String((output["error"] as Record<string, unknown>)["message"])
          : `Hosted workflow tool failed: ${request.toolName}`;
      throw new Error(message);
    }
    return { output };
  }

  private async invokeWorkflowHostedIntegrationTool(
    request: HostedIntegrationToolInvokeRequest,
  ): Promise<string> {
    const args = JsonObjectSchema.safeParse(request.args);
    if (!args.success) {
      return this.hostedIntegrationToolFailure(request, {
        code: "policy_denied",
        message: "hosted integration tool arguments must be a JSON object",
      });
    }
    const now = new Date().toISOString();
    const parsed = HostedIntegrationHostedToolBindingSchema.safeParse({
      agentId: request.actorId,
      familyId: request.familyId,
      toolName: request.toolName,
      allowedEnvironments: ["prod"],
      defaultEnvironment: "prod",
      generationPin: request.generationId
        ? { type: "generation", generationId: request.generationId }
        : { type: "current" },
      bindingKind: "internal",
      purpose: "workflow hosted tool card execution",
      bindingNote:
        "Internal workflow execution binding generated from hosted tool inventory.",
      updatedAt: now,
      updatedBy: "workflow-runtime",
    });
    if (!parsed.success) {
      return this.hostedIntegrationToolFailure(request, {
        code: "policy_denied",
        message: "workflow hosted integration binding is invalid",
      });
    }

    const result = await this.hostedIntegrationService.gateway.invoke({
      actor: { id: request.actorId, kind: "agent", roles: ["agent"] },
      familyId: request.familyId,
      toolName: request.toolName,
      environment: parsed.data.defaultEnvironment,
      args: args.data,
      hostedToolBindings: [parsed.data],
      generationId: request.generationId,
    });
    if (!result.ok) {
      return this.hostedIntegrationToolFailure(
        request,
        hostedIntegrationCallerVisibleError(result.error),
        result.runId,
      );
    }
    return JSON.stringify(result);
  }

  private async readHostedIntegrationSource(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const draftId = optionalStringParam(params, "draft_id");
    const filePath = optionalStringParam(params, "path");
    if (draftId) {
      if (filePath) {
        const result = await this.hostedIntegrationService.drafts.readDraftFile(
          {
            draftId,
            path: filePath,
          },
        );
        return result.ok
          ? {
              ok: true,
              path: filePath,
              ...sourceContentWindow(result.content, params),
            }
          : { ok: false, error: { code: result.reason } };
      }
      return this.readHostedIntegrationDraft({ draft_id: draftId });
    }

    const familyId = stringParam(params, "family_id");
    if (filePath) {
      const result =
        await this.hostedIntegrationService.sourceFiles.readSourceFile({
          familyId,
          path: filePath,
        });
      return result.ok
        ? {
            ok: true,
            path: filePath,
            ...sourceContentWindow(result.content, params),
          }
        : { ok: false, error: { code: result.reason } };
    }
    const family = await this.hostedIntegrationService.getFamily(familyId);
    const listed =
      await this.hostedIntegrationService.sourceFiles.listSourceFiles(familyId);
    return {
      ok: family !== null && listed.ok,
      family,
      files: listed.ok ? listed.files : [],
      ...(!listed.ok ? { error: { code: listed.reason } } : {}),
    };
  }

  private async readHostedIntegrationDraft(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const draftId = stringParam(params, "draft_id");
    const filePath = optionalStringParam(params, "path");
    if (filePath) {
      const result = await this.hostedIntegrationService.drafts.readDraftFile({
        draftId,
        path: filePath,
      });
      return result.ok
        ? {
            ok: true,
            path: filePath,
            ...sourceContentWindow(result.content, params),
          }
        : { ok: false, error: { code: result.reason } };
    }
    const draft = await this.hostedIntegrationService.drafts.getDraft(draftId);
    if (!draft) return { ok: false, error: { code: "not_found" } };
    const files =
      await this.hostedIntegrationService.drafts.listDraftFiles(draftId);
    return {
      ok: true,
      draft,
      files: files.ok ? files.files : [],
    };
  }

  private async readHostedIntegrationSourceView(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const familyId = stringParam(params, "family_id");
    const toolName = nativeHostedIntegrationToolNameParam(params, "tool_name");
    const draftId = optionalStringParam(params, "draft_id");
    const generationId = optionalStringParam(params, "generation_id");
    const sourceTarget = draftId
      ? await this.readDraftSourceViewTarget(draftId, familyId)
      : await this.readGenerationSourceViewTarget(familyId, generationId);
    if (!sourceTarget.ok) {
      return { ok: false, error: { code: sourceTarget.reason } };
    }

    const view = await buildHostedIntegrationFocusedSourceView({
      familyId,
      generationId: sourceTarget.generationId,
      manifest: sourceTarget.manifest,
      tools: sourceTarget.tools,
      entrypointPath: sourceTarget.manifest.runtime.entrypoint,
      source: sourceTarget.source,
      toolName,
      options: {
        includeSharedHelpers: params.include_shared_helpers === true,
        includeHooks: params.include_hooks === true,
        includeAllTools: params.include_all_tools === true,
        helperDepthLimit:
          positiveIntegerParam(params, "helper_depth_limit") ?? undefined,
        maxHelperSnippets:
          positiveIntegerParam(params, "max_helper_snippets") ?? undefined,
        maxSourceChars:
          positiveIntegerParam(params, "max_source_chars") ?? undefined,
      },
    });
    return { ok: true, view };
  }

  private async readDraftSourceViewTarget(
    draftId: string,
    familyId: string,
  ): Promise<
    | {
        ok: true;
        generationId: string;
        manifest: FamilyManifest;
        tools: HostedIntegrationToolSpec[];
        source: string;
      }
    | { ok: false; reason: string }
  > {
    const draft = await this.hostedIntegrationService.drafts.getDraft(draftId);
    if (!draft) return { ok: false, reason: "not_found" };
    if (draft.familyId !== familyId) return { ok: false, reason: "not_found" };
    const manifest = await this.readHostedIntegrationDraftManifest(draftId);
    const tools = await this.readHostedIntegrationDraftTools(draftId);
    const source = await this.hostedIntegrationService.drafts.readDraftFile({
      draftId,
      path: manifest.runtime.entrypoint,
    });
    if (!source.ok) return { ok: false, reason: source.reason };
    return {
      ok: true,
      generationId: `draft:${draft.id}`,
      manifest,
      tools,
      source: source.content,
    };
  }

  private async readGenerationSourceViewTarget(
    familyId: string,
    generationId: string | null,
  ): Promise<
    | {
        ok: true;
        generationId: string;
        manifest: FamilyManifest;
        tools: HostedIntegrationToolSpec[];
        source: string;
      }
    | { ok: false; reason: string }
  > {
    const generation = generationId
      ? await this.hostedIntegrationService.generations.getGeneration(
          generationId,
        )
      : await this.hostedIntegrationService.generations.getActiveGeneration(
          familyId,
        );
    if (!generation) {
      return {
        ok: false,
        reason: generationId ? "generation_not_found" : "no_active_generation",
      };
    }
    if (generation.familyId !== familyId) {
      return { ok: false, reason: "generation_not_found" };
    }

    const filesRoot = generationFilesRoot(this.dataDir, generation.id);
    try {
      const manifest = FamilyManifestSchema.parse(
        parseYaml(
          await readTextFileUnderRoot(
            filesRoot,
            "family.yaml",
            "generation files root",
          ),
        ),
      );
      const tools = hostedToolContractToToolSpecs(
        HostedToolContractDocumentSchema.parse(
          parseYaml(
            await readTextFileUnderRoot(
              filesRoot,
              "tools.yaml",
              "generation files root",
            ),
          ),
        ),
      );
      return {
        ok: true,
        generationId: generation.id,
        manifest,
        tools,
        source: await readTextFileUnderRoot(
          filesRoot,
          manifest.runtime.entrypoint,
          "generation files root",
        ),
      };
    } catch {
      return { ok: false, reason: "source_not_found" };
    }
  }

  private async diffHostedIntegrationGenerations(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const base = await this.readGenerationDiffSnapshot(
      stringParam(params, "base_generation_id"),
    );
    if (!base.ok) return { ok: false, error: { code: base.reason } };
    const compare = await this.readGenerationDiffSnapshot(
      stringParam(params, "compare_generation_id"),
    );
    if (!compare.ok) return { ok: false, error: { code: compare.reason } };
    return buildHostedIntegrationGenerationDiff({
      base: base.snapshot,
      compare: compare.snapshot,
      options: {
        mode:
          (optionalStringParam(params, "mode") as
            | "summary"
            | "unified"
            | "manifest"
            | "tool_focused"
            | null) ?? "summary",
        path: optionalStringParam(params, "path") ?? undefined,
        toolName: optionalStringParam(params, "tool_name") ?? undefined,
        includeSharedHelpers: params.include_shared_helpers === true,
        includeHooks: params.include_hooks === true,
      },
    });
  }

  private async readGenerationDiffSnapshot(generationId: string): Promise<
    | {
        ok: true;
        snapshot: {
          generationId: string;
          familyId: string;
          files: Record<string, string>;
        };
      }
    | { ok: false; reason: string }
  > {
    const generation =
      await this.hostedIntegrationService.generations.getGeneration(
        generationId,
      );
    if (!generation) return { ok: false, reason: "generation_not_found" };
    const filesRoot = generationFilesRoot(this.dataDir, generation.id);
    try {
      const files: Record<string, string> = {};
      const listed = await listFilesUnderRoot(filesRoot);
      for (const file of listed) {
        files[file.path] = await readTextFileUnderRoot(
          filesRoot,
          file.path,
          "generation files root",
        );
      }
      return {
        ok: true,
        snapshot: {
          generationId: generation.id,
          familyId: generation.familyId,
          files,
        },
      };
    } catch {
      return { ok: false, reason: "source_not_found" };
    }
  }

  private async applyHostedIntegrationDraftPatch(
    params: Record<string, unknown>,
  ): Promise<
    | {
        ok: true;
        mode: "replace_file" | "replace_text" | "insert_after";
        content: string;
      }
    | { ok: false; error: { code: string; message: string } }
  > {
    const mode =
      optionalStringParam(params, "mode") ??
      (hasOwn(params, "content") ? "replace_file" : null);
    if (mode === "replace_file") {
      return { ok: true, mode, content: stringParam(params, "content") };
    }
    if (mode !== "replace_text" && mode !== "insert_after") {
      return {
        ok: false,
        error: {
          code: "bad_arguments",
          message:
            "mode must be replace_file, replace_text, or insert_after; replace_file requires content.",
        },
      };
    }

    const current = await this.hostedIntegrationService.drafts.readDraftFile({
      draftId: stringParam(params, "draft_id"),
      path: stringParam(params, "path"),
    });
    if (!current.ok) {
      return {
        ok: false,
        error: {
          code: current.reason,
          message: "draft file could not be read before patching",
        },
      };
    }

    if (mode === "replace_text") {
      const oldText = stringParam(params, "old_text");
      const newText = stringParam(params, "new_text");
      const first = current.content.indexOf(oldText);
      if (first === -1) {
        return {
          ok: false,
          error: {
            code: "old_text_not_found",
            message: "old_text was not found in the draft file",
          },
        };
      }
      if (current.content.indexOf(oldText, first + oldText.length) !== -1) {
        return {
          ok: false,
          error: {
            code: "old_text_not_unique",
            message:
              "old_text matched more than once; provide a larger unique block",
          },
        };
      }
      return {
        ok: true,
        mode,
        content:
          current.content.slice(0, first) +
          newText +
          current.content.slice(first + oldText.length),
      };
    }

    const anchorText = stringParam(params, "anchor_text");
    const insertText = stringParam(params, "insert_text");
    const first = current.content.indexOf(anchorText);
    if (first === -1) {
      return {
        ok: false,
        error: {
          code: "anchor_text_not_found",
          message: "anchor_text was not found in the draft file",
        },
      };
    }
    if (current.content.indexOf(anchorText, first + anchorText.length) !== -1) {
      return {
        ok: false,
        error: {
          code: "anchor_text_not_unique",
          message:
            "anchor_text matched more than once; provide a larger unique block",
        },
      };
    }
    return {
      ok: true,
      mode,
      content:
        current.content.slice(0, first + anchorText.length) +
        insertText +
        current.content.slice(first + anchorText.length),
    };
  }

  private async invokeHostedIntegrationDebugRun(
    request: HostedToolManagementRequest,
  ): Promise<unknown> {
    const p = request.params;
    const operationClass = optionalStringParam(p, "operation_class") ?? "read";
    if (operationClass !== "read" && p.allow_writes !== true) {
      return { ok: false, error: { code: "approval_required" } };
    }
    const familyId = stringParam(p, "family_id");
    const toolName = nativeHostedIntegrationToolNameParam(p, "tool_name");
    const environment = optionalStringParam(p, "environment") ?? "test_debug";
    return this.hostedIntegrationService.gateway.invoke({
      actor: { id: request.actorId, kind: "agent", roles: ["tool_developer"] },
      familyId,
      toolName,
      environment,
      args: JsonObjectSchema.parse(p.args ?? {}),
      hostedToolBindings: [
        {
          agentId: request.actorId,
          familyId,
          toolName,
          allowedEnvironments: [environment as "prod" | "test_debug"],
          defaultEnvironment: environment as "prod" | "test_debug",
          generationPin: optionalStringParam(p, "generation_id")
            ? {
                type: "generation",
                generationId: stringParam(p, "generation_id"),
              }
            : { type: "current" },
          bindingKind: "internal",
          purpose: "debug",
          updatedAt: new Date().toISOString(),
          updatedBy: request.actorId,
        },
      ],
      invocationPurpose: "tool_maintenance",
      executionPurpose: "debug",
      generationId: optionalStringParam(p, "generation_id") ?? undefined,
    });
  }

  private async readHostedIntegrationReadiness(
    request: HostedToolManagementRequest,
  ): Promise<unknown> {
    const p = request.params;
    const targetType = stringParam(p, "target_type");
    switch (targetType) {
      case "environment_config": {
        const readiness = await this.environmentConfigReadiness(
          stringParam(p, "family_id"),
          stringParam(p, "environment"),
        );
        return { ok: true, readiness };
      }
      case "binding": {
        const agentId = stringParam(p, "agent_id");
        const familyId = stringParam(p, "family_id");
        const toolName = nativeHostedIntegrationToolNameParam(p, "tool_name");
        const def = this.agentManager.getAgentDef(agentId);
        const activeGeneration =
          await this.hostedIntegrationService.generations.getActiveGeneration(
            familyId,
          );
        return {
          ok: true,
          readiness: resolveAgentHostedToolBindingReadiness({
            agentId,
            familyId,
            toolName,
            hostedToolBindings: (def?.hostedIntegrationBindings ?? []).map(
              (binding) => ({ agentId, ...binding }),
            ),
            activeGenerationId: activeGeneration?.id,
          }),
        };
      }
      case "publish": {
        const draftId = stringParam(p, "draft_id");
        const draft =
          await this.hostedIntegrationService.drafts.getDraft(draftId);
        const validation = draft
          ? await this.hostedIntegrationService.validator.validateDraft(draftId)
          : null;
        return {
          ok: true,
          readiness: resolvePublishReadiness({
            draftId,
            draftExists: draft !== null,
            validation,
            runtimeConfigContract: { status: "empty" },
          }),
        };
      }
      case "debug": {
        const familyId = stringParam(p, "family_id");
        const toolName = nativeHostedIntegrationToolNameParam(p, "tool_name");
        const environment =
          optionalStringParam(p, "environment") ?? "test_debug";
        const family = await this.hostedIntegrationService.getFamily(familyId);
        const tool = family?.tools.find(
          (candidate) => candidate.name === toolName,
        );
        const activeGeneration =
          await this.hostedIntegrationService.generations.getActiveGeneration(
            familyId,
          );
        const environmentConfig =
          await this.hostedIntegrationService.environmentConfigs.getEnvironmentConfig(
            familyId,
            environment,
          );
        const executionConfig = resolveHostedIntegrationExecutionConfig({
          familyId,
          environment: environment === "prod" ? "prod" : "test_debug",
          generation: {
            runtimeConfig: activeGeneration?.runtimeConfig,
          },
          policyDecision: {
            ok: true,
            resolvedEnvironment: environment === "prod" ? "prod" : "test_debug",
          },
          environmentConfig,
          executionPurpose: "debug",
        });
        const readiness = resolveDebugReadiness({
          actor: {
            id: request.actorId,
            kind: "agent",
            roles: ["tool_developer"],
          },
          familyId,
          toolName,
          environment,
          allowProdEnvironment: p.allow_prod_environment === true,
          operation: tool?.classification.operation ?? "read",
          environmentReadiness: executionConfig.ok
            ? executionConfig.readiness
            : executionConfig.error,
        });
        return { ok: true, readiness };
      }
      case "invocation": {
        const agentId = stringParam(p, "agent_id");
        const familyId = stringParam(p, "family_id");
        const toolName = nativeHostedIntegrationToolNameParam(p, "tool_name");
        const def = this.agentManager.getAgentDef(agentId);
        const family = await this.hostedIntegrationService.getFamily(familyId);
        const tool = family?.tools.find(
          (candidate) => candidate.name === toolName,
        );
        const bindings = (def?.hostedIntegrationBindings ?? []).map(
          (binding) => ({ agentId, ...binding }),
        );
        const policyDecision = evaluateHostedIntegrationPolicy({
          actor: { id: agentId, kind: "agent", roles: ["agent"] },
          action: "invoke",
          familyId,
          toolName,
          operationClass: tool?.classification.operation ?? "read",
          environment: "test_debug",
          mode: "run",
          toolClassification: tool?.classification,
          hostedToolBindings: bindings,
        });
        const environment =
          policyDecision.ok && policyDecision.resolvedEnvironment
            ? policyDecision.resolvedEnvironment
            : "test_debug";
        const activeGeneration =
          await this.hostedIntegrationService.generations.getActiveGeneration(
            familyId,
          );
        const environmentConfig =
          await this.hostedIntegrationService.environmentConfigs.getEnvironmentConfig(
            familyId,
            environment,
          );
        const executionConfig = resolveHostedIntegrationExecutionConfig({
          familyId,
          environment,
          generation: {
            runtimeConfig: activeGeneration?.runtimeConfig,
          },
          policyDecision,
          environmentConfig,
          executionPurpose: "consumer",
        });
        return {
          ok: true,
          readiness: resolveInvocationReadiness({
            actor: { id: agentId, kind: "agent", roles: ["agent"] },
            familyId,
            toolName,
            toolLifecycle: tool?.lifecycle,
            policyDecision,
            environmentReadiness: executionConfig.ok
              ? executionConfig.readiness
              : executionConfig.error,
            capturedGenerationId:
              optionalStringParam(p, "captured_generation_id") ?? undefined,
            resolvedGenerationId: activeGeneration?.id,
          }),
        };
      }
      default:
        return { ok: false, error: { code: "invalid_readiness_target" } };
    }
  }

  private async environmentConfigReadiness(
    familyId: string,
    environment: string,
  ) {
    const environmentConfig =
      await this.hostedIntegrationService.environmentConfigs.getEnvironmentConfig(
        familyId,
        environment,
      );
    return resolveEnvironmentConfigReadiness({
      familyId,
      environment,
      environmentConfig,
      requiredConfigKeys: environmentConfig
        ? Object.keys(environmentConfig.config)
        : [],
      requiredSecretKeys: environmentConfig
        ? Object.keys(environmentConfig.secrets)
        : [],
    });
  }

  private async closeHostedIntegrationFailureBucket(
    request: HostedToolManagementRequest,
  ): Promise<unknown> {
    const params = request.params;
    const bucket = await this.hostedIntegrationService.failureBuckets.getBucket(
      stringParam(params, "bucket_id"),
    );
    if (!bucket) return { ok: false, error: { code: "not_found" } };

    const regression = await validateHostedIntegrationRegressionClose({
      service: this.hostedIntegrationService,
      dataDir: this.dataDir,
      actorId: request.actorId,
      bucket,
      draftId: optionalStringParam(params, "draft_id"),
      generationId: optionalStringParam(params, "generation_id"),
      regressionExampleId: optionalStringParam(params, "regression_example_id"),
    });
    if (!regression.ok) {
      return {
        ok: false,
        error: { code: regression.code },
        ...(regression.runId ? { runId: regression.runId } : {}),
      };
    }

    const result =
      await this.hostedIntegrationService.failureBuckets.closeBucket({
        bucketId: bucket.id,
      });
    return result.ok
      ? { ok: true, bucket: result.bucket }
      : { ok: false, error: { code: result.reason } };
  }

  private async runHostedIntegrationDraftExample(
    request: HostedToolManagementRequest,
  ): Promise<unknown> {
    const p = request.params;
    const draftId = stringParam(p, "draft_id");
    const draft = await this.hostedIntegrationService.drafts.getDraft(draftId);
    if (!draft) return { ok: false, error: { code: "not_found" } };
    const exampleId = stringParam(p, "example_id");
    const examples =
      await this.hostedIntegrationService.examples.listExamples(draftId);
    const example = examples.find((candidate) => candidate.id === exampleId);
    if (!example) return { ok: false, error: { code: "not_found" } };
    const manifest = await this.readHostedIntegrationDraftManifest(draftId);
    const tools = await this.readHostedIntegrationDraftTools(draftId);
    const tool = tools.find((candidate) => candidate.name === example.toolName);
    if (!tool) return { ok: false, error: { code: "tool_not_found" } };
    if (example.category === "discovery_required") {
      return {
        ok: false,
        error: {
          code: "example_not_runnable",
          message:
            "discovery_required examples document prerequisite lookup and are not ready-to-send invocation payloads",
        },
      };
    }

    const draftGenerationId = `draft:${draft.id}`;
    const environmentConfig =
      await this.hostedIntegrationService.environmentConfigs.getEnvironmentConfig(
        draft.familyId,
        "test_debug",
      );
    const executionConfig = resolveHostedIntegrationExecutionConfig({
      familyId: draft.familyId,
      environment: "test_debug",
      generation: { runtimeConfig: manifest.runtimeConfig },
      policyDecision: { ok: true, resolvedEnvironment: "test_debug" },
      environmentConfig,
      executionPurpose: "example",
    });
    if (!executionConfig.ok) {
      return { ok: false, error: { code: executionConfig.error.code } };
    }
    const { run, familyHome, runDir } =
      await this.hostedIntegrationService.artifacts.createRun({
        familyId: draft.familyId,
        toolName: example.toolName,
        generationId: draftGenerationId,
        actorId: request.actorId,
        input: example.args,
      });
    await this.hostedIntegrationService.gateway.executionLogs.startLog({
      runId: run.id,
      familyId: draft.familyId,
      toolName: example.toolName,
      generationId: draftGenerationId,
      actorId: request.actorId,
      environmentConfigId: executionConfig.environmentConfigId ?? null,
      configRevision: executionConfig.configRevision ?? null,
      executionPurpose: executionConfig.executionPurpose,
      sanitizedArgs: JsonObjectSchema.parse(example.args),
      status: "running",
      startedAt: run.startedAt,
    });

    const filesRoot = path.join(runDir, "files");
    await this.copyHostedIntegrationDraftFiles(draftId, filesRoot);
    const runtimeResult = await new HostedIntegrationPythonRuntime().callTool({
      familyId: draft.familyId,
      generationId: draftGenerationId,
      filesRoot,
      runtime: manifest.runtime,
      timeoutMs: manifest.runtime.defaultTimeoutMs,
      toolName: example.toolName,
      args: JsonObjectSchema.parse(example.args),
      context: {
        familyId: draft.familyId,
        generationId: draftGenerationId,
        runId: run.id,
        familyHome,
        runDir,
        config: executionConfig.config,
        secrets: executionConfig.secretsEnvironmentConfigId
          ? await this.hostedIntegrationService.secrets.readSecretsForRuntime({
              environmentConfigId: executionConfig.secretsEnvironmentConfigId,
            })
          : {},
      },
    });
    if (!runtimeResult.ok) {
      const normalizedError = hostedIntegrationRuntimeError(
        runtimeResult.error,
      );
      const errorEnvelope =
        await this.hostedIntegrationService.artifacts.completeRunError({
          familyId: draft.familyId,
          runId: run.id,
          error: JsonObjectSchema.parse(normalizedError),
        });
      await this.hostedIntegrationService.gateway.executionLogs.finishLog(
        run.id,
        {
          status: "failed",
          endedAt: new Date().toISOString(),
          error: normalizedError,
        },
      );
      return { ok: false, runId: run.id, error: errorEnvelope.error };
    }

    const envelope =
      await this.hostedIntegrationService.artifacts.completeRunSuccess({
        familyId: draft.familyId,
        runId: run.id,
        result: runtimeResult.result,
        inlineResultTokenLimit: manifest.runtime.inlineResultTokenLimit,
      });
    await this.hostedIntegrationService.gateway.executionLogs.finishLog(
      run.id,
      {
        status: "succeeded",
        endedAt: new Date().toISOString(),
        resultEnvelopeRef: `${run.id}/output.json`,
      },
    );
    return { ok: true, runId: run.id, envelope };
  }

  private async promoteHostedIntegrationDraft(
    request: HostedToolManagementRequest,
  ): Promise<unknown> {
    const p = request.params;
    const draftId = stringParam(p, "draft_id");
    const draft = await this.hostedIntegrationService.drafts.getDraft(draftId);
    if (!draft) return { ok: false, error: { code: "not_found" } };
    const lockId = stringParam(p, "lock_id");
    if (!(await this.hasCurrentHostedIntegrationDraftLock(draft, lockId))) {
      return { ok: false, error: { code: "lock_required" } };
    }
    const validation =
      await this.hostedIntegrationService.validator.validateDraft(draftId);
    if (!validation.ok) {
      return { ok: false, error: { code: "validation_failed" }, validation };
    }
    const manifest = await this.readHostedIntegrationDraftManifest(draftId);
    const tools = await this.readHostedIntegrationDraftTools(draftId);
    const examples =
      await this.hostedIntegrationService.examples.listExamples(draftId);
    const missingExamples = missingHostedIntegrationExampleToolNames(
      tools,
      examples,
    );
    if (missingExamples.length > 0) {
      return {
        ok: false,
        error: {
          code: "missing_required_examples",
          toolNames: missingExamples,
        },
      };
    }

    const approvalId = optionalStringParam(p, "approval_id");
    let approval: HostedIntegrationHumanApprovalRecord | null = null;
    if (approvalId) {
      approval =
        await this.hostedIntegrationService.approvals.getApproval(approvalId);
    }
    const approvalDecision = evaluateHostedIntegrationPromotionApproval({
      actor: { id: request.actorId, kind: "agent" },
      target: hostedIntegrationPromotionTargetForDraft(draft, tools),
      approval,
    });
    if (!approvalDecision.ok) {
      return { ok: false, error: { code: approvalDecision.reason } };
    }

    const source =
      await this.hostedIntegrationService.sourceFiles.replaceSourceFiles({
        familyId: draft.familyId,
        files: await this.collectHostedIntegrationDraftFiles(draftId),
        updatedBy: request.actorId,
      });
    const promoted =
      await this.hostedIntegrationService.generations.promoteDraft({
        draftId,
        promotedBy: request.actorId,
        validation,
        draftRevisionId: draft.updatedAt,
        sourceRevisionId: source.sourceRevisionId,
        approval: approvalDecision.approval,
      });
    return promoted.ok
      ? {
          ok: true,
          generation: promoted.generation,
          sourceRevisionId: source.sourceRevisionId,
        }
      : { ok: false, error: { code: promoted.reason } };
  }

  private async hasCurrentHostedIntegrationDraftLock(
    draft: HostedIntegrationDraft,
    lockId: string,
  ): Promise<boolean> {
    if (draft.lockId !== lockId) return false;
    const lock = await this.hostedIntegrationService.locks.getActiveLock(
      draft.familyId,
    );
    return lock?.id === lockId;
  }

  private async readHostedIntegrationDraftManifest(
    draftId: string,
  ): Promise<FamilyManifest> {
    const manifestFile =
      await this.hostedIntegrationService.drafts.readDraftFile({
        draftId,
        path: "family.yaml",
      });
    if (!manifestFile.ok) throw new Error("family.yaml is required");
    return FamilyManifestSchema.parse(parseYaml(manifestFile.content));
  }

  private async readHostedIntegrationDraftTools(
    draftId: string,
  ): Promise<HostedIntegrationToolSpec[]> {
    const toolsFile = await this.hostedIntegrationService.drafts.readDraftFile({
      draftId,
      path: "tools.yaml",
    });
    if (!toolsFile.ok) throw new Error("tools.yaml is required");
    return hostedToolContractToToolSpecs(
      HostedToolContractDocumentSchema.parse(parseYaml(toolsFile.content)),
    );
  }

  private async collectHostedIntegrationDraftFiles(
    draftId: string,
  ): Promise<Record<string, string>> {
    const listed =
      await this.hostedIntegrationService.drafts.listDraftFiles(draftId);
    if (!listed.ok) throw new Error("draft files not found");
    const files: Record<string, string> = {};
    for (const file of listed.files) {
      const read = await this.hostedIntegrationService.drafts.readDraftFile({
        draftId,
        path: file.path,
      });
      if (!read.ok) throw new Error(`draft file ${file.path} not found`);
      files[file.path] = read.content;
    }
    return files;
  }

  private async copyHostedIntegrationDraftFiles(
    draftId: string,
    outputRoot: string,
  ): Promise<void> {
    const files = await this.collectHostedIntegrationDraftFiles(draftId);
    await mkdir(outputRoot, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const resolved = path.resolve(outputRoot, relPath);
      const relative = path.relative(outputRoot, resolved);
      if (
        relative === "" ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        throw new Error("path escapes draft runtime root");
      }
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
    }
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
    // Keep cached agent entries until the next turn. The global tool registry
    // generation lazily rebuilds them, and the old emitted-tool snapshot is how
    // open sessions produce session.tool_catalog.changed notices.
    if (event?.reason === "delete") {
      this.hostedIntegrationToolRegistry.removeFamily(event.familyId);
      return;
    }
    const generations = event
      ? [
          await this.hostedIntegrationService.generations.getGeneration(
            event.generationId,
          ),
        ]
      : await this.hostedIntegrationService.generations.listGenerations();
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
    }
  }

  scheduleHostedIntegrationDeleteFinalization(familyId: string): void {
    if (this.hostedIntegrationDeleteDrainPolls.has(familyId)) return;
    this.hostedIntegrationDeleteDrainPolls.add(familyId);
    this.pollHostedIntegrationDeleteFinalization(familyId);
  }

  private pollHostedIntegrationDeleteFinalization(familyId: string): void {
    const timer = setTimeout(async () => {
      try {
        const result = await this.hostedIntegrationService.deleteFamily({
          familyId,
          deletedBy: "system:delete-drain",
        });
        if (result.status === "delete_draining") {
          this.pollHostedIntegrationDeleteFinalization(familyId);
          return;
        }
      } catch (error) {
        log.warn(
          { err: error, familyId },
          "hosted integration delete finalization failed",
        );
        this.pollHostedIntegrationDeleteFinalization(familyId);
        return;
      }
      this.hostedIntegrationDeleteDrainPolls.delete(familyId);
    }, HOSTED_INTEGRATION_DELETE_DRAIN_POLL_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  private async hostedIntegrationRegistrySnapshot(
    generation: HostedIntegrationGeneration,
  ): Promise<HostedIntegrationRegistrySnapshot | null> {
    const family = await this.hostedIntegrationService.getFamily(
      generation.familyId,
    );
    if (!family) {
      this.hostedIntegrationToolRegistry.removeFamily(generation.familyId);
      log.warn(
        {
          familyId: generation.familyId,
          generationId: generation.id,
        },
        "skipping hosted integration registry sync for active generation without current source family",
      );
      return null;
    }
    const tools = generation.tools.filter(
      isHostedIntegrationToolVisibleForSelection,
    );
    if (tools.length === 0) {
      this.hostedIntegrationToolRegistry.removeFamily(generation.familyId);
      return null;
    }
    return {
      familyId: generation.familyId,
      familyName: family.summary.name,
      generationId: generation.id,
      runtimeConfig: generation.runtimeConfig,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: jsonSchemaToZod(tool.inputSchema),
        outputSchema: tool.outputSchema,
        annotations: tool.mcpAnnotations,
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

function buildHostedIntegrationRepairTaskBody(input: {
  event: HostedIntegrationFailureBucketRecordedEvent;
  marker: string;
}): string {
  const { bucket, log } = input.event;
  return [
    input.marker,
    "",
    "Repair the hosted integration failure bucket and add or link a regression example before closing it.",
    "",
    "```yaml",
    `bucket_id: ${bucket.id}`,
    `latest_run_ref: ${log.runId}`,
    `error_artifact_ref: ${log.runId}/error.json`,
    `family_id: ${bucket.familyId}`,
    `tool_name: ${bucket.toolName}`,
    `generation_id: ${bucket.generationId}`,
    `sanitized_error_category: ${log.error?.code ?? "unknown"}`,
    "```",
    "",
    "Sanitized args:",
    "```json",
    JSON.stringify(log.sanitizedArgs, null, 2),
    "```",
  ].join("\n");
}

function missingHostedIntegrationExampleToolNames(
  tools: HostedIntegrationToolSpec[],
  examples: HostedIntegrationExample[],
): string[] {
  const covered = new Set(examples.map((example) => example.toolName));
  return tools
    .map((tool) => tool.name)
    .filter((toolName) => !covered.has(toolName));
}

function hostedIntegrationPromotionTargetForDraft(
  draft: HostedIntegrationDraft,
  tools: HostedIntegrationToolSpec[],
) {
  const toolNames = tools.map((tool) => tool.name);
  const destructiveToolNames = tools
    .filter((tool) => tool.classification.operation === "destructive")
    .map((tool) => tool.name);
  return {
    familyId: draft.familyId,
    draftId: draft.id,
    draftRevisionId: draft.updatedAt,
    operation: "promote" as const,
    operationClass: hostedIntegrationOperationClassForTools(tools),
    toolNames,
    destructiveToolNames,
  };
}

function hostedIntegrationOperationClassForTools(
  tools: HostedIntegrationToolSpec[],
): "read" | "write" | "destructive" {
  if (tools.some((tool) => tool.classification.operation === "destructive")) {
    return "destructive";
  }
  if (tools.some((tool) => tool.classification.operation === "write")) {
    return "write";
  }
  return "read";
}

function hostedIntegrationRuntimeError(error: {
  code: HostedIntegrationGatewayError["code"];
  message: string;
  details?: HostedIntegrationGatewayError["details"];
}): HostedIntegrationGatewayError {
  return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function hostedIntegrationCallerVisibleError(
  error: HostedIntegrationGatewayError,
): { code: string; message: string } {
  if (error.code === "tool_bug" || error.code === "runtime_error") {
    return { code: "tool_failed", message: "tool failed" };
  }
  return {
    code: error.code,
    message: error.message,
  };
}

function sourceContentWindow(
  content: string,
  params: Record<string, unknown>,
): {
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
} {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const requestedStart = positiveIntegerParam(params, "start_line") ?? 1;
  const maxLines = positiveIntegerParam(params, "max_lines");
  if (maxLines === null && requestedStart === 1) {
    return {
      content,
      totalLines,
      startLine: 1,
      endLine: totalLines,
      truncated: false,
    };
  }
  const startLine = Math.min(requestedStart, Math.max(totalLines, 1));
  const startIndex = startLine - 1;
  const endExclusive =
    maxLines === null
      ? totalLines
      : Math.min(totalLines, startIndex + maxLines);
  return {
    content: lines.slice(startIndex, endExclusive).join("\n"),
    totalLines,
    startLine,
    endLine: endExclusive,
    truncated: startIndex > 0 || endExclusive < totalLines,
  };
}

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function nativeHostedIntegrationToolNameParam(
  params: Record<string, unknown>,
  name: string,
): string {
  const value = stringParam(params, name);
  if (parseHostedToolName(value)) {
    throw new Error(
      `${name} must be a family-native hosted tool name, not a canonical hosted registry name`,
    );
  }
  return value;
}

function optionalStringParam(
  params: Record<string, unknown>,
  name: string,
): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function hostedFamilyPackageImportModeParam(
  params: Record<string, unknown>,
  name: string,
): "create" | "update" {
  const value = stringParam(params, name);
  if (value !== "create" && value !== "update") {
    throw new Error(`${name} must be create or update`);
  }
  return value;
}

function hostedFamilyPackageExportSourceParam(
  value: unknown,
):
  | { type: "active_generation"; familyId: string }
  | { type: "generation"; generationId: string }
  | { type: "draft"; draftId: string }
  | { type: "current_source"; familyId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source is required");
  }
  const params = value as Record<string, unknown>;
  const sourceType = stringParam(params, "source_type");
  if (sourceType === "active_generation") {
    return { type: sourceType, familyId: stringParam(params, "family_id") };
  }
  if (sourceType === "generation") {
    return {
      type: sourceType,
      generationId: stringParam(params, "generation_id"),
    };
  }
  if (sourceType === "draft") {
    return { type: sourceType, draftId: stringParam(params, "draft_id") };
  }
  if (sourceType === "current_source") {
    return { type: sourceType, familyId: stringParam(params, "family_id") };
  }
  throw new Error(
    "source.source_type must be active_generation, generation, draft, or current_source",
  );
}

function positiveIntegerParam(
  params: Record<string, unknown>,
  name: string,
): number | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerParam(
  params: Record<string, unknown>,
  name: string,
): number | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function jsonParam(
  params: Record<string, unknown>,
  name: string,
): JsonValue | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  return JsonValueSchema.parse(value);
}

function jsonObjectParam(
  params: Record<string, unknown>,
  name: string,
): Record<string, JsonValue> | null {
  const value = jsonParam(params, name);
  if (value === null) return null;
  return jsonObject(value);
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("value must be a JSON object");
  }
  return value;
}

function workflowInitialStepsFromRun(
  steps: ReturnType<WorkflowStore["listStepAttempts"]>,
): Record<string, WorkflowRunnerInitialStepState> {
  const initialSteps: Record<string, WorkflowRunnerInitialStepState> = {};
  for (const step of steps) {
    initialSteps[step.nodeId] = {
      ...(step.input !== undefined ? { input: step.input } : {}),
      ...(step.output !== undefined ? { output: step.output } : {}),
      ...(step.error !== undefined ? { error: step.error } : {}),
      status: step.status,
    };
  }
  return initialSteps;
}

function singleCardTestNode(node: WorkflowNode): WorkflowNode {
  const copy = cloneJsonValue(node) as WorkflowNode;
  copy.next = [];
  if (copy.type === "builtin.if" || copy.type === "builtin.if_else") {
    copy.then = [];
    copy.else = [];
  } else if (copy.type === "builtin.switch") {
    copy.cases = copy.cases.map((item) => ({ ...item, nodes: [] }));
    copy.default = [];
  } else if (copy.type === "builtin.foreach") {
    copy.body = [];
  } else if (copy.type === "builtin.parallel") {
    copy.branches = copy.branches.map((branch) => ({ ...branch, nodes: [] }));
  }
  return WorkflowNodeSchema.parse(copy);
}

function safeWorkflowId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z0-9]/.test(normalized)
    ? normalized
    : `step_${normalized}`;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const WORKFLOW_NODE_CATALOG_CONFIG_EXCLUDED_KEYS = new Set([
  "id",
  "type",
  "label",
  "next",
  "then",
  "else",
  "body",
  "default",
  "ui",
]);

function collectWorkflowCardConfigSchemaIssues(
  definition: WorkflowDefinition,
): WorkflowToolValidationIssue[] {
  const catalog = new Map<
    string,
    ReturnType<typeof getWorkflowCardCatalog>[number]
  >(
    getWorkflowCardCatalog().map((card) => [card.type, card]),
  );
  const issues: WorkflowToolValidationIssue[] = [];
  for (const node of definition.nodes) {
    const card = catalog.get(node.type);
    if (!card) continue;
    const path = `$.nodes.${node.id}`;
    const config = workflowNodeCatalogConfig(node);
    const validation = validateWorkflowJsonSchemaValue(
      card.configSchema,
      config,
      path,
    );
    if (validation.ok) continue;
    issues.push({
      code: "invalid_card_config",
      nodeId: node.id,
      path: validation.issue.path,
      message: `${card.type} config invalid: ${validation.message}`,
    });
  }
  return issues;
}

function workflowNodeCatalogConfig(node: WorkflowNode): JsonValue {
  const source = node as unknown as Record<string, unknown>;
  const config: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (WORKFLOW_NODE_CATALOG_CONFIG_EXCLUDED_KEYS.has(key)) continue;
    if (key === "cases" && Array.isArray(value)) {
      config[key] = value.map((item) =>
        stripWorkflowRouteKeysFromRecord(item),
      ) as JsonValue;
      continue;
    }
    if (key === "branches" && Array.isArray(value)) {
      config[key] = value.map((item) =>
        stripWorkflowRouteKeysFromRecord(item),
      ) as JsonValue;
      continue;
    }
    config[key] = value as JsonValue;
  }
  return config;
}

function stripWorkflowRouteKeysFromRecord(value: unknown): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value as JsonValue;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "nodes") continue;
    output[key] = child as JsonValue;
  }
  return output;
}

function collectWorkflowReferenceExpressionIssues(
  definition: WorkflowDefinition,
): WorkflowToolValidationIssue[] {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const issues: WorkflowToolValidationIssue[] = [];
  for (const node of definition.nodes) {
    const references = workflowReferencesInValue(node, `$.nodes.${node.id}`);
    for (const item of references) {
      const issue = validateWorkflowReference(item.reference, nodeIds);
      if (!issue) continue;
      issues.push({
        code: "invalid_reference",
        nodeId: node.id,
        path: item.path,
        reference: item.reference,
        message: issue,
      });
    }
  }
  return issues;
}

function collectWorkflowOutputCoverageIssues(
  definition: WorkflowDefinition,
): WorkflowToolValidationIssue[] {
  if (definition.outputSchema === undefined) return [];
  const outputNodes = definition.nodes.filter(
    (node) => node.type === "builtin.output.set",
  );
  if (outputNodes.length === 0) {
    return [
      {
        code: "missing_output_card",
        path: "$.outputSchema",
        message:
          "Workflow declares outputSchema but has no builtin.output.set card",
      },
    ];
  }
  const required = requiredOutputSchemaFields(definition.outputSchema);
  if (required.length === 0) return [];
  const covered = new Set(outputNodes.map((node) => node.path.split(".")[0]));
  const missing = required.filter((field) => !covered.has(field));
  return missing.map((field) => ({
    code: "missing_output_field",
    path: `$.outputSchema.required.${field}`,
    message: `Workflow outputSchema requires ${field} but no builtin.output.set card writes it`,
  }));
}

function collectWorkflowAuthoringWarnings(
  definition: WorkflowDefinition,
): WorkflowToolValidationIssue[] {
  const warnings: WorkflowToolValidationIssue[] = [];
  for (const node of definition.nodes) {
    if (node.type === "agent.call" && agentCallLooksDeterministic(node)) {
      warnings.push({
        severity: "warning",
        code: "deterministic_first",
        nodeId: node.id,
        path: `$.nodes.${node.id}`,
        message:
          "This agent.call looks like deterministic extraction, parsing, normalization, classification, or formatting; prefer built-in flow control, transformer cards, or MCP tools unless judgment is required.",
      });
    }
  }
  return warnings;
}

function agentCallLooksDeterministic(node: Extract<WorkflowNode, { type: "agent.call" }>): boolean {
  const haystack = JSON.stringify({
    prompt: node.prompt,
    input: node.input,
  }).toLowerCase();
  return [
    "extract",
    "parse",
    "normalize",
    "format",
    "convert",
    "regex",
    "split",
    "pick",
    "select field",
    "json",
    "csv",
    "uri",
    "url",
    "ip address",
    "subnet",
    "classify",
  ].some((token) => haystack.includes(token));
}

function collectWorkflowRouteScopeIssues(
  definition: WorkflowDefinition,
): WorkflowToolValidationIssue[] {
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const issues: WorkflowToolValidationIssue[] = [];
  for (const parent of definition.nodes) {
    if (parent.type === "builtin.if" || parent.type === "builtin.if_else") {
      issues.push(
        ...collectBranchRouteEscapeIssues({
          parent,
          nodesById,
          parentNext: parent.next,
          branches: [
            { id: "then", path: `$.nodes.${parent.id}.then`, starts: parent.then },
            { id: "else", path: `$.nodes.${parent.id}.else`, starts: parent.else },
          ],
          messagePrefix: "If",
        }),
      );
    }
    if (parent.type === "builtin.switch") {
      issues.push(
        ...collectBranchRouteEscapeIssues({
          parent,
          nodesById,
          parentNext: parent.next,
          branches: [
            ...parent.cases.map((item) => ({
              id: item.id,
              path: `$.nodes.${parent.id}.cases.${item.id}.nodes`,
              starts: item.nodes,
            })),
            {
              id: "default",
              path: `$.nodes.${parent.id}.default`,
              starts: parent.default,
            },
          ],
          messagePrefix: "Switch",
        }),
      );
    }
    if (parent.type === "builtin.foreach") {
      const parentNext = new Set(parent.next);
      for (const childId of scopedRouteReachableNodeIds(parent.body, nodesById)) {
        const child = nodesById.get(childId);
        if (!child) continue;
        const escaped = child.next.find((targetId) => parentNext.has(targetId));
        if (!escaped) continue;
        issues.push({
          code: "invalid_route_scope",
          nodeId: child.id,
          path: `$.nodes.${parent.id}.body`,
          reference: escaped,
          message: `Foreach body node ${child.id} cannot route directly to parent continuation ${escaped}`,
        });
      }
    }
    if (parent.type === "builtin.parallel") {
      const parentNext = new Set(parent.next);
      const branchStarts = new Map<string, string>();
      for (const branch of parent.branches) {
        for (const nodeId of branch.nodes) {
          const existingBranchId = branchStarts.get(nodeId);
          if (existingBranchId !== undefined) {
            issues.push({
              code: "duplicate_route_ownership",
              nodeId,
              path: `$.nodes.${parent.id}.branches.${branch.id}.nodes`,
              reference: existingBranchId,
              message: `Parallel branch start ${nodeId} is already owned by branch ${existingBranchId}`,
            });
            continue;
          }
          branchStarts.set(nodeId, branch.id);
        }
      }
      for (const branch of parent.branches) {
        const scoped = scopedRouteReachableNodeIds(branch.nodes, nodesById);
        for (const childId of scoped) {
          const child = nodesById.get(childId);
          if (!child) continue;
          const escaped = child.next.find(
            (targetId) =>
              parentNext.has(targetId) ||
              (branchStarts.has(targetId) &&
                branchStarts.get(targetId) !== branch.id),
          );
          if (!escaped) continue;
          issues.push({
            code: "invalid_route_scope",
            nodeId: child.id,
            path: `$.nodes.${parent.id}.branches.${branch.id}.nodes`,
            reference: escaped,
            message: `Parallel branch node ${child.id} cannot route directly outside branch ${branch.id} to ${escaped}`,
          });
        }
      }
    }
  }
  return issues;
}

function collectBranchRouteEscapeIssues(opts: {
  parent: WorkflowNode;
  nodesById: Map<string, WorkflowNode>;
  parentNext: string[];
  branches: Array<{ id: string; path: string; starts: string[] }>;
  messagePrefix: "If" | "Switch";
}): WorkflowToolValidationIssue[] {
  const issues: WorkflowToolValidationIssue[] = [];
  const parentNext = new Set(opts.parentNext);
  const branchStarts = new Map<string, string>();
  for (const branch of opts.branches) {
    for (const nodeId of branch.starts) {
      const existingBranchId = branchStarts.get(nodeId);
      if (existingBranchId !== undefined) {
        issues.push({
          code: "duplicate_route_ownership",
          nodeId,
          path: branch.path,
          reference: existingBranchId,
          message: `${opts.messagePrefix} branch start ${nodeId} is already owned by branch ${existingBranchId}`,
        });
        continue;
      }
      branchStarts.set(nodeId, branch.id);
    }
  }

  for (const branch of opts.branches) {
    const scoped = scopedRouteReachableNodeIds(branch.starts, opts.nodesById);
    for (const childId of scoped) {
      const child = opts.nodesById.get(childId);
      if (!child) continue;
      const escaped = child.next.find(
        (targetId) =>
          parentNext.has(targetId) ||
          (branchStarts.has(targetId) &&
            branchStarts.get(targetId) !== branch.id),
      );
      if (!escaped) continue;
      issues.push({
        code: "invalid_route_scope",
        nodeId: child.id,
        path: branch.path,
        reference: escaped,
        message: `${opts.messagePrefix} branch node ${child.id} cannot route directly outside branch ${branch.id} to ${escaped}`,
      });
    }
  }
  return issues;
}

function scopedRouteReachableNodeIds(
  starts: string[],
  nodesById: Map<string, WorkflowNode>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (seen.has(nodeId)) continue;
    const node = nodesById.get(nodeId);
    if (!node) continue;
    seen.add(nodeId);
    for (const targetId of node.next) {
      if (!seen.has(targetId)) stack.push(targetId);
    }
  }
  return seen;
}

function workflowReferencesInValue(
  value: unknown,
  path: string,
): Array<{ path: string; reference: string }> {
  if (typeof value === "string") {
    return extractWorkflowReferences(value).map((reference) => ({
      path,
      reference,
    }));
  }
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      workflowReferencesInValue(item, `${path}.${index}`),
    );
  }
  return Object.entries(value).flatMap(([key, child]) =>
    workflowReferencesInValue(child, `${path}.${key}`),
  );
}

function extractWorkflowReferences(value: string): string[] {
  const references = value.match(/\$\.[A-Za-z_][A-Za-z0-9_.-]*/g) ?? [];
  return [...new Set(references)];
}

function validateWorkflowReference(
  reference: string,
  nodeIds: Set<string>,
): string | null {
  const parts = reference.split(".");
  const family = parts[1];
  if (family === "workflowTrigger") {
    const scope = parts[2];
    return scope === "input" || scope === "meta"
      ? null
      : `Unsupported workflowTrigger reference scope in ${reference}; use $.workflowTrigger.input.*`;
  }
  if (family === "context") return null;
  if (family !== "steps") {
    return `Unsupported workflow reference family in ${reference}; use $.workflowTrigger, $.context, or $.steps`;
  }
  const stepId = parts[2];
  if (!stepId || !nodeIds.has(stepId)) {
    return `Unknown workflow step reference in ${reference}`;
  }
  const stepScope = parts[3];
  if (
    stepScope === undefined ||
    stepScope === "input" ||
    stepScope === "output" ||
    stepScope === "error" ||
    stepScope === "context" ||
    stepScope === "status"
  ) {
    return null;
  }
  return `Unsupported workflow step reference scope in ${reference}; use input, output, error, context, or status`;
}

function requiredOutputSchemaFields(schema: JsonValue): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const required = schema["required"];
  if (!Array.isArray(required)) return [];
  return required.filter((item): item is string => typeof item === "string");
}

type WorkflowHelpDetail = "summary" | "full";
type WorkflowHelpTarget =
  | { kind: "overview" }
  | { kind: "card_type"; card_type: string }
  | { kind: "workflow_schema" }
  | { kind: "reference_syntax" }
  | { kind: "input_schema"; workflow_id?: string }
  | { kind: "output_schema" }
  | { kind: "run_evidence" }
  | { kind: "promotion_gate" };

interface WorkflowHelpParameterRequest {
  name: string;
  detail: WorkflowHelpDetail;
  includeExamples: boolean;
  query?: string;
  value?: JsonValue;
}

interface WorkflowHelpParameterValue {
  summary: string;
  full?: string;
  examples?: JsonValue[];
  noExampleJustification?: string;
}

interface WorkflowHelpValue {
  summary: string;
  full?: string;
  whenToUse?: string[];
  whenNotToUse?: string[];
  parameters?: Record<string, WorkflowHelpParameterValue>;
  examples?: JsonValue[];
  noExampleJustification?: string;
}

interface WorkflowHelpStoreEntry {
  target: Record<string, JsonValue>;
  help: WorkflowHelpValue;
  updatedBy: string;
  updatedAt: string;
}

interface WorkflowHelpStore {
  version: 1;
  entries: Record<string, WorkflowHelpStoreEntry>;
}

function workflowHelpTargetParam(
  params: Record<string, unknown>,
): WorkflowHelpTarget {
  const target = params.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("target is required");
  }
  const record = target as Record<string, unknown>;
  const kind = stringParam(record, "kind");
  if (kind === "overview") return { kind };
  if (kind === "card_type") {
    return { kind, card_type: stringParam(record, "card_type") };
  }
  if (kind === "workflow_schema") return { kind };
  if (kind === "reference_syntax") return { kind };
  if (kind === "input_schema") {
    const workflowId = optionalStringParam(record, "workflow_id");
    return workflowId ? { kind, workflow_id: workflowId } : { kind };
  }
  if (kind === "output_schema") return { kind };
  if (kind === "run_evidence") return { kind };
  if (kind === "promotion_gate") return { kind };
  throw new Error(`unknown workflow help target kind: ${kind}`);
}

function workflowHelpDetailParam(
  params: Record<string, unknown>,
): WorkflowHelpDetail {
  const detail = optionalStringParam(params, "detail") ?? "summary";
  if (detail === "summary" || detail === "full") return detail;
  throw new Error("detail must be summary or full");
}

function workflowHelpParameterRequests(
  params: Record<string, unknown>,
): WorkflowHelpParameterRequest[] {
  if (!Array.isArray(params.parameters)) return [];
  return params.parameters.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("parameters entries must be objects");
    }
    const record = item as Record<string, unknown>;
    const detail = optionalStringParam(record, "detail") ?? "summary";
    if (detail !== "summary" && detail !== "full") {
      throw new Error("parameter detail must be summary or full");
    }
    return {
      name: stringParam(record, "name"),
      detail,
      includeExamples: record.include_examples === true,
      ...(optionalStringParam(record, "query")
        ? { query: optionalStringParam(record, "query")! }
        : {}),
      ...(record.value !== undefined
        ? { value: JsonValueSchema.parse(record.value) }
        : {}),
    };
  });
}

function workflowHelpValueParam(value: unknown): WorkflowHelpValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("help must be an object");
  }
  const record = value as Record<string, unknown>;
  const help: WorkflowHelpValue = {
    summary: stringParam(record, "summary"),
  };
  const full = optionalStringParam(record, "full");
  if (full) help.full = full;
  if (Array.isArray(record.whenToUse)) {
    help.whenToUse = record.whenToUse.map((item) =>
      typeof item === "string" && item.length > 0
        ? item
        : (() => {
            throw new Error("whenToUse entries must be non-empty strings");
          })(),
    );
  }
  if (Array.isArray(record.whenNotToUse)) {
    help.whenNotToUse = record.whenNotToUse.map((item) =>
      typeof item === "string" && item.length > 0
        ? item
        : (() => {
            throw new Error("whenNotToUse entries must be non-empty strings");
          })(),
    );
  }
  if (record.parameters !== undefined) {
    if (
      !record.parameters ||
      typeof record.parameters !== "object" ||
      Array.isArray(record.parameters)
    ) {
      throw new Error("help.parameters must be an object");
    }
    help.parameters = {};
    for (const [name, parameter] of Object.entries(record.parameters)) {
      if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
        throw new Error("help.parameters entries must be objects");
      }
      const parameterRecord = parameter as Record<string, unknown>;
      const parameterHelp: WorkflowHelpParameterValue = {
        summary: stringParam(parameterRecord, "summary"),
      };
      const parameterFull = optionalStringParam(parameterRecord, "full");
      if (parameterFull) parameterHelp.full = parameterFull;
      if (Array.isArray(parameterRecord.examples)) {
        parameterHelp.examples = parameterRecord.examples.map((example) =>
          JsonValueSchema.parse(example),
        );
      }
      const noExampleJustification = optionalStringParam(
        parameterRecord,
        "noExampleJustification",
      );
      if (noExampleJustification) {
        parameterHelp.noExampleJustification = noExampleJustification;
      }
      help.parameters[name] = parameterHelp;
    }
  }
  if (Array.isArray(record.examples)) {
    help.examples = record.examples.map((example) =>
      JsonValueSchema.parse(example),
    );
  }
  const noExampleJustification = optionalStringParam(
    record,
    "noExampleJustification",
  );
  if (noExampleJustification) {
    help.noExampleJustification = noExampleJustification;
  }
  return help;
}

function workflowHelpStoreFromUnknown(value: unknown): WorkflowHelpStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, entries: {} };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.entries || typeof record.entries !== "object") {
    return { version: 1, entries: {} };
  }
  const entries: Record<string, WorkflowHelpStoreEntry> = {};
  for (const [key, entry] of Object.entries(
    record.entries as Record<string, unknown>,
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const entryRecord = entry as Record<string, unknown>;
    try {
      entries[key] = {
        target: jsonObject(JsonValueSchema.parse(entryRecord.target)),
        help: workflowHelpValueParam(entryRecord.help),
        updatedBy: stringParam(entryRecord, "updatedBy"),
        updatedAt: stringParam(entryRecord, "updatedAt"),
      };
    } catch {
      continue;
    }
  }
  return { version: 1, entries };
}

function normalizeWorkflowHelpTarget(
  target: WorkflowHelpTarget,
): Record<string, JsonValue> {
  if (target.kind === "card_type") {
    return { kind: target.kind, cardType: target.card_type };
  }
  if (target.kind === "input_schema" && target.workflow_id) {
    return { kind: target.kind, workflowId: target.workflow_id };
  }
  return { kind: target.kind };
}

function workflowHelpTargetKey(target: WorkflowHelpTarget): string {
  if (target.kind === "card_type") return `card_type:${target.card_type}`;
  if (target.kind === "input_schema" && target.workflow_id) {
    return `input_schema:${target.workflow_id}`;
  }
  return target.kind;
}

function workflowCardTypeHelp(
  cardType: string,
  opts: {
    detail: WorkflowHelpDetail;
    includeExamples: boolean;
    parameters: WorkflowHelpParameterRequest[];
    persistedHelp?: WorkflowHelpValue;
  },
): unknown {
  const catalog = getWorkflowCardCatalog();
  const card = catalog.find((item) => item.type === cardType);
  if (!card) {
    return {
      ok: false,
      error: {
        code: "unknown_card_type",
        message: `Unknown workflow card type: ${cardType}`,
      },
      suggestions: catalog
        .map((item) => item.type)
        .filter((type) => type.includes(cardType.split(".").at(-1) ?? ""))
        .slice(0, 8)
        .concat(["builtin.if"])
        .filter((type, index, all) => all.indexOf(type) === index)
        .slice(0, 8),
    };
  }
  return {
    ok: true,
    target: { kind: "card_type", cardType: card.type },
    detail: opts.detail,
    summary: opts.persistedHelp?.summary ?? `${card.label}: ${card.description}`,
    ...(opts.persistedHelp?.whenToUse
      ? { whenToUse: opts.persistedHelp.whenToUse }
      : {}),
    ...(opts.persistedHelp?.whenNotToUse
      ? { whenNotToUse: opts.persistedHelp.whenNotToUse }
      : {}),
    ...(opts.detail === "full"
      ? {
          full:
            opts.persistedHelp?.full ??
            `${card.description} Family: ${card.family}. Routes: ${card.routePorts
              .map((port) => `${port.id}(${port.field})`)
              .join(", ") || "none"}.`,
        }
      : {}),
    card: {
      type: card.type,
      label: card.label,
      family: card.family,
      description: card.description,
      routePorts: card.routePorts,
      outputSchema: card.outputSchema,
      ...(opts.detail === "full"
        ? {
            configSchema: card.configSchema,
            defaultConfig: card.defaultConfig,
          }
        : {}),
    },
    ...(opts.parameters.length > 0
      ? {
          parameters: opts.parameters.map((request) =>
            workflowCardParameterHelp(
              card,
              request,
              opts.persistedHelp?.parameters?.[request.name],
            ),
          ),
        }
      : {}),
    ...(opts.includeExamples
      ? { examples: opts.persistedHelp?.examples ?? card.examples }
      : {}),
  };
}

function workflowCardParameterHelp(
  card: ReturnType<typeof getWorkflowCardCatalog>[number],
  request: WorkflowHelpParameterRequest,
  persistedHelp?: WorkflowHelpParameterValue,
): Record<string, unknown> {
  const schema = schemaPropertyAtPath(card.configSchema, request.name);
  if (!schema) {
    return {
      name: request.name,
      error: {
        code: "unknown_parameter",
        message: `Unknown parameter for ${card.type}: ${request.name}`,
      },
      candidateParameterPaths: schemaPropertyPaths(card.configSchema).filter(
        (path) => path.endsWith(request.name) || path.includes(request.name),
      ),
    };
  }
  return {
    name: request.name,
    summary:
      persistedHelp?.summary ??
      `${request.name} condition/config parameter for ${card.label}.`,
    ...(request.detail === "full"
      ? {
          full:
            persistedHelp?.full ??
            "Use $.workflowTrigger.input.* for workflow input, $.context.* for assigned variables, and $.steps.<step_id>.output.* for prior step output.",
        }
      : {}),
    schema,
    ...(request.includeExamples
      ? { examples: persistedHelp?.examples ?? card.examples }
      : {}),
    ...(request.query ? { query: request.query } : {}),
    ...(request.value !== undefined ? { value: request.value } : {}),
  };
}

function workflowStaticHelp(
  target: Exclude<WorkflowHelpTarget, { kind: "overview" | "card_type" }>,
  opts: {
    detail: WorkflowHelpDetail;
    includeExamples: boolean;
    persistedHelp?: WorkflowHelpValue;
  },
): unknown {
  const examples = opts.includeExamples
    ? {
        examples: [
          "$.workflowTrigger.input.customer",
          "$.steps.normalize_asset.output.value",
          "$.context.customer",
        ],
      }
    : {};
  if (target.kind === "reference_syntax") {
    return {
      ok: true,
      target,
      detail: opts.detail,
      summary:
        opts.persistedHelp?.summary ??
        "Workflow references use $.workflowTrigger, $.context, and $.steps.",
      families: {
        workflowTrigger: "$.workflowTrigger.input.<field>",
        context: "$.context.<variable>",
        steps: "$.steps.<step_id>.input|output|error|context.<field>",
      },
      ...(opts.detail === "full"
        ? {
            full:
              opts.persistedHelp?.full ??
              "Prefer explicit step ids. Use $.steps.<step_id>.output.<field> to pass a prior card's output into another card. Use transformer or set-variable cards to normalize values.",
          }
        : {}),
      ...examples,
    };
  }
  if (target.kind === "workflow_schema") {
    return {
      ok: true,
      target,
      detail: opts.detail,
      summary:
        opts.persistedHelp?.summary ??
        "Workflow definitions contain id/name/status/version, triggers, nodes, optional inputSchema, and optional ui canvas metadata.",
      required: ["id", "version", "status", "name", "triggers", "nodes"],
      ...examples,
    };
  }
  if (target.kind === "run_evidence") {
    return {
      ok: true,
      target,
      detail: opts.detail,
      summary:
        opts.persistedHelp?.summary ??
        "Use workflow_run_get summary first, then detail: 'step' with include fields for targeted evidence.",
      detailModes: ["summary", "step", "full"],
      includes: ["input", "output", "logs", "error", "context"],
      ...examples,
    };
  }
  if (target.kind === "input_schema") {
    return {
      ok: true,
      target,
      detail: opts.detail,
      summary:
        opts.persistedHelp?.summary ??
        "Workflow input schemas are JSON Schema contracts for $.workflowTrigger.input.",
      ...examples,
    };
  }
  if (target.kind === "output_schema") {
    return {
      ok: true,
      target,
      detail: opts.detail,
      summary:
        opts.persistedHelp?.summary ??
        "Workflow output should be set explicitly with builtin.output.set once that card is available.",
      ...examples,
    };
  }
  return {
    ok: true,
    target,
    detail: opts.detail,
    summary:
      opts.persistedHelp?.summary ??
      "Publishing should require validation plus a successful full test for the current draft hash.",
    gates: ["validation", "references", "successful_current_draft_test"],
    ...examples,
  };
}

function schemaPropertyAtPath(schema: JsonValue, path: string): JsonValue | null {
  let current: JsonValue | undefined = schema;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const currentObject: Record<string, JsonValue> = current;
    const properties = currentObject["properties"];
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return null;
    }
    current = (properties as Record<string, JsonValue>)[part];
  }
  return current ?? null;
}

function schemaPropertyPaths(schema: JsonValue, prefix = ""): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const schemaObject: Record<string, JsonValue> = schema;
  const properties = schemaObject["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [
      path,
      ...schemaPropertyPaths(
        (properties as Record<string, JsonValue>)[key] ?? null,
        path,
      ),
    ];
  });
}

type WorkflowValidationParseResult =
  | { ok: true; definition: WorkflowDefinition }
  | {
      ok: false;
      error: { code: string; message: string };
      issues: WorkflowToolValidationIssue[];
    };

type WorkflowTestAssertionOperator =
  | "exists"
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "matches"
  | "greater_than"
  | "less_than";

interface WorkflowTestAssertion {
  path: string;
  operator: WorkflowTestAssertionOperator;
  value?: JsonValue;
}

function parseWorkflowDefinitionForToolValidation(
  value: unknown,
): WorkflowValidationParseResult {
  const unsupported = collectUnsupportedWorkflowNodeTypeIssues(value);
  if (unsupported.length > 0)
    return unsupportedWorkflowNodeTypeResult(unsupported);
  const parsed = WorkflowDefinitionSchema.safeParse(value);
  if (!parsed.success)
    return invalidWorkflowDefinitionResult(parsed.error.issues);
  return { ok: true, definition: parsed.data };
}

function parseWorkflowCreateCandidateForToolValidation(
  value: unknown,
): WorkflowValidationParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidWorkflowDefinitionResult([
      { path: [], message: "candidate must be an object" },
    ]);
  }
  const unsupported = collectUnsupportedWorkflowNodeTypeIssues(value);
  if (unsupported.length > 0)
    return unsupportedWorkflowNodeTypeResult(unsupported);
  try {
    return {
      ok: true,
      definition: workflowCreateCandidate(
        workflowCreateBodyParam(value as Record<string, unknown>),
      ),
    };
  } catch (error) {
    return invalidWorkflowDefinitionResult([
      {
        path: [],
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}

function collectUnsupportedWorkflowNodeTypeIssues(
  value: unknown,
): WorkflowToolValidationIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const nodes = (value as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  const supportedTypes = new Set<string>(WorkflowNodeTypeValues);
  const issues: WorkflowToolValidationIssue[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const raw = node as Record<string, unknown>;
    if (typeof raw.type !== "string" || supportedTypes.has(raw.type)) continue;
    issues.push({
      code: "unsupported_card_type",
      nodeId: typeof raw.id === "string" ? raw.id : undefined,
      message: `Unsupported workflow node type: ${raw.type}`,
    });
  }
  return issues;
}

function unsupportedWorkflowNodeTypeResult(
  issues: WorkflowToolValidationIssue[],
): WorkflowValidationParseResult {
  return {
    ok: false,
    error: {
      code: "unsupported_card_type",
      message: issues.map((issue) => issue.message).join("; "),
    },
    issues,
  };
}

function invalidWorkflowDefinitionResult(
  issues: Array<{ path?: PropertyKey[]; message: string }>,
): WorkflowValidationParseResult {
  const normalized = issues.map((issue) => ({
    code: "invalid_definition",
    message:
      issue.path && issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
  }));
  return {
    ok: false,
    error: {
      code: "invalid_definition",
      message: normalized.map((issue) => issue.message).join("; "),
    },
    issues: normalized,
  };
}

function workflowCreateBodyParam(
  params: Record<string, unknown>,
): WorkflowCreateBody {
  const body: WorkflowCreateBody = {
    name: stringParam(params, "name"),
  };
  const id = optionalStringParam(params, "id");
  if (id) body.id = id;
  if (hasOwn(params, "description")) {
    body.description = optionalStringParam(params, "description");
  }
  if (hasOwn(params, "inputSchema") && params.inputSchema !== null) {
    body.inputSchema = JsonValueSchema.parse(params.inputSchema);
  }
  if (hasOwn(params, "outputSchema") && params.outputSchema !== null) {
    body.outputSchema = JsonValueSchema.parse(params.outputSchema);
  }
  if (Array.isArray(params.triggers)) {
    body.triggers = params.triggers as WorkflowCreateBody["triggers"];
  }
  if (Array.isArray(params.nodes)) {
    body.nodes = params.nodes as WorkflowCreateBody["nodes"];
  }
  if (params.ui && typeof params.ui === "object") {
    body.ui = params.ui as WorkflowCreateBody["ui"];
  }
  return body;
}

function workflowUpdateBodyParam(
  params: Record<string, unknown>,
): WorkflowUpdateBody {
  const body: WorkflowUpdateBody = {};
  if (hasOwn(params, "name")) body.name = stringParam(params, "name");
  if (hasOwn(params, "description")) {
    body.description = optionalStringParam(params, "description");
  }
  if (hasOwn(params, "inputSchema")) {
    body.inputSchema =
      params.inputSchema === null
        ? null
        : JsonValueSchema.parse(params.inputSchema);
  }
  if (hasOwn(params, "outputSchema")) {
    body.outputSchema =
      params.outputSchema === null
        ? null
        : JsonValueSchema.parse(params.outputSchema);
  }
  if (Array.isArray(params.triggers)) {
    body.triggers = params.triggers as WorkflowUpdateBody["triggers"];
  }
  if (Array.isArray(params.nodes)) {
    body.nodes = params.nodes as WorkflowUpdateBody["nodes"];
  }
  if (hasOwn(params, "ui")) {
    body.ui =
      params.ui === null ? null : (params.ui as WorkflowUpdateBody["ui"]);
  }
  return body;
}

function workflowImportPackageParam(value: unknown): WorkflowCreateBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package_document must be an object");
  }
  const document = value as Record<string, unknown>;
  if (document.format !== "openacme.workflow.definition.v1") {
    throw new Error("Unsupported workflow export format");
  }
  const workflow = document.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("Import file is missing workflow metadata");
  }
  const raw = workflow as Record<string, unknown>;
  const body: WorkflowCreateBody = {
    name: typeof raw.name === "string" ? raw.name : "",
  };
  if (!body.name.trim()) throw new Error("Imported workflow needs a name");
  if (typeof raw.description === "string") body.description = raw.description;
  if (raw.inputSchema !== undefined) {
    body.inputSchema = JsonValueSchema.parse(raw.inputSchema);
  }
  if (raw.outputSchema !== undefined) {
    body.outputSchema = JsonValueSchema.parse(raw.outputSchema);
  }
  if (Array.isArray(raw.triggers)) {
    body.triggers = raw.triggers as WorkflowCreateBody["triggers"];
  }
  if (Array.isArray(raw.nodes)) {
    body.nodes = raw.nodes as WorkflowCreateBody["nodes"];
  }
  if (raw.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui)) {
    body.ui = raw.ui as WorkflowCreateBody["ui"];
  }
  return body;
}

function workflowDefinitionStatusParam(
  params: Record<string, unknown>,
  name: string,
): WorkflowDefinitionStatus {
  const value = stringParam(params, name);
  if (value === "draft" || value === "published" || value === "archived") {
    return value;
  }
  throw new Error(`${name} must be draft, published, or archived`);
}

function workflowRunModeParam(
  params: Record<string, unknown>,
  name: string,
): WorkflowRunMode {
  const value = stringParam(params, name);
  if (value === "test" || value === "live") return value;
  throw new Error(`${name} must be test or live`);
}

function workflowRunStatusParam(
  params: Record<string, unknown>,
  name: string,
): WorkflowRunStatus {
  const value = stringParam(params, name);
  if (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`${name} must be a workflow run status`);
}

function workflowRunDetailModeParam(
  params: Record<string, unknown>,
  name: string,
): "summary" | "step" | "full" {
  const value = stringParam(params, name);
  if (value === "summary" || value === "step" || value === "full") {
    return value;
  }
  throw new Error(`${name} must be summary, step, or full`);
}

function workflowCallableSummary(definition: WorkflowDefinition) {
  return {
    id: definition.id,
    name: definition.name,
    status: definition.status,
    version: definition.version,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.inputSchema !== undefined
      ? { inputSchema: definition.inputSchema }
      : {}),
    ...(definition.outputSchema !== undefined
      ? { outputSchema: definition.outputSchema }
      : {}),
    triggers: definition.triggers
      .filter((trigger) => trigger.enabled !== false)
      .map((trigger) => ({
        id: trigger.id,
        kind: trigger.kind,
        runnable: trigger.kind === "manual",
        ...(trigger.kind === "manual" && trigger.inputSchema !== undefined
          ? { inputSchema: trigger.inputSchema }
          : {}),
      })),
  };
}

function workflowRunStepIncludeParam(
  params: Record<string, unknown>,
  name: string,
): Array<"input" | "output" | "logs" | "error" | "context"> | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const allowed = new Set(["input", "output", "logs", "error", "context"]);
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new Error(
        `${name} entries must be input, output, logs, error, or context`,
      );
    }
  }
  return value as Array<"input" | "output" | "logs" | "error" | "context">;
}

function workflowTestAssertionsParam(
  params: Record<string, unknown>,
  name: string,
): WorkflowTestAssertion[] | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== "string" || raw.path.length === 0) {
      throw new Error(`${name}[${index}].path is required`);
    }
    if (!isWorkflowTestAssertionOperator(raw.operator)) {
      throw new Error(`${name}[${index}].operator is invalid`);
    }
    return {
      path: raw.path,
      operator: raw.operator,
      ...(raw.value === undefined
        ? {}
        : { value: JsonValueSchema.parse(raw.value) }),
    };
  });
}

function isWorkflowTestAssertionOperator(
  value: unknown,
): value is WorkflowTestAssertionOperator {
  return (
    value === "exists" ||
    value === "equals" ||
    value === "not_equals" ||
    value === "contains" ||
    value === "not_contains" ||
    value === "matches" ||
    value === "greater_than" ||
    value === "less_than"
  );
}

function workflowDefinitionHash(definition: WorkflowDefinition): string {
  return createHash("sha256")
    .update(stableJsonStringify(definition))
    .digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJsonStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return stableJsonStringify(a) === stableJsonStringify(b);
}

function evaluateWorkflowTestAssertions(
  detail: unknown,
  assertions: WorkflowTestAssertion[],
) {
  const evidence = workflowAssertionEvidence(detail);
  const results = assertions.map((assertion) => {
    const resolved = resolveAssertionPath(evidence, assertion.path);
    const result = evaluateWorkflowTestAssertion(assertion, resolved);
    return {
      path: assertion.path,
      operator: assertion.operator,
      ok: result.ok,
      ...(resolved.found ? { actual: resolved.value } : { found: false }),
      ...(assertion.value === undefined ? {} : { expected: assertion.value }),
      ...(result.message ? { message: result.message } : {}),
    };
  });
  return { ok: results.every((result) => result.ok), results };
}

function workflowAssertionsFromRunDetail(
  detail: unknown,
): WorkflowTestAssertion[] | undefined {
  const run = workflowRunObjectFromDetail(detail);
  const trigger = run?.trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    return undefined;
  }
  const assertions = (trigger as Record<string, unknown>).testAssertions;
  if (!Array.isArray(assertions)) return undefined;
  return assertions
    .map((assertion) =>
      assertion && typeof assertion === "object" && !Array.isArray(assertion)
        ? (assertion as Record<string, unknown>)
        : null,
    )
    .filter((assertion): assertion is Record<string, unknown> => !!assertion)
    .map((assertion) => ({
      path: String(assertion.path),
      operator: assertion.operator as WorkflowTestAssertionOperator,
      ...(assertion.value === undefined ? {} : { value: assertion.value as JsonValue }),
    }));
}

function workflowRunDetailIsTerminal(detail: unknown): boolean {
  const status = workflowRunObjectFromDetail(detail)?.status;
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function workflowRunObjectFromDetail(
  detail: unknown,
): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return undefined;
  }
  const run = (detail as Record<string, unknown>).run;
  return run && typeof run === "object" && !Array.isArray(run)
    ? (run as Record<string, unknown>)
    : undefined;
}

function workflowAssertionEvidence(detail: unknown): Record<string, unknown> {
  const source =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : {};
  const steps: Record<string, unknown> = {};
  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  for (const rawStep of rawSteps) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      continue;
    }
    const step = rawStep as Record<string, unknown>;
    if (typeof step.nodeId !== "string") continue;
    steps[step.nodeId] = {
      status: step.status,
      input: step.input,
      output: step.output,
      error: step.error,
      contextDiff: step.contextDiff,
      durationMs: step.durationMs,
      attempt: step.attempt,
    };
  }
  const run = source.run as Record<string, unknown> | undefined;
  return {
    run: source.run,
    context: run?.context,
    workflowTrigger: {
      input: run?.input,
      meta: run?.trigger,
    },
    steps,
  };
}

function resolveAssertionPath(
  source: unknown,
  pathExpression: string,
): { found: true; value: unknown } | { found: false } {
  if (!pathExpression.startsWith("$.")) return { found: false };
  let current = source;
  for (const segment of pathExpression.slice(2).split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      if (index < current.length) {
        current = current[index];
        continue;
      }
      return { found: false };
    }
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function evaluateWorkflowTestAssertion(
  assertion: WorkflowTestAssertion,
  resolved: { found: true; value: unknown } | { found: false },
): { ok: boolean; message?: string } {
  if (assertion.operator === "exists") {
    return { ok: resolved.found };
  }
  if (!resolved.found) {
    return { ok: false, message: `Assertion path not found: ${assertion.path}` };
  }
  const actual = resolved.value;
  const expected = assertion.value;
  switch (assertion.operator) {
    case "equals":
      return { ok: jsonEquals(actual, expected) };
    case "not_equals":
      return { ok: !jsonEquals(actual, expected) };
    case "contains":
      return { ok: assertionContains(actual, expected) };
    case "not_contains":
      return { ok: !assertionContains(actual, expected) };
    case "matches":
      return typeof actual === "string" && typeof expected === "string"
        ? { ok: new RegExp(expected).test(actual) }
        : { ok: false, message: "matches requires string actual and expected" };
    case "greater_than":
      return typeof actual === "number" && typeof expected === "number"
        ? { ok: actual > expected }
        : {
            ok: false,
            message: "greater_than requires numeric actual and expected",
          };
    case "less_than":
      return typeof actual === "number" && typeof expected === "number"
        ? { ok: actual < expected }
        : {
            ok: false,
            message: "less_than requires numeric actual and expected",
          };
  }
}

function assertionContains(actual: unknown, expected: JsonValue | undefined) {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => jsonEquals(item, expected));
  }
  if (
    actual &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    typeof expected === "string"
  ) {
    return Object.prototype.hasOwnProperty.call(actual, expected);
  }
  return false;
}

function workflowMcpToolKey(server: string, tool: string): string {
  return `${server}:${tool}`;
}

function rejectWorkflowHostedToolOnAbortOrTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<T> {
  if (!signal && timeoutMs === undefined) return promise;
  if (signal?.aborted) {
    return Promise.reject(new Error("Workflow hosted tool canceled"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("Workflow hosted tool timed out"));
          }, timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(new Error("Workflow hosted tool canceled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseWorkflowHostedToolOutput(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function createHostedIntegrationServiceForRuntime(
  config: Config,
  hooks: {
    onRegistryRefresh: (
      event: HostedIntegrationRegistryRefreshEvent,
    ) => void | Promise<void>;
    onFailureBucketRecorded: (
      event: HostedIntegrationFailureBucketRecordedEvent,
    ) => void | Promise<void>;
  },
): { service: HostedIntegrationService; backend: "file" | "db" } {
  const deploymentMode = resolveDeploymentMode(config.server);
  const hostedIntegrationConfig = config as Config & {
    hostedIntegrations?: { persistenceBackend?: "auto" | "file" | "db" };
  };
  const configuredBackend =
    hostedIntegrationConfig.hostedIntegrations?.persistenceBackend ?? "auto";
  const backend =
    configuredBackend === "auto"
      ? deploymentMode === "authenticated"
        ? "db"
        : "file"
      : configuredBackend;

  if (deploymentMode === "authenticated" && backend === "file") {
    throw new Error(
      "hosted integrations file-backed persistence is only allowed for local trusted deployments; set hostedIntegrations.persistenceBackend to db or auto",
    );
  }

  if (backend === "file") {
    log.info("hosted integrations persistence backend selected", {
      backend,
      deploymentMode,
    });
    return {
      service: createFileHostedIntegrationService({
        dataDir: config.dataDir,
        ...hooks,
      }),
      backend,
    };
  }

  const hostedIntegrationDb = createDatabase(config);
  const service = createDbHostedIntegrationService({
    db: {
      prepare: (sql) => hostedIntegrationDb.prepare(sql),
      transaction: <T>(fn: () => T) => {
        const run = hostedIntegrationDb.transaction(fn);
        return () => run() as T;
      },
    },
    dataDir: config.dataDir,
    ...hooks,
  });
  log.info("hosted integrations persistence backend selected", {
    backend,
    deploymentMode,
  });
  const closeService = service.close.bind(service);
  service.close = async () => {
    await closeService();
    hostedIntegrationDb.close();
  };
  return {
    service,
    backend,
  };
}
