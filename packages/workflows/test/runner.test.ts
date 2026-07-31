import { describe, expect, it } from "vitest";
import { WorkflowRunner } from "../src/index.js";
import type { WorkflowDefinition } from "../src/index.js";

const now = "2026-07-30T00:00:00.000Z";

function definition(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return {
    id: "wf_runner",
    version: 1,
    status: "draft",
    name: "Runner workflow",
    triggers: [{ id: "manual", kind: "manual", enabled: true }],
    nodes,
    createdAt: now,
    updatedAt: now,
  };
}

function steppedNow(stepMs = 25): () => string {
  let tick = 0;
  const start = Date.parse(now);
  return () => new Date(start + tick++ * stepMs).toISOString();
}

describe("WorkflowRunner builtin MVP", () => {
  it("emits events to the event port while execution is still in progress", async () => {
    const eventKinds: string[] = [];
    const observedBeforeToolReturn: string[][] = [];
    const runner = new WorkflowRunner({
      ports: {
        events: {
          async append(event) {
            eventKinds.push(event.kind);
          },
        },
        mcp: {
          async callTool() {
            observedBeforeToolReturn.push([...eventKinds]);
            return { output: { ok: true } };
          },
        },
      },
    });

    const result = await runner.run({
      runId: "run_event_port",
      definition: definition([
        {
          id: "lookup",
          type: "mcp.tool",
          server: "crm",
          tool: "lookup",
          input: {},
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("succeeded");
    expect(observedBeforeToolReturn).toEqual([["run_started", "step_started"]]);
    expect(eventKinds).toEqual([
      "run_started",
      "step_started",
      "step_output",
      "step_completed",
      "run_completed",
    ]);
  });

  it("executes set, transform, log, and exit with inspectable trace", async () => {
    const runner = new WorkflowRunner();

    const result = await runner.run({
      runId: "run_success",
      definition: definition([
        {
          id: "set_customer",
          type: "builtin.set",
          assign: {
            customer: "$.input.customer",
          },
        },
        {
          id: "normalize_customer",
          label: "Normalize customer",
          type: "builtin.transform",
          input: {
            customer: "$.context.customer",
          },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id", "name"],
          },
          assign: {
            customer: {
              from: "$.steps.normalize_customer.output",
              mode: "replace",
            },
          },
        },
        {
          id: "log_customer",
          type: "builtin.log.info",
          message: "Customer normalized",
          payload: "$.context.customer",
          assign: {
            loggedCustomer: "$.steps.log_customer.output.payload",
          },
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context.customer",
        },
      ]),
      input: {
        customer: {
          id: "cust_1",
          name: "Ada",
          secret: "not selected",
        },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ id: "cust_1", name: "Ada" });
    expect(result.context).toEqual({
      customer: { id: "cust_1", name: "Ada" },
      loggedCustomer: { id: "cust_1", name: "Ada" },
    });
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_customer", "succeeded"],
      ["normalize_customer", "succeeded"],
      ["log_customer", "succeeded"],
      ["exit", "succeeded"],
    ]);
    expect(result.stepAttempts[1]?.contextDiff).toEqual({
      customer: {
        before: { id: "cust_1", name: "Ada", secret: "not selected" },
        after: { id: "cust_1", name: "Ada" },
      },
    });
    expect(result.stepAttempts[2]?.logsSummary).toEqual({
      logs: [
        {
          level: "info",
          message: "Customer normalized",
          payload: { id: "cust_1", name: "Ada" },
        },
      ],
    });
    expect(result.stepAttempts[2]?.contextDiff).toEqual({
      loggedCustomer: {
        before: null,
        after: { id: "cust_1", name: "Ada" },
      },
    });
    expect(
      result.events.find(
        (event) =>
          event.kind === "step_started" &&
          event.stepRunId === "run_success:normalize_customer:1",
      )?.payload,
    ).toEqual({
      nodeId: "normalize_customer",
      nodeType: "builtin.transform",
      nodeLabel: "Normalize customer",
      input: {
        customer: { id: "cust_1", name: "Ada", secret: "not selected" },
      },
    });
    expect(result.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "step_completed",
      "step_started",
      "step_output",
      "step_completed",
      "step_started",
      "log",
      "step_completed",
      "step_started",
      "run_completed",
      "step_completed",
    ]);
  });

  it("records non-null step durations for executed and skipped attempts", async () => {
    const result = await new WorkflowRunner({ now: steppedNow() }).run({
      runId: "run_durations",
      definition: definition([
        {
          id: "route",
          type: "builtin.if",
          condition: "$.input.ready",
          then: ["log_ready"],
          else: ["log_not_ready"],
        },
        {
          id: "log_ready",
          type: "builtin.log.info",
          message: "ready",
        },
        {
          id: "log_not_ready",
          type: "builtin.log.info",
          message: "not ready",
        },
      ]),
      input: { ready: true },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.find((step) => step.nodeId === "route"),
    ).toMatchObject({
      status: "succeeded",
      durationMs: expect.any(Number),
    });
    expect(
      result.stepAttempts.find((step) => step.nodeId === "log_ready"),
    ).toMatchObject({
      status: "succeeded",
      durationMs: expect.any(Number),
    });
    expect(
      result.stepAttempts.find((step) => step.nodeId === "log_not_ready"),
    ).toMatchObject({
      status: "skipped",
      durationMs: 0,
    });
  });

  it("records non-null step durations for failed attempts", async () => {
    const result = await new WorkflowRunner({ now: steppedNow() }).run({
      runId: "run_failure_durations",
      definition: definition([
        {
          id: "set_missing",
          type: "builtin.set",
          assign: { missing: "$.context.customer.missing" },
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts).toEqual([
      expect.objectContaining({
        nodeId: "set_missing",
        status: "failed",
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it("records canceled exit as a run_canceled event", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_exit_canceled",
      definition: definition([
        {
          id: "exit",
          type: "builtin.exit",
          status: "canceled",
          output: { reason: "operator-defined stop" },
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("canceled");
    expect(result.output).toEqual({ reason: "operator-defined stop" });
    expect(result.stepAttempts).toEqual([
      expect.objectContaining({
        nodeId: "exit",
        status: "canceled",
        output: { reason: "operator-defined stop" },
      }),
    ]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_canceled",
      "step_completed",
    ]);
    expect(result.events.at(-2)).toMatchObject({
      level: "system",
      kind: "run_canceled",
      message: "Workflow run canceled",
      payload: {
        status: "canceled",
        output: { reason: "operator-defined stop" },
      },
    });
  });

  it("records failed exit as a step_failed audit event", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_exit_failed",
      definition: definition([
        {
          id: "exit",
          type: "builtin.exit",
          status: "failed",
          output: { reason: "business rule failed" },
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(result.output).toEqual({ reason: "business rule failed" });
    expect(result.stepAttempts).toEqual([
      expect.objectContaining({
        nodeId: "exit",
        status: "failed",
        output: { reason: "business rule failed" },
      }),
    ]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "run_failed",
      "step_failed",
    ]);
    expect(result.events.at(-1)).toMatchObject({
      level: "error",
      kind: "step_failed",
      message: "Step exit failed",
      payload: {
        status: "failed",
        output: { reason: "business rule failed" },
      },
    });
  });

  it("selects if true branches and records skipped false steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.input.riskScore >= 70",
          then: ["high_log"],
          else: ["low_log"],
        },
        {
          id: "high_log",
          type: "builtin.log.error",
          message: "High risk",
        },
        {
          id: "low_log",
          type: "builtin.log.info",
          message: "Low risk",
        },
      ]),
      input: { riskScore: 82 },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["branch", "succeeded"],
      ["low_log", "skipped"],
      ["high_log", "succeeded"],
    ]);
    expect(
      result.events.find((event) => event.kind === "branch_selected")?.payload,
    ).toEqual({
      condition: "$.input.riskScore >= 70",
      selected: ["high_log"],
      skipped: ["low_log"],
    });
  });

  it("does not split boolean operators inside quoted condition strings", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_quoted_operators",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if_else",
          condition:
            'contains($.input.note, "red or blue") or contains($.input.note, "review and hold")',
          then: ["matched_log"],
          else: ["unmatched_log"],
        },
        {
          id: "matched_log",
          type: "builtin.log.info",
          message: "Matched note",
        },
        {
          id: "unmatched_log",
          type: "builtin.log.info",
          message: "Unmatched note",
        },
      ]),
      input: { note: "plain green note" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["branch", "succeeded"],
      ["matched_log", "skipped"],
      ["unmatched_log", "succeeded"],
    ]);
  });

  it("does not split contains arguments on commas inside quoted strings", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_quoted_comma",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if_else",
          condition: 'contains($.input.note, "red, blue")',
          then: ["matched_log"],
          else: ["unmatched_log"],
        },
        {
          id: "matched_log",
          type: "builtin.log.info",
          message: "Matched comma note",
        },
        {
          id: "unmatched_log",
          type: "builtin.log.info",
          message: "Unmatched comma note",
        },
      ]),
      input: { note: "plain red, blue note" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["branch", "succeeded"],
      ["unmatched_log", "skipped"],
      ["matched_log", "succeeded"],
    ]);
  });

  it("does not parse comparison operators inside quoted strings", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_quoted_comparison",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if_else",
          condition: '"a >= b" == $.input.note',
          then: ["matched_log"],
          else: ["unmatched_log"],
        },
        {
          id: "matched_log",
          type: "builtin.log.info",
          message: "Matched comparison note",
        },
        {
          id: "unmatched_log",
          type: "builtin.log.info",
          message: "Unmatched comparison note",
        },
      ]),
      input: { note: "a >= b" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["branch", "succeeded"],
      ["unmatched_log", "skipped"],
      ["matched_log", "succeeded"],
    ]);
  });

  it("supports parenthesized not conditions", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_parenthesized_not",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if_else",
          condition: 'not(contains($.input.note, "blocked"))',
          then: ["matched_log"],
          else: ["unmatched_log"],
        },
        {
          id: "matched_log",
          type: "builtin.log.info",
          message: "Matched allowed note",
        },
        {
          id: "unmatched_log",
          type: "builtin.log.info",
          message: "Unmatched blocked note",
        },
      ]),
      input: { note: "blocked" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["branch", "succeeded"],
      ["matched_log", "skipped"],
      ["unmatched_log", "succeeded"],
    ]);
  });

  it("does not mutate context when a step expression fails", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_failure",
      definition: definition([
        {
          id: "set_initial",
          type: "builtin.set",
          assign: { customerId: "$.input.customerId" },
        },
        {
          id: "set_missing",
          type: "builtin.set",
          assign: { missing: "$.context.customer.missing" },
        },
      ]),
      input: { customerId: "cust_1" },
    });

    expect(result.status).toBe("failed");
    expect(result.context).toEqual({ customerId: "cust_1" });
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_initial", "succeeded"],
      ["set_missing", "failed"],
    ]);
    expect(result.stepAttempts[1]?.error).toMatchObject({
      message: expect.stringContaining("$.context.customer.missing"),
    });
  });

  it("supports replace, merge, and append assignment modes", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_assignments",
      definition: definition([
        {
          id: "set_customer",
          type: "builtin.set",
          assign: {
            customer: "$.input.customer",
            tags: "$.input.initialTags",
          },
        },
        {
          id: "pick_customer",
          type: "builtin.transform",
          input: { customer: "$.context.customer" },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id"],
          },
          assign: {
            customer: {
              from: "$.steps.pick_customer.output",
              mode: "merge",
            },
          },
        },
        {
          id: "make_tag",
          type: "builtin.transform",
          input: { tag: "$.input.nextTag" },
          transform: "$.input.nextTag",
          assign: {
            tags: {
              from: "$.steps.make_tag.output",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        customer: { id: "cust_1", name: "Ada" },
        initialTags: ["existing"],
        nextTag: "reviewed",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      customer: { id: "cust_1", name: "Ada" },
      tags: ["existing", "reviewed"],
    });
  });

  it("calls MCP tools through the workflow port and assigns output", async () => {
    const calls: unknown[] = [];
    const result = await new WorkflowRunner({
      ports: {
        mcp: {
          async callTool(req) {
            calls.push(req);
            return {
              output: {
                normalized: true,
                customerId: "cust_1",
              },
            };
          },
        },
      },
    }).run({
      runId: "run_mcp_success",
      definition: definition([
        {
          id: "lookup_customer",
          type: "mcp.tool",
          server: "crm",
          tool: "lookup",
          input: {
            id: "$.input.customerId",
          },
          assign: {
            crmResult: "$.steps.lookup_customer.output",
          },
        },
      ]),
      input: { customerId: "cust_1" },
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      {
        server: "crm",
        tool: "lookup",
        input: { id: "cust_1" },
        timeoutMs: undefined,
      },
    ]);
    expect(result.context).toEqual({
      crmResult: { normalized: true, customerId: "cust_1" },
    });
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "lookup_customer",
      status: "succeeded",
      output: { normalized: true, customerId: "cust_1" },
      contextDiff: {
        crmResult: {
          before: null,
          after: { normalized: true, customerId: "cust_1" },
        },
      },
    });
    expect(result.events.map((event) => event.kind)).toContain("step_output");
  });

  it("fails MCP steps with persisted error details", async () => {
    const result = await new WorkflowRunner({
      ports: {
        mcp: {
          async callTool() {
            throw new Error("crm unavailable");
          },
        },
      },
    }).run({
      runId: "run_mcp_failure",
      definition: definition([
        {
          id: "lookup_customer",
          type: "mcp.tool",
          server: "crm",
          tool: "lookup",
          input: {
            id: "$.input.customerId",
          },
        },
      ]),
      input: { customerId: "cust_1" },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "lookup_customer",
      status: "failed",
      input: { id: "cust_1" },
      error: { message: "crm unavailable" },
    });
    expect(result.events.map((event) => event.kind)).toContain("run_failed");
  });

  it("calls agents through the workflow port and assigns output", async () => {
    const calls: unknown[] = [];
    const result = await new WorkflowRunner({
      ports: {
        agent: {
          listAgents: () => [],
          async callAgent(req) {
            calls.push(req);
            return {
              sessionId: "session_agent_1",
              output: {
                response: "Customer cust_1 is ready",
                sessionId: "session_agent_1",
              },
            };
          },
        },
      },
    }).run({
      runId: "run_agent_success",
      definition: definition([
        {
          id: "ask_support",
          type: "agent.call",
          agentId: "support",
          prompt: "Review customer {{$.input.customerId}}",
          input: {
            customerId: "$.input.customerId",
          },
          assign: {
            agentResult: "$.steps.ask_support.output",
          },
        },
      ]),
      input: { customerId: "cust_1" },
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      {
        agentId: "support",
        prompt: "Review customer cust_1",
        input: { customerId: "cust_1" },
        runId: "run_agent_success",
        timeoutMs: undefined,
      },
    ]);
    expect(result.context).toEqual({
      agentResult: {
        response: "Customer cust_1 is ready",
        sessionId: "session_agent_1",
      },
    });
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "ask_support",
      status: "succeeded",
      output: {
        response: "Customer cust_1 is ready",
        sessionId: "session_agent_1",
      },
    });
    expect(result.events.map((event) => event.kind)).toContain("step_output");
  });

  it("fails agent calls with persisted error details", async () => {
    const result = await new WorkflowRunner({
      ports: {
        agent: {
          listAgents: () => [],
          async callAgent() {
            throw new Error("agent call timed out");
          },
        },
      },
    }).run({
      runId: "run_agent_failure",
      definition: definition([
        {
          id: "ask_support",
          type: "agent.call",
          agentId: "support",
          prompt: "Review",
          timeoutMs: 100,
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "ask_support",
      status: "failed",
      error: {
        message: "agent call timed out",
      },
    });
  });

  it("runs foreach sequentially with per-item child attempts and output trace", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_foreach_success",
      definition: definition([
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          itemVar: "customer",
          body: ["pick_customer"],
          concurrency: 1,
          assign: {
            foreachSummary: "$.steps.each_customer.output",
          },
        },
        {
          id: "pick_customer",
          type: "builtin.transform",
          input: { customer: "customer" },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id"],
          },
          assign: {
            customerIds: {
              from: "$.steps.pick_customer.output",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        customers: [
          { id: "cust_1", name: "Ada" },
          { id: "cust_2", name: "Lin" },
        ],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      customerIds: [{ id: "cust_1" }, { id: "cust_2" }],
      foreachSummary: {
        count: 2,
        items: [
          {
            index: 0,
            item: { id: "cust_1", name: "Ada" },
            status: "succeeded",
            steps: { pick_customer: { id: "cust_1" } },
          },
          {
            index: 1,
            item: { id: "cust_2", name: "Lin" },
            status: "succeeded",
            steps: { pick_customer: { id: "cust_2" } },
          },
        ],
      },
    });
    expect(
      result.stepAttempts
        .filter((step) => step.nodeId === "pick_customer")
        .map((step) => [step.attempt, step.status, step.input, step.output]),
    ).toEqual([
      [
        1,
        "succeeded",
        { customer: { id: "cust_1", name: "Ada" } },
        { id: "cust_1" },
      ],
      [
        2,
        "succeeded",
        { customer: { id: "cust_2", name: "Lin" } },
        { id: "cust_2" },
      ],
    ]);
    expect(
      result.stepAttempts.find((step) => step.nodeId === "each_customer")
        ?.output,
    ).toMatchObject({
      count: 2,
      items: [
        {
          index: 0,
          status: "succeeded",
          steps: { pick_customer: { id: "cust_1" } },
        },
        {
          index: 1,
          status: "succeeded",
          steps: { pick_customer: { id: "cust_2" } },
        },
      ],
    });
    expect(
      result.stepAttempts.find((step) => step.nodeId === "each_customer")
        ?.contextDiff,
    ).toMatchObject({
      foreachSummary: {
        after: {
          count: 2,
        },
      },
    });
    expect(result.events.map((event) => event.kind)).toContain("step_output");
  });

  it("handles empty foreach collections without running body steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_foreach_empty",
      definition: definition([
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          body: ["pick_customer"],
        },
        {
          id: "pick_customer",
          type: "builtin.transform",
          input: { customer: "item" },
          transform: "$.input.never",
        },
      ]),
      input: { customers: [] },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({});
    expect(
      result.stepAttempts.filter((step) => step.nodeId === "pick_customer"),
    ).toHaveLength(0);
    expect(
      result.stepAttempts.find((step) => step.nodeId === "each_customer")
        ?.output,
    ).toEqual({ count: 0, items: [] });
  });

  it("fails foreach on partial failure while preserving completed item context", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_foreach_failure",
      definition: definition([
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.input.customers",
          itemVar: "customer",
          body: ["capture_id"],
        },
        {
          id: "capture_id",
          type: "builtin.set",
          assign: {
            customerIds: {
              from: "customer.id",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        customers: [{ id: "cust_1" }, {}],
      },
    });

    expect(result.status).toBe("failed");
    expect(result.context).toEqual({ customerIds: ["cust_1"] });
    expect(
      result.stepAttempts
        .filter((step) => step.nodeId === "capture_id")
        .map((step) => [step.attempt, step.status]),
    ).toEqual([
      [1, "succeeded"],
      [2, "failed"],
    ]);
  });

  it("rejects foreach concurrency above the current cap at the schema boundary", async () => {
    await expect(
      new WorkflowRunner().run({
        runId: "run_foreach_concurrency",
        definition: definition([
          {
            id: "each_customer",
            type: "builtin.foreach",
            items: "$.input.customers",
            body: ["noop"],
            concurrency: 2,
          },
          {
            id: "noop",
            type: "builtin.log.info",
            message: "noop",
          },
        ]),
        input: { customers: ["cust_1"] },
      }),
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: "too_big",
          maximum: 1,
          path: ["nodes", 0, "concurrency"],
        }),
      ],
    });
  });

  it("executes Python through the workflow port and assigns value output", async () => {
    const calls: unknown[] = [];
    const result = await new WorkflowRunner({
      ports: {
        python: {
          async execute(req) {
            calls.push(req);
            return {
              output: { doubled: 6 },
              stdout: "computed\n",
              stderr: "",
            };
          },
        },
      },
    }).run({
      runId: "run_python_success",
      definition: definition([
        {
          id: "python_step",
          type: "builtin.python",
          input: { value: "$.input.value" },
          code: "output = {'doubled': input['value'] * 2}",
          reset: true,
          timeoutMs: 1000,
          assign: {
            result: "$.steps.python_step.output.value",
          },
        },
      ]),
      input: { value: 3 },
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      {
        code: "output = {'doubled': input['value'] * 2}",
        input: { value: 3 },
        reset: true,
        timeoutMs: 1000,
      },
    ]);
    expect(result.context).toEqual({ result: { doubled: 6 } });
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "python_step",
      status: "succeeded",
      output: {
        value: { doubled: 6 },
        stdout: "computed\n",
        stderr: "",
      },
      logsSummary: {
        python: {
          stdout: "computed\n",
          stderr: "",
        },
      },
    });
  });

  it("persists Python failure details from the execution port", async () => {
    const error = new Error("python timed out after 100ms") as Error & {
      details?: unknown;
    };
    error.details = { stdout: "before\n", stderr: "timeout\n" };

    const result = await new WorkflowRunner({
      ports: {
        python: {
          async execute() {
            throw error;
          },
        },
      },
    }).run({
      runId: "run_python_failure",
      definition: definition([
        {
          id: "python_step",
          type: "builtin.python",
          code: "while True: pass",
          timeoutMs: 100,
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "python_step",
      status: "failed",
      error: {
        message: "python timed out after 100ms",
        details: { stdout: "before\n", stderr: "timeout\n" },
      },
      logsSummary: {
        python: {
          stdout: "before\n",
          stderr: "timeout\n",
        },
      },
    });
  });
});
