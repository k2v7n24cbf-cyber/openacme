import type { Config } from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import type { ModelResolver } from "@openacme/agent-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowManager } from "@openacme/workflows";
import {
  createFileHostedIntegrationService,
  HostedIntegrationExampleSchema,
  FamilyManifestSchema,
  HostedIntegrationPythonRuntime,
  HostedIntegrationPolicyBindingSchema,
  evaluateHostedIntegrationPromotionApproval,
  isHostedIntegrationToolVisibleForSelection,
  parseHostedIntegrationManagedToolName,
  type FamilyManifest,
  type HostedIntegrationDraft,
  type HostedIntegrationExample,
  type HostedIntegrationFailureBucketRecordedEvent,
  type HostedIntegrationGatewayError,
  type HostedIntegrationGeneration,
  type HostedIntegrationHumanApprovalRecord,
  type HostedIntegrationPolicyBinding,
  type HostedIntegrationRegistryRefreshEvent,
  type HostedIntegrationService,
  JsonObjectSchema,
} from "@openacme/hosted-integrations";
import {
  bindHostedIntegrationManagement,
  HostedIntegrationToolRegistryAdapter,
  registry as toolRegistry,
  type HostedIntegrationRegistrySnapshot,
  type HostedIntegrationManagementRequest,
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
import { validateHostedIntegrationRegressionClose } from "./hosted-integration-regression.js";

const log = createLogger("server.workflow-runtime");
const DEFAULT_WORKFLOW_DISPATCHER_INTERVAL_MS = 60_000;
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
  private readonly dataDir: string;
  private readonly workflowDb: ReturnType<typeof createDatabase>;
  private readonly workflowDispatcherIntervalMs: number;
  private readonly workflowDispatcherNow: () => Date;
  private workflowDispatcherTimer: NodeJS.Timeout | null = null;
  private workflowDispatcherTickInFlight: Promise<void> | null = null;

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
    this.hostedIntegrationService =
      opts?.hostedIntegrationService ??
      createFileHostedIntegrationService({
        dataDir: config.dataDir,
        onRegistryRefresh: (event) =>
          this.refreshHostedIntegrationRegistry(event),
        onFailureBucketRecorded: (event) =>
          this.createHostedIntegrationRepairTask(event),
      });
    bindHostedIntegrationManagement({
      invoke: (request) => this.invokeHostedIntegrationManagement(request),
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
    if (!result.ok) {
      return this.hostedIntegrationToolFailure(request, {
        code: "tool_failed",
        message: "tool failed",
      });
    }
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
      canonicalToolName: request.canonicalToolName,
      generationId: request.generationId,
    });
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

  private async invokeHostedIntegrationManagement(
    request: HostedIntegrationManagementRequest,
  ): Promise<unknown> {
    const denied = this.hostedIntegrationManagementDenied(request);
    if (denied) return denied;
    const p = request.params;
    switch (request.operation) {
      case "hosted_integration_family_list":
        return {
          ok: true,
          families: await this.hostedIntegrationService.listFamilies(),
        };
      case "hosted_integration_family_create": {
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
      case "hosted_integration_source_read":
        return this.readHostedIntegrationSource(p);
      case "hosted_integration_lock_acquire": {
        const result = await this.hostedIntegrationService.locks.acquireLock({
          familyId: stringParam(p, "family_id"),
          lockedBy: request.actorId,
          ttlMs: positiveIntegerParam(p, "ttl_ms") ?? 30 * 60 * 1000,
        });
        return result.ok
          ? { ok: true, lock: result.lock }
          : { ok: false, error: { code: result.reason }, lock: result.lock };
      }
      case "hosted_integration_lock_renew": {
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
      case "hosted_integration_lock_release": {
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
      case "hosted_integration_draft_create": {
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
      case "hosted_integration_draft_get":
        return this.readHostedIntegrationDraft(p);
      case "hosted_integration_draft_patch": {
        const result =
          await this.hostedIntegrationService.drafts.writeDraftFile({
            draftId: stringParam(p, "draft_id"),
            lockId: stringParam(p, "lock_id"),
            path: stringParam(p, "path"),
            content: stringParam(p, "content"),
          });
        return result.ok
          ? { ok: true }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_integration_draft_delete": {
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
      case "hosted_integration_example_list":
        return {
          ok: true,
          examples: await this.hostedIntegrationService.examples.listExamples(
            stringParam(p, "draft_id"),
          ),
        };
      case "hosted_integration_example_upsert": {
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
      case "hosted_integration_example_run":
        return this.runHostedIntegrationDraftExample(request);
      case "hosted_integration_validate":
        return this.hostedIntegrationService.validator.validateDraft(
          stringParam(p, "draft_id"),
        );
      case "hosted_integration_promote":
        return this.promoteHostedIntegrationDraft(request);
      case "hosted_integration_generation_list":
        return {
          ok: true,
          generations:
            await this.hostedIntegrationService.generations.listGenerations({
              familyId: optionalStringParam(p, "family_id") ?? undefined,
            }),
        };
      case "hosted_integration_generation_get": {
        const generation =
          await this.hostedIntegrationService.generations.getGeneration(
            stringParam(p, "generation_id"),
          );
        return generation
          ? { ok: true, generation }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_integration_generation_rollback": {
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
      case "hosted_integration_config_scope_list":
        return {
          ok: true,
          configScopes:
            await this.hostedIntegrationService.configScopes.listConfigScopes(),
        };
      case "hosted_integration_config_scope_get": {
        const configScope =
          await this.hostedIntegrationService.configScopes.getConfigScope(
            stringParam(p, "scope_id"),
          );
        return configScope
          ? { ok: true, configScope }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_integration_debug_run":
        return this.invokeHostedIntegrationDebugRun(request);
      case "hosted_integration_run_get": {
        const run =
          await this.hostedIntegrationService.gateway.executionLogs.getRunLog(
            stringParam(p, "run_id"),
          );
        return run
          ? { ok: true, run }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_integration_artifact_get": {
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
      case "hosted_integration_failure_bucket_list": {
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
      case "hosted_integration_failure_bucket_get": {
        const bucket =
          await this.hostedIntegrationService.failureBuckets.getBucket(
            stringParam(p, "bucket_id"),
          );
        return bucket
          ? { ok: true, bucket }
          : { ok: false, error: { code: "not_found" } };
      }
      case "hosted_integration_failure_bucket_assign": {
        const result =
          await this.hostedIntegrationService.failureBuckets.assignBucket({
            bucketId: stringParam(p, "bucket_id"),
            assignedTo: stringParam(p, "assigned_to"),
          });
        return result.ok
          ? { ok: true, bucket: result.bucket }
          : { ok: false, error: { code: result.reason } };
      }
      case "hosted_integration_failure_bucket_close":
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

  private hostedIntegrationManagementDenied(
    request: HostedIntegrationManagementRequest,
  ): { ok: false; error: { code: string; message: string } } | null {
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
          ? { ok: true, path: filePath, content: result.content }
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
        ? { ok: true, path: filePath, content: result.content }
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
        ? { ok: true, path: filePath, content: result.content }
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

  private async invokeHostedIntegrationDebugRun(
    request: HostedIntegrationManagementRequest,
  ): Promise<unknown> {
    const p = request.params;
    const operationClass = optionalStringParam(p, "operation_class") ?? "read";
    if (operationClass !== "read" && p.allow_writes !== true) {
      return { ok: false, error: { code: "approval_required" } };
    }
    const familyId = stringParam(p, "family_id");
    const toolName = nativeHostedIntegrationToolNameParam(p, "tool_name");
    const configScopeId = stringParam(p, "config_scope_id");
    return this.hostedIntegrationService.gateway.invoke({
      actor: { id: request.actorId, kind: "agent", roles: ["tool_developer"] },
      familyId,
      toolName,
      environment: stringParam(p, "environment"),
      args: JsonObjectSchema.parse(p.args ?? {}),
      bindings: [
        {
          agentId: request.actorId,
          familyId,
          toolName,
          allowedConfigScopeIds: [configScopeId],
          defaultConfigScopeId: configScopeId,
          environment: stringParam(p, "environment"),
        },
      ],
      generationId: optionalStringParam(p, "generation_id") ?? undefined,
    });
  }

  private async closeHostedIntegrationFailureBucket(
    request: HostedIntegrationManagementRequest,
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
    request: HostedIntegrationManagementRequest,
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
    const tool = manifest.tools.find(
      (candidate) => candidate.name === example.toolName,
    );
    if (!tool) return { ok: false, error: { code: "tool_not_found" } };

    const draftGenerationId = `draft:${draft.id}`;
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
      configScopeId: "debug",
      configRevision: 1,
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
        config: {},
        secrets: {},
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
    request: HostedIntegrationManagementRequest,
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
    const examples =
      await this.hostedIntegrationService.examples.listExamples(draftId);
    const missingExamples = missingHostedIntegrationExampleToolNames(
      manifest,
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
      target: hostedIntegrationPromotionTargetForDraft(draft, manifest),
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
  manifest: FamilyManifest,
  examples: HostedIntegrationExample[],
): string[] {
  const covered = new Set(examples.map((example) => example.toolName));
  return manifest.tools
    .map((tool) => tool.name)
    .filter((toolName) => !covered.has(toolName));
}

function hostedIntegrationPromotionTargetForDraft(
  draft: HostedIntegrationDraft,
  manifest: FamilyManifest,
) {
  const toolNames = manifest.tools.map((tool) => tool.name);
  const destructiveToolNames = manifest.tools
    .filter((tool) => tool.classification.operation === "destructive")
    .map((tool) => tool.name);
  return {
    familyId: draft.familyId,
    draftId: draft.id,
    draftRevisionId: draft.updatedAt,
    operation: "promote" as const,
    operationClass: hostedIntegrationOperationClassForManifest(manifest),
    toolNames,
    destructiveToolNames,
  };
}

function hostedIntegrationOperationClassForManifest(
  manifest: FamilyManifest,
): "read" | "write" | "destructive" {
  if (
    manifest.tools.some(
      (tool) => tool.classification.operation === "destructive",
    )
  ) {
    return "destructive";
  }
  if (
    manifest.tools.some((tool) => tool.classification.operation === "write")
  ) {
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
  if (parseHostedIntegrationManagedToolName(value)) {
    throw new Error(
      `${name} must be a family-native hosted integration tool name, not a managed canonical registry name`,
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
