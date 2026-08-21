import type { JsonValue, WorkflowAuthoringNodeType } from "./schemas.js";
import {
  WorkflowAuthoringNodeTypeValues,
  WorkflowLogNodeTypeValues,
  WorkflowTransformNodeTypeValues,
  workflowTransformKindFromNodeType,
} from "./schemas.js";

export type WorkflowCardFamily =
  | "variables"
  | "transformers"
  | "logic"
  | "flow"
  | "logs"
  | "code"
  | "mcp"
  | "hosted"
  | "ai";

export interface WorkflowCardRoutePort {
  id: string;
  label: string;
  field: "next" | "then" | "else" | "cases" | "default" | "body" | "branches";
  cardinality: "single" | "many";
  description: string;
}

export interface WorkflowCardCatalogItem {
  type: WorkflowAuthoringNodeType;
  family: WorkflowCardFamily;
  label: string;
  description: string;
  configSchema: JsonValue;
  defaultConfig: JsonValue;
  routePorts: WorkflowCardRoutePort[];
  outputSchema: JsonValue;
  examples: JsonValue[];
}

const anyJsonSchema = { description: "Any JSON value" };
const jsonObjectSchema = { type: "object", additionalProperties: true };
const expressionSchema = {
  type: "string",
  minLength: 1,
  description:
    "Reference expression such as $.workflowTrigger.input, $.context.customer, or $.steps.step_id.output.value.",
};
const nextPort: WorkflowCardRoutePort = {
  id: "next",
  label: "Next",
  field: "next",
  cardinality: "many",
  description: "Normal continuation after this card completes.",
};

const transformLabels: Record<
  (typeof WorkflowTransformNodeTypeValues)[number],
  {
    label: string;
    description: string;
    configSchema: JsonValue;
    defaultConfig: JsonValue;
  }
> = {
  "builtin.transform.value_resolve": {
    label: "Value Resolve",
    description:
      "Resolve a reference or literal value and expose it as output.value.",
    configSchema: {
      type: "object",
      required: ["transform"],
      properties: {
        input: jsonObjectSchema,
        transform: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: { const: "value.resolve" },
            value: anyJsonSchema,
          },
        },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: {
      transform: { kind: "value.resolve", value: "$.workflowTrigger.input" },
    },
  },
  "builtin.transform.object_pick": {
    label: "Object Pick",
    description: "Pick named fields from an object into output.value.",
    configSchema: {
      type: "object",
      required: ["transform"],
      properties: {
        input: jsonObjectSchema,
        transform: {
          type: "object",
          required: ["kind", "source", "fields"],
          properties: {
            kind: { const: "object_pick" },
            source: {
              type: "string",
              description:
                "Optional key in this card's input object. Omit it to pick from the input object itself.",
            },
            fields: { type: "array", items: { type: "string" } },
          },
        },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: {
      input: { source: "$.workflowTrigger.input" },
      transform: { kind: "object_pick", source: "source", fields: [] },
    },
  },
  "builtin.transform.string_replace": {
    label: "String Replace",
    description:
      "Replace text in a string and expose the result as output.value.",
    configSchema: transformSchema("string.replace", {
      value: expressionSchema,
      search: { type: "string" },
      replace: { type: "string" },
      all: { type: "boolean" },
    }),
    defaultConfig: {
      transform: {
        kind: "string.replace",
        value: "",
        search: "",
        replace: "",
        all: true,
      },
    },
  },
  "builtin.transform.string_regex_replace": {
    label: "Regex Replace",
    description: "Apply a regular-expression replacement to a string.",
    configSchema: transformSchema("string.regex_replace", {
      value: expressionSchema,
      pattern: { type: "string" },
      replace: { type: "string" },
      flags: { type: "string" },
    }),
    defaultConfig: {
      transform: {
        kind: "string.regex_replace",
        value: "",
        pattern: "",
        replace: "",
        flags: "g",
      },
    },
  },
  "builtin.transform.string_regex_match": {
    label: "Regex Match",
    description: "Match a string with a regular expression.",
    configSchema: transformSchema("string.regex_match", {
      value: expressionSchema,
      pattern: { type: "string" },
      flags: { type: "string" },
    }),
    defaultConfig: {
      transform: {
        kind: "string.regex_match",
        value: "",
        pattern: "",
        flags: "",
      },
    },
  },
  "builtin.transform.json_parse": {
    label: "JSON Parse",
    description: "Parse a JSON string into output.value.",
    configSchema: transformSchema("json.parse", { value: expressionSchema }),
    defaultConfig: { transform: { kind: "json.parse", value: "" } },
  },
  "builtin.transform.json_stringify": {
    label: "JSON Stringify",
    description: "Serialize a JSON value into a string.",
    configSchema: transformSchema("json.stringify", {
      value: anyJsonSchema,
      space: { type: "integer", minimum: 0 },
    }),
    defaultConfig: {
      transform: { kind: "json.stringify", value: "$.workflowTrigger.input" },
    },
  },
  "builtin.transform.csv_parse": {
    label: "CSV Parse",
    description: "Parse CSV text into rows.",
    configSchema: transformSchema("csv.parse", {
      value: expressionSchema,
      delimiter: { type: "string" },
      headers: { type: "boolean" },
    }),
    defaultConfig: {
      transform: {
        kind: "csv.parse",
        value: "",
        delimiter: ",",
        headers: true,
      },
    },
  },
  "builtin.transform.csv_stringify": {
    label: "CSV Stringify",
    description: "Convert an array of objects or arrays into CSV text.",
    configSchema: transformSchema("csv.stringify", {
      value: anyJsonSchema,
      delimiter: { type: "string" },
      includeHeaders: { type: "boolean" },
    }),
    defaultConfig: {
      transform: {
        kind: "csv.stringify",
        value: "$.workflowTrigger.input.rows",
        delimiter: ",",
        includeHeaders: true,
      },
    },
  },
  "builtin.transform.ip_parse": {
    label: "IP Parse",
    description: "Parse an IP address or CIDR and expose structured IP fields.",
    configSchema: transformSchema("ip.parse", { value: expressionSchema }),
    defaultConfig: { transform: { kind: "ip.parse", value: "" } },
  },
  "builtin.transform.ip_is_ipv4": {
    label: "Is IPv4",
    description: "Return whether a value is a valid IPv4 address.",
    configSchema: transformSchema("ip.is_ipv4", { value: expressionSchema }),
    defaultConfig: { transform: { kind: "ip.is_ipv4", value: "" } },
  },
  "builtin.transform.ip_is_ipv6": {
    label: "Is IPv6",
    description: "Return whether a value is a valid IPv6 address.",
    configSchema: transformSchema("ip.is_ipv6", { value: expressionSchema }),
    defaultConfig: { transform: { kind: "ip.is_ipv6", value: "" } },
  },
  "builtin.transform.ip_in_subnet": {
    label: "IP In Subnet",
    description: "Return whether an IP address belongs to a CIDR subnet.",
    configSchema: transformSchema("ip.in_subnet", {
      value: expressionSchema,
      cidr: expressionSchema,
    }),
    defaultConfig: { transform: { kind: "ip.in_subnet", value: "", cidr: "" } },
  },
  "builtin.transform.ip_netmask": {
    label: "IP Netmask",
    description: "Compute a netmask for an IP version and prefix length.",
    configSchema: transformSchema("ip.netmask", {
      prefixLength: { type: "integer", minimum: 0 },
      version: { enum: [4, 6] },
    }),
    defaultConfig: {
      transform: { kind: "ip.netmask", prefixLength: 24, version: 4 },
    },
  },
  "builtin.transform.ip_network": {
    label: "IP Network",
    description: "Compute network details for an IP/CIDR value.",
    configSchema: transformSchema("ip.network", { value: expressionSchema }),
    defaultConfig: { transform: { kind: "ip.network", value: "" } },
  },
  "builtin.transform.uri_parse": {
    label: "URI Parse",
    description: "Parse a URI into stable URL fields.",
    configSchema: transformSchema("uri.parse", { value: expressionSchema }),
    defaultConfig: { transform: { kind: "uri.parse", value: "" } },
  },
};

const staticCatalog: WorkflowCardCatalogItem[] = [
  {
    type: "builtin.set",
    family: "variables",
    label: "Set Variable",
    description: "Write one or more values into workflow context.",
    configSchema: {
      type: "object",
      required: ["assign"],
      properties: { assign: assignmentSchema() },
    },
    defaultConfig: { assign: { value: "$.workflowTrigger.input" } },
    routePorts: [nextPort],
    outputSchema: {
      type: "object",
      properties: { assigned: { type: "object" } },
    },
    examples: [{ assign: { customer: "$.workflowTrigger.input.customer" } }],
  },
  {
    type: "builtin.output.set",
    family: "variables",
    label: "Set Workflow Output",
    description: "Write an explicit value into the workflow's final output.",
    configSchema: {
      type: "object",
      required: ["path", "value"],
      properties: {
        path: {
          type: "string",
          description: "Dotted output path such as result or result.summary.",
        },
        value: anyJsonSchema,
        mode: { enum: ["replace", "merge", "append"] },
      },
    },
    defaultConfig: {
      path: "result",
      value: "$.steps.step_id.output.value",
      mode: "replace",
    },
    routePorts: [nextPort],
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        value: anyJsonSchema,
        mode: { type: "string" },
      },
    },
    examples: [
      {
        path: "result",
        value: "$.steps.prioritize.output.response",
        mode: "replace",
      },
    ],
  },
  {
    type: "builtin.if",
    family: "logic",
    label: "If",
    description: "Route execution to true or false paths from a condition.",
    configSchema: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: { type: "string", minLength: 1 },
      },
    },
    defaultConfig: { condition: "$.workflowTrigger.input.enabled == true" },
    routePorts: [
      {
        id: "then",
        label: "True",
        field: "then",
        cardinality: "many",
        description: "Route starts when the condition evaluates true.",
      },
      {
        id: "else",
        label: "False",
        field: "else",
        cardinality: "many",
        description: "Route starts when the condition evaluates false.",
      },
      nextPort,
    ],
    outputSchema: {
      type: "object",
      properties: { matched: { type: "boolean" } },
    },
    examples: [{ condition: "$.workflowTrigger.input.enabled == true" }],
  },
  {
    type: "builtin.switch",
    family: "logic",
    label: "Switch",
    description: "Route execution to a matching case or default path.",
    configSchema: {
      type: "object",
      required: ["value", "cases"],
      properties: {
        value: anyJsonSchema,
        cases: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "value"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              value: anyJsonSchema,
            },
          },
        },
      },
    },
    defaultConfig: {
      value: "$.workflowTrigger.input.kind",
      cases: [{ id: "case_a", label: "Case A", value: "a" }],
      default: [],
    },
    routePorts: [
      {
        id: "cases",
        label: "Cases",
        field: "cases",
        cardinality: "many",
        description: "Each case owns its own route starts in case.nodes.",
      },
      {
        id: "default",
        label: "Default",
        field: "default",
        cardinality: "many",
        description: "Route starts when no case matches.",
      },
      nextPort,
    ],
    outputSchema: {
      type: "object",
      properties: { matched: { type: "boolean" }, caseId: { type: "string" } },
    },
    examples: [
      {
        value: "$.workflowTrigger.input.kind",
        cases: [{ id: "internal", value: "internal" }],
      },
    ],
  },
  {
    type: "builtin.foreach",
    family: "flow",
    label: "For Each",
    description: "Loop over a list and run body cards for each item.",
    configSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: expressionSchema,
        itemVar: { type: "string", minLength: 1 },
        concurrency: { type: "integer", minimum: 1, maximum: 1 },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: { items: "$.workflowTrigger.input.items", itemVar: "item" },
    routePorts: [
      {
        id: "body",
        label: "Loop Body",
        field: "body",
        cardinality: "many",
        description: "First card or cards that run for each item.",
      },
      nextPort,
    ],
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "integer" },
        succeeded: { type: "integer" },
        failed: { type: "integer" },
        items: { type: "array" },
      },
    },
    examples: [{ items: "$.workflowTrigger.input.assets", itemVar: "asset" }],
  },
  {
    type: "builtin.parallel",
    family: "flow",
    label: "Parallel",
    description:
      "Run independent branch routes in parallel and aggregate their results.",
    configSchema: {
      type: "object",
      required: ["branches"],
      properties: {
        branches: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" }, label: { type: "string" } },
          },
        },
        concurrency: { type: "integer", minimum: 1, maximum: 16 },
        failFast: { type: "boolean" },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: {
      branches: [
        { id: "branch_a", label: "Branch A", nodes: [] },
        { id: "branch_b", label: "Branch B", nodes: [] },
      ],
      failFast: true,
    },
    routePorts: [
      {
        id: "branches",
        label: "Branches",
        field: "branches",
        cardinality: "many",
        description: "Each branch owns its own route starts in branch.nodes.",
      },
      nextPort,
    ],
    outputSchema: {
      type: "object",
      properties: {
        branches: { type: "array" },
        succeeded: { type: "integer" },
        failed: { type: "integer" },
      },
    },
    examples: [
      {
        branches: [{ id: "asset_lookup" }, { id: "ticket_lookup" }],
        failFast: false,
      },
    ],
  },
  {
    type: "builtin.exit",
    family: "flow",
    label: "Exit",
    description:
      "Terminate the workflow with a terminal status and optional output.",
    configSchema: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["succeeded", "failed", "canceled"] },
        output: anyJsonSchema,
      },
    },
    defaultConfig: { status: "succeeded" },
    routePorts: [],
    outputSchema: {
      type: "object",
      properties: { status: { type: "string" }, output: anyJsonSchema },
    },
    examples: [{ status: "succeeded", output: "$.context.summary" }],
  },
  {
    type: "builtin.throw_error",
    family: "flow",
    label: "Throw Error",
    description: "Fail the run with a controlled error code and details.",
    configSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string", minLength: 1 },
        code: { type: "string" },
        details: anyJsonSchema,
      },
    },
    defaultConfig: { message: "Workflow failed", code: "workflow_failed" },
    routePorts: [],
    outputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: anyJsonSchema,
      },
    },
    examples: [{ message: "Risk gate rejected", code: "risk_gate_rejected" }],
  },
  {
    type: "builtin.sleep",
    family: "flow",
    label: "Sleep",
    description: "Wait for a bounded delay before continuing.",
    configSchema: {
      type: "object",
      required: ["delayMs"],
      properties: {
        delayMs: { type: "integer", minimum: 1, maximum: 300000 },
        reason: { type: "string" },
      },
    },
    defaultConfig: { delayMs: 1000 },
    routePorts: [nextPort],
    outputSchema: {
      type: "object",
      properties: { delayMs: { type: "integer" }, reason: { type: "string" } },
    },
    examples: [{ delayMs: 5000, reason: "Wait for eventual consistency" }],
  },
  {
    type: "builtin.python",
    family: "code",
    label: "Python",
    description:
      "Run bounded Python code and expose result output as output.value.",
    configSchema: {
      type: "object",
      required: ["code"],
      properties: {
        input: jsonObjectSchema,
        code: { type: "string", minLength: 1 },
        reset: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000 },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: { code: "output = input", timeoutMs: 30000 },
    routePorts: [nextPort],
    outputSchema: { type: "object", properties: { value: anyJsonSchema } },
    examples: [
      { input: { value: "$.workflowTrigger.input" }, code: "output = input" },
    ],
  },
  {
    type: "mcp.tool",
    family: "mcp",
    label: "MCP Tool",
    description: "Call a discovered MCP server tool with mapped input.",
    configSchema: {
      type: "object",
      required: ["server", "tool"],
      properties: {
        server: { type: "string", minLength: 1 },
        tool: { type: "string", minLength: 1 },
        input: jsonObjectSchema,
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000 },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: { server: "", tool: "", input: {} },
    routePorts: [nextPort],
    outputSchema: { type: "object", properties: { result: anyJsonSchema } },
    examples: [{ server: "qualys", tool: "list_assets", input: { limit: 5 } }],
  },
  {
    type: "hosted.tool",
    family: "hosted",
    label: "Hosted Tool",
    description: "Call an OpenAcme hosted integration tool with mapped input.",
    configSchema: {
      type: "object",
      required: ["toolName"],
      properties: {
        toolName: { type: "string", minLength: 1 },
        input: jsonObjectSchema,
        timeoutMs: { type: "integer", minimum: 100, maximum: 300000 },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: { toolName: "", input: {} },
    routePorts: [nextPort],
    outputSchema: { type: "object", properties: { result: anyJsonSchema } },
    examples: [
      {
        toolName: "hosted_qualys__qualys_gav_asset_count",
        input: { filter_body: { filters: [] } },
      },
    ],
  },
  {
    type: "agent.call",
    family: "ai",
    label: "Agent Call",
    description:
      "Call an OpenAcme agent and expose its response as output.response.",
    configSchema: {
      type: "object",
      required: ["agentId", "prompt"],
      properties: {
        agentId: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        input: jsonObjectSchema,
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
        assign: assignmentSchema(),
      },
    },
    defaultConfig: { agentId: "", prompt: "" },
    routePorts: [nextPort],
    outputSchema: {
      type: "object",
      properties: { response: { type: "string" } },
    },
    examples: [
      {
        agentId: "risk-agent",
        prompt: "Prioritize $.workflowTrigger.input.findings",
      },
    ],
  },
];

const logCatalog: WorkflowCardCatalogItem[] = WorkflowLogNodeTypeValues.map(
  (type) => {
    const level = type.split(".").at(-1) ?? "info";
    return {
      type,
      family: "logs",
      label: `Log ${titleCase(level)}`,
      description: `Write a structured ${level} log event to the run timeline. The message may be a direct reference such as $.workflowTrigger.input.message or a template such as Received {{ $.workflowTrigger.input.message }}.`,
      configSchema: {
        type: "object",
        required: ["message"],
        properties: {
          input: jsonObjectSchema,
          message: { type: "string", minLength: 1 },
          payload: anyJsonSchema,
          assign: assignmentSchema(),
        },
      },
      defaultConfig: { message: `Workflow ${level}` },
      routePorts: [nextPort],
      outputSchema: {
        type: "object",
        properties: {
          level: { const: level },
          message: { type: "string" },
          payload: anyJsonSchema,
        },
      },
      examples: [
        { message: "$.workflowTrigger.input.message" } as JsonValue,
        {
          message: "Workflow reached {{ $.workflowTrigger.input.stage }}",
          payload: "$.context",
        } as JsonValue,
      ],
    };
  },
);

const transformCatalog: WorkflowCardCatalogItem[] =
  WorkflowTransformNodeTypeValues.map((type) => {
    const meta = transformLabels[type];
    return {
      type,
      family: "transformers",
      label: meta.label,
      description: meta.description,
      configSchema: meta.configSchema,
      defaultConfig: meta.defaultConfig,
      routePorts: [nextPort],
      outputSchema: transformOutputSchema(type),
      examples: [meta.defaultConfig],
    };
  });

const catalog = [...staticCatalog, ...transformCatalog, ...logCatalog].sort(
  (a, b) =>
    WorkflowAuthoringNodeTypeValues.indexOf(a.type) -
    WorkflowAuthoringNodeTypeValues.indexOf(b.type),
);

export function getWorkflowCardCatalog(): WorkflowCardCatalogItem[] {
  return catalog.map((item) => cloneJson(item) as WorkflowCardCatalogItem);
}

function assignmentSchema(): JsonValue {
  return {
    type: "object",
    additionalProperties: {
      oneOf: [
        { type: "string", minLength: 1 },
        {
          type: "object",
          required: ["from"],
          properties: {
            from: { type: "string", minLength: 1 },
            mode: { enum: ["replace", "merge", "append"] },
          },
        },
      ],
    },
  };
}

function transformSchema(
  kind: string,
  properties: Record<string, JsonValue>,
): JsonValue {
  return {
    type: "object",
    required: ["transform"],
    properties: {
      input: jsonObjectSchema,
      transform: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { const: kind },
          ...properties,
        },
      },
      assign: assignmentSchema(),
    },
  };
}

function transformOutputSchema(
  type: (typeof WorkflowTransformNodeTypeValues)[number],
): JsonValue {
  const kind = workflowTransformKindFromNodeType(type);
  if (kind === "uri.parse") {
    return {
      type: "object",
      properties: {
        value: {
          type: "object",
          properties: {
            href: { type: "string" },
            protocol: { type: "string" },
            scheme: { type: "string" },
            origin: { type: "string" },
            host: { type: "string" },
            hostname: { type: "string" },
            port: { type: "string" },
            pathname: { type: "string" },
            path: { type: "string" },
            query: { type: "object" },
            queryList: { type: "array" },
            fragment: { type: "string" },
            username: { type: ["string", "null"] },
            password: { type: "string" },
            hasCredentials: { type: "boolean" },
          },
        },
      },
    };
  }
  if (kind.startsWith("ip.is_") || kind === "ip.in_subnet") {
    return { type: "object", properties: { value: { type: "boolean" } } };
  }
  return { type: "object", properties: { value: anyJsonSchema } };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
