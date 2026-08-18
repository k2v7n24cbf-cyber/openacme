import type { Config } from "@openacme/config";
import { resolveDeploymentMode } from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import type { ModelResolver } from "@openacme/agent-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowManager } from "@openacme/workflows";
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
  HostedIntegrationToolRegistryAdapter,
  HOSTED_TOOL_HELP_TOOL_NAME,
  registry as toolRegistry,
  type HostedIntegrationRegistrySnapshot,
  type HostedToolManagementRequest,
  type HostedIntegrationToolInvokeRequest,
  type HostedToolHelpRequest,
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
import { validateHostedIntegrationRegressionClose } from "./hosted-integration-regression.js";

const log = createLogger("server.workflow-runtime");
const DEFAULT_WORKFLOW_DISPATCHER_INTERVAL_MS = 60_000;
const HOSTED_INTEGRATION_DELETE_DRAIN_POLL_MS = 1_000;
const HOSTED_INTEGRATION_REPAIR_AGENT_ID = "tool-developer";
const HOSTED_INTEGRATION_REPAIR_TASK_CREATOR = "system:hosted-integrations";
const HOSTED_INTEGRATION_REPAIR_MARKER_PREFIX =
  "openacme:hosted-integration-repair-bucket=";

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
          targetFamilyId: optionalStringParam(p, "target_family_id") ?? undefined,
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
    const tool = tools.find(
      (candidate) => candidate.name === example.toolName,
    );
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
  if (
    tools.some(
      (tool) => tool.classification.operation === "destructive",
    )
  ) {
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

function hostedFamilyPackageExportSourceParam(value: unknown):
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
    return { type: sourceType, generationId: stringParam(params, "generation_id") };
  }
  if (sourceType === "draft") {
    return { type: sourceType, draftId: stringParam(params, "draft_id") };
  }
  if (sourceType === "current_source") {
    return { type: sourceType, familyId: stringParam(params, "family_id") };
  }
  throw new Error("source.source_type must be active_generation, generation, draft, or current_source");
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
