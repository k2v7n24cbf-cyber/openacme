import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  WorkflowAssignmentMap,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowStepAttempt,
  WorkflowStepStatus,
} from "./schemas.js";
import {
  WorkflowDefinitionSchema,
  WorkflowRunEventSchema,
  WorkflowStepAttemptSchema,
} from "./schemas.js";
import type { WorkflowExecutionPorts } from "./ports.js";

export interface WorkflowRunnerOptions {
  ports?: WorkflowExecutionPorts;
  now?: () => string;
}

export interface WorkflowRunnerRunRequest {
  runId?: string;
  definition: WorkflowDefinition;
  input?: JsonValue;
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
  output?: JsonValue;
}

interface RunnerState {
  runId: string;
  definition: WorkflowDefinition;
  input: JsonValue;
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
  steps: JsonObject;
};

class WorkflowNodeExecutionError extends Error {
  constructor(
    message: string,
    readonly opts: {
      preserveContext?: boolean;
      runFailedAlready?: boolean;
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
    const definition = WorkflowDefinitionSchema.parse(req.definition);
    const state: RunnerState = {
      runId: req.runId ?? randomUUID(),
      definition,
      input: cloneJson(req.input ?? {}),
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
    const branchNodeIds = collectBranchNodeIds(definition.nodes);

    for (const node of definition.nodes) {
      if (state.stopped) break;
      if (branchNodeIds.has(node.id)) continue;
      await this.executeNode(state, node, nodesById);
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
    const startedAt = this.now();
    const attempt = opts.attempt ?? 1;
    const attemptId = `${state.runId}:${node.id}:${attempt}`;
    const beforeContext = cloneJson(state.context);
    const inputAtStart = safeResolvedNodeInput(state, node);
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
        endedAt: this.now(),
        input: resolvedNodeInput(state, node),
        output,
        logsSummary,
        contextDiff,
      });
      state.stepAttempts.push(step);
      if (
        (node.type === "builtin.transform" ||
          node.type === "builtin.foreach" ||
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
      if (node.type === "builtin.if" || node.type === "builtin.if_else") {
        const branch = output as BranchSelection;
        this.recordSkippedSteps(state, branch.skipped, attempt);
        await this.executeSelectedBranch(state, nodesById, branch.selected, {
          attempt,
        });
      }
    } catch (err) {
      const workflowErr =
        err instanceof WorkflowNodeExecutionError ? err : null;
      if (!workflowErr?.opts.preserveContext) {
        state.context = beforeContext;
      }
      state.status = "failed";
      state.stopped = true;
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
        status: "failed",
        startedAt,
        endedAt: this.now(),
        input: safeResolvedNodeInput(state, node),
        error,
        logsSummary,
      });
      state.stepAttempts.push(step);
      await this.appendEvent(state, {
        stepRunId: step.id,
        level: "error",
        kind: "step_failed",
        message: `Step ${node.id} failed`,
        payload: error,
      });
      if (!workflowErr?.opts.runFailedAlready) {
        await this.appendEvent(state, {
          level: "system",
          kind: "run_failed",
          message: "Workflow run failed",
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
        return assigned;
      }

      case "builtin.transform": {
        const input = resolvedNodeInput(state, node);
        const output = applyTransform(state, input, node.transform);
        state.steps[node.id] = { output };
        if (node.assign) applyAssignments(state, node.assign);
        return output;
      }

      case "builtin.if": {
        const selected = evaluateCondition(state, node.condition)
          ? node.then
          : [];
        const skipped = selected.length === 0 ? node.then : [];
        await this.appendBranchEvent(state, node.condition, selected, skipped);
        return { selected, skipped };
      }

      case "builtin.if_else": {
        const matches = evaluateCondition(state, node.condition);
        const selected = matches ? node.then : node.else;
        const skipped = matches ? node.else : node.then;
        await this.appendBranchEvent(state, node.condition, selected, skipped);
        return { selected, skipped };
      }

      case "builtin.log.info":
      case "builtin.log.debug":
      case "builtin.log.error": {
        const level = node.type.replace("builtin.log.", "") as
          | "info"
          | "debug"
          | "error";
        const payload =
          node.payload === undefined
            ? undefined
            : resolveJsonValue(state, node.payload);
        const output: JsonObject =
          payload === undefined
            ? { message: node.message }
            : { message: node.message, payload };
        state.steps[node.id] = { output };
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
        return state.output;
      }

      case "mcp.tool":
        return this.executeMcpTool(state, node);

      case "agent.call":
        return this.executeAgentCall(state, node);

      case "builtin.foreach":
        return this.executeForeach(state, node, attemptId);

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

    await this.appendEvent(state, {
      stepRunId: attemptId,
      level: "system",
      kind: "log",
      message: `Foreach ${node.id} started`,
      payload: { count: items.length, itemVar: node.itemVar, concurrency },
    });

    for (let index = 0; index < items.length; index++) {
      const item = cloneJson(items[index]!);
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
          outputs.push({
            index,
            item,
            status: "failed",
            steps: itemStepOutputs(state, beforeStepOutputs),
          });
          throw new WorkflowNodeExecutionError(
            `Foreach item ${index + 1} failed`,
            { preserveContext: true, runFailedAlready: true },
          );
        }
        const itemOutput: ForeachItemOutput = {
          index,
          item,
          status: "succeeded",
          steps: itemStepOutputs(state, beforeStepOutputs),
        };
        outputs.push(itemOutput);
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
      items: outputs,
    };
    state.steps[node.id] = { output };
    if (node.assign) applyAssignments(state, node.assign);
    return output;
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
    state.steps[node.id] = { output: result.output };
    if (node.assign) applyAssignments(state, node.assign);
    return result.output;
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
    const output =
      result.sessionId === undefined || isJsonObject(result.output)
        ? result.output
        : { response: result.output, sessionId: result.sessionId };
    state.steps[node.id] = { output };
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
    state.steps[node.id] = { output };
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
    state.stepAttempts.push(
      WorkflowStepAttemptSchema.parse({
        id: `${state.runId}:${nodeId}:${attempt}`,
        runId: state.runId,
        nodeId,
        attempt,
        status: "skipped",
        startedAt: this.now(),
        endedAt: this.now(),
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
}

function collectBranchNodeIds(nodes: WorkflowNode[]): Set<string> {
  const branchNodeIds = new Set<string>();
  for (const node of nodes) {
    if (node.type === "builtin.if") {
      node.then.forEach((nodeId) => branchNodeIds.add(nodeId));
    }
    if (node.type === "builtin.if_else") {
      node.then.forEach((nodeId) => branchNodeIds.add(nodeId));
      node.else.forEach((nodeId) => branchNodeIds.add(nodeId));
    }
    if (node.type === "builtin.foreach") {
      node.body.forEach((nodeId) => branchNodeIds.add(nodeId));
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

function safeResolvedNodeInput(
  state: RunnerState,
  node: WorkflowNode,
): JsonValue | undefined {
  try {
    return resolvedNodeInput(state, node);
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
  if (typeof transform === "string") {
    return resolveJsonValue(state, transform);
  }
  if (!isJsonObject(transform)) return cloneJson(transform);
  if (transform.kind === "object_pick") {
    const fields = transform.fields;
    if (
      !Array.isArray(fields) ||
      !fields.every((field) => typeof field === "string")
    ) {
      throw new Error("object_pick transform requires string fields");
    }
    const sourceName =
      typeof transform.source === "string" ? transform.source : undefined;
    const source = pickTransformSource(input, sourceName);
    const out: JsonObject = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        out[field] = cloneJson(source[field]!);
      }
    }
    return out;
  }
  return resolveJsonValue(state, transform);
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
  if (path[0] === "input") current = state.input;
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
      throw new Error(`merge assignment requires object values for ${path}`);
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
      throw new Error(`append assignment requires an array target for ${path}`);
    }
    target[leaf] = [...previous, cloneJson(value)];
  }
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
  const details = (err as Error & { details?: unknown }).details;
  return isJsonValue(details) ? details : undefined;
}

function completedStepStatus(node: WorkflowNode): WorkflowStepStatus {
  if (node.type === "builtin.exit") return node.status;
  return "succeeded";
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
