import type { JsonValue } from "@openacme/workflows";

export interface WorkflowEngineerLiveScenario {
  id: string;
  title: string;
  complex: boolean;
  requiredCards: string[];
  expectedEvidence: string[];
  expectedStatus: "succeeded" | "failed";
  input: JsonValue;
  definition: {
    name: string;
    description?: string;
    inputSchema?: JsonValue;
    triggers?: Array<Record<string, unknown>>;
    nodes: Array<Record<string, unknown>>;
  };
}

export const WORKFLOW_ENGINEER_LIVE_SCENARIOS: WorkflowEngineerLiveScenario[] = [
  {
    id: "manual_log",
    title: "Manual input is logged",
    complex: false,
    requiredCards: ["builtin.log.info"],
    expectedEvidence: ["log event", "step output"],
    expectedStatus: "succeeded",
    input: { message: "hello" },
    definition: {
      name: "Dogfood Manual Log",
      nodes: [
        {
          id: "log_input",
          type: "builtin.log.info",
          message: "Manual input received",
          payload: "$.workflowTrigger.input",
        },
      ],
    },
  },
  {
    id: "set_variable",
    title: "Set variable then log context",
    complex: false,
    requiredCards: ["builtin.set", "builtin.log.info"],
    expectedEvidence: ["context assignment", "log event"],
    expectedStatus: "succeeded",
    input: { customer: { id: "cust_1", name: "Acme" } },
    definition: {
      name: "Dogfood Set Variable",
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
          next: ["log_customer"],
        },
        {
          id: "log_customer",
          type: "builtin.log.info",
          message: "Customer stored",
          payload: "$.context.customer",
        },
      ],
    },
  },
  {
    id: "uri_parse",
    title: "Parse a URI",
    complex: false,
    requiredCards: ["builtin.transform.uri_parse", "builtin.log.info"],
    expectedEvidence: ["uri hostname", "transform output.value"],
    expectedStatus: "succeeded",
    input: { url: "https://example.com/path?q=1" },
    definition: {
      name: "Dogfood URI Parse",
      nodes: [
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: { kind: "uri.parse", value: "$.workflowTrigger.input.url" },
          assign: { parsedUri: "$.steps.parse_uri.output.value" },
          next: ["log_uri"],
        },
        {
          id: "log_uri",
          type: "builtin.log.info",
          message: "URI parsed",
          payload: "$.context.parsedUri.hostname",
        },
      ],
    },
  },
  {
    id: "json_parse_pick",
    title: "Parse JSON and pick object fields",
    complex: false,
    requiredCards: [
      "builtin.transform.json_parse",
      "builtin.transform.object_pick",
    ],
    expectedEvidence: ["parsed object", "picked fields"],
    expectedStatus: "succeeded",
    input: { raw: "{\"id\":\"asset_1\",\"hostname\":\"vm-1\",\"ignored\":true}" },
    definition: {
      name: "Dogfood JSON Parse Pick",
      nodes: [
        {
          id: "parse_json",
          type: "builtin.transform.json_parse",
          transform: { kind: "json.parse", value: "$.workflowTrigger.input.raw" },
          next: ["pick_fields"],
        },
        {
          id: "pick_fields",
          type: "builtin.transform.object_pick",
          input: { parsed: "$.steps.parse_json.output.value" },
          transform: {
            kind: "object_pick",
            source: "parsed",
            fields: ["id", "hostname"],
          },
        },
      ],
    },
  },
  {
    id: "sleep_then_log",
    title: "Sleep then continue",
    complex: false,
    requiredCards: ["builtin.sleep", "builtin.log.debug"],
    expectedEvidence: ["delay output", "debug log"],
    expectedStatus: "succeeded",
    input: {},
    definition: {
      name: "Dogfood Sleep",
      nodes: [
        {
          id: "wait_short",
          type: "builtin.sleep",
          delayMs: 1,
          reason: "dogfood wait",
          next: ["debug_after_wait"],
        },
        {
          id: "debug_after_wait",
          type: "builtin.log.debug",
          message: "Wait complete",
        },
      ],
    },
  },
  {
    id: "mcp_tool_call",
    title: "Call an MCP workflow tool",
    complex: false,
    requiredCards: ["mcp.tool", "builtin.log.info"],
    expectedEvidence: ["mcp result", "tool inventory"],
    expectedStatus: "succeeded",
    input: { limit: 2 },
    definition: {
      name: "Dogfood MCP Tool",
      nodes: [
        {
          id: "fetch_assets",
          type: "mcp.tool",
          server: "dogfood",
          tool: "list_assets",
          input: { limit: "$.workflowTrigger.input.limit" },
          next: ["log_assets"],
        },
        {
          id: "log_assets",
          type: "builtin.log.info",
          message: "Assets fetched",
          payload: "$.steps.fetch_assets.output.result.assets",
        },
      ],
    },
  },
  {
    id: "agent_call",
    title: "Call a workflow agent",
    complex: false,
    requiredCards: ["agent.call", "builtin.log.info"],
    expectedEvidence: ["agent response", "agent inventory"],
    expectedStatus: "succeeded",
    input: { finding: "critical vuln" },
    definition: {
      name: "Dogfood Agent Call",
      nodes: [
        {
          id: "ask_risk_agent",
          type: "agent.call",
          agentId: "risk-agent",
          prompt: "Summarize {{$.workflowTrigger.input.finding}}",
          next: ["log_response"],
        },
        {
          id: "log_response",
          type: "builtin.log.info",
          message: "Agent responded",
          payload: "$.steps.ask_risk_agent.output.response",
        },
      ],
    },
  },
  {
    id: "controlled_error",
    title: "Throw a controlled error",
    complex: false,
    requiredCards: ["builtin.throw_error"],
    expectedEvidence: ["failed run", "step error"],
    expectedStatus: "failed",
    input: {},
    definition: {
      name: "Dogfood Controlled Error",
      nodes: [
        {
          id: "throw_controlled",
          type: "builtin.throw_error",
          message: "Expected dogfood failure",
          code: "dogfood_expected",
        },
      ],
    },
  },
  {
    id: "if_branch",
    title: "Route true and false branches",
    complex: true,
    requiredCards: ["builtin.if", "builtin.log.info", "builtin.log.warn"],
    expectedEvidence: ["branch_selected", "true route"],
    expectedStatus: "succeeded",
    input: { internal: true },
    definition: {
      name: "Dogfood If Branch",
      nodes: [
        {
          id: "internal_gate",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.internal == true",
          then: ["log_internal"],
          else: ["log_external"],
        },
        {
          id: "log_internal",
          type: "builtin.log.info",
          message: "Internal route",
        },
        {
          id: "log_external",
          type: "builtin.log.warn",
          message: "External route",
        },
      ],
    },
  },
  {
    id: "switch_default",
    title: "Route switch case and default",
    complex: true,
    requiredCards: ["builtin.switch", "builtin.log.info", "builtin.log.warn"],
    expectedEvidence: ["branch_selected", "default route"],
    expectedStatus: "succeeded",
    input: { kind: "unknown" },
    definition: {
      name: "Dogfood Switch Default",
      nodes: [
        {
          id: "kind_switch",
          type: "builtin.switch",
          value: "$.workflowTrigger.input.kind",
          cases: [{ id: "case_a", label: "Case A", value: "a", nodes: ["log_a"] }],
          default: ["log_default"],
        },
        { id: "log_a", type: "builtin.log.info", message: "Case A" },
        { id: "log_default", type: "builtin.log.warn", message: "Default case" },
      ],
    },
  },
  {
    id: "foreach_assets",
    title: "Loop over assets and aggregate outputs",
    complex: true,
    requiredCards: ["builtin.foreach", "builtin.log.info"],
    expectedEvidence: ["foreach aggregate", "item output"],
    expectedStatus: "succeeded",
    input: { assets: [{ id: "a1" }, { id: "a2" }] },
    definition: {
      name: "Dogfood Foreach Assets",
      nodes: [
        {
          id: "each_asset",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.assets",
          itemVar: "asset",
          body: ["log_asset"],
        },
        {
          id: "log_asset",
          type: "builtin.log.info",
          message: "Asset processed",
          payload: "asset.id",
        },
      ],
    },
  },
  {
    id: "parallel_logs",
    title: "Run two independent branches in parallel",
    complex: true,
    requiredCards: ["builtin.parallel", "builtin.log.info", "builtin.log.debug"],
    expectedEvidence: ["parallel aggregate", "branch outputs"],
    expectedStatus: "succeeded",
    input: {},
    definition: {
      name: "Dogfood Parallel Logs",
      nodes: [
        {
          id: "parallel_checks",
          type: "builtin.parallel",
          branches: [
            { id: "asset_branch", label: "Asset branch", nodes: ["log_asset_branch"] },
            { id: "ticket_branch", label: "Ticket branch", nodes: ["log_ticket_branch"] },
          ],
          failFast: true,
        },
        {
          id: "log_asset_branch",
          type: "builtin.log.info",
          message: "Asset branch complete",
        },
        {
          id: "log_ticket_branch",
          type: "builtin.log.debug",
          message: "Ticket branch complete",
        },
      ],
    },
  },
  {
    id: "large_output_artifact",
    title: "Read a spilled large output artifact",
    complex: false,
    requiredCards: ["builtin.python"],
    expectedEvidence: ["artifact list", "workflow_artifact_get"],
    expectedStatus: "succeeded",
    input: {},
    definition: {
      name: "Dogfood Large Output Artifact",
      nodes: [
        {
          id: "large_output",
          type: "builtin.python",
          code: "output = 'x' * 70000",
          timeoutMs: 1000,
        },
      ],
    },
  },
  {
    id: "ip_subnet",
    title: "Check IP subnet membership",
    complex: false,
    requiredCards: ["builtin.transform.ip_in_subnet"],
    expectedEvidence: ["boolean transform output"],
    expectedStatus: "succeeded",
    input: { ip: "10.0.0.5", subnet: "10.0.0.0/24" },
    definition: {
      name: "Dogfood IP Subnet",
      nodes: [
        {
          id: "ip_gate",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.ip",
            cidr: "$.workflowTrigger.input.subnet",
          },
        },
      ],
    },
  },
  {
    id: "combined_asset_priority",
    title: "Fetch assets, loop each asset, call agent, then log summary",
    complex: true,
    requiredCards: ["mcp.tool", "builtin.foreach", "agent.call", "builtin.log.info"],
    expectedEvidence: ["mcp result", "foreach aggregate", "agent responses", "final log"],
    expectedStatus: "succeeded",
    input: { limit: 2 },
    definition: {
      name: "Dogfood Combined Asset Priority",
      nodes: [
        {
          id: "fetch_assets",
          type: "mcp.tool",
          server: "dogfood",
          tool: "list_assets",
          input: { limit: "$.workflowTrigger.input.limit" },
          assign: { assets: "$.steps.fetch_assets.output.result.assets" },
          next: ["each_asset"],
        },
        {
          id: "each_asset",
          type: "builtin.foreach",
          items: "$.context.assets",
          itemVar: "asset",
          body: ["prioritize_asset"],
          assign: { priorities: "$.steps.each_asset.output.items" },
          next: ["final_log"],
        },
        {
          id: "prioritize_asset",
          type: "agent.call",
          agentId: "risk-agent",
          prompt: "Pick one priority vulnerability for {{asset.id}}",
          input: { asset: "asset" },
        },
        {
          id: "final_log",
          type: "builtin.log.info",
          message: "Asset priorities completed",
          payload: "$.context.priorities",
        },
      ],
    },
  },
];
