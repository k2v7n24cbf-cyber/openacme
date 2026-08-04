import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../../../dist/index.js";
import { createStubModel } from "./stub-model.mjs";

const dataDir =
  process.env["OPENACME_DATA_DIR"] ?? join(homedir(), ".openacme-the-workflow");
const port = Number(process.env["OPENACME_PORT"] ?? 3458);
const baseUrl = `http://127.0.0.1:${port}`;
const workflowId = `wf_python_deployed_${Date.now().toString(36)}`;
const cancelWorkflowId = `${workflowId}_cancel`;

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env["OPENACME_DATA_DIR"] = dataDir;
process.env["OPENACME_TELEMETRY"] = "";

const config = ConfigSchema.parse({
  dataDir,
  server: { host: "127.0.0.1", port },
  model: {
    provider: "custom",
    model: "stub-1",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "stub",
  },
});

let closeApp = async () => {};
let server;
let exitCode = 0;

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    host: "127.0.0.1",
  };
}

async function post(path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function get(path, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function waitFor(fn, { timeoutMs = 2_000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

try {
  const created = await createApp(config, {
    resolveModel: () => createStubModel(),
  });
  closeApp = created.close;

  const member = created.manager.authStore.createMember({
    email: `workflow-python-smoke-${Date.now()}@example.com`,
    password: "workflow-python-smoke-password-123",
  });
  const token = created.manager.authStore.createSession(member.id).token;

  server = await new Promise((resolve) => {
    const s = serve(
      { fetch: created.app.fetch, port, hostname: "127.0.0.1" },
      () => resolve(s),
    );
  });

  await post("/api/workflows", token, {
    id: workflowId,
    name: "Workflow Python Deployed Smoke",
    nodes: [
      {
        id: "py_value",
        type: "builtin.python",
        input: { value: "$.input.value" },
        code: "print('deploy python ok')\noutput = input['value'] * 3",
        reset: true,
        timeoutMs: 5000,
        assign: {
          tripled: "$.steps.py_value.output.value",
        },
      },
      {
        id: "each_value",
        type: "builtin.foreach",
        items: "$.input.values",
        body: ["py_each"],
        concurrency: 1,
        assign: {
          foreachSummary: "$.steps.each_value.output",
        },
      },
      {
        id: "py_each",
        type: "builtin.python",
        input: { value: "item" },
        code: "output = input['value'] + 10",
        timeoutMs: 5000,
        assign: {
          shifted: {
            from: "$.steps.py_each.output.value",
            mode: "append",
          },
        },
      },
    ],
  });

  const detail = await post(`/api/workflows/${workflowId}/runs/test`, token, {
    input: { value: 4, values: [1, 2] },
  });
  if (detail.run?.status !== "succeeded") {
    throw new Error(`run failed with status ${detail.run?.status}`);
  }
  const context = detail.run.context ?? {};
  if (
    context.tripled !== 12 ||
    JSON.stringify(context.shifted) !== "[11,12]" ||
    context.foreachSummary?.count !== 2
  ) {
    throw new Error(`unexpected context: ${JSON.stringify(context)}`);
  }
  const pyValue = detail.steps?.find((step) => step.nodeId === "py_value");
  if (pyValue?.output?.stdout !== "deploy python ok\n") {
    throw new Error(`missing Python stdout trace: ${JSON.stringify(pyValue)}`);
  }
  const foreach = detail.steps?.find((step) => step.nodeId === "each_value");
  if (foreach?.output?.count !== 2) {
    throw new Error(`missing foreach trace: ${JSON.stringify(foreach)}`);
  }
  if (foreach?.contextDiff?.foreachSummary?.after?.count !== 2) {
    throw new Error(
      `missing foreach assignment diff: ${JSON.stringify(foreach)}`,
    );
  }

  const persisted = await get(`/api/workflow-runs/${detail.run.id}`, token);
  if (
    persisted.steps?.filter((step) => step.nodeId === "py_each").length !== 2
  ) {
    throw new Error("persisted run detail lost per-item Python attempts");
  }
  if (persisted.run?.context?.foreachSummary?.count !== 2) {
    throw new Error(
      `persisted run detail lost foreach assignment: ${JSON.stringify(
        persisted.run?.context,
      )}`,
    );
  }

  await post("/api/workflows", token, {
    id: cancelWorkflowId,
    name: "Workflow Python Cancel Deployed Smoke",
    nodes: [
      {
        id: "py_sleep",
        type: "builtin.python",
        code: "import time\ntime.sleep(2)\noutput = 'late'",
        timeoutMs: 5000,
        assign: {
          late: "$.steps.py_sleep.output.value",
        },
      },
    ],
  });

  const cancelRunPromise = post(
    `/api/workflows/${cancelWorkflowId}/runs/test`,
    token,
    { input: {} },
  );
  const runningCancelRun = await waitFor(() => {
    const [run] = created.runtime.workflowStore.listRuns({
      workflowId: cancelWorkflowId,
    });
    return run?.currentNodeId === "py_sleep" ? run : null;
  });
  const canceled = await post(
    `/api/workflow-runs/${runningCancelRun.id}/cancel`,
    token,
    {},
  );
  if (canceled.run?.status !== "canceled") {
    throw new Error(`Python cancel failed: ${JSON.stringify(canceled)}`);
  }
  const cancelDetail = await cancelRunPromise;
  if (
    cancelDetail.run?.status !== "canceled" ||
    cancelDetail.run?.context?.late !== undefined ||
    cancelDetail.steps?.find((step) => step.nodeId === "py_sleep")?.status !==
      "canceled" ||
    JSON.stringify(cancelDetail.events?.map((event) => event.kind) ?? []) !==
      '["run_started","step_started","run_canceled"]'
  ) {
    throw new Error(
      `Python subprocess output survived cancel: ${JSON.stringify(
        cancelDetail,
      )}`,
    );
  }
  const persistedCancel = await get(
    `/api/workflow-runs/${runningCancelRun.id}`,
    token,
  );
  if (
    persistedCancel.run?.status !== "canceled" ||
    persistedCancel.steps?.find((step) => step.nodeId === "py_sleep")
      ?.status !== "canceled" ||
    persistedCancel.run?.context?.late !== undefined
  ) {
    throw new Error(
      `persisted Python cancel was overwritten: ${JSON.stringify(
        persistedCancel,
      )}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workflowId,
        runId: detail.run.id,
        status: detail.run.status,
        context,
        cancelWorkflowId,
        cancelRunId: runningCancelRun.id,
        cancelStatus: persistedCancel.run.status,
      },
      null,
      2,
    ),
  );
} catch (err) {
  exitCode = 1;
  console.error(err);
} finally {
  if (server) {
    await Promise.race([
      new Promise((resolve) => server.close(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  await Promise.race([
    closeApp(),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  process.exit(exitCode);
}
