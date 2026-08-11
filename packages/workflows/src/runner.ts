import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type {
  JsonValue,
  WorkflowAssignmentMap,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRunEvent,
  WorkflowRunTrigger,
  WorkflowRunStatus,
  WorkflowStepAttempt,
  WorkflowStepStatus,
} from "./schemas.js";
import {
  isWorkflowTransformNodeType,
  WorkflowDefinitionSchema,
  WorkflowRunEventSchema,
  WorkflowStepAttemptSchema,
} from "./schemas.js";
import { normalizeWorkflowDefinitionGraph } from "./graph-contract.js";
import type { WorkflowExecutionPorts } from "./ports.js";

export interface WorkflowRunnerOptions {
  ports?: WorkflowExecutionPorts;
  now?: () => string;
}

export interface WorkflowRunnerRunRequest {
  runId?: string;
  definition: WorkflowDefinition;
  input?: JsonValue;
  trigger?: WorkflowRunTrigger;
  signal?: AbortSignal;
}

export interface WorkflowRunnerRunResult {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  status: WorkflowRunStatus;
  input: JsonValue;
  context: JsonValue;
  output?: JsonValue;
  stepAttempts: WorkflowStepAttempt[];
  events: WorkflowRunEvent[];
}

interface StepState {
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  status?: WorkflowStepStatus;
}

interface RunnerState {
  runId: string;
  definition: WorkflowDefinition;
  input: JsonValue;
  workflowTrigger: JsonObject;
  context: JsonObject;
  steps: Record<string, StepState>;
  foreachStack: ForeachFrame[];
  stepAttempts: WorkflowStepAttempt[];
  events: WorkflowRunEvent[];
  nextSequence: number;
  status: WorkflowRunStatus;
  output?: JsonValue;
  stopped: boolean;
  signal?: AbortSignal;
}

type JsonObject = { [key: string]: JsonValue };
type AssignmentMode = "replace" | "merge" | "append";
const MAX_TRANSFORM_OUTPUT_BYTES = 1_048_576;
const MAX_CSV_INPUT_BYTES = 1_048_576;
const DEFAULT_MAX_CSV_ROWS = 10_000;
const TRANSFORM_OPERATION_KINDS = new Set([
  "value.resolve",
  "object_pick",
  "string.replace",
  "string.regex_replace",
  "string.regex_match",
  "json.parse",
  "json.stringify",
  "csv.parse",
  "csv.stringify",
  "ip.parse",
  "ip.is_ipv4",
  "ip.is_ipv6",
  "ip.in_subnet",
  "ip.netmask",
  "ip.network",
  "uri.parse",
]);
type BranchSelection = JsonObject & {
  selected: string[];
  skipped: string[];
};
type RunnerEventInput = {
  stepRunId?: string | null;
  level: WorkflowRunEvent["level"];
  kind: WorkflowRunEvent["kind"];
  message?: string;
  payload?: JsonValue;
};
type ExecuteNodeOptions = {
  attempt?: number;
  path?: string[];
};
type ForeachFrame = {
  name: string;
  value: JsonValue;
  index: number;
  count: number;
  parentNodeId: string;
};
type ForeachItemOutput = JsonObject & {
  index: number;
  item: JsonValue;
  status: "succeeded" | "failed";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  steps: JsonObject;
  error?: JsonValue;
};
type ParallelBranchStatus = "succeeded" | "failed" | "canceled";
type ParallelBranchOutput = JsonObject & {
  id: string;
  label?: string;
  status: ParallelBranchStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  steps: JsonObject;
  context: JsonObject;
  error?: JsonValue;
};
type ParallelBranchRunResult = {
  output: ParallelBranchOutput;
  stepAttempts: WorkflowStepAttempt[];
  events: WorkflowRunEvent[];
};

class WorkflowNodeExecutionError extends Error {
  constructor(
    message: string,
    readonly opts: {
      preserveContext?: boolean;
      runFailedAlready?: boolean;
      status?: Extract<WorkflowRunStatus, "failed" | "canceled">;
      details?: JsonValue;
    } = {},
  ) {
    super(message);
    this.name = "WorkflowNodeExecutionError";
  }
}

export class WorkflowRunner {
  readonly ports: WorkflowExecutionPorts;
  private readonly now: () => string;

  constructor(opts: WorkflowRunnerOptions = {}) {
    this.ports = opts.ports ?? {};
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async run(req: WorkflowRunnerRunRequest): Promise<WorkflowRunnerRunResult> {
    const definition = normalizeWorkflowDefinitionGraph(
      WorkflowDefinitionSchema.parse(req.definition),
    );
    const input = cloneJson(req.input ?? {});
    const state: RunnerState = {
      runId: req.runId ?? randomUUID(),
      definition,
      input,
      workflowTrigger: {
        input: cloneJson(input),
        meta: workflowTriggerMeta(req.trigger),
      },
      context: {},
      steps: {},
      foreachStack: [],
      stepAttempts: [],
      events: [],
      nextSequence: 1,
      status: "running",
      stopped: false,
      ...(req.signal ? { signal: req.signal } : {}),
    };

    await this.appendEvent(state, {
      level: "system",
      kind: "run_started",
      message: "Workflow run started",
    });

    const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
    const entryNode = definition.nodes[0];
    if (entryNode) {
      await this.executeNode(state, entryNode, nodesById);
    }

    if (state.status === "running") {
      state.status = "succeeded";
      state.output = cloneJson(state.context);
      await this.appendEvent(state, {
        level: "system",
        kind: "run_completed",
        message: "Workflow run completed",
        payload: { status: state.status },
      });
    }

    return {
      runId: state.runId,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: state.status,
      input: cloneJson(state.input),
      context: cloneJson(state.context),
      output: state.output === undefined ? undefined : cloneJson(state.output),
      stepAttempts: state.stepAttempts.map((step) => cloneJson(step)),
      events: state.events.map((event) => cloneJson(event)),
    };
  }

  private async executeNode(
    state: RunnerState,
    node: WorkflowNode,
    nodesById: Map<string, WorkflowNode>,
    opts: ExecuteNodeOptions = {},
  ): Promise<void> {
    if (opts.path?.includes(node.id)) {
      throw new Error(
        `Workflow cycle detected: ${[...opts.path, node.id].join(" -> ")}`,
      );
    }
    const path = [...(opts.path ?? []), node.id];
    const startedAt = this.now();
    const attempt = opts.attempt ?? 1;
    const attemptId = `${state.runId}:${node.id}:${attempt}`;
    const beforeContext = cloneJson(state.context);
    const inputAtStart = safeResolvedStepInput(state, node);
    recordStepRunning(state, node.id, inputAtStart);
    await this.appendEvent(state, {
      stepRunId: attemptId,
      level: "system",
      kind: "step_started",
      message: `Step ${node.id} started`,
      payload: {
        nodeId: node.id,
        nodeType: node.type,
        ...(node.label ? { nodeLabel: node.label } : {}),
        ...(inputAtStart !== undefined ? { input: inputAtStart } : {}),
      },
    });
    const stepEventStartIndex = state.events.length;

    try {
      const output = await this.executeBuiltin(state, node, attemptId);
      const endedAt = this.now();
      const contextDiff = diffAssignedContext(beforeContext, state.context);
      const logsSummary = buildStepLogsSummary(
        node,
        output,
        undefined,
        state.events.slice(stepEventStartIndex),
      );
      const step = WorkflowStepAttemptSchema.parse({
        id: attemptId,
        runId: state.runId,
        nodeId: node.id,
        attempt,
        status: completedStepStatus(node),
        startedAt,
        endedAt,
        durationMs: stepDurationMs(startedAt, endedAt),
        input: resolvedStepInput(state, node),
        output,
        logsSummary,
        contextDiff,
      });
      state.stepAttempts.push(step);
      recordStepSucceeded(state, node.id, step.input, output, step.status);
      if (
        (isWorkflowTransformNodeType(node.type) ||
          node.type === "builtin.foreach" ||
          node.type === "builtin.parallel" ||
          node.type === "builtin.python" ||
          node.type === "mcp.tool" ||
          node.type === "agent.call") &&
        output !== undefined
      ) {
        await this.appendEvent(state, {
          stepRunId: step.id,
          level: "system",
          kind: "step_output",
          message: `Step ${node.id} produced output`,
          payload: output,
        });
      }
      await this.appendCompletedStepEvent(state, step, output);
      if (
        node.type === "builtin.if" ||
        node.type === "builtin.if_else" ||
        node.type === "builtin.switch"
      ) {
        const branch = output as BranchSelection;
        this.recordSkippedSteps(state, branch.skipped, attempt);
        await this.executeSelectedBranch(state, nodesById, branch.selected, {
          attempt,
          path,
        });
      }
      await this.executeNextNodes(state, nodesById, node.next, {
        attempt,
        path,
      });
    } catch (err) {
      const workflowErr =
        err instanceof WorkflowNodeExecutionError ? err : null;
      if (!workflowErr?.opts.preserveContext) {
        state.context = beforeContext;
      }
      const terminalStatus = workflowErr?.opts.status ?? "failed";
      state.status = terminalStatus;
      state.stopped = true;
      const endedAt = this.now();
      const error = errorToJson(err);
      const logsSummary = buildStepLogsSummary(
        node,
        undefined,
        error,
        state.events.slice(stepEventStartIndex),
      );
      const step = WorkflowStepAttemptSchema.parse({
        id: attemptId,
        runId: state.runId,
        nodeId: node.id,
        attempt,
        status: terminalStatus === "canceled" ? "canceled" : "failed",
        startedAt,
        endedAt,
        durationMs: stepDurationMs(startedAt, endedAt),
        input: safeResolvedStepInput(state, node),
        error,
        logsSummary,
      });
      state.stepAttempts.push(step);
      recordStepFailed(state, node.id, step.input, error, step.status);
      await this.appendEvent(state, {
        stepRunId: step.id,
        level: "error",
        kind: "step_failed",
        message: `Step ${node.id} failed`,
        payload: error,
      });
      if (!workflowErr?.opts.runFailedAlready) {
        const terminalEvent =
          terminalStatus === "canceled"
            ? {
                level: "system" as const,
                kind: "run_canceled" as const,
                message: "Workflow run canceled",
              }
            : {
                level: "system" as const,
                kind: "run_failed" as const,
                message: "Workflow run failed",
              };
        await this.appendEvent(state, {
          level: terminalEvent.level,
          kind: terminalEvent.kind,
          message: terminalEvent.message,
          payload: { nodeId: node.id, error },
        });
      }
    }
  }

  private async executeBuiltin(
    state: RunnerState,
    node: WorkflowNode,
    attemptId: string,
  ): Promise<JsonValue | undefined> {
    switch (node.type) {
      case "builtin.set": {
        const assigned = applyAssignments(state, node.assign);
        return { assigned };
      }

      default:
        if (isWorkflowTransformNodeType(node.type)) {
          const input = resolvedNodeInput(state, node);
          const value = applyTransform(state, input, node.transform);
          const output: JsonObject = { value };
          recordStepOutput(state, node.id, output);
          if (node.assign) applyAssignments(state, node.assign);
          return output;
        }
        throw new Error(`Unsupported workflow node type: ${node.type}`);

      case "builtin.if": {
        const matches = evaluateCondition(state, node.condition);
        const selected = matches ? node.then : node.else;
        const skipped = matches ? node.else : node.then;
        await this.appendBranchEvent(state, node.condition, selected, skipped);
        return { result: matches, selected, skipped };
      }

      case "builtin.if_else": {
        const matches = evaluateCondition(state, node.condition);
        const selected = matches ? node.then : node.else;
        const skipped = matches ? node.else : node.then;
        await this.appendBranchEvent(state, node.condition, selected, skipped);
        return { result: matches, selected, skipped };
      }

      case "builtin.switch": {
        const value = resolveJsonValue(state, node.value);
        const matched = node.cases.find((item) => jsonEquals(item.value, value));
        const selected = matched ? matched.nodes : node.default;
        const skipped = uniqueNodeIds([
          ...node.cases.flatMap((item) => item.nodes),
          ...node.default,
        ]).filter((nodeId) => !selected.includes(nodeId));
        await this.appendBranchEvent(state, `switch ${JSON.stringify(value)}`, selected, skipped);
        return {
          value,
          selected,
          skipped,
          matched: matched !== undefined,
          ...(matched ? { case: matched.id } : { case: "default" }),
        };
      }

      case "builtin.log.info":
      case "builtin.log.debug":
      case "builtin.log.warn":
      case "builtin.log.error": {
        const level = node.type.replace("builtin.log.", "") as
          | "info"
          | "debug"
          | "warn"
          | "error";
        const payload =
          node.payload === undefined
            ? undefined
            : resolveJsonValue(state, node.payload);
        const output: JsonObject =
          payload === undefined
            ? { message: node.message }
            : { message: node.message, payload };
        recordStepOutput(state, node.id, output);
        await this.appendEvent(state, {
          stepRunId: attemptId,
          level,
          kind: "log",
          message: node.message,
          payload,
        });
        if (node.assign) applyAssignments(state, node.assign);
        return output;
      }

      case "builtin.exit": {
        state.status = node.status;
        state.output =
          node.output === undefined
            ? undefined
            : resolveJsonValue(state, node.output);
        state.stopped = true;
        const terminalEvent = terminalExitEvent(node.status);
        await this.appendEvent(state, {
          stepRunId: attemptId,
          level: terminalEvent.level,
          kind: terminalEvent.kind,
          message: terminalEvent.message,
          payload:
            state.output === undefined
              ? { status: node.status }
              : { status: node.status, output: state.output },
        });
        return state.output === undefined
          ? { status: node.status }
          : { status: node.status, output: state.output };
      }

      case "builtin.throw_error": {
        const details: JsonObject = {};
        if (node.code !== undefined) details.code = node.code;
        if (node.details !== undefined) {
          details.details = resolveJsonValue(state, node.details);
        }
        throw new WorkflowNodeExecutionError(node.message, {
          details: Object.keys(details).length > 0 ? details : undefined,
        });
      }

      case "builtin.sleep": {
        await sleep(node.delayMs, state.signal);
        const output: JsonObject = { delayMs: node.delayMs };
        if (node.reason !== undefined) output.reason = node.reason;
        recordStepOutput(state, node.id, output);
        return output;
      }

      case "mcp.tool":
        return this.executeMcpTool(state, node);

      case "agent.call":
        return this.executeAgentCall(state, node);

      case "builtin.foreach":
        return this.executeForeach(state, node, attemptId);

      case "builtin.parallel":
        return this.executeParallel(state, node, attemptId);

      case "builtin.python":
        return this.executePython(state, node);
    }
  }

  private async executeForeach(
    state: RunnerState,
    node: Extract<WorkflowNode, { type: "builtin.foreach" }>,
    attemptId: string,
  ): Promise<JsonValue> {
    const concurrency = node.concurrency ?? 1;
    if (concurrency !== 1) {
      throw new Error("builtin.foreach currently supports concurrency: 1");
    }
    const items = resolveJsonValue(state, node.items);
    if (!Array.isArray(items)) {
      throw new Error("builtin.foreach items must resolve to an array");
    }

    const nodesById = new Map(
      state.definition.nodes.map((workflowNode) => [
        workflowNode.id,
        workflowNode,
      ]),
    );
    const outputs: ForeachItemOutput[] = [];
    let succeededCount = 0;
    let failedCount = 0;

    await this.appendEvent(state, {
      stepRunId: attemptId,
      level: "system",
      kind: "log",
      message: `Foreach ${node.id} started`,
      payload: { count: items.length, itemVar: node.itemVar, concurrency },
    });

    for (let index = 0; index < items.length; index++) {
      const item = cloneJson(items[index]!);
      const itemStartedAt = this.now();
      const beforeStepOutputs = snapshotStepOutputs(state);
      state.foreachStack.push({
        name: node.itemVar,
        value: item,
        index,
        count: items.length,
        parentNodeId: node.id,
      });
      try {
        await this.appendEvent(state, {
          stepRunId: attemptId,
          level: "system",
          kind: "log",
          message: `Foreach item ${index + 1} started`,
          payload: { index, item },
        });
        for (const nodeId of node.body) {
          if (state.stopped) break;
          const bodyNode = nodesById.get(nodeId);
          if (!bodyNode) {
            throw new Error(`Foreach references unknown node: ${nodeId}`);
          }
          await this.executeNode(state, bodyNode, nodesById, {
            attempt: index + 1,
          });
        }
        if (state.status !== "running") {
          const itemEndedAt = this.now();
          const itemOutput: ForeachItemOutput = {
            index,
            item,
            status: "failed",
            startedAt: itemStartedAt,
            endedAt: itemEndedAt,
            durationMs: stepDurationMs(itemStartedAt, itemEndedAt),
            steps: itemStepOutputs(state, beforeStepOutputs),
          };
          const itemError = latestFailedStepError(state);
          if (itemError !== undefined) itemOutput.error = itemError;
          outputs.push(itemOutput);
          failedCount += 1;
          throw new WorkflowNodeExecutionError(
            `Foreach item ${index + 1} failed`,
            {
              preserveContext: true,
              runFailedAlready: true,
              details: itemOutput,
            },
          );
        }
        const itemEndedAt = this.now();
        const itemOutput: ForeachItemOutput = {
          index,
          item,
          status: "succeeded",
          startedAt: itemStartedAt,
          endedAt: itemEndedAt,
          durationMs: stepDurationMs(itemStartedAt, itemEndedAt),
          steps: itemStepOutputs(state, beforeStepOutputs),
        };
        outputs.push(itemOutput);
        succeededCount += 1;
        await this.appendEvent(state, {
          stepRunId: attemptId,
          level: "system",
          kind: "log",
          message: `Foreach item ${index + 1} completed`,
          payload: itemOutput,
        });
      } finally {
        state.foreachStack.pop();
      }
    }

    const output: JsonObject = {
      count: items.length,
      succeededCount,
      failedCount,
      items: outputs,
    };
    recordStepOutput(state, node.id, output);
    if (node.assign) applyAssignments(state, node.assign);
    return output;
  }

  private async executeParallel(
    state: RunnerState,
    node: Extract<WorkflowNode, { type: "builtin.parallel" }>,
    attemptId: string,
  ): Promise<JsonValue> {
    const concurrency = node.concurrency ?? node.branches.length;
    const nodesById = new Map(
      state.definition.nodes.map((workflowNode) => [
        workflowNode.id,
        workflowNode,
      ]),
    );
    const parentContext = cloneJson(state.context);
    const parentSteps = cloneStepState(state.steps);
    const branchResults = new Map<string, ParallelBranchRunResult>();
    const branchControllers = new Map<string, AbortController>();
    let firstFailure: ParallelBranchRunResult | undefined;

    const abortBranches = () => {
      for (const controller of branchControllers.values()) {
        controller.abort();
      }
    };
    if (state.signal?.aborted) abortBranches();
    state.signal?.addEventListener("abort", abortBranches, { once: true });

    await this.appendEvent(state, {
      stepRunId: attemptId,
      level: "system",
      kind: "parallel_started",
      message: `Parallel ${node.id} started`,
      payload: {
        count: node.branches.length,
        concurrency,
        failFast: node.failFast,
      },
    });

    try {
      await runLimited(
        node.branches,
        concurrency,
        async (branch, branchIndex) => {
          if (node.failFast && firstFailure) return;
          const controller = new AbortController();
          branchControllers.set(branch.id, controller);
          if (state.signal?.aborted) controller.abort();
          await this.appendEvent(state, {
            stepRunId: attemptId,
            level: "system",
            kind: "parallel_branch_started",
            message: `Parallel branch ${branch.id} started`,
            payload: {
              branchId: branch.id,
              ...(branch.label ? { label: branch.label } : {}),
            },
          });
          const result = await this.executeParallelBranch(
            state,
            node,
            branch,
            branchIndex,
            nodesById,
            parentContext,
            parentSteps,
            controller.signal,
          );
          branchResults.set(branch.id, result);
          state.stepAttempts.push(...result.stepAttempts);
          await this.appendBranchEvents(state, result.events);
          const eventKind =
            result.output.status === "succeeded"
              ? "parallel_branch_completed"
              : "parallel_branch_failed";
          await this.appendEvent(state, {
            stepRunId: attemptId,
            level: result.output.status === "succeeded" ? "system" : "error",
            kind: eventKind,
            message:
              result.output.status === "succeeded"
                ? `Parallel branch ${branch.id} completed`
                : `Parallel branch ${branch.id} failed`,
            payload: result.output,
          });
          if (result.output.status !== "succeeded" && !firstFailure) {
            firstFailure = result;
            if (node.failFast) abortBranches();
          }
        },
      );
    } finally {
      state.signal?.removeEventListener("abort", abortBranches);
    }

    const branches = parallelBranchesObject(node, branchResults);
    const branchValues = Object.values(branches) as ParallelBranchOutput[];
    const succeededCount = branchValues.filter(
      (branch) => branch.status === "succeeded",
    ).length;
    const failedCount = branchValues.filter(
      (branch) => branch.status === "failed",
    ).length;
    const canceledCount = branchValues.filter(
      (branch) => branch.status === "canceled",
    ).length;
    const output: JsonObject = {
      count: node.branches.length,
      succeededCount,
      failedCount,
      canceledCount,
      failFast: node.failFast,
      branches,
      branchOrder: node.branches.map((branch) => branch.id),
    };
    recordStepOutput(state, node.id, output);

    if (firstFailure && node.failFast) {
      await this.appendEvent(state, {
        stepRunId: attemptId,
        level: "error",
        kind: "parallel_failed",
        message: `Parallel ${node.id} failed`,
        payload: output,
      });
      throw new WorkflowNodeExecutionError(
        `Parallel ${node.id} failed in branch ${firstFailure.output.id}`,
        {
          preserveContext: true,
          details: output,
        },
      );
    }

    if (node.assign) applyAssignments(state, node.assign);
    await this.appendEvent(state, {
      stepRunId: attemptId,
      level: failedCount > 0 || canceledCount > 0 ? "warn" : "system",
      kind: "parallel_completed",
      message: `Parallel ${node.id} completed`,
      payload: output,
    });
    return output;
  }

  private async executeParallelBranch(
    parentState: RunnerState,
    parallelNode: Extract<WorkflowNode, { type: "builtin.parallel" }>,
    branch: Extract<
      WorkflowNode,
      { type: "builtin.parallel" }
    >["branches"][number],
    branchIndex: number,
    nodesById: Map<string, WorkflowNode>,
    parentContext: JsonObject,
    parentSteps: Record<string, StepState>,
    signal: AbortSignal,
  ): Promise<ParallelBranchRunResult> {
    const startedAt = this.now();
    const branchState: RunnerState = {
      ...parentState,
      context: cloneJson(parentContext),
      steps: cloneStepState(parentSteps),
      foreachStack: parentState.foreachStack.map((frame) => ({
        ...frame,
        value: cloneJson(frame.value),
      })),
      stepAttempts: [],
      events: [],
      nextSequence: 1,
      status: "running",
      output: undefined,
      stopped: false,
      signal,
    };
    try {
      for (const nodeId of branch.nodes) {
        if (branchState.stopped) break;
        const bodyNode = nodesById.get(nodeId);
        if (!bodyNode) {
          throw new Error(
            `Parallel branch ${branch.id} references unknown node: ${nodeId}`,
          );
        }
        await this.executeNode(branchState, bodyNode, nodesById, {
          attempt: branchIndex + 1,
        });
      }
    } catch (err) {
      if (branchState.status === "running") {
        branchState.status =
          err instanceof WorkflowNodeExecutionError &&
          err.opts.status === "canceled"
            ? "canceled"
            : "failed";
        const step = WorkflowStepAttemptSchema.parse({
          id: `${parentState.runId}:${parallelNode.id}.${branch.id}:${branchIndex + 1}`,
          runId: parentState.runId,
          nodeId: `${parallelNode.id}.${branch.id}`,
          attempt: branchIndex + 1,
          status: branchState.status === "canceled" ? "canceled" : "failed",
          startedAt,
          endedAt: this.now(),
          durationMs: 0,
          error: errorToJson(err),
        });
        branchState.stepAttempts.push(step);
      }
    }
    const endedAt = this.now();
    const status: ParallelBranchStatus =
      branchState.status === "canceled"
        ? "canceled"
        : branchState.status === "failed"
          ? "failed"
          : "succeeded";
    const error = latestFailedStepError(branchState);
    const output: ParallelBranchOutput = {
      id: branch.id,
      ...(branch.label ? { label: branch.label } : {}),
      status,
      startedAt,
      endedAt,
      durationMs: stepDurationMs(startedAt, endedAt),
      steps: itemStepOutputs(
        branchState,
        stepOutputsFromStepState(parentSteps),
      ),
      context: cloneJson(branchState.context),
    };
    if (error !== undefined) output.error = error;
    return {
      output,
      stepAttempts: branchState.stepAttempts,
      events: branchState.events,
    };
  }

  private async executeMcpTool(
    state: RunnerState,
    node: Extract<WorkflowNode, { type: "mcp.tool" }>,
  ): Promise<JsonValue> {
    if (!this.ports.mcp) {
      throw new Error("Workflow MCP execution port is not configured");
    }
    const input = resolvedNodeInput(state, node) ?? {};
    const result = await this.ports.mcp.callTool({
      server: node.server,
      tool: node.tool,
      input,
      timeoutMs: node.timeoutMs,
      ...(state.signal ? { signal: state.signal } : {}),
    });
    const output: JsonObject = {
      server: node.server,
      tool: node.tool,
      result: result.output,
    };
    recordStepOutput(state, node.id, output);
    if (node.assign) applyAssignments(state, node.assign);
    return output;
  }

  private async executeAgentCall(
    state: RunnerState,
    node: Extract<WorkflowNode, { type: "agent.call" }>,
  ): Promise<JsonValue> {
    if (!this.ports.agent) {
      throw new Error("Workflow agent call port is not configured");
    }
    const input = resolvedNodeInput(state, node) ?? {};
    const prompt = renderStringTemplate(state, node.prompt);
    const result = await this.ports.agent.callAgent({
      agentId: node.agentId,
      prompt,
      input,
      runId: state.runId,
      timeoutMs: node.timeoutMs,
      ...(state.signal ? { signal: state.signal } : {}),
    });
    const output = isJsonObject(result.output)
      ? {
          ...result.output,
          ...(result.sessionId !== undefined &&
          result.output["sessionId"] === undefined
            ? { sessionId: result.sessionId }
            : {}),
        }
      : {
          response: result.output,
          ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        };
    recordStepOutput(state, node.id, output);
    if (node.assign) applyAssignments(state, node.assign);
    return output;
  }

  private async executePython(
    state: RunnerState,
    node: Extract<WorkflowNode, { type: "builtin.python" }>,
  ): Promise<JsonValue> {
    if (!this.ports.python) {
      throw new Error("Workflow Python execution port is not configured");
    }
    const input = resolvedNodeInput(state, node) ?? {};
    const result = await this.ports.python.execute({
      code: node.code,
      input,
      reset: node.reset,
      timeoutMs: node.timeoutMs,
      ...(state.signal ? { signal: state.signal } : {}),
    });
    const output: JsonObject = { value: result.output };
    if (result.stdout !== undefined) output.stdout = result.stdout;
    if (result.stderr !== undefined) output.stderr = result.stderr;
    recordStepOutput(state, node.id, output);
    if (node.assign) applyAssignments(state, node.assign);
    return output;
  }

  private async appendBranchEvent(
    state: RunnerState,
    condition: string,
    selected: string[],
    skipped: string[],
  ): Promise<void> {
    await this.appendEvent(state, {
      level: "system",
      kind: "branch_selected",
      message: "Branch selected",
      payload: { condition, selected, skipped },
    });
  }

  private async appendCompletedStepEvent(
    state: RunnerState,
    step: WorkflowStepAttempt,
    output: JsonValue | undefined,
  ): Promise<void> {
    if (step.status === "failed") {
      await this.appendEvent(state, {
        stepRunId: step.id,
        level: "error",
        kind: "step_failed",
        message: `Step ${step.nodeId} failed`,
        payload:
          output === undefined
            ? { status: step.status }
            : { status: step.status, output },
      });
      return;
    }
    await this.appendEvent(state, {
      stepRunId: step.id,
      level: "system",
      kind: "step_completed",
      message: `Step ${step.nodeId} completed`,
      payload: { status: step.status },
    });
  }

  private async executeSelectedBranch(
    state: RunnerState,
    nodesById: Map<string, WorkflowNode>,
    selected: string[],
    opts: ExecuteNodeOptions = {},
  ): Promise<void> {
    for (const nodeId of selected) {
      if (state.stopped) break;
      const branchNode = nodesById.get(nodeId);
      if (!branchNode)
        throw new Error(`Branch references unknown node: ${nodeId}`);
      await this.executeNode(state, branchNode, nodesById, opts);
    }
  }

  private async executeNextNodes(
    state: RunnerState,
    nodesById: Map<string, WorkflowNode>,
    next: string[],
    opts: ExecuteNodeOptions = {},
  ): Promise<void> {
    for (const nodeId of next) {
      if (state.stopped) break;
      const nextNode = nodesById.get(nodeId);
      if (!nextNode) throw new Error(`Next references unknown node: ${nodeId}`);
      await this.executeNode(state, nextNode, nodesById, opts);
    }
  }

  private recordSkippedSteps(
    state: RunnerState,
    skipped: string[],
    attempt = 1,
  ): void {
    for (const nodeId of skipped) {
      this.recordSkippedStep(state, nodeId, attempt);
    }
  }

  private recordSkippedStep(
    state: RunnerState,
    nodeId: string,
    attempt: number,
  ): void {
    const skippedAt = this.now();
    state.stepAttempts.push(
      WorkflowStepAttemptSchema.parse({
        id: `${state.runId}:${nodeId}:${attempt}`,
        runId: state.runId,
        nodeId,
        attempt,
        status: "skipped",
        startedAt: skippedAt,
        endedAt: skippedAt,
        durationMs: 0,
      }),
    );
  }

  private async appendEvent(
    state: RunnerState,
    event: RunnerEventInput,
  ): Promise<void> {
    const parsed = WorkflowRunEventSchema.parse({
      id: randomUUID(),
      runId: state.runId,
      sequence: state.nextSequence++,
      createdAt: this.now(),
      ...event,
    });
    state.events.push(parsed);
    await this.ports.events?.append({
      runId: parsed.runId,
      stepRunId: parsed.stepRunId,
      level: parsed.level,
      kind: parsed.kind,
      message: parsed.message,
      payload: parsed.payload,
    });
  }

  private async appendBranchEvents(
    state: RunnerState,
    events: WorkflowRunEvent[],
  ): Promise<void> {
    for (const event of events) {
      await this.appendEvent(state, {
        stepRunId: event.stepRunId,
        level: event.level,
        kind: event.kind,
        message: event.message,
        payload: event.payload,
      });
    }
  }
}

function collectBranchNodeIds(nodes: WorkflowNode[]): Set<string> {
  const branchNodeIds = new Set<string>();
  for (const node of nodes) {
    if (node.type === "builtin.if") {
      node.then.forEach((nodeId) => branchNodeIds.add(nodeId));
      node.else.forEach((nodeId) => branchNodeIds.add(nodeId));
    }
    if (node.type === "builtin.if_else") {
      node.then.forEach((nodeId) => branchNodeIds.add(nodeId));
      node.else.forEach((nodeId) => branchNodeIds.add(nodeId));
    }
    if (node.type === "builtin.switch") {
      for (const item of node.cases) {
        item.nodes.forEach((nodeId) => branchNodeIds.add(nodeId));
      }
      node.default.forEach((nodeId) => branchNodeIds.add(nodeId));
    }
    if (node.type === "builtin.foreach") {
      node.body.forEach((nodeId) => branchNodeIds.add(nodeId));
    }
    if (node.type === "builtin.parallel") {
      for (const branch of node.branches) {
        branch.nodes.forEach((nodeId) => branchNodeIds.add(nodeId));
      }
    }
  }
  return branchNodeIds;
}

function resolvedNodeInput(
  state: RunnerState,
  node: WorkflowNode,
): JsonValue | undefined {
  if (!("input" in node) || node.input === undefined) return undefined;
  return resolveJsonValue(state, node.input);
}

function resolvedStepInput(
  state: RunnerState,
  node: WorkflowNode,
): JsonValue | undefined {
  switch (node.type) {
    case "builtin.set":
      return { assign: resolvedAssignments(state, node.assign) };

    default:
      if (isWorkflowTransformNodeType(node.type)) {
      const request: JsonObject = {
        input: resolvedNodeInput(state, node) ?? {},
        transform: cloneJson(node.transform),
      };
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
      }
      throw new Error(`Unsupported workflow node type: ${node.type}`);

    case "builtin.if":
    case "builtin.if_else": {
      const matches = evaluateCondition(state, node.condition);
      return {
        condition: node.condition,
        result: matches,
        selected: matches ? node.then : node.else,
        skipped: matches ? node.else : node.then,
      };
    }

    case "builtin.switch": {
      const value = resolveJsonValue(state, node.value);
      const matched = node.cases.find((item) => jsonEquals(item.value, value));
      const selected = matched ? matched.nodes : node.default;
      const skipped = uniqueNodeIds([
        ...node.cases.flatMap((item) => item.nodes),
        ...node.default,
      ]).filter((nodeId) => !selected.includes(nodeId));
      return {
        value,
        selected,
        skipped,
        ...(matched ? { case: matched.id } : { case: "default" }),
      };
    }

    case "builtin.foreach": {
      const request: JsonObject = {
        input: resolvedNodeInput(state, node) ?? {},
        items: resolveJsonValue(state, node.items),
        itemVar: node.itemVar,
        body: node.body,
      };
      if (node.concurrency !== undefined) request.concurrency = node.concurrency;
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
    }

    case "builtin.exit": {
      const request: JsonObject = { status: node.status };
      if (node.output !== undefined) {
        request.output = resolveJsonValue(state, node.output);
      }
      return request;
    }

    case "builtin.throw_error": {
      const request: JsonObject = { message: node.message };
      if (node.code !== undefined) request.code = node.code;
      if (node.details !== undefined) {
        request.details = resolveJsonValue(state, node.details);
      }
      return request;
    }

    case "builtin.sleep": {
      const request: JsonObject = { delayMs: node.delayMs };
      if (node.reason !== undefined) request.reason = node.reason;
      return request;
    }

    case "builtin.log.info":
    case "builtin.log.debug":
    case "builtin.log.warn":
    case "builtin.log.error": {
      const request: JsonObject = {
        level: node.type.replace("builtin.log.", ""),
        input: resolvedNodeInput(state, node) ?? {},
        message: node.message,
      };
      if (node.payload !== undefined) {
        request.payload = resolveJsonValue(state, node.payload);
      }
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
    }

    case "builtin.parallel": {
      const request: JsonObject = {
        input: resolvedNodeInput(state, node) ?? {},
        branches: node.branches.map((branch) => ({
          id: branch.id,
          ...(branch.label ? { label: branch.label } : {}),
          nodes: branch.nodes,
        })),
        concurrency: node.concurrency ?? node.branches.length,
        failFast: node.failFast,
      };
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
    }

    case "builtin.python": {
      const request: JsonObject = {
        code: node.code,
        input: resolvedNodeInput(state, node) ?? {},
      };
      if (node.reset !== undefined) request.reset = node.reset;
      if (node.timeoutMs !== undefined) request.timeoutMs = node.timeoutMs;
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
    }

    case "mcp.tool": {
      const request: JsonObject = {
        server: node.server,
        tool: node.tool,
        input: resolvedNodeInput(state, node) ?? {},
      };
      if (node.timeoutMs !== undefined) request.timeoutMs = node.timeoutMs;
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
    }

    case "agent.call": {
      const request: JsonObject = {
        agentId: node.agentId,
        prompt: renderStringTemplate(state, node.prompt),
        input: resolvedNodeInput(state, node) ?? {},
      };
      if (node.timeoutMs !== undefined) request.timeoutMs = node.timeoutMs;
      if (node.assign) request.assign = resolvedAssignments(state, node.assign);
      return request;
    }
  }
}

function safeResolvedStepInput(
  state: RunnerState,
  node: WorkflowNode,
): JsonValue | undefined {
  try {
    return resolvedStepInput(state, node);
  } catch {
    return undefined;
  }
}

function resolvedAssignments(
  state: RunnerState,
  assignments: WorkflowAssignmentMap,
): JsonObject {
  const assigned: JsonObject = {};
  for (const [path, assignment] of Object.entries(assignments)) {
    const source =
      typeof assignment === "string" ? assignment : assignment.from;
    const mode = typeof assignment === "string" ? "replace" : assignment.mode;
    const item: JsonObject = {
      from: source,
      mode,
    };
    const value = tryResolveJsonValue(state, source);
    if (value !== undefined) item.value = value;
    assigned[path] = item;
  }
  return assigned;
}

function tryResolveJsonValue(
  state: RunnerState,
  reference: JsonValue,
): JsonValue | undefined {
  try {
    return resolveJsonValue(state, reference);
  } catch {
    return undefined;
  }
}

function applyAssignments(
  state: RunnerState,
  assignments: WorkflowAssignmentMap,
): JsonObject {
  const assigned: JsonObject = {};
  for (const [path, assignment] of Object.entries(assignments)) {
    const source =
      typeof assignment === "string" ? assignment : assignment.from;
    const mode = typeof assignment === "string" ? "replace" : assignment.mode;
    const value = resolveJsonValue(state, source);
    setContextPath(state.context, path, value, mode);
    assigned[path] = cloneJson(value);
  }
  return assigned;
}

function applyTransform(
  state: RunnerState,
  input: JsonValue | undefined,
  transform: JsonValue,
): JsonValue {
  const output = applyTransformValue(state, input, transform);
  assertTransformOutputSize(output);
  return output;
}

function applyTransformValue(
  state: RunnerState,
  input: JsonValue | undefined,
  transform: JsonValue,
): JsonValue {
  if (typeof transform === "string") {
    return resolveJsonValue(state, transform);
  }
  if (!isJsonObject(transform)) return cloneJson(transform);
  const operationKind = transformOperationKind(transform);
  if (operationKind === undefined) return resolveJsonValue(state, transform);
  switch (operationKind) {
    case "value.resolve":
      return requiredTransformField(state, transform, operationKind, "value");
    case "object_pick":
      return applyObjectPickTransform(input, transform);
    case "string.replace":
      return applyStringReplaceTransform(state, transform);
    case "string.regex_replace":
      return applyRegexReplaceTransform(state, transform);
    case "string.regex_match":
      return applyRegexMatchTransform(state, transform);
    case "json.parse":
      return applyJsonParseTransform(state, transform);
    case "json.stringify":
      return applyJsonStringifyTransform(state, transform);
    case "csv.parse":
      return applyCsvParseTransform(state, transform);
    case "csv.stringify":
      return applyCsvStringifyTransform(state, transform);
    case "ip.parse":
      return applyIpParseTransform(state, transform);
    case "ip.is_ipv4":
      return applyIpVersionCheckTransform(state, transform, 4);
    case "ip.is_ipv6":
      return applyIpVersionCheckTransform(state, transform, 6);
    case "ip.in_subnet":
      return applyIpInSubnetTransform(state, transform);
    case "ip.netmask":
      return applyIpNetmaskTransform(state, transform);
    case "ip.network":
      return applyIpNetworkTransform(state, transform);
    case "uri.parse":
      return applyUriParseTransform(state, transform);
    default:
      throw unsupportedTransformOperationError(operationKind);
  }
}

function transformOperationKind(transform: JsonObject): string | undefined {
  const kind = transform.kind;
  if (typeof kind !== "string") return undefined;
  if (TRANSFORM_OPERATION_KINDS.has(kind) || kind.includes(".")) return kind;
  return undefined;
}

function applyObjectPickTransform(
  input: JsonValue | undefined,
  transform: JsonObject,
): JsonValue {
  const fields = transform.fields;
  if (
    !Array.isArray(fields) ||
    !fields.every((field) => typeof field === "string")
  ) {
    throw transformFieldError("object_pick", "fields", "string[]", fields);
  }
  const rawSource = transform.source;
  if (rawSource !== undefined && typeof rawSource !== "string") {
    throw transformFieldError("object_pick", "source", "string", rawSource);
  }
  const source = pickTransformSource(input, rawSource);
  const out: JsonObject = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = cloneJson(source[field]!);
    }
  }
  return out;
}

function applyStringReplaceTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "string.replace";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const search = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "search",
  );
  const replacement = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "replacement",
  );
  const all = optionalBooleanTransformField(transform, operationKind, "all");
  return all
    ? value.split(search).join(replacement)
    : value.replace(search, replacement);
}

function applyRegexReplaceTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "string.regex_replace";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const pattern = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "pattern",
  );
  const replacement = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "replacement",
  );
  const flags =
    optionalStringTransformField(state, transform, operationKind, "flags") ??
    "";
  return value.replace(safeRegExp(operationKind, pattern, flags), replacement);
}

function applyRegexMatchTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "string.regex_match";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const pattern = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "pattern",
  );
  const flags =
    optionalStringTransformField(state, transform, operationKind, "flags") ??
    "";
  const regex = safeRegExp(operationKind, pattern, flags);
  const match = regex.exec(value);
  if (!match) {
    return { matched: false, groups: [], namedGroups: {} };
  }
  const groups = match.slice(1).map((item) => item ?? "");
  const namedGroups: JsonObject = {};
  for (const [key, item] of Object.entries(match.groups ?? {})) {
    namedGroups[key] = item ?? "";
  }
  return {
    matched: true,
    match: match[0],
    index: match.index,
    groups,
    namedGroups,
  };
}

function applyJsonParseTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "json.parse";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonValue(parsed)) {
      throw new Error("parsed value is not JSON-compatible");
    }
    return parsed;
  } catch (err) {
    throw new WorkflowNodeExecutionError(
      `Transform operation ${operationKind} could not parse JSON`,
      {
        details: {
          operationKind,
          message: err instanceof Error ? err.message : String(err),
        },
      },
    );
  }
}

function applyJsonStringifyTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "json.stringify";
  const value = requiredTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const pretty = optionalBooleanTransformField(
    transform,
    operationKind,
    "pretty",
  );
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

function applyCsvParseTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "csv.parse";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  assertCsvInputSize(value, operationKind);
  const delimiter =
    optionalStringTransformField(
      state,
      transform,
      operationKind,
      "delimiter",
    ) ?? ",";
  if (delimiter.length !== 1) {
    throw transformFieldError(
      operationKind,
      "delimiter",
      "single character",
      delimiter,
    );
  }
  const maxRows =
    optionalPositiveIntegerTransformField(
      transform,
      operationKind,
      "maxRows",
    ) ?? DEFAULT_MAX_CSV_ROWS;
  const rows = parseCsvRows(operationKind, value, delimiter);
  const hasHeaders =
    optionalBooleanTransformField(transform, operationKind, "headers") ?? true;
  if (!hasHeaders) {
    assertCsvRowCount(operationKind, rows.length, maxRows);
    return rows;
  }
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  const dataRows = rows.slice(1);
  assertCsvRowCount(operationKind, dataRows.length, maxRows);
  return dataRows.map((row) => {
    const out: JsonObject = {};
    headers.forEach((header, index) => {
      out[header] = row[index] ?? "";
    });
    return out;
  });
}

function applyCsvStringifyTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "csv.stringify";
  const value = requiredTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  if (!Array.isArray(value)) {
    throw transformFieldError(operationKind, "value", "array", value);
  }
  const delimiter =
    optionalStringTransformField(
      state,
      transform,
      operationKind,
      "delimiter",
    ) ?? ",";
  if (delimiter.length !== 1) {
    throw transformFieldError(
      operationKind,
      "delimiter",
      "single character",
      delimiter,
    );
  }
  const headers = optionalStringArrayTransformField(
    transform,
    operationKind,
    "headers",
  );
  const includeHeaders =
    optionalBooleanTransformField(transform, operationKind, "includeHeaders") ??
    true;
  const maxRows =
    optionalPositiveIntegerTransformField(
      transform,
      operationKind,
      "maxRows",
    ) ?? DEFAULT_MAX_CSV_ROWS;
  assertCsvRowCount(operationKind, value.length, maxRows);
  return stringifyCsvRows(value, delimiter, headers, includeHeaders);
}

function requiredTransformField(
  state: RunnerState,
  transform: JsonObject,
  operationKind: string,
  field: string,
): JsonValue {
  if (!Object.prototype.hasOwnProperty.call(transform, field)) {
    throw transformFieldError(operationKind, field, "value", undefined);
  }
  return resolveJsonValue(state, transform[field]!);
}

function requiredStringTransformField(
  state: RunnerState,
  transform: JsonObject,
  operationKind: string,
  field: string,
): string {
  const value = requiredTransformField(state, transform, operationKind, field);
  if (typeof value !== "string") {
    throw transformFieldError(operationKind, field, "string", value);
  }
  return value;
}

function optionalStringTransformField(
  state: RunnerState,
  transform: JsonObject,
  operationKind: string,
  field: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(transform, field)) return undefined;
  const value = resolveJsonValue(state, transform[field]!);
  if (typeof value !== "string") {
    throw transformFieldError(operationKind, field, "string", value);
  }
  return value;
}

function optionalBooleanTransformField(
  transform: JsonObject,
  operationKind: string,
  field: string,
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(transform, field)) return undefined;
  const value = transform[field];
  if (typeof value !== "boolean") {
    throw transformFieldError(operationKind, field, "boolean", value);
  }
  return value;
}

function optionalPositiveIntegerTransformField(
  transform: JsonObject,
  operationKind: string,
  field: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(transform, field)) return undefined;
  const value = transform[field];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw transformFieldError(operationKind, field, "positive integer", value);
  }
  return value;
}

function optionalStringArrayTransformField(
  transform: JsonObject,
  operationKind: string,
  field: string,
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(transform, field)) return undefined;
  const value = transform[field];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw transformFieldError(operationKind, field, "string[]", value);
  }
  return value;
}

function safeRegExp(
  operationKind: string,
  pattern: string,
  flags: string,
): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new WorkflowNodeExecutionError(
      `Transform operation ${operationKind} has invalid regex: ${
        err instanceof Error ? err.message : String(err)
      }`,
      {
        details: {
          operationKind,
          field: "pattern",
          pattern,
          flags,
        },
      },
    );
  }
}

function assertCsvInputSize(value: string, operationKind: string): void {
  const actualBytes = Buffer.byteLength(value, "utf8");
  if (actualBytes <= MAX_CSV_INPUT_BYTES) return;
  throw new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} input exceeds ${MAX_CSV_INPUT_BYTES} bytes`,
    {
      details: {
        operationKind,
        maxBytes: MAX_CSV_INPUT_BYTES,
        actualBytes,
      },
    },
  );
}

function assertCsvRowCount(
  operationKind: string,
  actualRows: number,
  maxRows: number,
): void {
  if (actualRows <= maxRows) return;
  throw new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} exceeded row limit ${maxRows}`,
    {
      details: {
        operationKind,
        maxRows,
        actualRows,
      },
    },
  );
}

function parseCsvRows(
  operationKind: string,
  value: string,
  delimiter: string,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let justEndedRow = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (value[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      justEndedRow = false;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      justEndedRow = false;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      justEndedRow = false;
      continue;
    }
    if (char === "\n" || char === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      justEndedRow = true;
      if (char === "\r" && value[index + 1] === "\n") index += 1;
      continue;
    }
    field += char;
    justEndedRow = false;
  }
  if (inQuotes) {
    throw new WorkflowNodeExecutionError(
      `Transform operation ${operationKind} has invalid CSV: unterminated quoted field`,
      { details: { operationKind, field: "value" } },
    );
  }
  if (field !== "" || row.length > 0 || (value.length > 0 && !justEndedRow)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function stringifyCsvRows(
  value: JsonValue[],
  delimiter: string,
  requestedHeaders: string[] | undefined,
  includeHeaders: boolean,
): string {
  if (value.length === 0) {
    return requestedHeaders && includeHeaders
      ? csvLine(requestedHeaders, delimiter)
      : "";
  }
  if (value.every((item) => Array.isArray(item))) {
    const lines = (value as JsonValue[][]).map((row) =>
      csvLine(row.map(csvCellValue), delimiter),
    );
    if (requestedHeaders && includeHeaders) {
      lines.unshift(csvLine(requestedHeaders, delimiter));
    }
    return lines.join("\n");
  }
  if (!value.every(isJsonObject)) {
    throw transformFieldError(
      "csv.stringify",
      "value",
      "array of objects or arrays",
      value,
    );
  }
  const objectRows = value as JsonObject[];
  const headers = requestedHeaders ?? collectCsvHeaders(objectRows);
  const lines = objectRows.map((row) =>
    csvLine(
      headers.map((header) => csvCellValue(row[header])),
      delimiter,
    ),
  );
  if (includeHeaders) lines.unshift(csvLine(headers, delimiter));
  return lines.join("\n");
}

function collectCsvHeaders(rows: JsonObject[]): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  return headers;
}

function csvCellValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function csvLine(values: string[], delimiter: string): string {
  return values.map((value) => escapeCsvCell(value, delimiter)).join(delimiter);
}

function escapeCsvCell(value: string, delimiter: string): string {
  if (
    !value.includes(delimiter) &&
    !value.includes('"') &&
    !value.includes("\n") &&
    !value.includes("\r")
  ) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function applyIpParseTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "ip.parse";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const parsed = parseIpAddress(value);
  if (!parsed) throw invalidIpError(operationKind, "value", value);
  return ipParseOutput(parsed);
}

function applyIpVersionCheckTransform(
  state: RunnerState,
  transform: JsonObject,
  version: 4 | 6,
): JsonValue {
  const operationKind = version === 4 ? "ip.is_ipv4" : "ip.is_ipv6";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  return isIP(value) === version;
}

function applyIpInSubnetTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "ip.in_subnet";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const cidr = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "cidr",
  );
  const subnet = parseCidr(operationKind, cidr);
  const parsed = parseIpAddress(value);
  if (!parsed || parsed.version !== subnet.version) return false;
  const mask = prefixMask(subnet.version, subnet.prefix);
  return (parsed.integer & mask) === (subnet.integer & mask);
}

function applyIpNetmaskTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "ip.netmask";
  const prefix = requiredIntegerTransformField(
    state,
    transform,
    operationKind,
    "prefix",
  );
  const version = requiredIpVersionField(state, transform, operationKind);
  validatePrefix(operationKind, prefix, version);
  const mask = prefixMask(version, prefix);
  return version === 4 ? formatIpv4(mask) : formatIpv6(mask);
}

function applyIpNetworkTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "ip.network";
  const cidr = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "cidr",
  );
  const parsed = parseCidr(operationKind, cidr);
  const mask = prefixMask(parsed.version, parsed.prefix);
  const networkInteger = parsed.integer & mask;
  const address =
    parsed.version === 4
      ? formatIpv4(networkInteger)
      : formatIpv6(networkInteger);
  return {
    version: parsed.version,
    address,
    prefix: parsed.prefix,
    cidr: `${address}/${parsed.prefix}`,
  };
}

function requiredIntegerTransformField(
  state: RunnerState,
  transform: JsonObject,
  operationKind: string,
  field: string,
): number {
  const value = requiredTransformField(state, transform, operationKind, field);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw transformFieldError(operationKind, field, "integer", value);
  }
  return value;
}

function requiredIpVersionField(
  state: RunnerState,
  transform: JsonObject,
  operationKind: string,
): 4 | 6 {
  const version = requiredIntegerTransformField(
    state,
    transform,
    operationKind,
    "version",
  );
  if (version !== 4 && version !== 6) {
    throw transformFieldError(operationKind, "version", "4 or 6", version);
  }
  return version;
}

type ParsedIpAddress = {
  version: 4 | 6;
  address: string;
  normalized: string;
  integer: bigint;
  octets?: number[];
  hextets?: string[];
};

type ParsedCidr = {
  version: 4 | 6;
  prefix: number;
  integer: bigint;
};

function parseIpAddress(value: string): ParsedIpAddress | null {
  const version = isIP(value);
  if (version === 4) return parseIpv4Address(value);
  if (version === 6) return parseIpv6Address(value);
  return null;
}

function parseIpv4Address(value: string): ParsedIpAddress | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255
      ? octet
      : Number.NaN;
  });
  if (octets.some((octet) => Number.isNaN(octet))) return null;
  const integer = octets.reduce(
    (acc, octet) => (acc << 8n) + BigInt(octet),
    0n,
  );
  return {
    version: 4,
    address: value,
    normalized: octets.join("."),
    integer,
    octets,
  };
}

function parseIpv6Address(value: string): ParsedIpAddress | null {
  const lower = value.toLowerCase();
  const doubleColonParts = lower.split("::");
  if (doubleColonParts.length > 2) return null;
  const hasCompression = doubleColonParts.length === 2;
  const left = parseIpv6PartList(doubleColonParts[0] ?? "");
  const right = parseIpv6PartList(
    hasCompression ? (doubleColonParts[1] ?? "") : "",
  );
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (hasCompression ? missing < 1 : missing !== 0) return null;
  const hextetNumbers = [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
  if (hextetNumbers.length !== 8) return null;
  const integer = hextetNumbers.reduce(
    (acc, hextet) => (acc << 16n) + BigInt(hextet),
    0n,
  );
  const hextets = hextetNumbers.map((hextet) =>
    hextet.toString(16).padStart(4, "0"),
  );
  return {
    version: 6,
    address: value,
    normalized: hextets.join(":"),
    integer,
    hextets,
  };
}

function parseIpv6PartList(value: string): number[] | null {
  if (value === "") return [];
  const parts = value.split(":");
  const out: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const ipv4 = parseIpv4Address(part);
      if (!ipv4 || !ipv4.octets) return null;
      out.push(ipv4.octets[0]! * 256 + ipv4.octets[1]!);
      out.push(ipv4.octets[2]! * 256 + ipv4.octets[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

function ipParseOutput(parsed: ParsedIpAddress): JsonObject {
  const out: JsonObject = {
    version: parsed.version,
    address: parsed.address,
    normalized: parsed.normalized,
    integer: parsed.integer.toString(),
  };
  if (parsed.version === 4 && parsed.octets) out.octets = parsed.octets;
  if (parsed.version === 6 && parsed.hextets) out.hextets = parsed.hextets;
  return out;
}

function parseCidr(operationKind: string, cidr: string): ParsedCidr {
  const separator = cidr.lastIndexOf("/");
  if (separator < 0) throw invalidCidrError(operationKind, cidr);
  const address = cidr.slice(0, separator);
  const rawPrefix = cidr.slice(separator + 1);
  if (!/^\d+$/.test(rawPrefix)) throw invalidCidrError(operationKind, cidr);
  const parsed = parseIpAddress(address);
  if (!parsed) throw invalidCidrError(operationKind, cidr);
  const prefix = Number(rawPrefix);
  validatePrefix(operationKind, prefix, parsed.version, cidr);
  return {
    version: parsed.version,
    prefix,
    integer: parsed.integer,
  };
}

function validatePrefix(
  operationKind: string,
  prefix: number,
  version: 4 | 6,
  cidr?: string,
): void {
  const max = version === 4 ? 32 : 128;
  if (Number.isInteger(prefix) && prefix >= 0 && prefix <= max) return;
  if (cidr) throw invalidCidrError(operationKind, cidr);
  throw new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} has invalid prefix`,
    {
      details: {
        operationKind,
        field: "prefix",
        prefix,
        version,
        max,
      },
    },
  );
}

function prefixMask(version: 4 | 6, prefix: number): bigint {
  const bits = version === 4 ? 32 : 128;
  if (prefix === 0) return 0n;
  return ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 255n))
    .join(".");
}

function formatIpv6(value: bigint): string {
  const hextets: string[] = [];
  for (let index = 7; index >= 0; index--) {
    const shift = BigInt(index * 16);
    hextets.push(
      Number((value >> shift) & 0xffffn)
        .toString(16)
        .padStart(4, "0"),
    );
  }
  return hextets.join(":");
}

function applyUriParseTransform(
  state: RunnerState,
  transform: JsonObject,
): JsonValue {
  const operationKind = "uri.parse";
  const value = requiredStringTransformField(
    state,
    transform,
    operationKind,
    "value",
  );
  const base = optionalStringTransformField(
    state,
    transform,
    operationKind,
    "base",
  );
  let url: URL;
  if (base === undefined) {
    try {
      url = new URL(value);
    } catch {
      throw invalidUriError(operationKind, "value", { value });
    }
  } else {
    let parsedBase: URL;
    try {
      parsedBase = new URL(base);
    } catch {
      throw invalidUriError(operationKind, "base", { value, base });
    }
    try {
      url = new URL(value, parsedBase);
    } catch {
      throw invalidUriError(operationKind, "value", { value, base });
    }
  }
  return uriParseOutput(url);
}

function uriParseOutput(url: URL): JsonObject {
  const hasCredentials = url.username !== "" || url.password !== "";
  const redactedUrl = new URL(url.href);
  redactedUrl.username = "";
  redactedUrl.password = "";
  const query = uriQueryObject(redactedUrl.searchParams);
  return {
    href: redactedUrl.href,
    protocol: redactedUrl.protocol,
    scheme: redactedUrl.protocol.replace(/:$/, ""),
    origin: redactedUrl.origin,
    host: redactedUrl.host,
    hostname: redactedUrl.hostname,
    port: redactedUrl.port,
    pathname: redactedUrl.pathname,
    path: `${redactedUrl.pathname}${redactedUrl.search}`,
    search: redactedUrl.search,
    query,
    queryList: Array.from(redactedUrl.searchParams.entries()).map(
      ([key, value]) => ({ key, value }),
    ),
    hash: redactedUrl.hash,
    fragment: redactedUrl.hash.startsWith("#")
      ? redactedUrl.hash.slice(1)
      : redactedUrl.hash,
    username: null,
    password: null,
    hasCredentials,
  };
}

function uriQueryObject(searchParams: URLSearchParams): JsonObject {
  const query: JsonObject = {};
  for (const [key, value] of searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

function invalidIpError(
  operationKind: string,
  field: string,
  value: string,
): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} has invalid IP address`,
    {
      details: {
        operationKind,
        field,
        value,
      },
    },
  );
}

function invalidUriError(
  operationKind: string,
  field: string,
  input: { value: string; base?: string },
): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} has invalid URI`,
    {
      details: {
        operationKind,
        field,
        ...input,
      },
    },
  );
}

function invalidCidrError(
  operationKind: string,
  cidr: string,
): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} has invalid CIDR`,
    {
      details: {
        operationKind,
        field: "cidr",
        cidr,
      },
    },
  );
}

function transformFieldError(
  operationKind: string,
  field: string,
  expected: string,
  actual: JsonValue | undefined,
): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError(
    `Transform operation ${operationKind} has invalid field ${field}: expected ${expected}`,
    {
      details: {
        operationKind,
        field,
        expected,
        actualType: jsonTypeName(actual),
      },
    },
  );
}

function unsupportedTransformOperationError(
  operationKind: string,
): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError(
    `Unsupported transform operation: ${operationKind}`,
    {
      details: { operationKind },
    },
  );
}

function assertTransformOutputSize(output: JsonValue): void {
  const serialized = JSON.stringify(output);
  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes <= MAX_TRANSFORM_OUTPUT_BYTES) return;
  throw new WorkflowNodeExecutionError(
    `Transform output exceeds ${MAX_TRANSFORM_OUTPUT_BYTES} bytes`,
    {
      details: {
        maxBytes: MAX_TRANSFORM_OUTPUT_BYTES,
        actualBytes,
      },
    },
  );
}

function pickTransformSource(
  input: JsonValue | undefined,
  sourceName: string | undefined,
): JsonObject {
  if (sourceName) {
    if (!isJsonObject(input))
      throw new Error(`Transform input is not an object`);
    const source = input[sourceName];
    if (!isJsonObject(source)) {
      throw new Error(`Transform source is not an object: ${sourceName}`);
    }
    return source;
  }
  if (isJsonObject(input)) {
    const values = Object.values(input);
    if (values.length === 1 && isJsonObject(values[0])) return values[0];
    return input;
  }
  throw new Error("Transform input is not an object");
}

function sleep(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(canceledExecutionError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(canceledExecutionError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function canceledExecutionError(): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError("Workflow run canceled", {
    status: "canceled",
  });
}

function buildStepLogsSummary(
  node: WorkflowNode,
  output: JsonValue | undefined,
  error: JsonValue | undefined,
  stepEvents: WorkflowRunEvent[],
): JsonValue | undefined {
  const logs = stepEvents
    .filter((event) => event.kind === "log")
    .map((event) => {
      const log: JsonObject = {
        level: event.level,
      };
      if (event.message !== undefined) log.message = event.message;
      if (event.payload !== undefined) log.payload = cloneJson(event.payload);
      return log;
    });
  const summary: JsonObject = {};
  if (logs.length > 0) summary.logs = logs;

  const pythonIo =
    pythonOutputLogs(node, output) ?? pythonErrorLogs(node, error);
  if (pythonIo !== undefined) summary.python = pythonIo;

  return Object.keys(summary).length === 0 ? undefined : summary;
}

function pythonOutputLogs(
  node: WorkflowNode,
  output: JsonValue | undefined,
): JsonValue | undefined {
  if (node.type !== "builtin.python" || !isJsonObject(output)) return undefined;
  return pickPythonIo(output);
}

function pythonErrorLogs(
  node: WorkflowNode,
  error: JsonValue | undefined,
): JsonValue | undefined {
  if (node.type !== "builtin.python" || !isJsonObject(error)) return undefined;
  const details = error.details;
  if (!isJsonObject(details)) return undefined;
  return pickPythonIo(details);
}

function pickPythonIo(source: JsonObject): JsonValue | undefined {
  const io: JsonObject = {};
  if (typeof source.stdout === "string") io.stdout = source.stdout;
  if (typeof source.stderr === "string") io.stderr = source.stderr;
  return Object.keys(io).length === 0 ? undefined : io;
}

function evaluateCondition(state: RunnerState, expression: string): boolean {
  const trimmed = expression.trim();
  const orParts = splitByOperator(trimmed, "or");
  if (orParts.length > 1)
    return orParts.some((part) => evaluateCondition(state, part));
  const andParts = splitByOperator(trimmed, "and");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateCondition(state, part));
  }
  if (trimmed.startsWith("not ")) {
    return !evaluateCondition(state, trimmed.slice(4));
  }
  const parenthesizedNot = parseSingleArgCall(trimmed, "not");
  if (parenthesizedNot !== null) {
    return !evaluateCondition(state, parenthesizedNot);
  }
  const exists = /^exists\((.+)\)$/.exec(trimmed);
  if (exists) {
    return (
      resolveReference(state, exists[1]!.trim(), { allowMissing: true }) !==
      undefined
    );
  }
  const contains = /^contains\((.+),(.+)\)$/.exec(trimmed);
  if (contains) {
    const args = splitFunctionArgs(contains[1]!, contains[2]!);
    const collection = evaluateOperand(state, args[0]);
    const needle = evaluateOperand(state, args[1]);
    return Array.isArray(collection)
      ? collection.some((item) => jsonEquals(item, needle))
      : typeof collection === "string" && typeof needle === "string"
        ? collection.includes(needle)
        : false;
  }
  const startsWith = /^startsWith\((.+),(.+)\)$/.exec(trimmed);
  if (startsWith) {
    const args = splitFunctionArgs(startsWith[1]!, startsWith[2]!);
    const value = evaluateOperand(state, args[0]);
    const prefix = evaluateOperand(state, args[1]);
    return typeof value === "string" && typeof prefix === "string"
      ? value.startsWith(prefix)
      : false;
  }
  const endsWith = /^endsWith\((.+),(.+)\)$/.exec(trimmed);
  if (endsWith) {
    const args = splitFunctionArgs(endsWith[1]!, endsWith[2]!);
    const value = evaluateOperand(state, args[0]);
    const suffix = evaluateOperand(state, args[1]);
    return typeof value === "string" && typeof suffix === "string"
      ? value.endsWith(suffix)
      : false;
  }
  const comparison = parseComparison(trimmed);
  if (comparison) {
    const left = evaluateOperand(state, comparison.left);
    const op = comparison.operator;
    const right = evaluateOperand(state, comparison.right);
    switch (op) {
      case "==":
        return jsonEquals(left, right);
      case "!=":
        return !jsonEquals(left, right);
      case ">":
        return toNumber(left) > toNumber(right);
      case ">=":
        return toNumber(left) >= toNumber(right);
      case "<":
        return toNumber(left) < toNumber(right);
      case "<=":
        return toNumber(left) <= toNumber(right);
    }
  }
  return Boolean(evaluateOperand(state, trimmed));
}

function parseComparison(
  expression: string,
): { left: string; operator: string; right: string } | null {
  const operators = ["==", "!=", ">=", "<=", ">", "<"];
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === quote && expression[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const operator = operators.find((candidate) =>
      expression.startsWith(candidate, index),
    );
    if (!operator) continue;
    const left = expression.slice(0, index).trim();
    const right = expression.slice(index + operator.length).trim();
    if (!left || !right) return null;
    return { left, operator, right };
  }
  return null;
}

function parseSingleArgCall(expression: string, name: string): string | null {
  const prefix = `${name}(`;
  if (!expression.startsWith(prefix)) return null;

  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let index = name.length; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === quote && expression[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) {
        if (index !== expression.length - 1) return null;
        const arg = expression.slice(prefix.length, index).trim();
        if (!arg) throw new Error(`${name}() requires one argument`);
        return arg;
      }
    }
  }
  return null;
}

function splitByOperator(expression: string, operator: "and" | "or"): string[] {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (quote) {
      if (char === quote && expression[index - 1] !== "\\") quote = null;
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index++;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && depth > 0) depth--;
    if (
      depth === 0 &&
      expression.slice(index, index + operator.length) === operator &&
      isWhitespace(expression[index - 1]) &&
      isWhitespace(expression[index + operator.length])
    ) {
      parts.push(expression.slice(start, index).trim());
      index += operator.length;
      start = index;
      continue;
    }
    index++;
  }
  if (parts.length === 0) return [expression];
  parts.push(expression.slice(start).trim());
  return parts;
}

function splitFunctionArgs(...args: string[]): [string, string] {
  const expression = args.join(",");
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (quote) {
      if (char === quote && expression[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && depth > 0) depth--;
    if (char === "," && depth === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(expression.slice(start).trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`contains() requires two arguments`);
  }
  return [parts[0], parts[1]];
}

function evaluateOperand(
  state: RunnerState,
  operand: string,
): JsonValue | undefined {
  const lengthCall = /^length\((.+)\)$/.exec(operand);
  if (lengthCall) {
    const value = evaluateOperand(state, lengthCall[1]!.trim());
    if (Array.isArray(value) || typeof value === "string") return value.length;
    if (isJsonObject(value)) return Object.keys(value).length;
    throw new Error(`length() cannot read ${lengthCall[1]}`);
  }
  if (isReferenceExpression(state, operand)) {
    return resolveReference(state, operand);
  }
  if (
    (operand.startsWith('"') && operand.endsWith('"')) ||
    (operand.startsWith("'") && operand.endsWith("'"))
  ) {
    return operand.slice(1, -1);
  }
  if (operand === "true") return true;
  if (operand === "false") return false;
  if (operand === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(operand)) return Number(operand);
  return operand;
}

function resolveJsonValue(state: RunnerState, value: JsonValue): JsonValue {
  if (typeof value === "string") {
    if (isReferenceExpression(state, value)) {
      const resolved = resolveReference(state, value);
      if (resolved === undefined)
        throw new Error(`Reference not found: ${value}`);
      return cloneJson(resolved);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveJsonValue(state, item));
  }
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = resolveJsonValue(state, child);
    }
    return out;
  }
  return value;
}

function renderStringTemplate(state: RunnerState, template: string): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, reference) => {
    const resolved = resolveReference(state, String(reference).trim());
    if (resolved === undefined) return "";
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function resolveReference(
  state: RunnerState,
  reference: string,
  opts: { allowMissing?: boolean } = {},
): JsonValue | undefined {
  const foreachFrame = findForeachFrame(state, reference);
  if (foreachFrame) {
    const path =
      reference === foreachFrame.name
        ? []
        : reference.slice(foreachFrame.name.length + 1).split(".");
    let current: unknown = foreachFrame.value;
    for (const segment of path) {
      if (
        isJsonObject(current) &&
        Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        current = current[segment];
        continue;
      }
      if (opts.allowMissing) return undefined;
      throw new Error(`Reference not found: ${reference}`);
    }
    return current as JsonValue | undefined;
  }
  if (reference === "item" || reference.startsWith("item.")) {
    throw new Error("item is only available inside foreach");
  }
  const path = reference.startsWith("$.") ? reference.slice(2).split(".") : [];
  let current: unknown;
  if (path[0] === "workflowTrigger") current = state.workflowTrigger;
  else if (path[0] === "context") current = state.context;
  else if (path[0] === "steps") current = state.steps;
  else throw new Error(`Unsupported reference: ${reference}`);

  for (const segment of path.slice(1)) {
    if (
      isJsonObject(current) &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = current[segment];
      continue;
    }
    if (opts.allowMissing) return undefined;
    throw new Error(`Reference not found: ${reference}`);
  }
  if (current === undefined && !opts.allowMissing) {
    throw new Error(`Reference not found: ${reference}`);
  }
  return current as JsonValue | undefined;
}

function isReferenceExpression(state: RunnerState, value: string): boolean {
  return value.startsWith("$.") || findForeachFrame(state, value) !== undefined;
}

function findForeachFrame(
  state: RunnerState,
  reference: string,
): ForeachFrame | undefined {
  for (let index = state.foreachStack.length - 1; index >= 0; index--) {
    const frame = state.foreachStack[index]!;
    if (reference === frame.name || reference.startsWith(`${frame.name}.`)) {
      return frame;
    }
  }
  return undefined;
}

function setContextPath(
  context: JsonObject,
  path: string,
  value: JsonValue,
  mode: AssignmentMode,
): void {
  const parts = path.split(".");
  let target = context;
  for (const part of parts.slice(0, -1)) {
    const existing = target[part];
    if (!isJsonObject(existing)) {
      const next: JsonObject = {};
      target[part] = next;
      target = next;
    } else {
      target = existing;
    }
  }
  const leaf = parts.at(-1)!;
  const previous = target[leaf];
  if (mode === "replace") {
    target[leaf] = cloneJson(value);
    return;
  }
  if (mode === "merge") {
    if (!isJsonObject(previous) || !isJsonObject(value)) {
      throw assignmentModeError(path, mode, previous, value);
    }
    target[leaf] = { ...previous, ...cloneJson(value) };
    return;
  }
  if (mode === "append") {
    if (previous === undefined) {
      target[leaf] = [cloneJson(value)];
      return;
    }
    if (!Array.isArray(previous)) {
      throw assignmentModeError(path, mode, previous, value);
    }
    target[leaf] = [...previous, cloneJson(value)];
  }
}

function assignmentModeError(
  path: string,
  mode: Exclude<AssignmentMode, "replace">,
  target: JsonValue | undefined,
  value: JsonValue,
): WorkflowNodeExecutionError {
  const expected =
    mode === "merge" ? "an object target and object value" : "an array target";
  return new WorkflowNodeExecutionError(
    `${mode} assignment for ${path} requires ${expected}`,
    {
      details: {
        assignmentPath: path,
        assignmentMode: mode,
        targetType: jsonTypeName(target),
        valueType: jsonTypeName(value),
      },
    },
  );
}

function jsonTypeName(value: JsonValue | undefined): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function diffAssignedContext(
  before: JsonObject,
  after: JsonObject,
): JsonValue | undefined {
  const diff: JsonObject = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforeValue = before[key];
    const afterValue = after[key];
    if (!jsonEquals(beforeValue, afterValue)) {
      diff[key] = {
        before: beforeValue === undefined ? null : cloneJson(beforeValue),
        after: afterValue === undefined ? null : cloneJson(afterValue),
      };
    }
  }
  return Object.keys(diff).length ? diff : undefined;
}

function snapshotStepOutputs(state: RunnerState): Record<string, JsonValue> {
  const snapshot: Record<string, JsonValue> = {};
  for (const [nodeId, step] of Object.entries(state.steps)) {
    if (step.output !== undefined) snapshot[nodeId] = cloneJson(step.output);
  }
  return snapshot;
}

function workflowTriggerMeta(trigger: WorkflowRunTrigger | undefined): JsonObject {
  if (trigger === undefined) return {};
  const meta: JsonObject = {};
  for (const [key, value] of Object.entries(trigger)) {
    if (key === "input") continue;
    meta[key] = cloneJson(value as JsonValue);
  }
  return meta;
}

function recordStepRunning(
  state: RunnerState,
  nodeId: string,
  input: JsonValue | undefined,
): void {
  state.steps[nodeId] = {
    ...(state.steps[nodeId] ?? {}),
    ...(input === undefined ? {} : { input: cloneJson(input) }),
    status: "running",
  };
}

function recordStepOutput(
  state: RunnerState,
  nodeId: string,
  output: JsonValue,
): void {
  state.steps[nodeId] = {
    ...(state.steps[nodeId] ?? {}),
    output: cloneJson(output),
  };
}

function recordStepSucceeded(
  state: RunnerState,
  nodeId: string,
  input: JsonValue | undefined,
  output: JsonValue | undefined,
  status: WorkflowStepStatus,
): void {
  state.steps[nodeId] = {
    ...(state.steps[nodeId] ?? {}),
    ...(input === undefined ? {} : { input: cloneJson(input) }),
    ...(output === undefined ? {} : { output: cloneJson(output) }),
    status,
  };
}

function recordStepFailed(
  state: RunnerState,
  nodeId: string,
  input: JsonValue | undefined,
  error: JsonValue,
  status: WorkflowStepStatus,
): void {
  state.steps[nodeId] = {
    ...(state.steps[nodeId] ?? {}),
    ...(input === undefined ? {} : { input: cloneJson(input) }),
    error: cloneJson(error),
    status,
  };
}

function cloneStepState(
  steps: Record<string, StepState>,
): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const [nodeId, step] of Object.entries(steps)) {
    out[nodeId] = {};
    if (step.input !== undefined) out[nodeId]!.input = cloneJson(step.input);
    if (step.output !== undefined) out[nodeId]!.output = cloneJson(step.output);
    if (step.error !== undefined) out[nodeId]!.error = cloneJson(step.error);
    if (step.status !== undefined) out[nodeId]!.status = step.status;
  }
  return out;
}

function stepOutputsFromStepState(
  steps: Record<string, StepState>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [nodeId, step] of Object.entries(steps)) {
    if (step.output !== undefined) out[nodeId] = cloneJson(step.output);
  }
  return out;
}

function itemStepOutputs(
  state: RunnerState,
  beforeStepOutputs: Record<string, JsonValue>,
): JsonObject {
  const out: JsonObject = {};
  for (const [nodeId, step] of Object.entries(state.steps)) {
    if (step.output === undefined) continue;
    if (jsonEquals(beforeStepOutputs[nodeId], step.output)) continue;
    out[nodeId] = cloneJson(step.output);
  }
  return out;
}

function latestFailedStepError(state: RunnerState): JsonValue | undefined {
  for (let index = state.stepAttempts.length - 1; index >= 0; index--) {
    const step = state.stepAttempts[index]!;
    if (step.status === "failed" || step.status === "canceled") {
      return step.error === undefined ? undefined : cloneJson(step.error);
    }
  }
  return undefined;
}

function parallelBranchesObject(
  node: Extract<WorkflowNode, { type: "builtin.parallel" }>,
  branchResults: Map<string, ParallelBranchRunResult>,
): JsonObject {
  const out: JsonObject = {};
  for (const branch of node.branches) {
    const result = branchResults.get(branch.id);
    if (result) {
      out[branch.id] = cloneJson(result.output);
      continue;
    }
    const canceled: ParallelBranchOutput = {
      id: branch.id,
      ...(branch.label ? { label: branch.label } : {}),
      status: "canceled",
      startedAt: "",
      endedAt: "",
      durationMs: 0,
      steps: {},
      context: {},
      error: {
        message: "Parallel branch was not started because failFast canceled it",
      },
    };
    out[branch.id] = canceled;
  }
  return out;
}

async function runLimited<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]!, index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => runWorker(),
    ),
  );
}

function errorToJson(err: unknown): JsonValue {
  if (err instanceof Error) {
    const out: JsonObject = {
      name: err.name,
      message: err.message,
    };
    const details = errorDetails(err);
    if (details !== undefined) out.details = details;
    return out;
  }
  return { message: String(err) };
}

function errorDetails(err: Error): JsonValue | undefined {
  if (err instanceof WorkflowNodeExecutionError) {
    return err.opts.details;
  }
  const details = (err as Error & { details?: unknown }).details;
  return isJsonValue(details) ? details : undefined;
}

function completedStepStatus(node: WorkflowNode): WorkflowStepStatus {
  if (node.type === "builtin.exit") return node.status;
  return "succeeded";
}

function uniqueNodeIds(nodeIds: string[]): string[] {
  return [...new Set(nodeIds)];
}

function stepDurationMs(startedAt: string, endedAt: string): number {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0;
  return Math.max(0, ended - started);
}

function terminalExitEvent(
  status: Extract<WorkflowStepStatus, "succeeded" | "failed" | "canceled">,
): {
  level: "system" | "error";
  kind: "run_completed" | "run_failed" | "run_canceled";
  message: string;
} {
  if (status === "failed") {
    return {
      level: "error",
      kind: "run_failed",
      message: "Workflow run failed",
    };
  }
  if (status === "canceled") {
    return {
      level: "system",
      kind: "run_canceled",
      message: "Workflow run canceled",
    };
  }
  return {
    level: "system",
    kind: "run_completed",
    message: "Workflow run succeeded",
  };
}

function toNumber(value: JsonValue | undefined): number {
  if (typeof value !== "number")
    throw new Error(`Expected number, got ${typeof value}`);
  return value;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/.test(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isJsonObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function cloneJson<
  T extends JsonValue | WorkflowStepAttempt | WorkflowRunEvent | undefined,
>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
