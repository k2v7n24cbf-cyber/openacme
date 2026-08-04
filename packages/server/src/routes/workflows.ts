import type { Context, Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { WorkflowStore } from "@openacme/db";
import {
  JsonValueSchema,
  WorkflowDefinitionUiSchema,
  WorkflowNodeSchema,
  WorkflowRunner,
  WorkflowTriggerSchema,
  validateWorkflowNodeReferences,
  validateWorkflowTriggers,
  type JsonValue,
  type WorkflowExecutionPorts,
  type WorkflowEventPort,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunMode,
  type WorkflowRunTrigger,
  type WorkflowTrigger,
} from "@openacme/workflows";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const WorkflowCreateBodySchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    inputSchema: JsonValueSchema.optional(),
    triggers: z.array(WorkflowTriggerSchema).optional(),
    nodes: z.array(WorkflowNodeSchema).optional(),
    ui: WorkflowDefinitionUiSchema.optional(),
  })
  .strict();

const WorkflowUpdateBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    inputSchema: JsonValueSchema.nullable().optional(),
    triggers: z.array(WorkflowTriggerSchema).optional(),
    nodes: z.array(WorkflowNodeSchema).optional(),
    ui: WorkflowDefinitionUiSchema.nullable().optional(),
  })
  .strict();

const WorkflowRunBodySchema = z
  .object({
    input: JsonValueSchema.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();

const WorkflowArtifactPruneBodySchema = z
  .object({
    createdBefore: z.string().datetime({ offset: true }),
  })
  .strict();

export function registerWorkflowRoutes(
  app: Hono,
  store: WorkflowStore,
  opts: { ports?: WorkflowExecutionPorts } = {},
): void {
  const runAbortControllers = new Map<string, AbortController>();

  app.post("/api/workflow-webhooks/:id/by-path/*", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const path = webhookPathFromWildcard(
      c,
      `/api/workflow-webhooks/${id}/by-path/`,
    );
    if (!path) return c.json({ error: "invalid path" }, 400);
    const body = await parseBody(c.req.raw, JsonValueSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const current = store.getDefinition(id);
    if (!current) return c.json({ error: "not_found" }, 404);
    const definition = store.getVersion(id, current.version);
    if (!definition) {
      return c.json({ error: "published_version_not_found" }, 404);
    }
    const trigger = findWebhookTriggerByPath(definition.triggers, path);
    if (!trigger.ok) {
      return c.json({ error: trigger.error }, trigger.status);
    }
    return executePublicWebhookRequest(c, store, {
      definition,
      trigger: trigger.value,
      input: body.value,
      ports: opts.ports,
      runAbortControllers,
    });
  });

  app.post("/api/workflow-webhooks/:id/:triggerId", async (c) => {
    const id = c.req.param("id");
    const triggerId = c.req.param("triggerId");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    if (!SAFE_ID.test(triggerId))
      return c.json({ error: "invalid triggerId" }, 400);
    const body = await parseBody(c.req.raw, JsonValueSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const current = store.getDefinition(id);
    if (!current) return c.json({ error: "not_found" }, 404);
    const definition = store.getVersion(id, current.version);
    if (!definition) {
      return c.json({ error: "published_version_not_found" }, 404);
    }
    const trigger = definition.triggers.find((item) => item.id === triggerId);
    if (!trigger || trigger.kind !== "webhook") {
      return c.json({ error: "trigger_not_found" }, 404);
    }
    return executePublicWebhookRequest(c, store, {
      definition,
      trigger,
      input: body.value,
      ports: opts.ports,
      runAbortControllers,
    });
  });

  app.get("/api/workflows", (c) => {
    if (hasUnsupportedWorkflowScopeQuery(c)) {
      return c.json({ error: "workflow_scope_unsupported" }, 400);
    }
    const statusParam = queryParam(c, "status");
    if (!statusParam.ok) {
      return c.json({ error: "invalid status" }, 400);
    }
    const status = parseDefinitionStatus(statusParam.value);
    if (statusParam.value && !status)
      return c.json({ error: "invalid status" }, 400);
    const limit = parseBoundedIntQuery(c, "limit", 100, 1, 500);
    if (!limit.ok) return c.json({ error: limit.error }, 400);
    return c.json({
      workflows: store.listDefinitions({
        ...(status ? { status } : {}),
        limit: limit.value,
      }),
    });
  });

  app.post("/api/workflows", async (c) => {
    const body = await parseBody(c.req.raw, WorkflowCreateBodySchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (body.value.id && !SAFE_ID.test(body.value.id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const references = validateNodes(body.value.nodes ?? []);
    if (!references.ok) return c.json({ error: references.message }, 400);
    const triggers = validateTriggers(body.value.triggers ?? []);
    if (!triggers.ok) return c.json({ error: triggers.message }, 400);
    try {
      const workflow = store.createDraft(body.value);
      return c.json({ workflow }, 201);
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.get("/api/workflows/mcp/tools", async (c) => {
    try {
      return c.json({ tools: (await opts.ports?.mcp?.listTools?.()) ?? [] });
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.get("/api/workflows/agents", (c) => {
    try {
      return c.json({ agents: opts.ports?.agent?.listAgents() ?? [] });
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.get("/api/workflows/:id", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const workflow = store.getDefinition(id);
    if (!workflow) return c.json({ error: "not_found" }, 404);
    return c.json({ workflow });
  });

  app.patch("/api/workflows/:id", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const body = await parseBody(c.req.raw, WorkflowUpdateBodySchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (body.value.nodes) {
      const references = validateNodes(body.value.nodes);
      if (!references.ok) return c.json({ error: references.message }, 400);
    }
    if (body.value.triggers) {
      const triggers = validateTriggers(body.value.triggers);
      if (!triggers.ok) return c.json({ error: triggers.message }, 400);
    }
    try {
      return c.json({ workflow: store.updateDraft(id, body.value) });
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.delete("/api/workflows/:id", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    try {
      return c.json({ workflow: store.archiveDefinition(id) });
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.post("/api/workflows/:id/publish", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const workflow = store.getDefinition(id);
    if (!workflow) return c.json({ error: "not_found" }, 404);
    const references = validateNodes(workflow.nodes);
    if (!references.ok) return c.json({ error: references.message }, 400);
    const triggers = validateTriggers(workflow.triggers);
    if (!triggers.ok) return c.json({ error: triggers.message }, 400);
    try {
      return c.json({ workflow: store.publish(id) });
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.get("/api/workflows/:id/triggers", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const workflow = store.getDefinition(id);
    if (!workflow) return c.json({ error: "not_found" }, 404);
    return c.json({
      triggers: workflow.triggers.map(triggerView),
    });
  });

  app.post("/api/workflows/:id/triggers/:triggerId/runs", async (c) => {
    const id = c.req.param("id");
    const triggerId = c.req.param("triggerId");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    if (!SAFE_ID.test(triggerId))
      return c.json({ error: "invalid triggerId" }, 400);
    const body = await parseBody(c.req.raw, WorkflowRunBodySchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const current = store.getDefinition(id);
    if (!current) return c.json({ error: "not_found" }, 404);
    const version = body.value.version ?? current.version;
    const definition = store.getVersion(id, version);
    if (!definition)
      return c.json({ error: "published_version_not_found" }, 404);
    const trigger = definition.triggers.find((item) => item.id === triggerId);
    if (!trigger) return c.json({ error: "trigger_not_found" }, 404);
    const guard = triggerRunGuard(trigger);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);
    try {
      const input = body.value.input ?? {};
      const detail = await executePublishedTriggerRun(store, {
        definition,
        trigger,
        input,
        requestId: c.req.header("x-openacme-webhook-request-id"),
        ports: opts.ports,
        runAbortControllers,
      });
      return c.json(detail, 201);
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.post("/api/workflows/:id/runs/test", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const body = await parseBody(c.req.raw, WorkflowRunBodySchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    if (body.value.version !== undefined) {
      return c.json({ error: "test_run_version_not_supported" }, 400);
    }
    const definition = store.getDefinition(id);
    if (!definition) return c.json({ error: "not_found" }, 404);
    try {
      const detail = await executeWorkflowRun(store, {
        definition,
        mode: "test",
        definitionSource: "draft",
        input: body.value.input ?? {},
        trigger: manualTriggerSnapshot("manual", body.value.input ?? {}),
        ports: opts.ports,
        runAbortControllers,
      });
      return c.json(detail, 201);
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.post("/api/workflows/:id/runs/live", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const body = await parseBody(c.req.raw, WorkflowRunBodySchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const current = store.getDefinition(id);
    if (!current) return c.json({ error: "not_found" }, 404);
    const version = body.value.version ?? current.version;
    const definition = store.getVersion(id, version);
    if (!definition)
      return c.json({ error: "published_version_not_found" }, 404);
    try {
      const detail = await executeWorkflowRun(store, {
        definition,
        mode: "live",
        definitionSource: "published",
        input: body.value.input ?? {},
        trigger: manualTriggerSnapshot("manual", body.value.input ?? {}),
        ports: opts.ports,
        runAbortControllers,
      });
      return c.json(detail, 201);
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.get("/api/workflows/:id/runs", (c) => {
    const workflowId = c.req.param("id");
    if (!SAFE_ID.test(workflowId))
      return c.json({ error: "invalid workflowId" }, 400);
    const runFilters = parseRunListFilters(c);
    if (!runFilters.ok) return c.json({ error: runFilters.error }, 400);
    const limit = parseBoundedIntQuery(c, "limit", 100, 1, 500);
    if (!limit.ok) return c.json({ error: limit.error }, 400);
    const offset = parseBoundedIntQuery(c, "offset", 0, 0, 1_000_000);
    if (!offset.ok) return c.json({ error: offset.error }, 400);
    return c.json(
      store.listRunsPage({
        workflowId,
        ...runFilters.value,
        limit: limit.value,
        offset: offset.value,
      }),
    );
  });

  app.get("/api/workflow-runs", (c) => {
    if (hasUnsupportedWorkflowScopeQuery(c)) {
      return c.json({ error: "workflow_scope_unsupported" }, 400);
    }
    const workflowIdParam = queryParam(c, "workflowId");
    if (!workflowIdParam.ok) {
      return c.json({ error: "invalid workflowId" }, 400);
    }
    const workflowId = workflowIdParam.value;
    if (workflowId && !SAFE_ID.test(workflowId)) {
      return c.json({ error: "invalid workflowId" }, 400);
    }
    const runFilters = parseRunListFilters(c);
    if (!runFilters.ok) return c.json({ error: runFilters.error }, 400);
    const limit = parseBoundedIntQuery(c, "limit", 100, 1, 500);
    if (!limit.ok) return c.json({ error: limit.error }, 400);
    const offset = parseBoundedIntQuery(c, "offset", 0, 0, 1_000_000);
    if (!offset.ok) return c.json({ error: offset.error }, 400);
    return c.json(
      store.listRunsPage({
        ...(workflowId ? { workflowId } : {}),
        ...runFilters.value,
        limit: limit.value,
        offset: offset.value,
      }),
    );
  });

  app.get("/api/workflow-runs/:id", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const detail = getRunDetail(store, id);
    if (!detail) return c.json({ error: "not_found" }, 404);
    return c.json(detail);
  });

  app.post("/api/workflow-artifacts/prune", async (c) => {
    const body = await parseBody(c.req.raw, WorkflowArtifactPruneBodySchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    return c.json(
      store.pruneArtifactFiles({
        createdBefore: body.value.createdBefore,
      }),
    );
  });

  app.get("/api/workflow-runs/:id/artifacts/:artifactId", (c) => {
    const id = c.req.param("id");
    const artifactId = c.req.param("artifactId");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    if (!SAFE_ID.test(artifactId))
      return c.json({ error: "invalid artifactId" }, 400);
    if (!store.getRun(id)) return c.json({ error: "not_found" }, 404);
    const artifact = store.readArtifactContent(id, artifactId);
    if (!artifact) return c.json({ error: "artifact_not_found" }, 404);
    return c.json(artifact);
  });

  app.get("/api/workflow-runs/:id/artifacts/:artifactId/download", (c) => {
    const id = c.req.param("id");
    const artifactId = c.req.param("artifactId");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    if (!SAFE_ID.test(artifactId))
      return c.json({ error: "invalid artifactId" }, 400);
    if (!store.getRun(id)) return c.json({ error: "not_found" }, 404);
    const artifact = store.readArtifactContent(id, artifactId);
    if (!artifact) return c.json({ error: "artifact_not_found" }, 404);
    const filename = `${artifact.artifact.id}.json`;
    const body = `${JSON.stringify(artifact.content, null, 2)}\n`;
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        filename,
      )}`,
    );
    return c.body(body);
  });

  app.post("/api/workflow-runs/:id/rerun", async (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    const previous = store.getRun(id);
    if (!previous) return c.json({ error: "not_found" }, 404);
    const definition =
      previous.definitionSource === "published"
        ? store.getVersion(previous.workflowId, previous.workflowVersion)
        : store.getDefinition(previous.workflowId);
    if (!definition)
      return c.json({ error: "workflow_definition_not_found" }, 404);
    try {
      const detail = await executeWorkflowRun(store, {
        definition,
        mode: previous.mode,
        definitionSource: previous.definitionSource,
        input: previous.input,
        trigger: previous.trigger,
        ports: opts.ports,
        runAbortControllers,
      });
      return c.json(detail, 201);
    } catch (err) {
      return routeError(c, err);
    }
  });

  app.post("/api/workflow-runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    if (!SAFE_ID.test(id)) return c.json({ error: "invalid id" }, 400);
    try {
      return c.json(cancelWorkflowRun(store, id, runAbortControllers));
    } catch (err) {
      return routeError(c, err);
    }
  });
}

function cancelWorkflowRun(
  store: WorkflowStore,
  id: string,
  runAbortControllers?: Map<string, AbortController>,
) {
  const run = store.getRun(id);
  if (!run) throw new RouteHttpError("not_found", 404);
  if (isTerminalRunStatus(run.status)) {
    throw new RouteHttpError("run_not_cancelable", 409);
  }
  const endedAt = new Date().toISOString();
  cancelCurrentStepAttempt(store, run, endedAt);
  const updated = store.updateRunState(id, {
    status: "canceled",
    currentNodeId: null,
    waitingReason: null,
    endedAt,
    durationMs: stepDurationMs(run.startedAt, endedAt),
  });
  store.appendRunEvent({
    runId: id,
    level: "system",
    kind: "run_canceled",
    message: "Workflow run canceled",
    payload: { previousStatus: run.status },
    createdAt: endedAt,
  });
  runAbortControllers?.get(id)?.abort();
  return {
    run: updated,
    steps: store.listStepAttempts(id),
    events: store.listRunEvents(id),
    artifacts: store.listArtifacts(id),
  };
}

function cancelCurrentStepAttempt(
  store: WorkflowStore,
  run: NonNullable<ReturnType<WorkflowStore["getRun"]>>,
  endedAt: string,
): void {
  if (!run.currentNodeId) return;
  const step = [...store.listStepAttempts(run.id)]
    .reverse()
    .find(
      (item) =>
        item.nodeId === run.currentNodeId && !isTerminalStepStatus(item.status),
    );
  if (!step) return;
  store.recordStepAttempt({
    id: step.id,
    runId: step.runId,
    nodeId: step.nodeId,
    attempt: step.attempt,
    status: "canceled",
    startedAt: step.startedAt,
    endedAt,
    durationMs: stepDurationMs(step.startedAt, endedAt),
    input: step.input,
    output: step.output,
    error: step.error,
    logsSummary: step.logsSummary,
    contextDiff: step.contextDiff,
  });
}

async function executeWorkflowRun(
  store: WorkflowStore,
  args: {
    definition: WorkflowDefinition;
    mode: WorkflowRunMode;
    definitionSource: "draft" | "published";
    input: JsonValue;
    trigger: WorkflowRunTrigger;
    ports?: WorkflowExecutionPorts;
    runAbortControllers?: Map<string, AbortController>;
  },
) {
  const references = validateNodes(args.definition.nodes);
  if (!references.ok) throw new Error(references.message);
  const triggers = validateTriggers(args.definition.triggers);
  if (!triggers.ok) throw new Error(triggers.message);
  const inputValidation = validateWorkflowInputSchema(
    args.definition.inputSchema,
    args.input,
  );
  if (!inputValidation.ok) throw new RouteHttpError(inputValidation.error, 400);

  const startedAt = new Date().toISOString();
  const run = store.createRun({
    workflowId: args.definition.id,
    workflowVersion: args.definition.version,
    definitionSource: args.definitionSource,
    mode: args.mode,
    trigger: args.trigger,
    input: args.input,
    status: "running",
    createdAt: startedAt,
    startedAt,
  });
  const abortController = new AbortController();
  args.runAbortControllers?.set(run.id, abortController);

  const eventPorts = {
    ...(args.ports ?? {}),
    events: {
      append: async (event) => {
        const current = store.getRun(event.runId);
        if (current && isTerminalRunStatus(current.status)) return;
        updateRunProgressFromEvent(store, event);
        store.appendRunEvent(event);
        try {
          await args.ports?.events?.append(event);
        } catch {
          // Observer event ports must not break durable workflow execution.
        }
      },
    },
  } satisfies WorkflowExecutionPorts;
  let result: Awaited<ReturnType<WorkflowRunner["run"]>>;
  try {
    result = await new WorkflowRunner({ ports: eventPorts }).run({
      runId: run.id,
      definition: args.definition,
      input: executionInputForRun(store, run),
      signal: abortController.signal,
    });
  } finally {
    args.runAbortControllers?.delete(run.id);
  }

  const latest = store.getRun(run.id);
  if (latest && isTerminalRunStatus(latest.status)) {
    return {
      run: latest,
      steps: store.listStepAttempts(run.id),
      events: store.listRunEvents(run.id),
      artifacts: store.listArtifacts(run.id),
    };
  }

  for (const step of result.stepAttempts) {
    store.recordStepAttempt({
      id: step.id,
      runId: step.runId,
      nodeId: step.nodeId,
      attempt: step.attempt,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      durationMs: step.durationMs,
      input: step.input,
      output: step.output,
      error: step.error,
      logsSummary: step.logsSummary,
      contextDiff: step.contextDiff,
    });
  }

  const endedAt = new Date().toISOString();
  const updated = store.updateRunState(run.id, {
    status: result.status,
    context: result.context,
    currentNodeId: null,
    waitingReason: null,
    endedAt,
    durationMs: stepDurationMs(run.startedAt, endedAt),
  });
  return {
    run: updated,
    steps: store.listStepAttempts(run.id),
    events: store.listRunEvents(run.id),
    artifacts: store.listArtifacts(run.id),
  };
}

function executionInputForRun(
  store: WorkflowStore,
  run: WorkflowRun,
): JsonValue {
  const artifactId = artifactIdFromValue(run.input);
  if (!artifactId) return run.input;
  return store.readArtifactContent(run.id, artifactId)?.content ?? run.input;
}

function artifactIdFromValue(value: JsonValue): string | null {
  if (!isRecord(value) || !isRecord(value["artifact"])) return null;
  const artifact = value["artifact"];
  return typeof artifact["id"] === "string" ? artifact["id"] : null;
}

type WorkflowPortEvent = Parameters<WorkflowEventPort["append"]>[0];

function updateRunProgressFromEvent(
  store: WorkflowStore,
  event: WorkflowPortEvent,
): void {
  const current = store.getRun(event.runId);
  if (!current || isTerminalRunStatus(current.status)) return;

  if (event.kind === "step_started") {
    const step = stepAttemptFromEvent(event);
    if (!step) return;
    store.recordStepAttempt({
      id: step.id,
      runId: event.runId,
      nodeId: step.nodeId,
      attempt: step.attempt,
      status: "running",
      startedAt: new Date().toISOString(),
      ...(step.input !== undefined ? { input: step.input } : {}),
    });
    store.updateRunState(event.runId, {
      status: current.status,
      currentNodeId: step.nodeId,
      waitingReason: null,
    });
    return;
  }

  if (event.kind === "step_completed" || event.kind === "step_failed") {
    recordTerminalStepAttemptFromEvent(store, event);
    const step = stepAttemptFromEvent(event);
    store.updateRunState(event.runId, {
      status: current.status,
      currentNodeId:
        step && current.currentNodeId === step.nodeId
          ? null
          : current.currentNodeId,
      waitingReason: null,
    });
    return;
  }

  if (
    event.kind === "run_completed" ||
    event.kind === "run_failed" ||
    event.kind === "run_canceled"
  ) {
    store.updateRunState(event.runId, {
      status: current.status,
      currentNodeId: null,
      waitingReason: null,
    });
  }
}

function recordTerminalStepAttemptFromEvent(
  store: WorkflowStore,
  event: WorkflowPortEvent,
  endedAtOverride?: string,
): void {
  const step = stepAttemptFromEvent(event);
  if (!step) return;
  const status = terminalStepStatusFromEvent(event);
  const existing = [...store.listStepAttempts(event.runId)]
    .reverse()
    .find((item) => item.id === step.id);
  const endedAt = endedAtOverride ?? new Date().toISOString();
  store.recordStepAttempt({
    id: step.id,
    runId: event.runId,
    nodeId: step.nodeId,
    attempt: step.attempt,
    status,
    startedAt: existing?.startedAt ?? endedAt,
    endedAt,
    durationMs: stepDurationMs(existing?.startedAt ?? endedAt, endedAt),
    input: existing?.input ?? step.input,
    output: existing?.output,
    error: terminalStepErrorFromEvent(event) ?? existing?.error,
    logsSummary: existing?.logsSummary,
    contextDiff: existing?.contextDiff,
  });
}

function terminalStepStatusFromEvent(
  event: WorkflowPortEvent,
): "succeeded" | "failed" | "canceled" {
  const payloadStatus =
    isRecord(event.payload) && typeof event.payload["status"] === "string"
      ? event.payload["status"]
      : undefined;
  if (
    event.kind === "step_completed" &&
    (payloadStatus === "succeeded" ||
      payloadStatus === "failed" ||
      payloadStatus === "canceled")
  ) {
    return payloadStatus;
  }
  return event.kind === "step_failed" ? "failed" : "succeeded";
}

function terminalStepErrorFromEvent(
  event: WorkflowPortEvent,
): JsonValue | undefined {
  if (event.kind !== "step_failed") return undefined;
  if (isRecord(event.payload) && isJsonValue(event.payload["output"])) {
    return event.payload["output"];
  }
  return undefined;
}

function stepAttemptFromEvent(event: WorkflowPortEvent): {
  id: string;
  nodeId: string;
  attempt: number;
  input?: JsonValue;
} | null {
  const stepRunId = event.stepRunId;
  if (!stepRunId) return null;
  if (isRecord(event.payload) && typeof event.payload["nodeId"] === "string") {
    return {
      id: stepRunId,
      nodeId: event.payload["nodeId"],
      attempt: attemptFromStepRunId(stepRunId),
      ...(isJsonValue(event.payload["input"])
        ? { input: event.payload["input"] }
        : {}),
    };
  }
  const parts = stepRunId.split(":");
  const nodeId = parts.length >= 3 ? (parts.at(-2) ?? null) : null;
  return nodeId
    ? { id: stepRunId, nodeId, attempt: attemptFromStepRunId(stepRunId) }
    : null;
}

function attemptFromStepRunId(stepRunId: string): number {
  const parsed = Number(stepRunId.split(":").at(-1));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function isJsonValue(value: unknown): value is JsonValue {
  return JsonValueSchema.safeParse(value).success;
}

export async function executePublishedTriggerRun(
  store: WorkflowStore,
  args: {
    definition: WorkflowDefinition;
    trigger: WorkflowTrigger;
    input: JsonValue;
    requestId?: string;
    scheduledAt?: string;
    ports?: WorkflowExecutionPorts;
    runAbortControllers?: Map<string, AbortController>;
  },
) {
  const workflowInputValidation = validateWorkflowInputSchema(
    args.definition.inputSchema,
    args.input,
  );
  if (!workflowInputValidation.ok) {
    throw new RouteHttpError(workflowInputValidation.error, 400);
  }
  const triggerInputValidation = validateWorkflowInputSchema(
    triggerInputSchema(args.trigger),
    args.input,
    "Trigger input",
  );
  if (!triggerInputValidation.ok) {
    throw new RouteHttpError(triggerInputValidation.error, 400);
  }
  return executeWorkflowRun(store, {
    definition: args.definition,
    mode: "live",
    definitionSource: "published",
    input: args.input,
    trigger: runTriggerSnapshot(
      args.trigger,
      args.input,
      args.requestId,
      args.scheduledAt,
    ),
    ports: args.ports,
    runAbortControllers: args.runAbortControllers,
  });
}

function validateNodes(nodes: WorkflowDefinition["nodes"]) {
  return validateWorkflowNodeReferences(nodes);
}

function validateTriggers(triggers: WorkflowDefinition["triggers"]) {
  return validateWorkflowTriggers(triggers);
}

function validateWorkflowInputSchema(
  schema: JsonValue | undefined,
  input: JsonValue,
  label = "Input",
): { ok: true } | { ok: false; error: string } {
  if (schema === undefined || schema === null || schema === true) {
    return { ok: true };
  }
  if (schema === false) {
    return {
      ok: false,
      error: `${label} does not match schema: $ is disallowed`,
    };
  }
  if (!isRecord(schema)) return { ok: true };
  const issue = validateJsonSchemaValue(schema, input, "$");
  return issue
    ? { ok: false, error: `${label} does not match schema: ${issue}` }
    : { ok: true };
}

function validateJsonSchemaValue(
  schema: Record<string, unknown>,
  value: JsonValue,
  path: string,
): string | null {
  if ("const" in schema && !jsonEquals(value, schema.const)) {
    return `${path} must equal ${JSON.stringify(schema.const)}`;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => jsonEquals(value, item))
  ) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}`;
  }
  const typeIssue = validateJsonSchemaType(schema.type, value, path);
  if (typeIssue) return typeIssue;

  if (isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const key of required) {
      if (!(key in value)) return `${path}.${key} is required`;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(childSchema)) continue;
      const issue = validateJsonSchemaValue(
        childSchema,
        value[key] as JsonValue,
        `${path}.${key}`,
      );
      if (issue) return issue;
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      const extra = Object.keys(value).find((key) => !allowed.has(key));
      if (extra) return `${path}.${extra} is not allowed`;
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = validateJsonSchemaValue(
        schema.items,
        value[index] as JsonValue,
        `${path}[${index}]`,
      );
      if (issue) return issue;
    }
  }

  return null;
}

function validateJsonSchemaType(
  type: unknown,
  value: JsonValue,
  path: string,
): string | null {
  if (type === undefined) return null;
  const allowed = Array.isArray(type)
    ? type.filter((item): item is string => typeof item === "string")
    : typeof type === "string"
      ? [type]
      : [];
  if (allowed.length === 0) return null;
  return allowed.some((item) => jsonSchemaTypeMatches(item, value))
    ? null
    : `${path} must be ${allowed.join("|")}`;
}

function jsonSchemaTypeMatches(type: string, value: JsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  return true;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getRunDetail(store: WorkflowStore, id: string) {
  const run = store.getRun(id);
  if (!run) return null;
  healTerminalRunStepAttemptsFromEvents(store, run);
  return {
    run,
    steps: store.listStepAttempts(id),
    events: store.listRunEvents(id),
    artifacts: store.listArtifacts(id),
  };
}

function healTerminalRunStepAttemptsFromEvents(
  store: WorkflowStore,
  run: NonNullable<ReturnType<WorkflowStore["getRun"]>>,
): void {
  if (!isTerminalRunStatus(run.status)) return;
  const nonTerminalSteps = store
    .listStepAttempts(run.id)
    .filter((step) => !isTerminalStepStatus(step.status));
  if (nonTerminalSteps.length === 0) return;
  const terminalEvents = store
    .listRunEvents(run.id)
    .filter(
      (event) =>
        event.kind === "step_completed" || event.kind === "step_failed",
    );
  for (const step of nonTerminalSteps) {
    const event = terminalEvents.find((item) => item.stepRunId === step.id);
    if (!event) continue;
    recordTerminalStepAttemptFromEvent(store, event, event.createdAt);
  }
}

function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function isTerminalStepStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "canceled"
  );
}

function stepDurationMs(
  startedAt: string | null | undefined,
  endedAt: string,
): number | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(ended)) return null;
  return Math.max(0, ended - started);
}

async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<{ ok: true; value: z.infer<T> } | { ok: false; error: string }> {
  try {
    const raw = (await req.json()) as unknown;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid body" };
    return { ok: true, value: parsed.data };
  } catch {
    return { ok: false, error: "invalid json" };
  }
}

function parseMode(value: string | undefined): WorkflowRunMode | undefined {
  if (value === "test" || value === "live") return value;
  return undefined;
}

function parseRunStatus(
  value: string | undefined,
):
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | undefined {
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
  return undefined;
}

function parseRunListFilters(c: Context):
  | {
      ok: true;
      value: {
        mode?: WorkflowRunMode;
        status?:
          | "queued"
          | "running"
          | "waiting"
          | "succeeded"
          | "failed"
          | "canceled";
        triggerId?: string;
        createdFrom?: string;
        createdTo?: string;
      };
    }
  | { ok: false; error: string } {
  const modeParam = queryParam(c, "mode");
  if (!modeParam.ok) return { ok: false, error: "invalid mode" };
  const modeValue = modeParam.value;
  const mode = parseMode(modeValue);
  if (modeValue && !mode) return { ok: false, error: "invalid mode" };
  const statusParam = queryParam(c, "status");
  if (!statusParam.ok) return { ok: false, error: "invalid status" };
  const statusValue = statusParam.value;
  const status = parseRunStatus(statusValue);
  if (statusValue && !status) return { ok: false, error: "invalid status" };
  const triggerParam = queryParam(c, "triggerId");
  if (!triggerParam.ok) return { ok: false, error: "invalid triggerId" };
  const triggerId = triggerParam.value;
  if (triggerId && !SAFE_ID.test(triggerId)) {
    return { ok: false, error: "invalid triggerId" };
  }
  const createdFromParam = queryParam(c, "createdFrom");
  if (!createdFromParam.ok) return { ok: false, error: "invalid createdFrom" };
  const createdFrom = parseDateFilter(createdFromParam.value, "start");
  if (createdFrom === "invalid")
    return { ok: false, error: "invalid createdFrom" };
  const createdToParam = queryParam(c, "createdTo");
  if (!createdToParam.ok) return { ok: false, error: "invalid createdTo" };
  const createdTo = parseDateFilter(createdToParam.value, "end");
  if (createdTo === "invalid") return { ok: false, error: "invalid createdTo" };
  if (createdFrom && createdTo && createdFrom > createdTo) {
    return { ok: false, error: "invalid date range" };
  }
  return {
    ok: true,
    value: {
      ...(mode ? { mode } : {}),
      ...(status ? { status } : {}),
      ...(triggerId ? { triggerId } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(createdTo ? { createdTo } : {}),
    },
  };
}

function queryParam(
  c: Context,
  name: string,
): { ok: true; value: string | undefined } | { ok: false } {
  const values = new URL(c.req.raw.url).searchParams.getAll(name);
  if (values.length > 1) return { ok: false };
  return { ok: true, value: values[0] };
}

function hasUnsupportedWorkflowScopeQuery(c: Context): boolean {
  const params = new URL(c.req.raw.url).searchParams;
  return params.has("teamId") || params.has("agentId") || params.has("ownerId");
}

function parseDateFilter(
  value: string | undefined,
  boundary: "start" | "end",
): string | undefined | "invalid" {
  if (!value) return undefined;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!dateOnly && !timestampSeparatorIsValid(value)) return "invalid";
  const date = dateOnly
    ? parseDateOnlyFilter(dateOnly, boundary)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "invalid";
  if (!dateOnly && !timestampDatePartIsValid(value)) return "invalid";
  return date.toISOString();
}

function parseDateOnlyFilter(
  match: RegExpExecArray,
  boundary: "start" | "end",
): Date {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      boundary === "start" ? 0 : 23,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 999,
    ),
  );
  if (!validCalendarDate(year, month, day)) {
    return new Date(Number.NaN);
  }
  return date;
}

function timestampSeparatorIsValid(value: string): boolean {
  return !/^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function timestampDatePartIsValid(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!match) return true;
  return validCalendarDate(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDefinitionStatus(
  value: string | undefined,
): "draft" | "published" | "archived" | undefined {
  if (value === "draft" || value === "published" || value === "archived") {
    return value;
  }
  return undefined;
}

function parseBoundedIntQuery(
  c: Context,
  name: "limit" | "offset",
  fallback: number,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const value = queryParam(c, name);
  if (!value.ok) return { ok: false, error: `invalid ${name}` };
  const raw = value.value;
  if (raw !== undefined && !/^-?\d+$/.test(raw)) {
    return { ok: false, error: `invalid ${name}` };
  }
  if (raw === undefined) return { ok: true, value: fallback };
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    return { ok: false, error: `invalid ${name}` };
  }
  return {
    ok: true,
    value: parsed,
  };
}

function triggerView(trigger: WorkflowTrigger) {
  const view =
    trigger.kind === "webhook"
      ? (({ secretSha256: _secretSha256, ...value }) => value)(trigger)
      : trigger;
  return {
    ...view,
    runnable:
      (trigger.kind === "manual" || trigger.kind === "webhook") &&
      trigger.enabled === true,
  };
}

function triggerRunGuard(
  trigger: WorkflowTrigger,
): { ok: true } | { ok: false; status: 409; error: string } {
  if (trigger.kind !== "manual" && trigger.kind !== "webhook") {
    return { ok: false, status: 409, error: "trigger_kind_not_runnable" };
  }
  if (trigger.enabled !== true) {
    return { ok: false, status: 409, error: "trigger_not_enabled" };
  }
  return { ok: true };
}

function webhookSecretGuard(
  trigger: Extract<WorkflowTrigger, { kind: "webhook" }>,
  providedSecret: string | undefined,
):
  | { ok: true }
  | {
      ok: false;
      status: 401 | 409;
      error: "webhook_secret_invalid" | "webhook_secret_required";
    } {
  if (!trigger.secretSha256) {
    return { ok: false, status: 409, error: "webhook_secret_required" };
  }
  if (!providedSecret) {
    return { ok: false, status: 401, error: "webhook_secret_invalid" };
  }
  return sha256Equals(providedSecret, trigger.secretSha256)
    ? { ok: true }
    : { ok: false, status: 401, error: "webhook_secret_invalid" };
}

function webhookPathFromWildcard(c: Context, prefix: string): string | null {
  if (!c.req.path.startsWith(prefix)) return null;
  try {
    return normalizeWebhookPath(
      decodeURIComponent(c.req.path.slice(prefix.length)),
    );
  } catch {
    return null;
  }
}

function normalizeWebhookPath(value: string | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}

function findWebhookTriggerByPath(
  triggers: WorkflowTrigger[],
  path: string,
):
  | { ok: true; value: Extract<WorkflowTrigger, { kind: "webhook" }> }
  | {
      ok: false;
      status: 404 | 409;
      error: "trigger_not_found" | "webhook_path_ambiguous";
    } {
  const matches = triggers.filter(
    (trigger): trigger is Extract<WorkflowTrigger, { kind: "webhook" }> =>
      trigger.kind === "webhook" && normalizeWebhookPath(trigger.path) === path,
  );
  if (matches.length === 0) {
    return { ok: false, status: 404, error: "trigger_not_found" };
  }
  if (matches.length > 1) {
    return { ok: false, status: 409, error: "webhook_path_ambiguous" };
  }
  const trigger = matches[0];
  if (!trigger) {
    return { ok: false, status: 404, error: "trigger_not_found" };
  }
  return { ok: true, value: trigger };
}

async function executePublicWebhookRequest(
  c: Context,
  store: WorkflowStore,
  opts: {
    definition: WorkflowDefinition;
    trigger: Extract<WorkflowTrigger, { kind: "webhook" }>;
    input: JsonValue;
    ports?: WorkflowExecutionPorts;
    runAbortControllers?: Map<string, AbortController>;
  },
) {
  const guard = triggerRunGuard(opts.trigger);
  if (!guard.ok) return c.json({ error: guard.error }, guard.status);
  const secretGuard = webhookSecretGuard(
    opts.trigger,
    c.req.header("x-openacme-webhook-secret"),
  );
  if (!secretGuard.ok) {
    return c.json({ error: secretGuard.error }, secretGuard.status);
  }
  try {
    const detail = await executePublishedTriggerRun(store, {
      definition: opts.definition,
      trigger: opts.trigger,
      input: opts.input,
      requestId: c.req.header("x-openacme-webhook-request-id"),
      ports: opts.ports,
      runAbortControllers: opts.runAbortControllers,
    });
    return c.json(detail, 201);
  } catch (err) {
    return routeError(c, err);
  }
}

function sha256Equals(secret: string, expectedHex: string): boolean {
  const actual = Buffer.from(sha256Hex(secret), "hex");
  const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function triggerInputSchema(trigger: WorkflowTrigger): JsonValue | undefined {
  if (trigger.kind === "manual" || trigger.kind === "webhook") {
    return trigger.inputSchema;
  }
  return undefined;
}

function runTriggerSnapshot(
  trigger: WorkflowTrigger,
  input: JsonValue,
  requestId: string | undefined,
  scheduledAt: string | undefined,
): WorkflowRunTrigger {
  if (trigger.kind === "scheduled") {
    return {
      kind: "scheduled",
      triggerId: trigger.id,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
  }
  if (trigger.kind === "webhook") {
    return webhookTriggerSnapshot(trigger.id, requestId);
  }
  return manualTriggerSnapshot(trigger.id, input);
}

function manualTriggerSnapshot(
  triggerId: string,
  input: JsonValue,
): WorkflowRunTrigger {
  return {
    kind: "manual",
    triggerId,
    requestedBy: "operator",
    input,
  };
}

function webhookTriggerSnapshot(
  triggerId: string,
  requestId: string | undefined,
): WorkflowRunTrigger {
  return {
    kind: "webhook",
    triggerId,
    ...(requestId ? { requestId } : {}),
  };
}

function routeError(c: Context, err: unknown) {
  if (err instanceof RouteHttpError) {
    return c.json({ error: err.code }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not found") || message.includes("not_found")) {
    return c.json({ error: "not_found" }, 404);
  }
  if (message.includes("UNIQUE constraint")) {
    return c.json({ error: "already_exists" }, 409);
  }
  return c.json({ error: message }, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

class RouteHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
  }
}
