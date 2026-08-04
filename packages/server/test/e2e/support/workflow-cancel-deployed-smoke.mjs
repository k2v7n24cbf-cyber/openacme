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
const workflowId = `wf_cancel_deployed_${Date.now().toString(36)}`;
const runId = `run_cancel_deployed_${Date.now().toString(36)}`;
const lateWorkflowId = `wf_cancel_late_deployed_${Date.now().toString(36)}`;
const exitCanceledWorkflowId = `wf_exit_canceled_deployed_${Date.now().toString(36)}`;
const exitFailedWorkflowId = `wf_exit_failed_deployed_${Date.now().toString(36)}`;

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
let token = "";
const lateCancelSignalStates = [];

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
  const payload = text ? JSON.parse(text) : null;
  return { status: res.status, payload };
}

async function get(path, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" },
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  return { status: res.status, payload };
}

function expectStatus(res, status, label) {
  if (res.status !== status) {
    throw new Error(
      `${label} returned ${res.status}: ${JSON.stringify(res.payload)}`,
    );
  }
  return res.payload;
}

try {
  let created;
  created = await createApp(config, {
    resolveModel: () => createStubModel(),
    workflowExecutionPorts: {
      mcp: {
        async callTool(req) {
          const signal = req.signal;
          const [run] = created.runtime.workflowStore.listRuns({
            workflowId: lateWorkflowId,
          });
          if (!run) {
            throw new Error("late cancel run was not visible during tool call");
          }
          const beforeCancel = signal?.aborted ?? null;
          const cancelDetail = expectStatus(
            await post(`/api/workflow-runs/${run.id}/cancel`, token, {}),
            200,
            "cancel run during execution",
          );
          if (cancelDetail.run?.status !== "canceled") {
            throw new Error(
              `late cancel did not cancel run: ${JSON.stringify(cancelDetail)}`,
            );
          }
          lateCancelSignalStates.push({
            beforeCancel,
            afterCancel: signal?.aborted ?? null,
          });
          return { output: { id: "cust_late_cancel", score: 99 } };
        },
      },
    },
  });
  closeApp = created.close;

  const member = created.manager.authStore.createMember({
    email: `workflow-cancel-smoke-${Date.now()}@example.com`,
    password: "workflow-cancel-smoke-password-123",
  });
  token = created.manager.authStore.createSession(member.id).token;

  const workflow = created.runtime.workflowStore.createDraft({
    id: workflowId,
    name: "Workflow Cancel Deployed Smoke",
    nodes: [
      {
        id: "set_customer",
        type: "builtin.set",
        assign: { customer: "$.input.customer" },
      },
    ],
  });
  created.runtime.workflowStore.createRun({
    id: runId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    definitionSource: "draft",
    mode: "test",
    status: "running",
    input: { customer: { id: "cust_cancel", name: "Cancel Ada" } },
    currentNodeId: "set_customer",
    startedAt: new Date().toISOString(),
  });
  created.runtime.workflowStore.recordStepAttempt({
    id: `${runId}_set_customer_attempt_1`,
    runId,
    nodeId: "set_customer",
    attempt: 1,
    status: "running",
    startedAt: "2026-07-30T10:00:00.000Z",
    input: { customer: { id: "cust_cancel", name: "Cancel Ada" } },
  });
  created.runtime.workflowStore.appendRunEvent({
    runId,
    level: "system",
    kind: "run_started",
    message: "Workflow run started",
  });

  server = await new Promise((resolve) => {
    const s = serve(
      { fetch: created.app.fetch, port, hostname: "127.0.0.1" },
      () => resolve(s),
    );
  });

  const detail = expectStatus(
    await post(`/api/workflow-runs/${runId}/cancel`, token, {}),
    200,
    "cancel run",
  );
  if (
    detail.run?.status !== "canceled" ||
    detail.run?.currentNodeId !== null ||
    !detail.run?.endedAt
  ) {
    throw new Error(`unexpected canceled run: ${JSON.stringify(detail.run)}`);
  }
  const eventKinds = detail.events?.map((event) => event.kind) ?? [];
  if (JSON.stringify(eventKinds) !== '["run_started","run_canceled"]') {
    throw new Error(`missing cancel event: ${JSON.stringify(detail.events)}`);
  }
  const canceledDetailStep = detail.steps?.find(
    (step) => step.nodeId === "set_customer",
  );
  if (
    canceledDetailStep?.status !== "canceled" ||
    !canceledDetailStep.endedAt ||
    typeof canceledDetailStep.durationMs !== "number"
  ) {
    throw new Error(
      `cancel did not close current step: ${JSON.stringify(detail.steps)}`,
    );
  }

  const terminal = expectStatus(
    await post(`/api/workflow-runs/${runId}/cancel`, token, {}),
    409,
    "cancel terminal run",
  );
  if (terminal.error !== "run_not_cancelable") {
    throw new Error(`unexpected terminal error: ${JSON.stringify(terminal)}`);
  }

  const persisted = expectStatus(
    await get(`/api/workflow-runs/${runId}`, token),
    200,
    "get canceled detail",
  );
  if (
    persisted.run?.status !== "canceled" ||
    persisted.events?.at(-1)?.kind !== "run_canceled" ||
    persisted.steps?.find((step) => step.nodeId === "set_customer")?.status !==
      "canceled"
  ) {
    throw new Error(`cancel did not persist: ${JSON.stringify(persisted)}`);
  }
  const persistedStep = persisted.steps.find(
    (step) => step.nodeId === "set_customer",
  );

  expectStatus(
    await post("/api/workflows", token, {
      id: lateWorkflowId,
      name: "Workflow Late Cancel Deployed Smoke",
      nodes: [
        {
          id: "crm_lookup",
          type: "mcp.tool",
          server: "crm",
          tool: "lookup",
          input: {
            id: "$.input.customerId",
            apiKey: "$.input.apiKey",
          },
          assign: {
            crm: "$.steps.crm_lookup.output",
          },
        },
      ],
    }),
    201,
    "create late cancel workflow",
  );
  const lateDetail = expectStatus(
    await post(`/api/workflows/${lateWorkflowId}/runs/test`, token, {
      input: {
        customerId: "cust_late_cancel",
        apiKey: "raw-late-cancel-api-key",
      },
    }),
    201,
    "run late cancel workflow",
  );
  const lateEventKinds = lateDetail.events?.map((event) => event.kind) ?? [];
  const lateStepStarted = lateDetail.events?.find(
    (event) => event.kind === "step_started",
  );
  if (
    JSON.stringify(lateCancelSignalStates) !==
      '[{"beforeCancel":false,"afterCancel":true}]' ||
    lateDetail.run?.status !== "canceled" ||
    JSON.stringify(lateDetail).includes("raw-late-cancel-api-key") ||
    JSON.stringify(lateDetail.run?.trigger?.input) !==
      '{"customerId":"cust_late_cancel","apiKey":"[redacted]"}' ||
    lateDetail.steps?.find((step) => step.nodeId === "crm_lookup")?.status !==
      "canceled" ||
    JSON.stringify(
      lateDetail.steps?.find((step) => step.nodeId === "crm_lookup")?.input,
    ) !== '{"id":"cust_late_cancel","apiKey":"[redacted]"}' ||
    JSON.stringify(lateStepStarted?.payload?.input) !==
      '{"id":"cust_late_cancel","apiKey":"[redacted]"}' ||
    JSON.stringify(lateEventKinds) !==
      '["run_started","step_started","run_canceled"]'
  ) {
    throw new Error(
      `late completion overwrote cancel: ${JSON.stringify(lateDetail)}`,
    );
  }
  const latePersisted = expectStatus(
    await get(`/api/workflow-runs/${lateDetail.run.id}`, token),
    200,
    "get late canceled detail",
  );
  if (
    latePersisted.run?.status !== "canceled" ||
    JSON.stringify(latePersisted).includes("raw-late-cancel-api-key") ||
    JSON.stringify(latePersisted.run?.trigger?.input) !==
      '{"customerId":"cust_late_cancel","apiKey":"[redacted]"}' ||
    latePersisted.steps?.find((step) => step.nodeId === "crm_lookup")
      ?.status !== "canceled" ||
    JSON.stringify(
      latePersisted.steps?.find((step) => step.nodeId === "crm_lookup")?.input,
    ) !== '{"id":"cust_late_cancel","apiKey":"[redacted]"}' ||
    JSON.stringify(
      latePersisted.events?.find((event) => event.kind === "step_started")
        ?.payload?.input,
    ) !== '{"id":"cust_late_cancel","apiKey":"[redacted]"}' ||
    JSON.stringify(latePersisted.events?.map((event) => event.kind) ?? []) !==
      '["run_started","step_started","run_canceled"]'
  ) {
    throw new Error(
      `late cancel did not persist: ${JSON.stringify(latePersisted)}`,
    );
  }

  expectStatus(
    await post("/api/workflows", token, {
      id: exitCanceledWorkflowId,
      name: "Workflow Exit Canceled Deployed Smoke",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "canceled",
          output: { reason: "operator-defined stop" },
        },
      ],
    }),
    201,
    "create exit canceled workflow",
  );
  const exitCanceledDetail = expectStatus(
    await post(`/api/workflows/${exitCanceledWorkflowId}/runs/test`, token, {
      input: {},
    }),
    201,
    "run exit canceled workflow",
  );
  const exitCanceledEventKinds =
    exitCanceledDetail.events?.map((event) => event.kind) ?? [];
  if (
    exitCanceledDetail.run?.status !== "canceled" ||
    exitCanceledDetail.steps?.find((step) => step.nodeId === "exit")?.status !==
      "canceled" ||
    JSON.stringify(exitCanceledEventKinds) !==
      '["run_started","step_started","run_canceled","step_completed"]' ||
    exitCanceledDetail.events?.find((event) => event.kind === "run_canceled")
      ?.message !== "Workflow run canceled"
  ) {
    throw new Error(
      `exit canceled workflow did not persist canceled audit semantics: ${JSON.stringify(
        exitCanceledDetail,
      )}`,
    );
  }
  const exitCanceledPersisted = expectStatus(
    await get(`/api/workflow-runs/${exitCanceledDetail.run.id}`, token),
    200,
    "get exit canceled detail",
  );
  if (
    exitCanceledPersisted.run?.status !== "canceled" ||
    exitCanceledPersisted.steps?.find((step) => step.nodeId === "exit")
      ?.status !== "canceled" ||
    JSON.stringify(
      exitCanceledPersisted.events?.map((event) => event.kind) ?? [],
    ) !== '["run_started","step_started","run_canceled","step_completed"]'
  ) {
    throw new Error(
      `exit canceled workflow did not persist after reload: ${JSON.stringify(
        exitCanceledPersisted,
      )}`,
    );
  }

  expectStatus(
    await post("/api/workflows", token, {
      id: exitFailedWorkflowId,
      name: "Workflow Exit Failed Deployed Smoke",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "failed",
          output: { reason: "business rule failed" },
        },
      ],
    }),
    201,
    "create exit failed workflow",
  );
  const exitFailedDetail = expectStatus(
    await post(`/api/workflows/${exitFailedWorkflowId}/runs/test`, token, {
      input: {},
    }),
    201,
    "run exit failed workflow",
  );
  const exitFailedEventKinds =
    exitFailedDetail.events?.map((event) => event.kind) ?? [];
  if (
    exitFailedDetail.run?.status !== "failed" ||
    exitFailedDetail.steps?.find((step) => step.nodeId === "exit")?.status !==
      "failed" ||
    JSON.stringify(exitFailedEventKinds) !==
      '["run_started","step_started","run_failed","step_failed"]' ||
    exitFailedDetail.events?.find((event) => event.kind === "step_failed")
      ?.message !== "Step exit failed"
  ) {
    throw new Error(
      `exit failed workflow did not persist failed audit semantics: ${JSON.stringify(
        exitFailedDetail,
      )}`,
    );
  }
  const exitFailedPersisted = expectStatus(
    await get(`/api/workflow-runs/${exitFailedDetail.run.id}`, token),
    200,
    "get exit failed detail",
  );
  if (
    exitFailedPersisted.run?.status !== "failed" ||
    exitFailedPersisted.steps?.find((step) => step.nodeId === "exit")
      ?.status !== "failed" ||
    JSON.stringify(
      exitFailedPersisted.events?.map((event) => event.kind) ?? [],
    ) !== '["run_started","step_started","run_failed","step_failed"]'
  ) {
    throw new Error(
      `exit failed workflow did not persist after reload: ${JSON.stringify(
        exitFailedPersisted,
      )}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workflowId,
        runId,
        status: persisted.run.status,
        stepStatus: persistedStep.status,
        eventKinds,
        lateWorkflowId,
        lateRunId: lateDetail.run.id,
        lateStatus: latePersisted.run.status,
        lateTriggerInput: latePersisted.run.trigger.input,
        lateStepStatus: latePersisted.steps.find(
          (step) => step.nodeId === "crm_lookup",
        ).status,
        lateStepInput: latePersisted.steps.find(
          (step) => step.nodeId === "crm_lookup",
        ).input,
        lateEventKinds,
        lateCancelSignalStates,
        exitCanceledWorkflowId,
        exitCanceledRunId: exitCanceledPersisted.run.id,
        exitCanceledStatus: exitCanceledPersisted.run.status,
        exitCanceledStepStatus: exitCanceledPersisted.steps.find(
          (step) => step.nodeId === "exit",
        ).status,
        exitCanceledEventKinds,
        exitFailedWorkflowId,
        exitFailedRunId: exitFailedPersisted.run.id,
        exitFailedStatus: exitFailedPersisted.run.status,
        exitFailedStepStatus: exitFailedPersisted.steps.find(
          (step) => step.nodeId === "exit",
        ).status,
        exitFailedEventKinds,
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
