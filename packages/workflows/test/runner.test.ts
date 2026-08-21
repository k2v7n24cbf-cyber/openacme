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
    nodes: withLegacyTopLevelNext(nodes),
    createdAt: now,
    updatedAt: now,
  };
}

function withLegacyTopLevelNext(
  nodes: WorkflowDefinition["nodes"],
): WorkflowDefinition["nodes"] {
  const referenced = new Set<string>();
  for (const node of nodes) {
    if (node.type === "builtin.if" || node.type === "builtin.if_else") {
      node.then.forEach((nodeId) => referenced.add(nodeId));
      node.else.forEach((nodeId) => referenced.add(nodeId));
    } else if (node.type === "builtin.switch") {
      node.cases.forEach((item) =>
        item.nodes.forEach((nodeId) => referenced.add(nodeId)),
      );
      node.default.forEach((nodeId) => referenced.add(nodeId));
    } else if (node.type === "builtin.foreach") {
      node.body.forEach((nodeId) => referenced.add(nodeId));
    } else if (node.type === "builtin.parallel") {
      node.branches.forEach((branch) =>
        branch.nodes.forEach((nodeId) => referenced.add(nodeId)),
      );
    }
  }
  const topLevel = nodes.filter((node) => !referenced.has(node.id));
  const nextById = new Map<string, string>();
  for (let index = 0; index < topLevel.length - 1; index += 1) {
    const source = topLevel[index];
    const target = topLevel[index + 1];
    if (!source || !target) continue;
    nextById.set(source.id, target.id);
  }
  return nodes.map((node) =>
    (node.next ?? []).length > 0 || !nextById.has(node.id)
      ? node
      : { ...node, next: [nextById.get(node.id)!] },
  );
}

function steppedNow(stepMs = 25): () => string {
  let tick = 0;
  const start = Date.parse(now);
  return () => new Date(start + tick++ * stepMs).toISOString();
}

describe("WorkflowRunner builtin MVP", () => {
  it("does not execute adjacent nodes without an explicit next edge", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_no_implicit_next",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "start",
            type: "builtin.log.info",
            message: "Start only",
          },
          {
            id: "should_not_run",
            type: "builtin.log.info",
            message: "No edge",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: {},
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId)).toEqual(["start"]);
  });

  it("executes adjacent nodes only when an explicit next edge exists", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_explicit_next",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "start",
            type: "builtin.log.info",
            message: "Start",
            next: ["after_start"],
          },
          {
            id: "after_start",
            type: "builtin.log.info",
            message: "Connected",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: {},
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId)).toEqual([
      "start",
      "after_start",
    ]);
  });

  it("does not expose final context as workflow output without an explicit output card", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_no_explicit_output",
      definition: definition([
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
        },
      ]),
      input: { customer: "Acme" },
    });

    expect(result.context).toEqual({ customer: "Acme" });
    expect(result.output).toEqual({});
  });

  it("composes explicit workflow output with output.set cards", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_explicit_output",
      definition: definition([
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
          next: ["output_customer"],
        },
        {
          id: "output_customer",
          type: "builtin.output.set",
          path: "customer",
          value: "$.context.customer",
          mode: "replace",
          next: ["output_meta_base"],
        },
        {
          id: "output_meta_base",
          type: "builtin.output.set",
          path: "meta",
          value: { source: "test" },
          mode: "replace",
          next: ["output_meta"],
        },
        {
          id: "output_meta",
          type: "builtin.output.set",
          path: "meta",
          value: { verified: true },
          mode: "merge",
          next: ["output_tags"],
        },
        {
          id: "output_tags",
          type: "builtin.output.set",
          path: "tags",
          value: "first",
          mode: "append",
          next: ["output_more_tags"],
        },
        {
          id: "output_more_tags",
          type: "builtin.output.set",
          path: "tags",
          value: "second",
          mode: "append",
        },
      ]),
      input: { customer: "Acme" },
    });

    expect(result.output).toEqual({
      customer: "Acme",
      meta: { source: "test", verified: true },
      tags: ["first", "second"],
    });
    expect(
      result.stepAttempts.find((step) => step.nodeId === "output_customer")
        ?.output,
    ).toEqual({ path: "customer", value: "Acme", mode: "replace" });
  });

  it("stops after the requested top-level step without executing downstream steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_stop_after_top_level",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "start",
            type: "builtin.log.info",
            message: "Start",
            next: ["middle"],
          },
          {
            id: "middle",
            type: "builtin.log.info",
            message: "Middle",
            next: ["after_middle"],
          },
          {
            id: "after_middle",
            type: "builtin.log.info",
            message: "Should not run",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: {},
      stopAfterStepId: "middle",
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId)).toEqual([
      "start",
      "middle",
    ]);
  });

  it("stops after a selected branch step without executing its downstream continuation", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_stop_after_branch",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "gate",
            type: "builtin.if",
            condition: "$.workflowTrigger.input.enabled == true",
            then: ["enabled_log"],
            else: ["disabled_log"],
          },
          {
            id: "enabled_log",
            type: "builtin.log.info",
            message: "Enabled",
            next: ["after_branch"],
          },
          {
            id: "disabled_log",
            type: "builtin.log.info",
            message: "Disabled",
          },
          {
            id: "after_branch",
            type: "builtin.log.info",
            message: "Should not run",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: { enabled: true },
      stopAfterStepId: "enabled_log",
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId)).toEqual([
      "gate",
      "disabled_log",
      "enabled_log",
    ]);
    expect(
      result.stepAttempts.find((step) => step.nodeId === "disabled_log")
        ?.status,
    ).toBe("skipped");
  });

  it("stops foreach after the requested body step", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_stop_after_foreach_body",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "each_item",
            type: "builtin.foreach",
            items: "$.workflowTrigger.input.items",
            itemVar: "item",
            body: ["log_item"],
            next: ["after_loop"],
          },
          {
            id: "log_item",
            type: "builtin.log.info",
            message: "item",
          },
          {
            id: "after_loop",
            type: "builtin.log.info",
            message: "Should not run",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: { items: ["a", "b", "c"] },
      stopAfterStepId: "log_item",
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId)).toEqual([
      "log_item",
      "each_item",
    ]);
  });

  it("stops parallel parent continuation after a branch reaches the requested step", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_stop_after_parallel_branch",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "parallel_checks",
            type: "builtin.parallel",
            branches: [
              { id: "a", nodes: ["branch_a"] },
              { id: "b", nodes: ["branch_b"] },
            ],
            failFast: false,
            next: ["after_parallel"],
          },
          {
            id: "branch_a",
            type: "builtin.log.info",
            message: "A",
            next: ["after_a"],
          },
          {
            id: "after_a",
            type: "builtin.log.info",
            message: "Should not run",
          },
          {
            id: "branch_b",
            type: "builtin.log.info",
            message: "B",
          },
          {
            id: "after_parallel",
            type: "builtin.log.info",
            message: "Should not run",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: {},
      stopAfterStepId: "branch_a",
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId).sort()).toEqual([
      "branch_a",
      "branch_b",
      "parallel_checks",
    ]);
    expect(result.stepAttempts.map((step) => step.nodeId)).not.toContain(
      "after_a",
    );
    expect(result.stepAttempts.map((step) => step.nodeId)).not.toContain(
      "after_parallel",
    );
  });

  it("normalizes legacy route arrays into explicit next chains before execution", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_legacy_route_array_normalized",
      definition: {
        id: "wf_runner",
        version: 1,
        status: "draft",
        name: "Runner workflow",
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
        nodes: [
          {
            id: "gate",
            type: "builtin.if",
            condition: "$.workflowTrigger.input.internal == true",
            then: ["log_internal", "kind_switch"],
            else: ["log_external", "kind_switch"],
          },
          {
            id: "log_internal",
            type: "builtin.log.info",
            message: "internal",
          },
          {
            id: "log_external",
            type: "builtin.log.info",
            message: "external",
          },
          {
            id: "kind_switch",
            type: "builtin.switch",
            value: "$.workflowTrigger.input.kind",
            cases: [{ id: "audit", value: "audit", nodes: ["log_audit"] }],
            default: [],
          },
          {
            id: "log_audit",
            type: "builtin.log.info",
            message: "audit",
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      input: { internal: true, kind: "audit" },
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts.map((step) => step.nodeId)).toEqual([
      "gate",
      "log_external",
      "log_internal",
      "kind_switch",
      "log_audit",
    ]);
    expect(
      result.stepAttempts.find((step) => step.nodeId === "log_external")
        ?.status,
    ).toBe("skipped");
  });

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

  it("resolves canonical workflow trigger and step input/output references", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_workflow_trigger_refs",
      definition: definition([
        {
          id: "normalize",
          type: "builtin.transform.value_resolve",
          input: {
            customer: "$.workflowTrigger.input.customer",
            triggerCustomer: "$.workflowTrigger.input.customer",
            triggerKind: "$.workflowTrigger.meta.kind",
          },
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.customer",
          },
          assign: {
            normalizedCustomer: "$.steps.normalize.output.value",
            triggerKind: "$.workflowTrigger.meta.kind",
          },
        },
        {
          id: "log_customer",
          type: "builtin.log.info",
          message: "Customer normalized",
          input: {
            customerId: "$.steps.normalize.output.value.id",
            normalizeStatus: "$.steps.normalize.status",
          },
          payload: "$.steps.normalize.input.input",
          assign: {
            loggedInput: "$.steps.normalize.input.input",
            loggedOutput: "$.steps.log_customer.output.payload",
          },
        },
      ]),
      input: { customer: { id: "cust-1", name: "Acme" } },
      trigger: {
        kind: "manual",
        triggerId: "manual_review",
        requestedBy: "operator",
        input: { customer: { id: "cust-1", name: "Acme" } },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({
      normalizedCustomer: { id: "cust-1", name: "Acme" },
      triggerKind: "manual",
      loggedInput: {
        customer: { id: "cust-1", name: "Acme" },
        triggerCustomer: { id: "cust-1", name: "Acme" },
        triggerKind: "manual",
      },
      loggedOutput: {
        customer: { id: "cust-1", name: "Acme" },
        triggerCustomer: { id: "cust-1", name: "Acme" },
        triggerKind: "manual",
      },
    });
  });

  it("resolves log messages from references and templates", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_log_message_refs",
      definition: definition([
        {
          id: "log_direct",
          type: "builtin.log.info",
          message: "$.workflowTrigger.input.message",
          next: ["log_template"],
        },
        {
          id: "log_template",
          type: "builtin.log.info",
          message: "Received {{ $.workflowTrigger.input.message }}",
        },
      ]),
      input: { message: "hello from trigger" },
      trigger: {
        kind: "manual",
        triggerId: "manual",
        input: { message: "hello from trigger" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts[0]?.input).toMatchObject({
      message: "hello from trigger",
    });
    expect(result.stepAttempts[0]?.output).toEqual({
      message: "hello from trigger",
    });
    expect(result.stepAttempts[1]?.input).toMatchObject({
      message: "Received hello from trigger",
    });
    expect(
      result.events
        .filter((event) => event.kind === "log")
        .map((event) => event.message),
    ).toEqual(["hello from trigger", "Received hello from trigger"]);
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
            customer: "$.workflowTrigger.input.customer",
          },
        },
        {
          id: "normalize_customer",
          label: "Normalize customer",
          type: "builtin.transform.object_pick",
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
              from: "$.steps.normalize_customer.output.value",
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
    expect(result.stepAttempts[2]?.input).toEqual({
      level: "info",
      input: {},
      message: "Customer normalized",
      payload: { id: "cust_1", name: "Ada" },
      assign: {
        loggedCustomer: {
          from: "$.steps.log_customer.output.payload",
          mode: "replace",
          value: { id: "cust_1", name: "Ada" },
        },
      },
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
      nodeType: "builtin.transform.object_pick",
      nodeLabel: "Normalize customer",
      input: {
        input: {
          customer: { id: "cust_1", name: "Ada", secret: "not selected" },
        },
        transform: {
          kind: "object_pick",
          source: "customer",
          fields: ["id", "name"],
        },
        assign: {
          customer: {
            from: "$.steps.normalize_customer.output.value",
            mode: "replace",
          },
        },
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
          condition: "$.workflowTrigger.input.ready",
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
        output: {
          status: "canceled",
          output: { reason: "operator-defined stop" },
        },
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
        output: {
          status: "failed",
          output: { reason: "business rule failed" },
        },
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
        output: {
          status: "failed",
          output: { reason: "business rule failed" },
        },
      },
    });
  });

  it("executes warn log and records it in step logs", async () => {
    const observedLevels: string[] = [];
    const result = await new WorkflowRunner({
      ports: {
        events: {
          async append(event) {
            if (event.kind === "log") observedLevels.push(event.level);
          },
        },
      },
    }).run({
      runId: "run_warn_log",
      definition: definition([
        {
          id: "warn_operator",
          type: "builtin.log.warn",
          message: "Asset owner missing",
          payload: { severity: "medium" },
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "warn_operator",
      status: "succeeded",
      output: {
        message: "Asset owner missing",
        payload: { severity: "medium" },
      },
      logsSummary: {
        logs: [
          {
            level: "warn",
            message: "Asset owner missing",
            payload: { severity: "medium" },
          },
        ],
      },
    });
    expect(observedLevels).toEqual(["warn"]);
  });

  it("throws a controlled workflow error and stops downstream steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_throw_error",
      definition: definition([
        {
          id: "fail_missing_owner",
          type: "builtin.throw_error",
          message: "Asset owner is missing",
          code: "asset_owner_missing",
          details: { assetId: "$.workflowTrigger.input.asset.id" },
        },
        {
          id: "after_failure",
          type: "builtin.log.info",
          message: "should not run",
        },
      ]),
      input: { asset: { id: "asset_1" } },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts).toEqual([
      expect.objectContaining({
        nodeId: "fail_missing_owner",
        status: "failed",
        error: {
          name: "WorkflowNodeExecutionError",
          message: "Asset owner is missing",
          details: {
            code: "asset_owner_missing",
            details: { assetId: "asset_1" },
          },
        },
      }),
    ]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "step_failed",
      "run_failed",
    ]);
    expect(result.events.at(-2)).toMatchObject({
      level: "error",
      kind: "step_failed",
      message: "Step fail_missing_owner failed",
      payload: {
        message: "Asset owner is missing",
      },
    });
  });

  it("executes sleep with duration and cancellation support", async () => {
    const completed = await new WorkflowRunner({ now: steppedNow(10) }).run({
      runId: "run_sleep",
      definition: definition([
        {
          id: "wait_for_index",
          type: "builtin.sleep",
          delayMs: 1,
          reason: "Wait for external index consistency",
        },
      ]),
      input: {},
    });

    expect(completed.status).toBe("succeeded");
    expect(completed.stepAttempts[0]).toMatchObject({
      nodeId: "wait_for_index",
      status: "succeeded",
      output: {
        delayMs: 1,
        reason: "Wait for external index consistency",
      },
      durationMs: expect.any(Number),
    });

    const controller = new AbortController();
    controller.abort();
    const canceled = await new WorkflowRunner().run({
      runId: "run_sleep_canceled",
      definition: definition([
        {
          id: "wait_for_index",
          type: "builtin.sleep",
          delayMs: 100,
        },
      ]),
      input: {},
      signal: controller.signal,
    });

    expect(canceled.status).toBe("canceled");
    expect(canceled.stepAttempts[0]).toMatchObject({
      nodeId: "wait_for_index",
      status: "canceled",
      error: {
        name: "WorkflowNodeExecutionError",
        message: "Workflow run canceled",
      },
    });
    expect(canceled.events.map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "step_failed",
      "run_canceled",
    ]);
  });

  it("selects if true branches and records skipped false steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.riskScore >= 70",
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
      condition: "$.workflowTrigger.input.riskScore >= 70",
      selected: ["high_log"],
      skipped: ["low_log"],
    });
  });

  it("selects switch cases and records skipped case/default steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_switch_case",
      definition: definition([
        {
          id: "route_by_kind",
          type: "builtin.switch",
          value: "$.workflowTrigger.input.kind",
          cases: [
            { id: "asset", value: "asset", nodes: ["asset_log"] },
            { id: "owner", value: "owner", nodes: ["owner_log"] },
          ],
          default: ["unknown_log"],
        },
        {
          id: "asset_log",
          type: "builtin.log.info",
          message: "Asset route",
        },
        {
          id: "owner_log",
          type: "builtin.log.info",
          message: "Owner route",
        },
        {
          id: "unknown_log",
          type: "builtin.log.warn",
          message: "Unknown route",
        },
      ]),
      input: { kind: "owner" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["route_by_kind", "succeeded"],
      ["asset_log", "skipped"],
      ["unknown_log", "skipped"],
      ["owner_log", "succeeded"],
    ]);
    expect(
      result.events.find((event) => event.kind === "branch_selected")?.payload,
    ).toEqual({
      condition: 'switch "owner"',
      selected: ["owner_log"],
      skipped: ["asset_log", "unknown_log"],
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
            'contains($.workflowTrigger.input.note, "red or blue") or contains($.workflowTrigger.input.note, "review and hold")',
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
          condition: 'contains($.workflowTrigger.input.note, "red, blue")',
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
          condition: '"a >= b" == $.workflowTrigger.input.note',
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
          condition: 'not(contains($.workflowTrigger.input.note, "blocked"))',
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

  it("supports string prefix and suffix conditions", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_prefix_suffix",
      definition: definition([
        {
          id: "starts",
          type: "builtin.if_else",
          condition: 'startsWith($.workflowTrigger.input.name, "prod-")',
          then: ["ends"],
          else: ["unmatched_log"],
        },
        {
          id: "ends",
          type: "builtin.if_else",
          condition: 'endsWith($.workflowTrigger.input.name, "-01")',
          then: ["matched_log"],
          else: ["unmatched_log"],
        },
        {
          id: "matched_log",
          type: "builtin.log.info",
          message: "Matched name",
        },
        {
          id: "unmatched_log",
          type: "builtin.log.info",
          message: "Unmatched name",
        },
      ]),
      input: { name: "prod-api-01" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["starts", "succeeded"],
      ["unmatched_log", "skipped"],
      ["ends", "succeeded"],
      ["unmatched_log", "skipped"],
      ["matched_log", "succeeded"],
    ]);
  });

  it("supports negated string prefix conditions", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_not_prefix",
      definition: definition([
        {
          id: "branch",
          type: "builtin.if_else",
          condition: 'not(startsWith($.workflowTrigger.input.name, "dev-"))',
          then: ["matched_log"],
          else: ["unmatched_log"],
        },
        {
          id: "matched_log",
          type: "builtin.log.info",
          message: "Matched non-dev name",
        },
        {
          id: "unmatched_log",
          type: "builtin.log.info",
          message: "Unmatched dev name",
        },
      ]),
      input: { name: "prod-api-01" },
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

  it("does not mutate context when a step expression fails", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_failure",
      definition: definition([
        {
          id: "set_initial",
          type: "builtin.set",
          assign: { customerId: "$.workflowTrigger.input.customerId" },
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
            customer: "$.workflowTrigger.input.customer",
            tags: "$.workflowTrigger.input.initialTags",
          },
        },
        {
          id: "pick_customer",
          type: "builtin.transform.object_pick",
          input: { customer: "$.context.customer" },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id"],
          },
          assign: {
            customer: {
              from: "$.steps.pick_customer.output.value",
              mode: "merge",
            },
          },
        },
        {
          id: "make_tag",
          type: "builtin.transform.value_resolve",
          input: { tag: "$.workflowTrigger.input.nextTag" },
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.nextTag",
          },
          assign: {
            tags: {
              from: "$.steps.make_tag.output.value",
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

  it("runs explicit value resolve and object_pick transformer cards", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_compatibility",
      definition: definition([
        {
          id: "reference_transform",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.customer.id",
          },
          assign: {
            customerId: "$.steps.reference_transform.output.value",
          },
        },
        {
          id: "literal_transform",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: {
              note: "literal objects can be resolved explicitly",
              customerId: "$.context.customerId",
            },
          },
          assign: {
            literal: "$.steps.literal_transform.output.value",
          },
        },
        {
          id: "pick_transform",
          type: "builtin.transform.object_pick",
          input: {
            customer: "$.workflowTrigger.input.customer",
          },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id", "name"],
          },
          assign: {
            picked: "$.steps.pick_transform.output.value",
          },
        },
      ]),
      input: {
        customer: { id: "cust_1", name: "Ada", secret: "hidden" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      customerId: "cust_1",
      literal: {
        note: "literal objects can be resolved explicitly",
        customerId: "cust_1",
      },
      picked: { id: "cust_1", name: "Ada" },
    });
  });

  it("rejects invalid transform operation shapes with operation details", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_invalid_operation",
      definition: definition([
        {
          id: "invalid_pick",
          type: "builtin.transform.object_pick",
          input: {
            customer: "$.workflowTrigger.input.customer",
          },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: "id",
          },
        },
      ]),
      input: {
        customer: { id: "cust_1", name: "Ada" },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "invalid_pick",
      status: "failed",
      error: {
        name: "WorkflowNodeExecutionError",
        message:
          "Transform operation object_pick has invalid field fields: expected string[]",
        details: {
          operationKind: "object_pick",
          field: "fields",
          expected: "string[]",
          actualType: "string",
        },
      },
    });
  });

  it("rejects unsupported transformer card types at schema validation", async () => {
    await expect(
      new WorkflowRunner().run({
        runId: "run_transform_unsupported_operation",
        definition: definition([
          {
            id: "unsupported_transform",
            type: "builtin.transform.string_future_operation",
            transform: {
              kind: "string.future_operation",
              value: "$.workflowTrigger.input.value",
            },
          },
        ]),
        input: { value: "hello" },
      }),
    ).rejects.toThrow("Invalid discriminator value");
  });

  it("supports transform assignment back to the same variable", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_self_assign",
      definition: definition([
        {
          id: "set_customer",
          type: "builtin.set",
          assign: {
            customer: "$.workflowTrigger.input.customer",
          },
        },
        {
          id: "normalize_customer",
          type: "builtin.transform.object_pick",
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
              from: "$.steps.normalize_customer.output.value",
              mode: "replace",
            },
          },
        },
      ]),
      input: {
        customer: { id: "cust_1", name: "Ada", secret: "hidden" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      customer: { id: "cust_1", name: "Ada" },
    });
    expect(result.stepAttempts[1]?.contextDiff).toEqual({
      customer: {
        before: { id: "cust_1", name: "Ada", secret: "hidden" },
        after: { id: "cust_1", name: "Ada" },
      },
    });
  });

  it("rejects transform outputs above the runner guardrail", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_output_guard",
      definition: definition([
        {
          id: "large_transform",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: "x".repeat(1_048_577),
          },
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "large_transform",
      status: "failed",
      error: {
        name: "WorkflowNodeExecutionError",
        message: "Transform output exceeds 1048576 bytes",
        details: {
          maxBytes: 1_048_576,
          actualBytes: expect.any(Number),
        },
      },
    });
  });

  it("runs string replace transforms for first and all occurrences", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_string_replace",
      definition: definition([
        {
          id: "replace_first",
          type: "builtin.transform.string_replace",
          transform: {
            kind: "string.replace",
            value: "$.workflowTrigger.input.text",
            search: "risk",
            replacement: "issue",
          },
          assign: {
            first: "$.steps.replace_first.output.value",
          },
        },
        {
          id: "replace_all",
          type: "builtin.transform.string_replace",
          transform: {
            kind: "string.replace",
            value: "$.workflowTrigger.input.text",
            search: "risk",
            replacement: "issue",
            all: true,
          },
          assign: {
            all: "$.steps.replace_all.output.value",
          },
        },
      ]),
      input: {
        text: "risk accepted, risk tracked",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      first: "issue accepted, risk tracked",
      all: "issue accepted, issue tracked",
    });
  });

  it("runs regex replace and regex match transforms", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_regex",
      definition: definition([
        {
          id: "regex_replace",
          type: "builtin.transform.string_regex_replace",
          transform: {
            kind: "string.regex_replace",
            value: "$.workflowTrigger.input.vuln",
            pattern: "CVE-(\\d{4})-(\\d+)",
            replacement: "CVE:$1:$2",
            flags: "g",
          },
          assign: {
            normalized: "$.steps.regex_replace.output.value",
          },
        },
        {
          id: "regex_match",
          type: "builtin.transform.string_regex_match",
          transform: {
            kind: "string.regex_match",
            value: "$.workflowTrigger.input.vuln",
            pattern: "CVE-(?<year>\\d{4})-(?<number>\\d+)",
          },
          assign: {
            match: "$.steps.regex_match.output.value",
          },
        },
      ]),
      input: {
        vuln: "Patch CVE-2026-12345 now",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      normalized: "Patch CVE:2026:12345 now",
      match: {
        matched: true,
        match: "CVE-2026-12345",
        index: 6,
        groups: ["2026", "12345"],
        namedGroups: { year: "2026", number: "12345" },
      },
    });
  });

  it("fails invalid regex transforms with controlled details", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_invalid_regex",
      definition: definition([
        {
          id: "bad_regex",
          type: "builtin.transform.string_regex_match",
          transform: {
            kind: "string.regex_match",
            value: "$.workflowTrigger.input.value",
            pattern: "(",
          },
        },
      ]),
      input: { value: "hello" },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "bad_regex",
      status: "failed",
      error: {
        name: "WorkflowNodeExecutionError",
        message: expect.stringContaining(
          "Transform operation string.regex_match has invalid regex",
        ),
        details: {
          operationKind: "string.regex_match",
          field: "pattern",
          pattern: "(",
          flags: "",
        },
      },
    });
  });

  it("runs JSON parse and stringify transforms", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_json",
      definition: definition([
        {
          id: "parse_json",
          type: "builtin.transform.json_parse",
          transform: {
            kind: "json.parse",
            value: "$.workflowTrigger.input.raw",
          },
          assign: {
            parsed: "$.steps.parse_json.output.value",
          },
        },
        {
          id: "stringify_json",
          type: "builtin.transform.json_stringify",
          transform: {
            kind: "json.stringify",
            value: "$.context.parsed",
            pretty: true,
          },
          assign: {
            serialized: "$.steps.stringify_json.output.value",
          },
        },
      ]),
      input: {
        raw: '{"id":"asset_1","risk":9}',
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      parsed: { id: "asset_1", risk: 9 },
      serialized: '{\n  "id": "asset_1",\n  "risk": 9\n}',
    });
  });

  it("runs CSV parse and stringify transforms with stable headers", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_csv",
      definition: definition([
        {
          id: "parse_csv",
          type: "builtin.transform.csv_parse",
          transform: {
            kind: "csv.parse",
            value: "$.workflowTrigger.input.csv",
            headers: true,
          },
          assign: {
            rows: "$.steps.parse_csv.output.value",
          },
        },
        {
          id: "stringify_csv",
          type: "builtin.transform.csv_stringify",
          transform: {
            kind: "csv.stringify",
            value: "$.context.rows",
            headers: ["id", "name", "note"],
          },
          assign: {
            csv: "$.steps.stringify_csv.output.value",
          },
        },
      ]),
      input: {
        csv: 'id,name,note\n1,Ada,"needs, review"\n2,Lin,ready',
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      rows: [
        { id: "1", name: "Ada", note: "needs, review" },
        { id: "2", name: "Lin", note: "ready" },
      ],
      csv: 'id,name,note\n1,Ada,"needs, review"\n2,Lin,ready',
    });
  });

  it("enforces CSV row guardrails", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_csv_guard",
      definition: definition([
        {
          id: "parse_csv",
          type: "builtin.transform.csv_parse",
          transform: {
            kind: "csv.parse",
            value: "$.workflowTrigger.input.csv",
            headers: true,
            maxRows: 1,
          },
        },
      ]),
      input: {
        csv: "id,name\n1,Ada\n2,Lin",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "parse_csv",
      status: "failed",
      error: {
        name: "WorkflowNodeExecutionError",
        message: "Transform operation csv.parse exceeded row limit 1",
        details: {
          operationKind: "csv.parse",
          maxRows: 1,
          actualRows: 2,
        },
      },
    });
  });

  it("parses IPv4 and IPv6 addresses with stable metadata", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_ip_parse",
      definition: definition([
        {
          id: "parse_ipv4",
          type: "builtin.transform.ip_parse",
          transform: {
            kind: "ip.parse",
            value: "$.workflowTrigger.input.ipv4",
          },
          assign: {
            ipv4: "$.steps.parse_ipv4.output.value",
          },
        },
        {
          id: "parse_ipv6",
          type: "builtin.transform.ip_parse",
          transform: {
            kind: "ip.parse",
            value: "$.workflowTrigger.input.ipv6",
          },
          assign: {
            ipv6: "$.steps.parse_ipv6.output.value",
          },
        },
      ]),
      input: {
        ipv4: "192.168.1.10",
        ipv6: "2001:db8::1",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      ipv4: {
        version: 4,
        address: "192.168.1.10",
        normalized: "192.168.1.10",
        integer: "3232235786",
        octets: [192, 168, 1, 10],
      },
      ipv6: {
        version: 6,
        address: "2001:db8::1",
        normalized: "2001:0db8:0000:0000:0000:0000:0000:0001",
        integer: "42540766411282592856903984951653826561",
        hextets: [
          "2001",
          "0db8",
          "0000",
          "0000",
          "0000",
          "0000",
          "0000",
          "0001",
        ],
      },
    });
  });

  it("returns booleans for IPv4 and IPv6 checks including invalid input", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_ip_boolean",
      definition: definition([
        {
          id: "is_ipv4",
          type: "builtin.transform.ip_is_ipv4",
          transform: {
            kind: "ip.is_ipv4",
            value: "$.workflowTrigger.input.ipv4",
          },
          assign: { isIpv4: "$.steps.is_ipv4.output.value" },
        },
        {
          id: "is_ipv6",
          type: "builtin.transform.ip_is_ipv6",
          transform: {
            kind: "ip.is_ipv6",
            value: "$.workflowTrigger.input.ipv6",
          },
          assign: { isIpv6: "$.steps.is_ipv6.output.value" },
        },
        {
          id: "invalid_ipv4",
          type: "builtin.transform.ip_is_ipv4",
          transform: {
            kind: "ip.is_ipv4",
            value: "$.workflowTrigger.input.invalid",
          },
          assign: { invalidIsIpv4: "$.steps.invalid_ipv4.output.value" },
        },
      ]),
      input: {
        ipv4: "10.1.2.3",
        ipv6: "2001:db8::1",
        invalid: "not-an-ip",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      isIpv4: true,
      isIpv6: true,
      invalidIsIpv4: false,
    });
  });

  it("checks IPv4 and IPv6 subnet membership", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_ip_subnet",
      definition: definition([
        {
          id: "internal_ipv4",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.privateIp",
            cidr: "10.0.0.0/8",
          },
          assign: { internalIpv4: "$.steps.internal_ipv4.output.value" },
        },
        {
          id: "external_ipv4",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.publicIp",
            cidr: "10.0.0.0/8",
          },
          assign: { externalIpv4: "$.steps.external_ipv4.output.value" },
        },
        {
          id: "internal_ipv6",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.ipv6",
            cidr: "2001:db8::/32",
          },
          assign: { internalIpv6: "$.steps.internal_ipv6.output.value" },
        },
      ]),
      input: {
        privateIp: "10.44.1.7",
        publicIp: "172.16.1.7",
        ipv6: "2001:db8:abcd::1",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      internalIpv4: true,
      externalIpv4: false,
      internalIpv6: true,
    });
  });

  it("computes IP netmasks and network addresses", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_ip_network",
      definition: definition([
        {
          id: "netmask_v4",
          type: "builtin.transform.ip_netmask",
          transform: { kind: "ip.netmask", prefix: 24, version: 4 },
          assign: { netmaskV4: "$.steps.netmask_v4.output.value" },
        },
        {
          id: "netmask_v6",
          type: "builtin.transform.ip_netmask",
          transform: { kind: "ip.netmask", prefix: 64, version: 6 },
          assign: { netmaskV6: "$.steps.netmask_v6.output.value" },
        },
        {
          id: "network_v4",
          type: "builtin.transform.ip_network",
          transform: { kind: "ip.network", cidr: "192.168.1.42/24" },
          assign: { networkV4: "$.steps.network_v4.output.value" },
        },
        {
          id: "network_v6",
          type: "builtin.transform.ip_network",
          transform: { kind: "ip.network", cidr: "2001:db8:abcd::1234/64" },
          assign: { networkV6: "$.steps.network_v6.output.value" },
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      netmaskV4: "255.255.255.0",
      netmaskV6: "ffff:ffff:ffff:ffff:0000:0000:0000:0000",
      networkV4: {
        version: 4,
        address: "192.168.1.0",
        prefix: 24,
        cidr: "192.168.1.0/24",
      },
      networkV6: {
        version: 6,
        address: "2001:0db8:abcd:0000:0000:0000:0000:0000",
        prefix: 64,
        cidr: "2001:0db8:abcd:0000:0000:0000:0000:0000/64",
      },
    });
  });

  it("fails invalid CIDR transforms with controlled details", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_ip_invalid_cidr",
      definition: definition([
        {
          id: "invalid_cidr",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.ip",
            cidr: "10.0.0.0/33",
          },
        },
      ]),
      input: { ip: "10.0.0.1" },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "invalid_cidr",
      status: "failed",
      error: {
        name: "WorkflowNodeExecutionError",
        message: "Transform operation ip.in_subnet has invalid CIDR",
        details: {
          operationKind: "ip.in_subnet",
          field: "cidr",
          cidr: "10.0.0.0/33",
        },
      },
    });
  });

  it("routes workflow branches with ip.in_subnet output", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_ip_branch",
      definition: definition([
        {
          id: "check_internal",
          type: "builtin.transform.ip_in_subnet",
          transform: {
            kind: "ip.in_subnet",
            value: "$.workflowTrigger.input.ip",
            cidr: "10.0.0.0/8",
          },
          assign: { isInternal: "$.steps.check_internal.output.value" },
        },
        {
          id: "route_ip",
          type: "builtin.if",
          condition: "$.context.isInternal == true",
          then: ["log_internal"],
          else: ["log_external"],
        },
        {
          id: "log_internal",
          type: "builtin.log.info",
          message: "internal ip",
          payload: "$.workflowTrigger.input.ip",
        },
        {
          id: "log_external",
          type: "builtin.log.info",
          message: "external ip",
          payload: "$.workflowTrigger.input.ip",
        },
      ]),
      input: { ip: "10.1.2.3" },
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["check_internal", "succeeded"],
      ["route_ip", "succeeded"],
      ["log_external", "skipped"],
      ["log_internal", "succeeded"],
    ]);
    expect(
      result.events.find((event) => event.message === "internal ip")?.payload,
    ).toBe("10.1.2.3");
  });

  it("parses HTTPS URIs with host path query and fragment fields", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_uri_parse",
      definition: definition([
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: {
            kind: "uri.parse",
            value: "$.workflowTrigger.input.url",
          },
          assign: {
            uri: "$.steps.parse_uri.output.value",
          },
        },
      ]),
      input: {
        url: "https://api.example.com:8443/v1/assets?id=123&tag=cloud&tag=prod#section",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      uri: {
        href: "https://api.example.com:8443/v1/assets?id=123&tag=cloud&tag=prod#section",
        protocol: "https:",
        scheme: "https",
        origin: "https://api.example.com:8443",
        host: "api.example.com:8443",
        hostname: "api.example.com",
        port: "8443",
        pathname: "/v1/assets",
        path: "/v1/assets?id=123&tag=cloud&tag=prod",
        search: "?id=123&tag=cloud&tag=prod",
        query: { id: "123", tag: ["cloud", "prod"] },
        queryList: [
          { key: "id", value: "123" },
          { key: "tag", value: "cloud" },
          { key: "tag", value: "prod" },
        ],
        hash: "#section",
        fragment: "section",
        username: null,
        password: null,
        hasCredentials: false,
      },
    });
  });

  it("redacts URI credentials while preserving non-secret URL parts", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_uri_credentials",
      definition: definition([
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: {
            kind: "uri.parse",
            value: "$.workflowTrigger.input.url",
          },
          assign: {
            uri: "$.steps.parse_uri.output.value",
          },
        },
      ]),
      input: {
        url: "https://user:secret@example.com/private?token=abc",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result.context)).not.toContain("secret");
    expect(result.context).toMatchObject({
      uri: {
        href: "https://example.com/private?token=abc",
        origin: "https://example.com",
        host: "example.com",
        username: null,
        password: null,
        hasCredentials: true,
      },
    });
  });

  it("parses relative URI values when a base URL is supplied", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_uri_base",
      definition: definition([
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: {
            kind: "uri.parse",
            value: "$.workflowTrigger.input.path",
            base: "https://api.example.com/root/",
          },
          assign: {
            uri: "$.steps.parse_uri.output.value",
          },
        },
      ]),
      input: {
        path: "../assets?limit=5",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({
      uri: {
        href: "https://api.example.com/assets?limit=5",
        origin: "https://api.example.com",
        pathname: "/assets",
        query: { limit: "5" },
      },
    });
  });

  it("fails invalid URI transforms with controlled details", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_transform_uri_invalid",
      definition: definition([
        {
          id: "parse_uri",
          type: "builtin.transform.uri_parse",
          transform: {
            kind: "uri.parse",
            value: "$.workflowTrigger.input.url",
          },
        },
      ]),
      input: {
        url: "not-a-url",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "parse_uri",
      status: "failed",
      error: {
        name: "WorkflowNodeExecutionError",
        message: "Transform operation uri.parse has invalid URI",
        details: {
          operationKind: "uri.parse",
          field: "value",
          value: "not-a-url",
        },
      },
    });
  });

  it("creates append arrays for missing assignment targets", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_append_missing_target",
      definition: definition([
        {
          id: "capture_finding",
          type: "builtin.set",
          assign: {
            findings: {
              from: "$.workflowTrigger.input.finding",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        finding: { id: "finding_1", severity: "high" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      findings: [{ id: "finding_1", severity: "high" }],
    });
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "capture_finding",
      contextDiff: {
        findings: {
          before: null,
          after: [{ id: "finding_1", severity: "high" }],
        },
      },
    });
  });

  it("merges object assignment values into existing object targets", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_merge_existing_target",
      definition: definition([
        {
          id: "set_asset",
          type: "builtin.set",
          assign: {
            asset: "$.workflowTrigger.input.asset",
          },
        },
        {
          id: "merge_enrichment",
          type: "builtin.set",
          assign: {
            asset: {
              from: "$.workflowTrigger.input.enrichment",
              mode: "merge",
            },
          },
        },
      ]),
      input: {
        asset: { id: "asset_1", owner: "security" },
        enrichment: { risk: "critical", owner: "platform" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      asset: { id: "asset_1", owner: "platform", risk: "critical" },
    });
    expect(result.stepAttempts[1]).toMatchObject({
      nodeId: "merge_enrichment",
      contextDiff: {
        asset: {
          before: { id: "asset_1", owner: "security" },
          after: { id: "asset_1", owner: "platform", risk: "critical" },
        },
      },
    });
  });

  it("applies append and merge assignments inside selected branch bodies", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_branch_assignments",
      definition: definition([
        {
          id: "set_initial",
          type: "builtin.set",
          assign: {
            asset: "$.workflowTrigger.input.asset",
          },
        },
        {
          id: "route_asset",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.routeTrue",
          then: ["mark_true", "record_true"],
          else: ["mark_false", "record_false"],
        },
        {
          id: "mark_true",
          type: "builtin.set",
          assign: {
            asset: {
              from: "$.workflowTrigger.input.truePatch",
              mode: "merge",
            },
          },
        },
        {
          id: "record_true",
          type: "builtin.set",
          assign: {
            routes: {
              from: "$.context.asset",
              mode: "append",
            },
          },
        },
        {
          id: "mark_false",
          type: "builtin.set",
          assign: {
            asset: {
              from: "$.workflowTrigger.input.falsePatch",
              mode: "merge",
            },
          },
        },
        {
          id: "record_false",
          type: "builtin.set",
          assign: {
            routes: {
              from: "$.context.asset",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        routeTrue: true,
        asset: { id: "asset_1", status: "open" },
        truePatch: { status: "triaged", owner: "secops" },
        falsePatch: { status: "ignored" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      asset: { id: "asset_1", status: "triaged", owner: "secops" },
      routes: [{ id: "asset_1", status: "triaged", owner: "secops" }],
    });
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_initial", "succeeded"],
      ["route_asset", "succeeded"],
      ["mark_false", "skipped"],
      ["mark_true", "succeeded"],
      ["record_true", "succeeded"],
    ]);
  });

  it("applies append and merge assignments inside false branch bodies", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_false_branch_assignments",
      definition: definition([
        {
          id: "set_initial",
          type: "builtin.set",
          assign: {
            asset: "$.workflowTrigger.input.asset",
          },
        },
        {
          id: "route_asset",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.routeTrue",
          then: ["mark_true", "record_true"],
          else: ["mark_false", "record_false"],
        },
        {
          id: "mark_true",
          type: "builtin.set",
          assign: {
            asset: {
              from: "$.workflowTrigger.input.truePatch",
              mode: "merge",
            },
          },
        },
        {
          id: "record_true",
          type: "builtin.set",
          assign: {
            routes: {
              from: "$.context.asset",
              mode: "append",
            },
          },
        },
        {
          id: "mark_false",
          type: "builtin.set",
          assign: {
            asset: {
              from: "$.workflowTrigger.input.falsePatch",
              mode: "merge",
            },
          },
        },
        {
          id: "record_false",
          type: "builtin.set",
          assign: {
            routes: {
              from: "$.context.asset",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        routeTrue: false,
        asset: { id: "asset_2", status: "open" },
        truePatch: { status: "triaged" },
        falsePatch: { status: "ignored", reason: "out-of-scope" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      asset: { id: "asset_2", status: "ignored", reason: "out-of-scope" },
      routes: [{ id: "asset_2", status: "ignored", reason: "out-of-scope" }],
    });
    expect(
      result.stepAttempts.map((step) => [step.nodeId, step.status]),
    ).toEqual([
      ["set_initial", "succeeded"],
      ["route_asset", "succeeded"],
      ["mark_true", "skipped"],
      ["mark_false", "succeeded"],
      ["record_false", "succeeded"],
    ]);
  });

  it("rolls back all assignments from a step when a later assignment fails", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_assignment_rollback",
      definition: definition([
        {
          id: "set_initial",
          type: "builtin.set",
          assign: {
            asset: "$.workflowTrigger.input.asset",
            notes: "$.workflowTrigger.input.notes",
          },
        },
        {
          id: "partial_failure",
          type: "builtin.set",
          assign: {
            notes: {
              from: "$.workflowTrigger.input.newNote",
              mode: "append",
            },
            asset: {
              from: "$.workflowTrigger.input.invalidMergeValue",
              mode: "merge",
            },
          },
        },
      ]),
      input: {
        asset: { id: "asset_1" },
        notes: ["original"],
        newNote: "should rollback",
        invalidMergeValue: "not an object",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.context).toEqual({
      asset: { id: "asset_1" },
      notes: ["original"],
    });
    expect(result.stepAttempts[1]).toMatchObject({
      nodeId: "partial_failure",
      status: "failed",
      error: {
        message:
          "merge assignment for asset requires an object target and object value",
        details: {
          assignmentPath: "asset",
          assignmentMode: "merge",
          targetType: "object",
          valueType: "string",
        },
      },
    });
    expect(result.stepAttempts[1]?.contextDiff).toBeUndefined();
  });

  it("rejects append assignment to non-array targets with node-specific details", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_append_invalid_target",
      definition: definition([
        {
          id: "set_tags",
          type: "builtin.set",
          assign: {
            tags: "$.workflowTrigger.input.tags",
          },
        },
        {
          id: "append_tag",
          type: "builtin.set",
          assign: {
            tags: {
              from: "$.workflowTrigger.input.nextTag",
              mode: "append",
            },
          },
        },
      ]),
      input: {
        tags: "not-an-array",
        nextTag: "reviewed",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.context).toEqual({ tags: "not-an-array" });
    expect(result.stepAttempts[1]).toMatchObject({
      nodeId: "append_tag",
      status: "failed",
      error: {
        message: "append assignment for tags requires an array target",
        details: {
          assignmentPath: "tags",
          assignmentMode: "append",
          targetType: "string",
          valueType: "string",
        },
      },
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
            id: "$.workflowTrigger.input.customerId",
          },
          assign: {
            crmResult: "$.steps.lookup_customer.output.result",
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
      output: {
        server: "crm",
        tool: "lookup",
        result: { normalized: true, customerId: "cust_1" },
      },
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
            id: "$.workflowTrigger.input.customerId",
          },
        },
      ]),
      input: { customerId: "cust_1" },
    });

    expect(result.status).toBe("failed");
    expect(result.stepAttempts[0]).toMatchObject({
      nodeId: "lookup_customer",
      status: "failed",
      input: {
        server: "crm",
        tool: "lookup",
        input: { id: "cust_1" },
      },
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
          prompt: "Review customer {{$.workflowTrigger.input.customerId}}",
          input: {
            customerId: "$.workflowTrigger.input.customerId",
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
      input: {
        agentId: "support",
        prompt: "Review customer cust_1",
        input: { customerId: "cust_1" },
      },
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

  it("runs independent parallel branches and aggregates isolated outputs", async () => {
    const result = await new WorkflowRunner({ now: steppedNow() }).run({
      runId: "run_parallel_success",
      definition: definition([
        {
          id: "parallel_enrichment",
          type: "builtin.parallel",
          branches: [
            { id: "asset", label: "Asset", nodes: ["parse_asset"] },
            { id: "owner", label: "Owner", nodes: ["parse_owner"] },
          ],
          concurrency: 2,
          failFast: true,
          assign: {
            enrichment: "$.steps.parallel_enrichment.output.branches",
          },
        },
        {
          id: "parse_asset",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.asset",
          },
          assign: {
            shared: "$.steps.parse_asset.output.value",
          },
        },
        {
          id: "parse_owner",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.owner",
          },
          assign: {
            shared: "$.steps.parse_owner.output.value",
          },
        },
      ]),
      input: {
        asset: { id: "asset_1", risk: "critical" },
        owner: { team: "security" },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      enrichment: {
        asset: expect.objectContaining({
          id: "asset",
          label: "Asset",
          status: "succeeded",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          durationMs: expect.any(Number),
          steps: {
            parse_asset: { value: { id: "asset_1", risk: "critical" } },
          },
          context: { shared: { id: "asset_1", risk: "critical" } },
        }),
        owner: expect.objectContaining({
          id: "owner",
          label: "Owner",
          status: "succeeded",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          durationMs: expect.any(Number),
          steps: { parse_owner: { value: { team: "security" } } },
          context: { shared: { team: "security" } },
        }),
      },
    });
    expect(result.context).not.toHaveProperty("shared");
    expect(
      result.stepAttempts.find((step) => step.nodeId === "parallel_enrichment"),
    ).toMatchObject({
      status: "succeeded",
      durationMs: expect.any(Number),
      output: {
        count: 2,
        succeededCount: 2,
        failedCount: 0,
        canceledCount: 0,
        branchOrder: ["asset", "owner"],
      },
      contextDiff: {
        enrichment: {
          before: null,
          after: expect.any(Object),
        },
      },
    });
    expect(result.stepAttempts.map((step) => step.nodeId)).toContain(
      "parse_asset",
    );
    expect(result.stepAttempts.map((step) => step.nodeId)).toContain(
      "parse_owner",
    );
    expect(result.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "parallel_started",
        "parallel_branch_started",
        "parallel_branch_completed",
        "parallel_completed",
        "step_output",
      ]),
    );
  });

  it("waits for all parallel branches when failFast is false and reports failures", async () => {
    const result = await new WorkflowRunner({ now: steppedNow() }).run({
      runId: "run_parallel_fail_slow",
      definition: definition([
        {
          id: "parallel_checks",
          type: "builtin.parallel",
          failFast: false,
          branches: [
            { id: "ok", nodes: ["ok_transform"] },
            { id: "bad", nodes: ["bad_check"] },
          ],
          assign: {
            checks: "$.steps.parallel_checks.output",
          },
        },
        {
          id: "ok_transform",
          type: "builtin.transform.value_resolve",
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.ok",
          },
        },
        {
          id: "bad_check",
          type: "builtin.throw_error",
          message: "bad branch",
          code: "bad_branch",
        },
      ]),
      input: { ok: { ready: true } },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({
      checks: {
        count: 2,
        succeededCount: 1,
        failedCount: 1,
        canceledCount: 0,
        failFast: false,
        branches: {
          ok: {
            status: "succeeded",
            steps: { ok_transform: { value: { ready: true } } },
          },
          bad: {
            status: "failed",
            error: {
              message: "bad branch",
              details: { code: "bad_branch" },
            },
          },
        },
      },
    });
    expect(
      result.events.filter((event) => event.kind === "parallel_branch_failed"),
    ).toHaveLength(1);
  });

  it("fails fast and cancels running parallel siblings", async () => {
    const result = await new WorkflowRunner({ now: steppedNow() }).run({
      runId: "run_parallel_fail_fast",
      definition: definition([
        {
          id: "parallel_checks",
          type: "builtin.parallel",
          failFast: true,
          concurrency: 2,
          branches: [
            { id: "bad", nodes: ["bad_check"] },
            { id: "slow", nodes: ["wait_slow"] },
          ],
        },
        {
          id: "bad_check",
          type: "builtin.throw_error",
          message: "bad branch",
        },
        {
          id: "wait_slow",
          type: "builtin.sleep",
          delayMs: 300_000,
          reason: "waiting sibling",
        },
      ]),
      input: {},
    });

    expect(result.status).toBe("failed");
    expect(
      result.stepAttempts.find((step) => step.nodeId === "parallel_checks"),
    ).toMatchObject({
      status: "failed",
      error: {
        message: "Parallel parallel_checks failed in branch bad",
        details: {
          count: 2,
          failedCount: 1,
          canceledCount: 1,
          branches: {
            bad: { status: "failed" },
            slow: { status: "canceled" },
          },
        },
      },
    });
    expect(
      result.stepAttempts.find((step) => step.nodeId === "wait_slow"),
    ).toMatchObject({
      status: "canceled",
      error: { message: "Workflow run canceled" },
    });
    expect(result.events.map((event) => event.kind)).toContain(
      "parallel_failed",
    );
  });

  it("propagates cancellation signals into parallel branch execution ports", async () => {
    const abortedSignals: Array<boolean | undefined> = [];
    const controller = new AbortController();
    controller.abort();
    const result = await new WorkflowRunner({
      ports: {
        mcp: {
          async callTool(req) {
            abortedSignals.push(req.signal?.aborted);
            throw new Error("mcp observed cancellation");
          },
        },
        agent: {
          listAgents: () => [],
          async callAgent(req) {
            abortedSignals.push(req.signal?.aborted);
            throw new Error("agent observed cancellation");
          },
        },
        python: {
          async execute(req) {
            abortedSignals.push(req.signal?.aborted);
            throw new Error("python observed cancellation");
          },
        },
      },
    }).run({
      runId: "run_parallel_signal",
      definition: definition([
        {
          id: "parallel_ports",
          type: "builtin.parallel",
          failFast: false,
          branches: [
            { id: "mcp", nodes: ["mcp_step"] },
            { id: "agent", nodes: ["agent_step"] },
            { id: "python", nodes: ["python_step"] },
          ],
        },
        {
          id: "mcp_step",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: {},
        },
        {
          id: "agent_step",
          type: "agent.call",
          agentId: "demo",
          prompt: "Review",
        },
        {
          id: "python_step",
          type: "builtin.python",
          code: "output = input",
        },
      ]),
      input: {},
      signal: controller.signal,
    });

    expect(result.status).toBe("succeeded");
    expect(abortedSignals).toEqual([true, true, true]);
    expect(
      result.stepAttempts.find((step) => step.nodeId === "parallel_ports"),
    ).toMatchObject({
      output: {
        failedCount: 3,
        branches: {
          mcp: { status: "failed" },
          agent: { status: "failed" },
          python: { status: "failed" },
        },
      },
    });
  });

  it("runs foreach sequentially with per-item child attempts and output trace", async () => {
    const result = await new WorkflowRunner({ now: steppedNow() }).run({
      runId: "run_foreach_success",
      definition: definition([
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.customers",
          itemVar: "customer",
          body: ["pick_customer"],
          concurrency: 1,
          assign: {
            foreachSummary: "$.steps.each_customer.output",
          },
        },
        {
          id: "pick_customer",
          type: "builtin.transform.object_pick",
          input: { customer: "customer" },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id"],
          },
          assign: {
            customerIds: {
              from: "$.steps.pick_customer.output.value",
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
    expect(result.context).toMatchObject({
      customerIds: [{ id: "cust_1" }, { id: "cust_2" }],
      foreachSummary: {
        count: 2,
        succeededCount: 2,
        failedCount: 0,
        items: [
          {
            index: 0,
            item: { id: "cust_1", name: "Ada" },
            status: "succeeded",
            startedAt: expect.any(String),
            endedAt: expect.any(String),
            durationMs: expect.any(Number),
            steps: { pick_customer: { value: { id: "cust_1" } } },
          },
          {
            index: 1,
            item: { id: "cust_2", name: "Lin" },
            status: "succeeded",
            startedAt: expect.any(String),
            endedAt: expect.any(String),
            durationMs: expect.any(Number),
            steps: { pick_customer: { value: { id: "cust_2" } } },
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
        {
          input: { customer: { id: "cust_1", name: "Ada" } },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id"],
          },
          assign: {
            customerIds: {
              from: "$.steps.pick_customer.output.value",
              mode: "append",
              value: { id: "cust_1" },
            },
          },
        },
        { value: { id: "cust_1" } },
      ],
      [
        2,
        "succeeded",
        {
          input: { customer: { id: "cust_2", name: "Lin" } },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id"],
          },
          assign: {
            customerIds: {
              from: "$.steps.pick_customer.output.value",
              mode: "append",
              value: { id: "cust_2" },
            },
          },
        },
        { value: { id: "cust_2" } },
      ],
    ]);
    expect(
      result.stepAttempts.find((step) => step.nodeId === "each_customer")
        ?.output,
    ).toMatchObject({
      count: 2,
      succeededCount: 2,
      failedCount: 0,
      items: [
        {
          index: 0,
          status: "succeeded",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          durationMs: expect.any(Number),
          steps: { pick_customer: { value: { id: "cust_1" } } },
        },
        {
          index: 1,
          status: "succeeded",
          startedAt: expect.any(String),
          endedAt: expect.any(String),
          durationMs: expect.any(Number),
          steps: { pick_customer: { value: { id: "cust_2" } } },
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
          succeededCount: 2,
          failedCount: 0,
        },
      },
    });
    const foreachOutput = result.stepAttempts.find(
      (step) => step.nodeId === "each_customer",
    )?.output as { items?: Array<{ durationMs?: number }> } | undefined;
    expect(foreachOutput?.items?.map((item) => item.durationMs)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(result.events.map((event) => event.kind)).toContain("step_output");
  });

  it("merges object outputs from foreach item body steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_foreach_merge",
      definition: definition([
        {
          id: "set_summary",
          type: "builtin.set",
          assign: {
            riskSummary: "$.workflowTrigger.input.initialSummary",
          },
        },
        {
          id: "each_asset",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.assets",
          itemVar: "asset",
          body: ["merge_asset_risk"],
        },
        {
          id: "merge_asset_risk",
          type: "builtin.set",
          assign: {
            riskSummary: {
              from: "asset.riskPatch",
              mode: "merge",
            },
          },
        },
      ]),
      input: {
        initialSummary: { baseline: "ready" },
        assets: [
          { id: "asset_1", riskPatch: { asset_1: "critical" } },
          { id: "asset_2", riskPatch: { asset_2: "high" } },
        ],
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context).toEqual({
      riskSummary: {
        baseline: "ready",
        asset_1: "critical",
        asset_2: "high",
      },
    });
    expect(
      result.stepAttempts
        .filter((step) => step.nodeId === "merge_asset_risk")
        .map((step) => step.contextDiff),
    ).toEqual([
      {
        riskSummary: {
          before: { baseline: "ready" },
          after: { baseline: "ready", asset_1: "critical" },
        },
      },
      {
        riskSummary: {
          before: { baseline: "ready", asset_1: "critical" },
          after: {
            baseline: "ready",
            asset_1: "critical",
            asset_2: "high",
          },
        },
      },
    ]);
  });

  it("handles empty foreach collections without running body steps", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_foreach_empty",
      definition: definition([
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.customers",
          body: ["pick_customer"],
        },
        {
          id: "pick_customer",
          type: "builtin.transform.value_resolve",
          input: { customer: "item" },
          transform: {
            kind: "value.resolve",
            value: "$.workflowTrigger.input.never",
          },
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
    ).toEqual({ count: 0, succeededCount: 0, failedCount: 0, items: [] });
  });

  it("fails foreach on partial failure while preserving completed item context", async () => {
    const result = await new WorkflowRunner().run({
      runId: "run_foreach_failure",
      definition: definition([
        {
          id: "each_customer",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.customers",
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
    expect(
      result.stepAttempts.find((step) => step.nodeId === "each_customer")
        ?.error,
    ).toMatchObject({
      name: "WorkflowNodeExecutionError",
      message: "Foreach item 2 failed",
      details: {
        index: 1,
        item: {},
        status: "failed",
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        durationMs: expect.any(Number),
        error: {
          message: "Reference not found: customer.id",
        },
      },
    });
  });

  it("rejects foreach concurrency above the current cap at the schema boundary", async () => {
    await expect(
      new WorkflowRunner().run({
        runId: "run_foreach_concurrency",
        definition: definition([
          {
            id: "each_customer",
            type: "builtin.foreach",
            items: "$.workflowTrigger.input.customers",
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
          input: { value: "$.workflowTrigger.input.value" },
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

  it("executes hosted tools with mapped input and trigger actor", async () => {
    const calls: Array<{
      toolName: string;
      input: unknown;
      actorId?: string;
      timeoutMs?: number;
    }> = [];
    const result = await new WorkflowRunner({
      ports: {
        hosted: {
          async callTool(req) {
            calls.push(req);
            return { output: { ok: true, count: 5 } };
          },
        },
      },
    }).run({
      runId: "run_hosted_success",
      definition: definition([
        {
          id: "asset_count",
          type: "hosted.tool",
          toolName: "hosted_qualys__qualys_gav_asset_count",
          input: { limit: "$.workflowTrigger.input.limit" },
          timeoutMs: 1500,
        },
      ]),
      input: { limit: 5 },
      trigger: {
        kind: "manual",
        triggerId: "manual",
        requestedBy: "workflow-engineer",
        input: { limit: 5 },
      },
    });

    expect(calls).toEqual([
      {
        toolName: "hosted_qualys__qualys_gav_asset_count",
        input: { limit: 5 },
        actorId: "workflow-engineer",
        timeoutMs: 1500,
      },
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.stepAttempts[0]?.output).toEqual({
      toolName: "hosted_qualys__qualys_gav_asset_count",
      result: { ok: true, count: 5 },
    });
  });
});
