import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient } from "./support/client.js";

describe("Workflow foreach and Python steps (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
  });

  afterAll(async () => {
    await srv.close();
  });

  it("runs Python subprocess steps and foreach item traces", async () => {
    let res = await c.post("/api/workflows", {
      id: "wf_python_e2e",
      name: "Workflow Python E2E",
      nodes: [
        {
          id: "py_value",
          type: "builtin.python",
          input: { value: "$.input.value" },
          code: "x = input['value'] * 2\nprint('value ready')\noutput = x",
          reset: true,
          timeoutMs: 5000,
          assign: {
            doubled: "$.steps.py_value.output.value",
          },
        },
        {
          id: "py_isolated",
          type: "builtin.python",
          code: "output = 'x' in globals()",
          timeoutMs: 5000,
          assign: {
            isolated: "$.steps.py_isolated.output.value",
          },
        },
        {
          id: "each_value",
          type: "builtin.foreach",
          items: "$.input.values",
          body: ["py_each"],
          concurrency: 1,
        },
        {
          id: "py_each",
          type: "builtin.python",
          input: { value: "item" },
          code: "output = input['value'] + 1",
          timeoutMs: 5000,
          assign: {
            increments: {
              from: "$.steps.py_each.output.value",
              mode: "append",
            },
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await c.post("/api/workflows/wf_python_e2e/runs/test", {
      input: { value: 3, values: [2, 4] },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
      steps: Array<{
        nodeId: string;
        attempt: number;
        status: string;
        output?: unknown;
      }>;
      events: Array<{ kind: string }>;
    };

    expect(detail.run).toMatchObject({
      status: "succeeded",
      context: {
        doubled: 6,
        isolated: false,
        increments: [3, 5],
      },
    });
    expect(
      detail.steps.find((step) => step.nodeId === "py_value"),
    ).toMatchObject({
      status: "succeeded",
      output: {
        value: 6,
        stdout: "value ready\n",
        stderr: "",
      },
    });
    expect(
      detail.steps
        .filter((step) => step.nodeId === "py_each")
        .map((step) => [step.attempt, step.output]),
    ).toEqual([
      [1, { value: 3, stdout: "", stderr: "" }],
      [2, { value: 5, stdout: "", stderr: "" }],
    ]);
    expect(
      detail.steps.find((step) => step.nodeId === "each_value")?.output,
    ).toMatchObject({
      count: 2,
      items: [
        { index: 0, status: "succeeded", steps: { py_each: { value: 3 } } },
        { index: 1, status: "succeeded", steps: { py_each: { value: 5 } } },
      ],
    });
    expect(detail.events.map((event) => event.kind)).toContain("step_output");

    const persisted = await c.json(`/api/workflow-runs/${detail.run.id}`);
    expect(persisted.run.context).toMatchObject({
      doubled: 6,
      isolated: false,
      increments: [3, 5],
    });
  });

  it("persists Python failure and timeout details on workflow steps", async () => {
    let res = await c.post("/api/workflows", {
      id: "wf_python_failure_e2e",
      name: "Workflow Python Failure E2E",
      nodes: [
        {
          id: "py_fail",
          type: "builtin.python",
          code: "raise RuntimeError('boom')",
          timeoutMs: 5000,
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await c.post("/api/workflows/wf_python_failure_e2e/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const failed = (await res.json()) as {
      run: { status: string };
      steps: Array<{
        status: string;
        error?: { details?: { stderr?: string } };
      }>;
    };
    expect(failed.run.status).toBe("failed");
    expect(failed.steps[0]).toMatchObject({
      status: "failed",
      error: {
        message: "Workflow Python execution failed",
      },
    });
    expect(failed.steps[0]?.error?.details?.stderr).toContain(
      "RuntimeError: boom",
    );

    res = await c.post("/api/workflows", {
      id: "wf_python_timeout_e2e",
      name: "Workflow Python Timeout E2E",
      nodes: [
        {
          id: "py_timeout",
          type: "builtin.python",
          code: "import time\ntime.sleep(1)\noutput = 'late'",
          timeoutMs: 100,
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await c.post("/api/workflows/wf_python_timeout_e2e/runs/test", {
      input: {},
    });
    expect(res.status).toBe(201);
    const timedOut = (await res.json()) as {
      run: { status: string };
      steps: Array<{ status: string; error?: { message?: string } }>;
    };
    expect(timedOut.run.status).toBe("failed");
    expect(timedOut.steps[0]).toMatchObject({
      status: "failed",
      error: {
        message: "Workflow Python timed out after 100ms",
      },
    });
  });
});
