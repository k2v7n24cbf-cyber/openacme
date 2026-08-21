import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowTrigger,
} from "./schemas.js";

const WORKFLOW_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface WorkflowNodeReferenceIssue {
  nodeId: string;
  field:
    | "id"
    | "next"
    | "then"
    | "else"
    | "body"
    | "branches"
    | "cases"
    | "default";
  targetId?: string;
  message: string;
}

export type WorkflowNodeReferenceValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: WorkflowNodeReferenceIssue[]; message: string };

export interface WorkflowTriggerIssue {
  triggerId: string;
  field: "id" | "path" | "schedule";
  message: string;
}

export type WorkflowTriggerValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: WorkflowTriggerIssue[]; message: string };

export interface WorkflowJsonSchemaIssue {
  path: string;
  message: string;
}

export interface WorkflowJsonSchemaValueIssue {
  path: string;
  message: string;
}

export type WorkflowJsonSchemaValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: WorkflowJsonSchemaIssue[]; message: string };

export type WorkflowJsonSchemaValueValidation =
  | { ok: true }
  | {
      ok: false;
      issue: WorkflowJsonSchemaValueIssue;
      message: string;
    };

export type WorkflowInputSchemaValidation =
  | { ok: true }
  | { ok: false; error: string };

export interface WorkflowDefinitionIssue {
  field: "name";
  message: string;
}

export interface WorkflowGraphCompletenessIssue {
  nodeId: string;
  field: "entry";
  message: string;
}

export type WorkflowGraphCompletenessValidation =
  | { ok: true; issues: [] }
  | {
      ok: false;
      issues: WorkflowGraphCompletenessIssue[];
      message: string;
    };

export type WorkflowAuthoringIssue =
  | WorkflowDefinitionIssue
  | WorkflowNodeReferenceIssue
  | WorkflowTriggerIssue
  | WorkflowJsonSchemaIssue
  | WorkflowGraphCompletenessIssue;

export type WorkflowAuthoringValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: WorkflowAuthoringIssue[]; message: string };

export function validateWorkflowNodeReferences(
  nodes: WorkflowNode[],
): WorkflowNodeReferenceValidation {
  const issues: WorkflowNodeReferenceIssue[] = [];
  const nodeIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const node of nodes) {
    if (!WORKFLOW_SAFE_ID.test(node.id)) {
      issues.push({
        nodeId: node.id,
        field: "id",
        message: `Invalid workflow node id: ${node.id}`,
      });
    }
    if (seenIds.has(node.id)) {
      issues.push({
        nodeId: node.id,
        field: "id",
        message: `Duplicate workflow node id: ${node.id}`,
      });
      continue;
    }
    seenIds.add(node.id);
    nodeIds.add(node.id);
  }

  for (const node of nodes) {
    collectMissingTargets(issues, node.id, "next", node.next, nodeIds);
    switch (node.type) {
      case "builtin.if":
        collectMissingTargets(issues, node.id, "then", node.then, nodeIds);
        collectMissingTargets(issues, node.id, "else", node.else, nodeIds);
        break;
      case "builtin.if_else":
        collectMissingTargets(issues, node.id, "then", node.then, nodeIds);
        collectMissingTargets(issues, node.id, "else", node.else, nodeIds);
        break;
      case "builtin.switch":
        collectSwitchIssues(issues, node, nodeIds);
        break;
      case "builtin.foreach":
        collectMissingTargets(issues, node.id, "body", node.body, nodeIds);
        break;
      case "builtin.parallel":
        collectParallelIssues(issues, node, nodeIds);
        break;
    }
  }

  if (issues.length === 0) return { ok: true, issues: [] };
  return {
    ok: false,
    issues,
    message: issues.map((issue) => issue.message).join("; "),
  };
}

export function validateWorkflowGraphCompleteness(
  nodes: WorkflowNode[],
): WorkflowGraphCompletenessValidation {
  const executableNodes = nodes.filter(isExecutableWorkflowNode);
  const entry = executableNodes[0];
  if (!entry) return { ok: true, issues: [] };

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const stack = [entry.id];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (reachable.has(nodeId)) continue;
    const node = nodesById.get(nodeId);
    if (!node) continue;
    reachable.add(nodeId);

    for (const targetId of workflowNodeTargets(node)) {
      if (!reachable.has(targetId)) stack.push(targetId);
    }
  }

  const unreachableNodeIds = executableNodes
    .map((node) => node.id)
    .filter((nodeId) => !reachable.has(nodeId));
  if (unreachableNodeIds.length === 0) return { ok: true, issues: [] };

  return {
    ok: false,
    issues: unreachableNodeIds.map((nodeId) => ({
      nodeId,
      field: "entry",
      message: `Workflow node is unreachable from the workflow entry: ${nodeId}`,
    })),
    message: `Workflow flow is incomplete. Connect or remove unreachable card(s): ${unreachableNodeIds.join(
      ", ",
    )}`,
  };
}

export function validateWorkflowTriggers(
  triggers: WorkflowTrigger[],
): WorkflowTriggerValidation {
  const issues: WorkflowTriggerIssue[] = [];
  const seenIds = new Set<string>();
  const seenWebhookPaths = new Map<string, string>();

  for (const trigger of triggers) {
    if (!trigger.id.trim()) {
      issues.push({
        triggerId: trigger.id,
        field: "id",
        message: "Workflow trigger id is required",
      });
    }
    if (!WORKFLOW_SAFE_ID.test(trigger.id)) {
      issues.push({
        triggerId: trigger.id,
        field: "id",
        message: `Invalid workflow trigger id: ${trigger.id}`,
      });
    }
    if (seenIds.has(trigger.id)) {
      issues.push({
        triggerId: trigger.id,
        field: "id",
        message: `Duplicate workflow trigger id: ${trigger.id}`,
      });
      continue;
    }
    seenIds.add(trigger.id);

    if (trigger.kind === "scheduled" && !trigger.schedule.expr.trim()) {
      issues.push({
        triggerId: trigger.id,
        field: "schedule",
        message: `Scheduled trigger ${trigger.id} needs a cron schedule`,
      });
      continue;
    }
    if (trigger.kind !== "webhook") continue;
    if (trigger.path !== undefined && !trigger.path.trim()) {
      issues.push({
        triggerId: trigger.id,
        field: "path",
        message: `Webhook trigger ${trigger.id} path must be a string`,
      });
      continue;
    }
    const path = normalizeWebhookPath(trigger.path);
    if (!path) continue;
    const existing = seenWebhookPaths.get(path);
    if (existing) {
      issues.push({
        triggerId: trigger.id,
        field: "path",
        message: `Duplicate workflow webhook path: ${path}`,
      });
      continue;
    }
    seenWebhookPaths.set(path, trigger.id);
  }

  if (issues.length === 0) return { ok: true, issues: [] };
  return {
    ok: false,
    issues,
    message: issues.map((issue) => issue.message).join("; "),
  };
}

export function validateWorkflowDefinitionAuthoring(
  definition: WorkflowDefinition,
): WorkflowAuthoringValidation {
  if (!definition.name.trim()) {
    return {
      ok: false,
      issues: [{ field: "name", message: "Workflow needs a name" }],
      message: "Workflow needs a name",
    };
  }

  const nodeReferences = validateWorkflowNodeReferences(definition.nodes);
  if (!nodeReferences.ok) return nodeReferences;

  const graphCompleteness = validateWorkflowGraphCompleteness(definition.nodes);
  if (!graphCompleteness.ok) return graphCompleteness;

  const triggers = validateWorkflowTriggers(definition.triggers);
  if (!triggers.ok) return triggers;

  const workflowSchema = validateWorkflowJsonSchema(definition.inputSchema);
  if (!workflowSchema.ok) return workflowSchema;

  const outputSchema = validateWorkflowJsonSchema(
    definition.outputSchema,
    "Output schema",
  );
  if (!outputSchema.ok) return outputSchema;

  for (const trigger of definition.triggers) {
    const triggerSchema = validateWorkflowJsonSchema(
      workflowTriggerInputSchema(trigger),
      `Trigger ${trigger.id} input schema`,
    );
    if (!triggerSchema.ok) return triggerSchema;
  }

  return { ok: true, issues: [] };
}

export function validateWorkflowJsonSchema(
  schema: JsonValue | undefined,
  label = "Input schema",
): WorkflowJsonSchemaValidation {
  const issues: WorkflowJsonSchemaIssue[] = [];
  collectJsonSchemaIssues(schema, "$", issues);
  if (issues.length === 0) return { ok: true, issues: [] };
  return {
    ok: false,
    issues,
    message: `${label} is invalid: ${issues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("; ")}`,
  };
}

export function validateWorkflowInputSchema(
  schema: JsonValue | undefined,
  input: JsonValue,
  label = "Input",
): WorkflowInputSchemaValidation {
  const schemaValidation = validateWorkflowJsonSchema(
    schema,
    `${label} schema`,
  );
  if (!schemaValidation.ok) {
    return { ok: false, error: schemaValidation.message };
  }
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
    ? {
        ok: false,
        error: `${label} does not match schema: ${formatJsonSchemaValueIssue(
          issue,
        )}`,
      }
    : { ok: true };
}

export function validateWorkflowJsonSchemaValue(
  schema: JsonValue | undefined,
  value: JsonValue,
  path = "$",
): WorkflowJsonSchemaValueValidation {
  const schemaValidation = validateWorkflowJsonSchema(schema, `${path} schema`);
  if (!schemaValidation.ok) {
    return {
      ok: false,
      issue: { path, message: schemaValidation.message },
      message: schemaValidation.message,
    };
  }
  if (schema === undefined || schema === null || schema === true) {
    return { ok: true };
  }
  if (schema === false) {
    const issue = { path, message: "is disallowed" };
    return { ok: false, issue, message: formatJsonSchemaValueIssue(issue) };
  }
  if (!isRecord(schema)) return { ok: true };
  const issue = validateJsonSchemaValue(schema, value, path);
  return issue
    ? { ok: false, issue, message: formatJsonSchemaValueIssue(issue) }
    : { ok: true };
}

function isExecutableWorkflowNode(node: WorkflowNode): boolean {
  return node.type !== "builtin.exit";
}

function workflowNodeTargets(node: WorkflowNode): string[] {
  const targets = [...node.next];
  switch (node.type) {
    case "builtin.if":
    case "builtin.if_else":
      targets.push(...node.then, ...node.else);
      break;
    case "builtin.switch":
      for (const item of node.cases) targets.push(...item.nodes);
      targets.push(...node.default);
      break;
    case "builtin.foreach":
      targets.push(...node.body);
      break;
    case "builtin.parallel":
      for (const branch of node.branches) targets.push(...branch.nodes);
      break;
  }
  return targets;
}

function workflowTriggerInputSchema(
  trigger: WorkflowTrigger,
): JsonValue | undefined {
  switch (trigger.kind) {
    case "manual":
    case "webhook":
      return trigger.inputSchema;
    case "scheduled":
    case "task":
      return undefined;
  }
}

function collectMissingTargets(
  issues: WorkflowNodeReferenceIssue[],
  nodeId: string,
  field: "next" | "then" | "else" | "body" | "branches" | "cases" | "default",
  targets: string[],
  nodeIds: Set<string>,
) {
  for (const targetId of targets) {
    if (nodeIds.has(targetId)) continue;
    issues.push({
      nodeId,
      field,
      targetId,
      message: `Node ${nodeId} ${field} references missing node ${targetId}`,
    });
  }
}

function collectSwitchIssues(
  issues: WorkflowNodeReferenceIssue[],
  node: Extract<WorkflowNode, { type: "builtin.switch" }>,
  nodeIds: Set<string>,
) {
  const caseIds = new Set<string>();
  for (const item of node.cases) {
    if (caseIds.has(item.id)) {
      issues.push({
        nodeId: node.id,
        field: "cases",
        message: `Node ${node.id} has duplicate switch case id: ${item.id}`,
      });
    } else {
      caseIds.add(item.id);
    }

    for (const targetId of item.nodes) {
      if (targetId === node.id) {
        issues.push({
          nodeId: node.id,
          field: "cases",
          targetId,
          message: `Node ${node.id} switch case ${item.id} cannot reference itself`,
        });
        continue;
      }
      collectMissingTargets(issues, node.id, "cases", [targetId], nodeIds);
    }
  }
  for (const targetId of node.default) {
    if (targetId === node.id) {
      issues.push({
        nodeId: node.id,
        field: "default",
        targetId,
        message: `Node ${node.id} switch default cannot reference itself`,
      });
      continue;
    }
    collectMissingTargets(issues, node.id, "default", [targetId], nodeIds);
  }
}

function collectParallelIssues(
  issues: WorkflowNodeReferenceIssue[],
  node: Extract<WorkflowNode, { type: "builtin.parallel" }>,
  nodeIds: Set<string>,
) {
  const branchIds = new Set<string>();
  for (const branch of node.branches) {
    if (branchIds.has(branch.id)) {
      issues.push({
        nodeId: node.id,
        field: "branches",
        message: `Node ${node.id} has duplicate parallel branch id: ${branch.id}`,
      });
    } else {
      branchIds.add(branch.id);
    }

    for (const targetId of branch.nodes) {
      if (targetId === node.id) {
        issues.push({
          nodeId: node.id,
          field: "branches",
          targetId,
          message: `Node ${node.id} parallel branch ${branch.id} cannot reference itself`,
        });
        continue;
      }
      collectMissingTargets(issues, node.id, "branches", [targetId], nodeIds);
    }
  }
}

function collectJsonSchemaIssues(
  schema: JsonValue | undefined,
  path: string,
  issues: WorkflowJsonSchemaIssue[],
): void {
  if (schema === undefined || schema === null) return;
  if (typeof schema === "boolean") return;
  if (!isRecord(schema)) {
    issues.push({ path, message: "must be a JSON Schema object or boolean" });
    return;
  }

  const type = schema.type;
  if (
    type !== undefined &&
    !isJsonSchemaType(type) &&
    !(
      Array.isArray(type) &&
      type.length > 0 &&
      type.every((item) => isJsonSchemaType(item))
    )
  ) {
    issues.push({
      path: `${path}.type`,
      message:
        'must be one of "object", "array", "string", "number", "integer", "boolean", or "null"',
    });
  }

  if ("properties" in schema && !isRecord(schema.properties)) {
    issues.push({ path: `${path}.properties`, message: "must be an object" });
  }
  if (isRecord(schema.properties)) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      collectJsonSchemaIssues(
        childSchema as JsonValue,
        `${path}.properties.${key}`,
        issues,
      );
    }
  }

  if (
    "required" in schema &&
    !(
      Array.isArray(schema.required) &&
      schema.required.every((item) => typeof item === "string")
    )
  ) {
    issues.push({
      path: `${path}.required`,
      message: "must be an array of property names",
    });
  }

  if ("items" in schema) {
    if (typeof schema.items !== "boolean" && !isRecord(schema.items)) {
      issues.push({
        path: `${path}.items`,
        message: "must be a JSON Schema object or boolean",
      });
    } else {
      collectJsonSchemaIssues(
        schema.items as JsonValue,
        `${path}.items`,
        issues,
      );
    }
  }

  if (
    "additionalProperties" in schema &&
    typeof schema.additionalProperties !== "boolean" &&
    !isRecord(schema.additionalProperties)
  ) {
    issues.push({
      path: `${path}.additionalProperties`,
      message: "must be a boolean or JSON Schema object",
    });
  }
  if (isRecord(schema.additionalProperties)) {
    collectJsonSchemaIssues(
      schema.additionalProperties as JsonValue,
      `${path}.additionalProperties`,
      issues,
    );
  }

  if (
    "enum" in schema &&
    !(Array.isArray(schema.enum) && schema.enum.length > 0)
  ) {
    issues.push({ path: `${path}.enum`, message: "must be a non-empty array" });
  }

  for (const [key, value] of Object.entries(schema)) {
    if (!NUMERIC_KEYWORDS.has(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path: `${path}.${key}`, message: "must be a number" });
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (!INTEGER_KEYWORDS.has(key)) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.push({
        path: `${path}.${key}`,
        message: "must be a non-negative integer",
      });
    }
  }

  if ("pattern" in schema && typeof schema.pattern !== "string") {
    issues.push({ path: `${path}.pattern`, message: "must be a string" });
  }
  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern);
    } catch {
      issues.push({
        path: `${path}.pattern`,
        message: "must be a valid regular expression",
      });
    }
  }
}

function validateJsonSchemaValue(
  schema: Record<string, unknown>,
  value: JsonValue,
  path: string,
): WorkflowJsonSchemaValueIssue | null {
  if ("const" in schema && !jsonEquals(value, schema.const)) {
    return { path, message: `must equal ${JSON.stringify(schema.const)}` };
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => jsonEquals(value, item))
  ) {
    return {
      path,
      message: `must be one of ${JSON.stringify(schema.enum)}`,
    };
  }
  const typeIssue = validateJsonSchemaType(schema.type, value, path);
  if (typeIssue) return typeIssue;

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      return { path, message: `must have length >= ${schema.minLength}` };
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      return { path, message: `must have length <= ${schema.maxLength}` };
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    ) {
      return {
        path,
        message: `must match pattern ${JSON.stringify(schema.pattern)}`,
      };
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return { path, message: `must be >= ${schema.minimum}` };
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return { path, message: `must be <= ${schema.maximum}` };
    }
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    for (const key of required) {
      if (!(key in value)) {
        return { path: `${path}.${key}`, message: "is required" };
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isJsonSchemaObject(childSchema)) continue;
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
      if (extra) {
        return { path: `${path}.${extra}`, message: "is not allowed" };
      }
    } else if (isJsonSchemaObject(schema.additionalProperties)) {
      const allowed = new Set(Object.keys(properties));
      for (const [key, childValue] of Object.entries(value)) {
        if (allowed.has(key)) continue;
        const issue = validateJsonSchemaValue(
          schema.additionalProperties,
          childValue as JsonValue,
          `${path}.${key}`,
        );
        if (issue) return issue;
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return {
        path,
        message: `must contain at least ${schema.minItems} items`,
      };
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return {
        path,
        message: `must contain at most ${schema.maxItems} items`,
      };
    }
    if (schema.items === false && value.length > 0) {
      return { path, message: "must not contain items" };
    }
    if (isJsonSchemaObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const issue = validateJsonSchemaValue(
          schema.items,
          value[index] as JsonValue,
          `${path}[${index}]`,
        );
        if (issue) return issue;
      }
    }
  }

  return null;
}

function validateJsonSchemaType(
  type: unknown,
  value: JsonValue,
  path: string,
): WorkflowJsonSchemaValueIssue | null {
  if (type === undefined) return null;
  const allowed = Array.isArray(type)
    ? type.filter(isJsonSchemaType)
    : isJsonSchemaType(type)
      ? [type]
      : [];
  if (allowed.length === 0) return null;
  return allowed.some((item) => jsonSchemaTypeMatches(item, value))
    ? null
    : { path, message: `must be ${allowed.join("|")}` };
}

function formatJsonSchemaValueIssue(
  issue: WorkflowJsonSchemaValueIssue,
): string {
  return `${issue.path} ${issue.message}`;
}

const JSON_SCHEMA_TYPES = new Set([
  "null",
  "array",
  "object",
  "string",
  "boolean",
  "number",
  "integer",
]);

const NUMERIC_KEYWORDS = new Set(["minimum", "maximum"]);
const INTEGER_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

function isJsonSchemaType(value: unknown): value is string {
  return typeof value === "string" && JSON_SCHEMA_TYPES.has(value);
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWebhookPath(value: string | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}
