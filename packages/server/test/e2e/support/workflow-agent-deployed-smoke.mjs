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

const workflowId = `wf_agent_deployed_${Date.now().toString(36)}`;
const cancelWorkflowId = `${workflowId}_cancel`;
const agentId = `support_${Date.now().toString(36)}`;

let closeApp = async () => {};
let server;
let exitCode = 0;

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    host: "127.0.0.1",
  };
}

async function post(path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}: ${text}`);
  }
  return payload;
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

async function waitFor(fn, { timeoutMs = 3_000, intervalMs = 25 } = {}) {
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
    email: `workflow-smoke-${Date.now()}@example.com`,
    password: "workflow-smoke-password-123",
  });
  const token = created.manager.authStore.createSession(member.id).token;

  server = await new Promise((resolve) => {
    const s = serve(
      { fetch: created.app.fetch, port, hostname: "127.0.0.1" },
      () => resolve(s),
    );
  });

  await post("/api/agents", token, { id: agentId, name: "Support" });
  const agents = await get("/api/workflows/agents", token);
  if (!agents.agents?.some((agent) => agent.id === agentId)) {
    throw new Error("support agent was not listed through workflow metadata");
  }

  await post("/api/workflows", token, {
    id: workflowId,
    name: "Workflow Agent Deployed Smoke",
    nodes: [
      {
        id: "ask_support",
        type: "agent.call",
        agentId,
        prompt:
          "Return [[mock:text:deployed workflow support ok]] for {{$.workflowTrigger.input.customerId}}",
        input: { customerId: "$.workflowTrigger.input.customerId" },
        assign: {
          support: "$.steps.ask_support.output",
        },
      },
    ],
  });

  const detail = await post(`/api/workflows/${workflowId}/runs/test`, token, {
    input: { customerId: "cust_deployed" },
  });
  const support = detail.run?.context?.support;
  if (detail.run?.status !== "succeeded") {
    throw new Error(`run failed with status ${detail.run?.status}`);
  }
  if (support?.response !== "deployed workflow support ok") {
    throw new Error(`unexpected agent response: ${JSON.stringify(support)}`);
  }
  if (typeof support?.sessionId !== "string") {
    throw new Error("agent session id was not persisted in workflow context");
  }
  if (!detail.events?.some((event) => event.kind === "step_output")) {
    throw new Error("workflow run did not persist a step_output event");
  }

  const persisted = await get(`/api/workflow-runs/${detail.run.id}`, token);
  if (persisted.steps?.[0]?.output?.sessionId !== support.sessionId) {
    throw new Error("persisted run detail lost the agent session id");
  }

  await post("/api/workflows", token, {
    id: cancelWorkflowId,
    name: "Workflow Agent Cancel Deployed Smoke",
    nodes: [
      {
        id: "ask_support_cancel",
        type: "agent.call",
        agentId,
        prompt: "Return [[mock:slow-long]] for cancel",
        assign: {
          support: "$.steps.ask_support_cancel.output",
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
    return run?.currentNodeId === "ask_support_cancel" ? run : null;
  });
  const canceled = await post(
    `/api/workflow-runs/${runningCancelRun.id}/cancel`,
    token,
    {},
  );
  if (canceled.run?.status !== "canceled") {
    throw new Error(`agent cancel failed: ${JSON.stringify(canceled)}`);
  }
  const cancelDetail = await cancelRunPromise;
  if (
    cancelDetail.run?.status !== "canceled" ||
    cancelDetail.run?.context?.support !== undefined ||
    cancelDetail.steps?.find((step) => step.nodeId === "ask_support_cancel")
      ?.status !== "canceled" ||
    JSON.stringify(cancelDetail.events?.map((event) => event.kind) ?? []) !==
      '["run_started","step_started","run_canceled"]'
  ) {
    throw new Error(
      `late agent output survived cancel: ${JSON.stringify(cancelDetail)}`,
    );
  }
  const persistedCancel = await get(
    `/api/workflow-runs/${runningCancelRun.id}`,
    token,
  );
  if (
    persistedCancel.run?.status !== "canceled" ||
    persistedCancel.run?.context?.support !== undefined ||
    persistedCancel.steps?.find((step) => step.nodeId === "ask_support_cancel")
      ?.status !== "canceled"
  ) {
    throw new Error(
      `persisted agent cancel was overwritten: ${JSON.stringify(
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
        response: support.response,
        sessionId: support.sessionId,
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
