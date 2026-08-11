import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
const workflowId = `wf_trigger_deployed_${Date.now().toString(36)}`;
const publicWebhookSecret = "workflow-trigger-public-smoke-secret";

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

async function post(path, token, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...authHeaders(token), ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  return { status: res.status, payload };
}

async function publicPost(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "workflow-webhook.example",
      ...headers,
    },
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

async function getText(path, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" },
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectStatus(res, status, label) {
  if (res.status !== status) {
    throw new Error(
      `${label} returned ${res.status}: ${JSON.stringify(res.payload)}`,
    );
  }
  return res.payload;
}

function assertEventTimeline(detail, label) {
  const events = detail.events ?? [];
  if (events.length === 0) {
    throw new Error(`${label} did not return persisted workflow events`);
  }
  const sequence = events.map((event) => event.sequence);
  const expected = Array.from(
    { length: events.length },
    (_, index) => index + 1,
  );
  if (JSON.stringify(sequence) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} event sequence is not contiguous: ${JSON.stringify(events)}`,
    );
  }
  if (
    events[0]?.kind !== "run_started" ||
    !events.some((event) =>
      ["run_completed", "run_failed", "run_canceled"].includes(event.kind),
    )
  ) {
    throw new Error(
      `${label} event boundary is invalid: ${JSON.stringify(events)}`,
    );
  }
}

try {
  const created = await createApp(config, {
    resolveModel: () => createStubModel(),
    workflowDispatcherIntervalMs: 25,
    workflowDispatcherNow: () => new Date("2026-07-30T02:00:30.000Z"),
  });
  closeApp = created.close;

  const member = created.manager.authStore.createMember({
    email: `workflow-trigger-smoke-${Date.now()}@example.com`,
    password: "workflow-trigger-smoke-password-123",
  });
  const token = created.manager.authStore.createSession(member.id).token;

  server = await new Promise((resolve) => {
    const s = serve(
      { fetch: created.app.fetch, port, hostname: "127.0.0.1" },
      () => resolve(s),
    );
  });

  const invalidWorkflowId = await post("/api/workflows", token, {
    id: `${workflowId}/invalid`,
    name: "Workflow Unsafe Id Guard",
    nodes: [
      {
        id: "exit",
        type: "builtin.exit",
        status: "succeeded",
        output: "$.workflowTrigger.input",
      },
    ],
  });
  if (
    invalidWorkflowId.status !== 400 ||
    invalidWorkflowId.payload?.error !== "invalid id"
  ) {
    throw new Error(
      `unsafe workflow id was accepted: ${JSON.stringify(invalidWorkflowId)}`,
    );
  }

  const invalidDuplicateTrigger = await post("/api/workflows", token, {
    id: `${workflowId}_invalid_duplicate_trigger`,
    name: "Workflow Trigger Duplicate Guard",
    triggers: [
      { id: "manual", kind: "manual", enabled: true },
      { id: "manual", kind: "manual", enabled: true },
    ],
    nodes: [
      {
        id: "exit",
        type: "builtin.exit",
        status: "succeeded",
        output: "$.workflowTrigger.input",
      },
    ],
  });
  if (
    invalidDuplicateTrigger.status !== 400 ||
    invalidDuplicateTrigger.payload?.error !==
      "Duplicate workflow trigger id: manual"
  ) {
    throw new Error(
      `duplicate trigger id was accepted: ${JSON.stringify(invalidDuplicateTrigger)}`,
    );
  }

  const invalidUnsafeTriggerId = await post("/api/workflows", token, {
    id: `${workflowId}_invalid_trigger_id`,
    name: "Workflow Trigger Unsafe Id Guard",
    triggers: [{ id: "manual/review", kind: "manual", enabled: true }],
    nodes: [
      {
        id: "exit",
        type: "builtin.exit",
        status: "succeeded",
        output: "$.workflowTrigger.input",
      },
    ],
  });
  if (
    invalidUnsafeTriggerId.status !== 400 ||
    invalidUnsafeTriggerId.payload?.error !==
      "Invalid workflow trigger id: manual/review"
  ) {
    throw new Error(
      `unsafe trigger id was accepted: ${JSON.stringify(invalidUnsafeTriggerId)}`,
    );
  }

  const invalidUnsafeNodeId = await post("/api/workflows", token, {
    id: `${workflowId}_invalid_node_id`,
    name: "Workflow Node Unsafe Id Guard",
    nodes: [
      {
        id: "load/customer",
        type: "builtin.log.info",
        message: "Invalid node id",
      },
    ],
  });
  if (
    invalidUnsafeNodeId.status !== 400 ||
    invalidUnsafeNodeId.payload?.error !==
      "Invalid workflow node id: load/customer"
  ) {
    throw new Error(
      `unsafe node id was accepted: ${JSON.stringify(invalidUnsafeNodeId)}`,
    );
  }

  const invalidDuplicateWebhookPath = await post("/api/workflows", token, {
    id: `${workflowId}_invalid_duplicate_path`,
    name: "Workflow Webhook Path Duplicate Guard",
    triggers: [
      {
        id: "incoming_a",
        kind: "webhook",
        enabled: true,
        path: "crm/customer",
      },
      {
        id: "incoming_b",
        kind: "webhook",
        enabled: false,
        path: "/crm/customer/",
      },
    ],
    nodes: [
      {
        id: "exit",
        type: "builtin.exit",
        status: "succeeded",
        output: "$.workflowTrigger.input",
      },
    ],
  });
  if (
    invalidDuplicateWebhookPath.status !== 400 ||
    invalidDuplicateWebhookPath.payload?.error !==
      "Duplicate workflow webhook path: crm/customer"
  ) {
    throw new Error(
      `duplicate webhook path was accepted: ${JSON.stringify(invalidDuplicateWebhookPath)}`,
    );
  }

  expectStatus(
    await post("/api/workflows", token, {
      id: workflowId,
      name: "Workflow Trigger Deployed Smoke",
      inputSchema: {
        type: "object",
        required: ["customer"],
        properties: {
          customer: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      triggers: [
        { id: "manual_review", kind: "manual", enabled: true },
        {
          id: "invalid_nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: {
            customer: { id: "cust_invalid_scheduled" },
          },
        },
        {
          id: "nightly",
          kind: "scheduled",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
          input: {
            customer: { id: "cust_scheduled", name: "Scheduled Bea" },
          },
        },
        {
          id: "disabled_nightly",
          kind: "scheduled",
          enabled: false,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
        },
        {
          id: "incoming_customer",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
          secretSha256: sha256(publicWebhookSecret),
          inputSchema: {
            type: "object",
            required: ["source"],
            properties: { source: { const: "crm" } },
          },
        },
      ],
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
        },
        {
          id: "audit_log",
          type: "builtin.log.info",
          message: "Customer ready",
          payload: "$.context.customer",
          assign: {
            loggedCustomer: "$.steps.audit_log.output.payload",
          },
        },
        {
          id: "quoted_condition",
          type: "builtin.if_else",
          condition:
            'contains($.workflowTrigger.input.customer.name, "Trigger or Ada") or contains($.workflowTrigger.input.customer.name, "Review and Hold")',
          then: ["quoted_match"],
          else: ["quoted_miss"],
        },
        {
          id: "quoted_match",
          type: "builtin.log.error",
          message: "Quoted condition matched",
        },
        {
          id: "quoted_miss",
          type: "builtin.log.info",
          message: "Quoted condition missed",
        },
        {
          id: "comma_condition",
          type: "builtin.if_else",
          condition: 'contains($.workflowTrigger.input.customer.name, "Trigger, Ada")',
          then: ["comma_match"],
          else: ["comma_miss"],
        },
        {
          id: "comma_match",
          type: "builtin.log.info",
          message: "Comma condition matched",
        },
        {
          id: "comma_miss",
          type: "builtin.log.error",
          message: "Comma condition missed",
        },
        {
          id: "comparison_condition",
          type: "builtin.if_else",
          condition: '"Trigger >= Ada" == $.workflowTrigger.input.customer.name',
          then: ["comparison_match"],
          else: ["comparison_miss"],
        },
        {
          id: "comparison_match",
          type: "builtin.log.error",
          message: "Comparison condition matched",
        },
        {
          id: "comparison_miss",
          type: "builtin.log.info",
          message: "Comparison condition missed",
        },
        {
          id: "not_condition",
          type: "builtin.if_else",
          condition: 'not(contains($.workflowTrigger.input.customer.name, "Trigger Ada"))',
          then: ["not_match"],
          else: ["not_miss"],
        },
        {
          id: "not_match",
          type: "builtin.log.error",
          message: "Parenthesized not condition matched",
        },
        {
          id: "not_miss",
          type: "builtin.log.info",
          message: "Parenthesized not condition missed",
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context.customer",
        },
      ],
    }),
    201,
    "create workflow",
  );

  const triggers = expectStatus(
    await get(`/api/workflows/${workflowId}/triggers`, token),
    200,
    "list triggers",
  );
  if (
    !triggers.triggers?.some(
      (trigger) => trigger.id === "manual_review" && trigger.runnable === true,
    ) ||
    !triggers.triggers?.some(
      (trigger) =>
        trigger.id === "invalid_nightly" &&
        trigger.enabled === true &&
        trigger.runnable === false,
    ) ||
    !triggers.triggers?.some(
      (trigger) =>
        trigger.id === "nightly" &&
        trigger.enabled === true &&
        trigger.runnable === false,
    ) ||
    !triggers.triggers?.some(
      (trigger) =>
        trigger.id === "disabled_nightly" && trigger.runnable === false,
    ) ||
    !triggers.triggers?.some(
      (trigger) =>
        trigger.id === "incoming_customer" && trigger.runnable === true,
    )
  ) {
    throw new Error(`unexpected trigger metadata: ${JSON.stringify(triggers)}`);
  }

  const invalidDraftTestVersion = await post(
    `/api/workflows/${workflowId}/runs/test`,
    token,
    {
      version: 2,
      input: { customer: { id: "cust_test_version", name: "Version Ada" } },
    },
  );
  if (
    invalidDraftTestVersion.status !== 400 ||
    invalidDraftTestVersion.payload?.error !== "test_run_version_not_supported"
  ) {
    throw new Error(
      `draft test run accepted version selector: ${JSON.stringify(invalidDraftTestVersion)}`,
    );
  }

  expectStatus(
    await post(`/api/workflows/${workflowId}/publish`, token, {}),
    200,
    "publish workflow",
  );

  const detail = expectStatus(
    await post(
      `/api/workflows/${workflowId}/triggers/manual_review/runs`,
      token,
      {
        input: { customer: { id: "cust_trigger", name: "Trigger Ada" } },
      },
    ),
    201,
    "run manual trigger",
  );
  if (detail.run?.status !== "succeeded") {
    throw new Error(`manual trigger run failed: ${JSON.stringify(detail.run)}`);
  }
  if (detail.run?.context?.loggedCustomer?.id !== "cust_trigger") {
    throw new Error(
      `log assignment did not update context: ${JSON.stringify(detail.run?.context)}`,
    );
  }
  const auditLogStep = detail.steps?.find(
    (step) => step.nodeId === "audit_log",
  );
  if (auditLogStep?.contextDiff?.loggedCustomer?.after?.id !== "cust_trigger") {
    throw new Error(
      `log assignment diff missing: ${JSON.stringify(auditLogStep)}`,
    );
  }
  const quotedStepStates = Object.fromEntries(
    detail.steps
      ?.filter((step) => ["quoted_match", "quoted_miss"].includes(step.nodeId))
      .map((step) => [step.nodeId, step.status]) ?? [],
  );
  if (
    quotedStepStates["quoted_match"] !== "skipped" ||
    quotedStepStates["quoted_miss"] !== "succeeded"
  ) {
    throw new Error(
      `quoted condition selected wrong branch: ${JSON.stringify(quotedStepStates)}`,
    );
  }
  const commaStepStates = Object.fromEntries(
    detail.steps
      ?.filter((step) => ["comma_match", "comma_miss"].includes(step.nodeId))
      .map((step) => [step.nodeId, step.status]) ?? [],
  );
  if (
    commaStepStates["comma_match"] !== "skipped" ||
    commaStepStates["comma_miss"] !== "succeeded"
  ) {
    throw new Error(
      `comma condition selected wrong branch: ${JSON.stringify(commaStepStates)}`,
    );
  }
  const comparisonStepStates = Object.fromEntries(
    detail.steps
      ?.filter((step) =>
        ["comparison_match", "comparison_miss"].includes(step.nodeId),
      )
      .map((step) => [step.nodeId, step.status]) ?? [],
  );
  if (
    comparisonStepStates["comparison_match"] !== "skipped" ||
    comparisonStepStates["comparison_miss"] !== "succeeded"
  ) {
    throw new Error(
      `comparison condition selected wrong branch: ${JSON.stringify(
        comparisonStepStates,
      )}`,
    );
  }
  const notStepStates = Object.fromEntries(
    detail.steps
      ?.filter((step) => ["not_match", "not_miss"].includes(step.nodeId))
      .map((step) => [step.nodeId, step.status]) ?? [],
  );
  if (
    notStepStates["not_match"] !== "skipped" ||
    notStepStates["not_miss"] !== "succeeded"
  ) {
    throw new Error(
      `parenthesized not condition selected wrong branch: ${JSON.stringify(
        notStepStates,
      )}`,
    );
  }

  const inputSpillWorkflowId = `${workflowId}_input_spill`;
  expectStatus(
    await post("/api/workflows", token, {
      id: inputSpillWorkflowId,
      name: "Workflow Run Input Spill Deployed Smoke",
      nodes: [
        {
          id: "set_customer_id",
          type: "builtin.set",
          assign: {
            customerId: "$.workflowTrigger.input.customer.id",
          },
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    }),
    201,
    "create run input spill workflow",
  );
  const largeInputDetail = expectStatus(
    await post(`/api/workflows/${inputSpillWorkflowId}/runs/test`, token, {
      input: {
        customer: {
          id: "cust_large_input",
          records: "x".repeat(70_000),
          apiKey: "raw-deployed-run-input-key",
        },
      },
    }),
    201,
    "run draft workflow with large input",
  );
  const runInputRef = largeInputDetail.run?.input?.artifact;
  if (
    largeInputDetail.run?.status !== "succeeded" ||
    largeInputDetail.run?.context?.customerId !== "cust_large_input" ||
    runInputRef?.kind !== "run_input" ||
    runInputRef.path !== `runs/${largeInputDetail.run.id}/input.json` ||
    !String(runInputRef.preview).includes('"cust_large_input"') ||
    String(JSON.stringify(largeInputDetail.run?.input)).includes(
      "raw-deployed-run-input-key",
    )
  ) {
    throw new Error(
      `large run input was not spilled in deployed detail: ${JSON.stringify(
        largeInputDetail.run,
      )}`,
    );
  }
  const runInputArtifact = largeInputDetail.artifacts?.find(
    (item) => item.id === runInputRef.id,
  );
  if (
    runInputArtifact?.runId !== largeInputDetail.run.id ||
    runInputArtifact.stepRunId !== null ||
    runInputArtifact.kind !== "run_input" ||
    runInputArtifact.path !== runInputRef.path
  ) {
    throw new Error(
      `large run input artifact metadata missing: ${JSON.stringify(
        largeInputDetail.artifacts,
      )}`,
    );
  }
  const runInputArtifactPath = join(
    dataDir,
    "workflow-artifacts",
    runInputRef.path,
  );
  if (!existsSync(runInputArtifactPath)) {
    throw new Error(`large run input artifact file missing`);
  }
  const runInputArtifactJson = readFileSync(runInputArtifactPath, "utf8");
  if (
    !runInputArtifactJson.includes('"apiKey":"[redacted]"') ||
    runInputArtifactJson.includes("raw-deployed-run-input-key")
  ) {
    throw new Error(`large run input artifact file was not redacted`);
  }
  const runInputArtifactContent = expectStatus(
    await get(
      `/api/workflow-runs/${largeInputDetail.run.id}/artifacts/${runInputRef.id}`,
      token,
    ),
    200,
    "get spilled run input artifact content",
  );
  if (
    runInputArtifactContent.artifact?.id !== runInputRef.id ||
    runInputArtifactContent.artifact?.runId !== largeInputDetail.run.id ||
    runInputArtifactContent.content?.customer?.apiKey !== "[redacted]" ||
    String(JSON.stringify(runInputArtifactContent)).includes(
      "raw-deployed-run-input-key",
    )
  ) {
    throw new Error(
      `spilled run input artifact content route returned wrong payload: ${JSON.stringify(
        runInputArtifactContent,
      )}`,
    );
  }
  const runInputArtifactDownload = await getText(
    `/api/workflow-runs/${largeInputDetail.run.id}/artifacts/${runInputRef.id}/download`,
    token,
  );
  if (
    runInputArtifactDownload.status !== 200 ||
    !runInputArtifactDownload.headers
      .get("content-disposition")
      ?.includes(`${runInputRef.id}.json`) ||
    !runInputArtifactDownload.text.includes('"apiKey": "[redacted]"') ||
    runInputArtifactDownload.text.includes("raw-deployed-run-input-key")
  ) {
    throw new Error(
      `spilled run input artifact download returned wrong payload: ${JSON.stringify(
        {
          status: runInputArtifactDownload.status,
          contentDisposition: runInputArtifactDownload.headers.get(
            "content-disposition",
          ),
          text: runInputArtifactDownload.text.slice(0, 200),
        },
      )}`,
    );
  }

  created.runtime.workflowStore.recordArtifact({
    id: `${workflowId}_artifact_output`,
    runId: detail.run.id,
    stepRunId: detail.steps?.find((step) => step.nodeId === "exit")?.id,
    kind: "step_output",
    path: `workflows/${workflowId}/${detail.run.id}/exit-output.json`,
    preview: '{"customer":"cust_trigger"}',
    createdAt: "2026-07-30T02:00:31.000Z",
  });
  const detailWithArtifacts = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with artifacts",
  );
  const artifact = detailWithArtifacts.artifacts?.find(
    (item) => item.id === `${workflowId}_artifact_output`,
  );
  if (
    artifact?.kind !== "step_output" ||
    artifact.path !==
      `workflows/${workflowId}/${detail.run.id}/exit-output.json` ||
    artifact.preview !== '{"customer":"cust_trigger"}'
  ) {
    throw new Error(
      `artifact metadata missing from run detail: ${JSON.stringify(
        detailWithArtifacts.artifacts,
      )}`,
    );
  }
  const exitStep = detail.steps?.find((step) => step.nodeId === "exit");
  if (!exitStep) {
    throw new Error(`exit step missing from manual run detail`);
  }
  created.runtime.workflowStore.recordStepAttempt({
    id: exitStep.id,
    runId: detail.run.id,
    nodeId: exitStep.nodeId,
    attempt: exitStep.attempt,
    status: exitStep.status,
    startedAt: exitStep.startedAt,
    endedAt: exitStep.endedAt,
    durationMs: exitStep.durationMs,
    input: exitStep.input,
    output: {
      records: "x".repeat(70_000),
      apiKey: "raw-deployed-spill-key",
    },
    error: exitStep.error,
    logsSummary: exitStep.logsSummary,
    contextDiff: exitStep.contextDiff,
  });
  const detailWithSpill = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with spilled output",
  );
  const spilledOutput = detailWithSpill.steps?.find(
    (step) => step.nodeId === "exit",
  )?.output?.artifact;
  if (
    spilledOutput?.kind !== "step_output" ||
    !spilledOutput.path?.startsWith(`runs/${detail.run.id}/steps/`) ||
    !spilledOutput.path?.endsWith("/output.json") ||
    !String(spilledOutput.preview).includes('"records"')
  ) {
    throw new Error(
      `spilled output reference missing from run detail: ${JSON.stringify(
        detailWithSpill.steps?.find((step) => step.nodeId === "exit")?.output,
      )}`,
    );
  }
  const spilledArtifact = detailWithSpill.artifacts?.find(
    (item) => item.id === spilledOutput.id,
  );
  if (
    spilledArtifact?.runId !== detail.run.id ||
    spilledArtifact.stepRunId !== exitStep.id ||
    spilledArtifact.path !== spilledOutput.path
  ) {
    throw new Error(
      `spilled output artifact metadata missing: ${JSON.stringify(
        detailWithSpill.artifacts,
      )}`,
    );
  }
  const spilledArtifactPath = join(
    dataDir,
    "workflow-artifacts",
    spilledOutput.path,
  );
  if (!existsSync(spilledArtifactPath)) {
    throw new Error(`spilled output file missing: ${spilledArtifactPath}`);
  }
  const spilledArtifactJson = readFileSync(spilledArtifactPath, "utf8");
  if (
    !spilledArtifactJson.includes('"[redacted]"') ||
    spilledArtifactJson.includes("raw-deployed-spill-key")
  ) {
    throw new Error(`spilled output file was not redacted`);
  }
  const spilledArtifactContent = expectStatus(
    await get(
      `/api/workflow-runs/${detail.run.id}/artifacts/${spilledOutput.id}`,
      token,
    ),
    200,
    "get spilled output artifact content",
  );
  if (
    spilledArtifactContent.artifact?.id !== spilledOutput.id ||
    spilledArtifactContent.artifact?.runId !== detail.run.id ||
    spilledArtifactContent.artifact?.path !== spilledOutput.path ||
    spilledArtifactContent.content?.apiKey !== "[redacted]" ||
    String(JSON.stringify(spilledArtifactContent)).includes(
      "raw-deployed-spill-key",
    )
  ) {
    throw new Error(
      `spilled output artifact content route returned wrong payload: ${JSON.stringify(
        spilledArtifactContent,
      )}`,
    );
  }
  const spilledArtifactDownload = await getText(
    `/api/workflow-runs/${detail.run.id}/artifacts/${spilledOutput.id}/download`,
    token,
  );
  if (
    spilledArtifactDownload.status !== 200 ||
    !spilledArtifactDownload.headers
      .get("content-type")
      ?.includes("application/json") ||
    !spilledArtifactDownload.headers
      .get("content-disposition")
      ?.includes("attachment") ||
    !spilledArtifactDownload.headers
      .get("content-disposition")
      ?.includes(`${spilledOutput.id}.json`) ||
    !spilledArtifactDownload.text.includes('"apiKey": "[redacted]"') ||
    spilledArtifactDownload.text.includes("raw-deployed-spill-key")
  ) {
    throw new Error(
      `spilled output artifact download route returned wrong payload: ${JSON.stringify(
        {
          status: spilledArtifactDownload.status,
          contentType: spilledArtifactDownload.headers.get("content-type"),
          contentDisposition: spilledArtifactDownload.headers.get(
            "content-disposition",
          ),
          text: spilledArtifactDownload.text.slice(0, 200),
        },
      )}`,
    );
  }
  const wrongRunArtifactContent = await get(
    `/api/workflow-runs/run_missing/artifacts/${spilledOutput.id}`,
    token,
  );
  if (
    wrongRunArtifactContent.status !== 404 ||
    wrongRunArtifactContent.payload?.error !== "not_found"
  ) {
    throw new Error(
      `artifact content route exposed missing run: ${JSON.stringify(
        wrongRunArtifactContent,
      )}`,
    );
  }
  const eventPayload = created.runtime.workflowStore.appendRunEvent({
    id: `${workflowId}_event_payload`,
    runId: detail.run.id,
    stepRunId: exitStep.id,
    level: "system",
    kind: "step_output",
    message: "Large deployed event payload",
    payload: {
      records: "x".repeat(70_000),
      apiKey: "raw-deployed-event-key",
    },
    createdAt: "2026-07-30T02:00:32.000Z",
  });
  const eventPayloadRef = eventPayload.payload?.artifact;
  if (
    eventPayloadRef?.kind !== "event_payload" ||
    !eventPayloadRef.path?.startsWith(`runs/${detail.run.id}/events/`) ||
    !eventPayloadRef.path?.endsWith("/payload.json") ||
    !String(eventPayloadRef.preview).includes('"records"')
  ) {
    throw new Error(
      `spilled event payload reference missing from append result: ${JSON.stringify(
        eventPayload.payload,
      )}`,
    );
  }
  const detailWithEventSpill = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with spilled event payload",
  );
  const persistedEventPayloadRef = detailWithEventSpill.events?.find(
    (event) => event.id === eventPayload.id,
  )?.payload?.artifact;
  if (
    persistedEventPayloadRef?.id !== eventPayloadRef.id ||
    persistedEventPayloadRef.path !== eventPayloadRef.path
  ) {
    throw new Error(
      `spilled event payload missing from run detail: ${JSON.stringify(
        detailWithEventSpill.events?.find(
          (event) => event.id === eventPayload.id,
        ),
      )}`,
    );
  }
  const eventPayloadArtifact = detailWithEventSpill.artifacts?.find(
    (item) => item.id === eventPayloadRef.id,
  );
  if (
    eventPayloadArtifact?.runId !== detail.run.id ||
    eventPayloadArtifact.stepRunId !== exitStep.id ||
    eventPayloadArtifact.kind !== "event_payload"
  ) {
    throw new Error(
      `spilled event artifact metadata missing: ${JSON.stringify(
        detailWithEventSpill.artifacts,
      )}`,
    );
  }
  const eventPayloadArtifactPath = join(
    dataDir,
    "workflow-artifacts",
    eventPayloadRef.path,
  );
  if (!existsSync(eventPayloadArtifactPath)) {
    throw new Error(
      `spilled event payload file missing: ${eventPayloadArtifactPath}`,
    );
  }
  const eventPayloadJson = readFileSync(eventPayloadArtifactPath, "utf8");
  if (
    !eventPayloadJson.includes('"[redacted]"') ||
    eventPayloadJson.includes("raw-deployed-event-key")
  ) {
    throw new Error(`spilled event payload file was not redacted`);
  }
  created.runtime.workflowStore.recordStepAttempt({
    id: exitStep.id,
    runId: detail.run.id,
    nodeId: exitStep.nodeId,
    attempt: exitStep.attempt,
    status: exitStep.status,
    startedAt: exitStep.startedAt,
    endedAt: exitStep.endedAt,
    durationMs: exitStep.durationMs,
    input: exitStep.input,
    output: exitStep.output,
    error: {
      name: "Error",
      message: "Large deployed step error",
      details: {
        records: "x".repeat(70_000),
        apiKey: "raw-deployed-error-key",
      },
    },
    logsSummary: exitStep.logsSummary,
    contextDiff: exitStep.contextDiff,
  });
  const detailWithErrorSpill = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with spilled step error",
  );
  const errorRef = detailWithErrorSpill.steps?.find(
    (step) => step.nodeId === "exit",
  )?.error?.artifact;
  if (
    errorRef?.kind !== "step_error" ||
    !errorRef.path?.startsWith(`runs/${detail.run.id}/steps/`) ||
    !errorRef.path?.endsWith("/error.json") ||
    !String(errorRef.preview).includes("Large deployed step error")
  ) {
    throw new Error(
      `spilled error reference missing from run detail: ${JSON.stringify(
        detailWithErrorSpill.steps?.find((step) => step.nodeId === "exit")
          ?.error,
      )}`,
    );
  }
  const errorArtifact = detailWithErrorSpill.artifacts?.find(
    (item) => item.id === errorRef.id,
  );
  if (
    errorArtifact?.runId !== detail.run.id ||
    errorArtifact.stepRunId !== exitStep.id ||
    errorArtifact.kind !== "step_error"
  ) {
    throw new Error(
      `spilled error artifact metadata missing: ${JSON.stringify(
        detailWithErrorSpill.artifacts,
      )}`,
    );
  }
  const errorArtifactPath = join(dataDir, "workflow-artifacts", errorRef.path);
  if (!existsSync(errorArtifactPath)) {
    throw new Error(`spilled error file missing: ${errorArtifactPath}`);
  }
  const errorArtifactJson = readFileSync(errorArtifactPath, "utf8");
  if (
    !errorArtifactJson.includes('"[redacted]"') ||
    errorArtifactJson.includes("raw-deployed-error-key")
  ) {
    throw new Error(`spilled error file was not redacted`);
  }
  const errorSpillStep = detailWithErrorSpill.steps?.find(
    (step) => step.nodeId === "exit",
  );
  created.runtime.workflowStore.recordStepAttempt({
    id: exitStep.id,
    runId: detail.run.id,
    nodeId: exitStep.nodeId,
    attempt: exitStep.attempt,
    status: exitStep.status,
    startedAt: exitStep.startedAt,
    endedAt: exitStep.endedAt,
    durationMs: exitStep.durationMs,
    input: errorSpillStep?.input,
    output: errorSpillStep?.output,
    error: errorSpillStep?.error,
    logsSummary: {
      lines: ["Large deployed step logs summary", "x".repeat(70_000)],
      apiKey: "raw-deployed-logs-key",
    },
    contextDiff: exitStep.contextDiff,
  });
  const detailWithLogsSpill = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with spilled step logs summary",
  );
  const logsRef = detailWithLogsSpill.steps?.find(
    (step) => step.nodeId === "exit",
  )?.logsSummary?.artifact;
  if (
    logsRef?.kind !== "step_logs_summary" ||
    !logsRef.path?.startsWith(`runs/${detail.run.id}/steps/`) ||
    !logsRef.path?.endsWith("/logs-summary.json") ||
    !String(logsRef.preview).includes("Large deployed step logs summary")
  ) {
    throw new Error(
      `spilled logs summary reference missing from run detail: ${JSON.stringify(
        detailWithLogsSpill.steps?.find((step) => step.nodeId === "exit")
          ?.logsSummary,
      )}`,
    );
  }
  const logsArtifact = detailWithLogsSpill.artifacts?.find(
    (item) => item.id === logsRef.id,
  );
  if (
    logsArtifact?.runId !== detail.run.id ||
    logsArtifact.stepRunId !== exitStep.id ||
    logsArtifact.kind !== "step_logs_summary"
  ) {
    throw new Error(
      `spilled logs summary artifact metadata missing: ${JSON.stringify(
        detailWithLogsSpill.artifacts,
      )}`,
    );
  }
  const logsArtifactPath = join(dataDir, "workflow-artifacts", logsRef.path);
  if (!existsSync(logsArtifactPath)) {
    throw new Error(`spilled logs summary file missing: ${logsArtifactPath}`);
  }
  const logsArtifactJson = readFileSync(logsArtifactPath, "utf8");
  if (
    !logsArtifactJson.includes('"[redacted]"') ||
    logsArtifactJson.includes("raw-deployed-logs-key")
  ) {
    throw new Error(`spilled logs summary file was not redacted`);
  }
  const logsSpillStep = detailWithLogsSpill.steps?.find(
    (step) => step.nodeId === "exit",
  );
  created.runtime.workflowStore.recordStepAttempt({
    id: exitStep.id,
    runId: detail.run.id,
    nodeId: exitStep.nodeId,
    attempt: exitStep.attempt,
    status: exitStep.status,
    startedAt: exitStep.startedAt,
    endedAt: exitStep.endedAt,
    durationMs: exitStep.durationMs,
    input: logsSpillStep?.input,
    output: logsSpillStep?.output,
    error: logsSpillStep?.error,
    logsSummary: logsSpillStep?.logsSummary,
    contextDiff: {
      deployedContextDiff: {
        before: null,
        after: {
          id: "cust_context_diff_deployed",
          records: "x".repeat(70_000),
          apiKey: "raw-deployed-context-diff-key",
        },
      },
    },
  });
  const detailWithContextDiffSpill = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with spilled step context diff",
  );
  const contextDiffRef = detailWithContextDiffSpill.steps?.find(
    (step) => step.nodeId === "exit",
  )?.contextDiff?.artifact;
  if (
    contextDiffRef?.kind !== "step_context_diff" ||
    !contextDiffRef.path?.startsWith(`runs/${detail.run.id}/steps/`) ||
    !contextDiffRef.path?.endsWith("/context-diff.json") ||
    !String(contextDiffRef.preview).includes("cust_context_diff_deployed")
  ) {
    throw new Error(
      `spilled context diff reference missing from run detail: ${JSON.stringify(
        detailWithContextDiffSpill.steps?.find((step) => step.nodeId === "exit")
          ?.contextDiff,
      )}`,
    );
  }
  const contextDiffArtifact = detailWithContextDiffSpill.artifacts?.find(
    (item) => item.id === contextDiffRef.id,
  );
  if (
    contextDiffArtifact?.runId !== detail.run.id ||
    contextDiffArtifact.stepRunId !== exitStep.id ||
    contextDiffArtifact.kind !== "step_context_diff" ||
    contextDiffArtifact.path !== contextDiffRef.path
  ) {
    throw new Error(
      `spilled context diff artifact metadata missing: ${JSON.stringify(
        detailWithContextDiffSpill.artifacts,
      )}`,
    );
  }
  const contextDiffArtifactPath = join(
    dataDir,
    "workflow-artifacts",
    contextDiffRef.path,
  );
  if (!existsSync(contextDiffArtifactPath)) {
    throw new Error(
      `spilled context diff file missing: ${contextDiffArtifactPath}`,
    );
  }
  const contextDiffArtifactJson = readFileSync(contextDiffArtifactPath, "utf8");
  if (
    !contextDiffArtifactJson.includes('"[redacted]"') ||
    contextDiffArtifactJson.includes("raw-deployed-context-diff-key")
  ) {
    throw new Error(`spilled context diff file was not redacted`);
  }
  const contextDiffArtifactContent = expectStatus(
    await get(
      `/api/workflow-runs/${detail.run.id}/artifacts/${contextDiffRef.id}`,
      token,
    ),
    200,
    "get spilled context diff artifact content",
  );
  if (
    contextDiffArtifactContent.artifact?.id !== contextDiffRef.id ||
    contextDiffArtifactContent.artifact?.runId !== detail.run.id ||
    contextDiffArtifactContent.artifact?.path !== contextDiffRef.path ||
    contextDiffArtifactContent.content?.deployedContextDiff?.after?.apiKey !==
      "[redacted]" ||
    String(JSON.stringify(contextDiffArtifactContent)).includes(
      "raw-deployed-context-diff-key",
    )
  ) {
    throw new Error(
      `spilled context diff artifact content route returned wrong payload: ${JSON.stringify(
        contextDiffArtifactContent,
      )}`,
    );
  }
  const contextDiffArtifactDownload = await getText(
    `/api/workflow-runs/${detail.run.id}/artifacts/${contextDiffRef.id}/download`,
    token,
  );
  if (
    contextDiffArtifactDownload.status !== 200 ||
    !contextDiffArtifactDownload.headers
      .get("content-type")
      ?.includes("application/json") ||
    !contextDiffArtifactDownload.headers
      .get("content-disposition")
      ?.includes("attachment") ||
    !contextDiffArtifactDownload.headers
      .get("content-disposition")
      ?.includes(`${contextDiffRef.id}.json`) ||
    !contextDiffArtifactDownload.text.includes('"apiKey": "[redacted]"') ||
    contextDiffArtifactDownload.text.includes("raw-deployed-context-diff-key")
  ) {
    throw new Error(
      `spilled context diff artifact download route returned wrong payload: ${JSON.stringify(
        {
          status: contextDiffArtifactDownload.status,
          contentType: contextDiffArtifactDownload.headers.get("content-type"),
          contentDisposition: contextDiffArtifactDownload.headers.get(
            "content-disposition",
          ),
          text: contextDiffArtifactDownload.text.slice(0, 200),
        },
      )}`,
    );
  }
  created.runtime.workflowStore.updateRunState(detail.run.id, {
    status: detail.run.status,
    context: {
      deployedContext: {
        customerId: "cust_trigger",
        records: "x".repeat(70_000),
        apiKey: "raw-deployed-context-key",
      },
    },
    currentNodeId: detail.run.currentNodeId,
    waitingReason: detail.run.waitingReason,
    startedAt: detail.run.startedAt,
    endedAt: detail.run.endedAt,
  });
  const detailWithContextSpill = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail with spilled final context",
  );
  const contextRef = detailWithContextSpill.run?.context?.artifact;
  if (
    contextRef?.kind !== "run_context" ||
    contextRef.path !== `runs/${detail.run.id}/context.json` ||
    !String(contextRef.preview).includes('"deployedContext"')
  ) {
    throw new Error(
      `spilled final context reference missing from run detail: ${JSON.stringify(
        detailWithContextSpill.run?.context,
      )}`,
    );
  }
  const contextArtifact = detailWithContextSpill.artifacts?.find(
    (item) => item.id === contextRef.id,
  );
  if (
    contextArtifact?.runId !== detail.run.id ||
    contextArtifact.stepRunId !== null ||
    contextArtifact.kind !== "run_context"
  ) {
    throw new Error(
      `spilled final context artifact metadata missing: ${JSON.stringify(
        detailWithContextSpill.artifacts,
      )}`,
    );
  }
  const contextArtifactPath = join(
    dataDir,
    "workflow-artifacts",
    contextRef.path,
  );
  if (!existsSync(contextArtifactPath)) {
    throw new Error(
      `spilled final context file missing: ${contextArtifactPath}`,
    );
  }
  const contextArtifactJson = readFileSync(contextArtifactPath, "utf8");
  if (
    !contextArtifactJson.includes('"[redacted]"') ||
    contextArtifactJson.includes("raw-deployed-context-key")
  ) {
    throw new Error(`spilled final context file was not redacted`);
  }
  const retentionEvent = created.runtime.workflowStore.appendRunEvent({
    id: `${workflowId}_retention_payload`,
    runId: detail.run.id,
    stepRunId: exitStep.id,
    level: "system",
    kind: "step_output",
    message: "Retention old deployed payload",
    payload: {
      records: "x".repeat(70_000),
      apiKey: "raw-deployed-retention-key",
    },
    createdAt: "2026-07-30T00:00:01.000Z",
  });
  const retentionRef = retentionEvent.payload?.artifact;
  if (
    retentionRef?.kind !== "event_payload" ||
    !retentionRef.path?.startsWith(`runs/${detail.run.id}/events/`) ||
    !retentionRef.path?.endsWith("/payload.json")
  ) {
    throw new Error(
      `retention artifact reference missing: ${JSON.stringify(
        retentionEvent.payload,
      )}`,
    );
  }
  const retentionArtifactPath = join(
    dataDir,
    "workflow-artifacts",
    retentionRef.path,
  );
  if (!existsSync(retentionArtifactPath)) {
    throw new Error(
      `retention artifact file missing before prune: ${retentionArtifactPath}`,
    );
  }
  const retentionBeforePrune = expectStatus(
    await get(
      `/api/workflow-runs/${detail.run.id}/artifacts/${retentionRef.id}`,
      token,
    ),
    200,
    "get retention artifact content before prune",
  );
  if (
    retentionBeforePrune.content?.apiKey !== "[redacted]" ||
    JSON.stringify(retentionBeforePrune).includes("raw-deployed-retention-key")
  ) {
    throw new Error(
      `retention artifact content was not redacted before prune: ${JSON.stringify(
        retentionBeforePrune,
      )}`,
    );
  }
  const pruneResult = expectStatus(
    await post("/api/workflow-artifacts/prune", token, {
      createdBefore: "2026-07-30T00:00:02.000Z",
    }),
    200,
    "prune deployed workflow artifacts through HTTP",
  );
  if (
    pruneResult.scannedArtifacts < 1 ||
    pruneResult.deletedFiles < 1 ||
    existsSync(retentionArtifactPath)
  ) {
    throw new Error(
      `artifact retention prune failed: ${JSON.stringify({
        pruneResult,
        retentionArtifactPath,
        exists: existsSync(retentionArtifactPath),
      })}`,
    );
  }
  const detailAfterPrune = expectStatus(
    await get(`/api/workflow-runs/${detail.run.id}`, token),
    200,
    "get manual trigger run detail after artifact prune",
  );
  if (
    !detailAfterPrune.artifacts?.some(
      (item) => item.id === retentionRef.id && item.path === retentionRef.path,
    )
  ) {
    throw new Error(
      `retention prune removed artifact metadata: ${JSON.stringify(
        detailAfterPrune.artifacts,
      )}`,
    );
  }
  const retentionAfterPrune = await get(
    `/api/workflow-runs/${detail.run.id}/artifacts/${retentionRef.id}`,
    token,
  );
  if (
    retentionAfterPrune.status !== 404 ||
    retentionAfterPrune.payload?.error !== "artifact_not_found"
  ) {
    throw new Error(
      `retention artifact content still readable after prune: ${JSON.stringify(
        retentionAfterPrune,
      )}`,
    );
  }
  const retentionDownloadAfterPrune = await get(
    `/api/workflow-runs/${detail.run.id}/artifacts/${retentionRef.id}/download`,
    token,
  );
  if (
    retentionDownloadAfterPrune.status !== 404 ||
    retentionDownloadAfterPrune.payload?.error !== "artifact_not_found"
  ) {
    throw new Error(
      `retention artifact download still readable after prune: ${JSON.stringify(
        retentionDownloadAfterPrune,
      )}`,
    );
  }
  if (detail.run?.trigger?.triggerId !== "manual_review") {
    throw new Error(
      `trigger snapshot missing: ${JSON.stringify(detail.run?.trigger)}`,
    );
  }
  assertEventTimeline(detail, "manual trigger run");

  const webhookDetail = expectStatus(
    await post(
      `/api/workflows/${workflowId}/triggers/incoming_customer/runs`,
      token,
      {
        input: {
          source: "crm",
          triggerId: "manual_review",
          customer: { id: "cust_webhook", name: "Webhook Lin" },
        },
      },
      { "x-openacme-webhook-request-id": "req_deployed_webhook_1" },
    ),
    201,
    "run webhook trigger",
  );
  if (
    webhookDetail.run?.status !== "succeeded" ||
    webhookDetail.run?.trigger?.kind !== "webhook" ||
    webhookDetail.run?.trigger?.triggerId !== "incoming_customer" ||
    webhookDetail.run?.trigger?.requestId !== "req_deployed_webhook_1"
  ) {
    throw new Error(
      `webhook trigger run failed: ${JSON.stringify(webhookDetail.run)}`,
    );
  }
  assertEventTimeline(webhookDetail, "webhook trigger run");

  const invalidAuthenticatedTriggerId = await post(
    `/api/workflows/${workflowId}/triggers/incoming:customer/runs`,
    token,
    {
      input: {
        source: "crm",
        customer: { id: "cust_invalid_trigger_id", name: "Invalid" },
      },
    },
  );
  if (
    invalidAuthenticatedTriggerId.status !== 400 ||
    invalidAuthenticatedTriggerId.payload?.error !== "invalid triggerId"
  ) {
    throw new Error(
      `authenticated trigger route returned wrong unsafe trigger id error: ${JSON.stringify(invalidAuthenticatedTriggerId)}`,
    );
  }

  const publicRejected = await publicPost(
    `/api/workflow-webhooks/${workflowId}/incoming_customer`,
    {
      source: "crm",
      customer: { id: "cust_public_blocked", name: "Blocked" },
    },
    { "x-openacme-webhook-secret": "wrong" },
  );
  if (
    publicRejected.status !== 401 ||
    publicRejected.payload?.error !== "webhook_secret_invalid"
  ) {
    throw new Error(
      `public webhook accepted wrong secret: ${JSON.stringify(publicRejected)}`,
    );
  }

  const publicInvalidTriggerInput = await publicPost(
    `/api/workflow-webhooks/${workflowId}/incoming_customer`,
    {
      source: "manual",
      customer: { id: "cust_public_invalid", name: "Invalid Public" },
    },
    { "x-openacme-webhook-secret": publicWebhookSecret },
  );
  if (
    publicInvalidTriggerInput.status !== 400 ||
    publicInvalidTriggerInput.payload?.error !==
      'Trigger input does not match schema: $.source must equal "crm"'
  ) {
    throw new Error(
      `public webhook accepted invalid trigger input: ${JSON.stringify(publicInvalidTriggerInput)}`,
    );
  }

  const invalidPublicTriggerId = await publicPost(
    `/api/workflow-webhooks/${workflowId}/incoming:customer`,
    {
      source: "crm",
      customer: { id: "cust_invalid_public_trigger_id", name: "Invalid" },
    },
    { "x-openacme-webhook-secret": publicWebhookSecret },
  );
  if (
    invalidPublicTriggerId.status !== 400 ||
    invalidPublicTriggerId.payload?.error !== "invalid triggerId"
  ) {
    throw new Error(
      `public webhook route returned wrong unsafe trigger id error: ${JSON.stringify(invalidPublicTriggerId)}`,
    );
  }

  const publicDetail = expectStatus(
    await publicPost(
      `/api/workflow-webhooks/${workflowId}/incoming_customer`,
      {
        source: "crm",
        triggerId: "manual_review",
        customer: { id: "cust_public_webhook", name: "Public Webhook Lin" },
      },
      {
        "x-openacme-webhook-secret": publicWebhookSecret,
        "x-openacme-webhook-request-id": "req_public_webhook_1",
      },
    ),
    201,
    "run public webhook trigger",
  );
  if (
    publicDetail.run?.status !== "succeeded" ||
    publicDetail.run?.trigger?.kind !== "webhook" ||
    publicDetail.run?.trigger?.triggerId !== "incoming_customer" ||
    publicDetail.run?.trigger?.requestId !== "req_public_webhook_1"
  ) {
    throw new Error(
      `public webhook trigger run failed: ${JSON.stringify(publicDetail.run)}`,
    );
  }
  assertEventTimeline(publicDetail, "public webhook trigger run");

  const publicPathDetail = expectStatus(
    await publicPost(
      `/api/workflow-webhooks/${workflowId}/by-path/crm/customer`,
      {
        source: "crm",
        triggerId: "manual_review",
        customer: {
          id: "cust_public_webhook_path",
          name: "Public Webhook Path Lin",
        },
      },
      {
        "x-openacme-webhook-secret": publicWebhookSecret,
        "x-openacme-webhook-request-id": "req_public_webhook_path_1",
      },
    ),
    201,
    "run public webhook path trigger",
  );
  if (
    publicPathDetail.run?.status !== "succeeded" ||
    publicPathDetail.run?.trigger?.kind !== "webhook" ||
    publicPathDetail.run?.trigger?.triggerId !== "incoming_customer" ||
    publicPathDetail.run?.trigger?.requestId !== "req_public_webhook_path_1"
  ) {
    throw new Error(
      `public webhook path trigger run failed: ${JSON.stringify(publicPathDetail.run)}`,
    );
  }

  const publicPathInvalidTriggerInput = await publicPost(
    `/api/workflow-webhooks/${workflowId}/by-path/crm/customer`,
    {
      source: "manual",
      customer: { id: "cust_public_path_invalid", name: "Invalid Path" },
    },
    { "x-openacme-webhook-secret": publicWebhookSecret },
  );
  if (
    publicPathInvalidTriggerInput.status !== 400 ||
    publicPathInvalidTriggerInput.payload?.error !==
      'Trigger input does not match schema: $.source must equal "crm"'
  ) {
    throw new Error(
      `public webhook path accepted invalid trigger input: ${JSON.stringify(publicPathInvalidTriggerInput)}`,
    );
  }

  const publicPathMissing = await publicPost(
    `/api/workflow-webhooks/${workflowId}/by-path/crm/missing`,
    {
      source: "crm",
      customer: { id: "cust_public_missing", name: "Missing" },
    },
    { "x-openacme-webhook-secret": publicWebhookSecret },
  );
  if (
    publicPathMissing.status !== 404 ||
    publicPathMissing.payload?.error !== "trigger_not_found"
  ) {
    throw new Error(
      `public webhook path matched missing trigger: ${JSON.stringify(publicPathMissing)}`,
    );
  }

  const invalidWebhook = await post(
    `/api/workflows/${workflowId}/triggers/incoming_customer/runs`,
    token,
    {
      input: {
        source: "manual",
        customer: { id: "blocked", name: "Blocked" },
      },
    },
  );
  if (
    invalidWebhook.status !== 400 ||
    !String(invalidWebhook.payload?.error ?? "").includes("Trigger input")
  ) {
    throw new Error(
      `invalid webhook input was not rejected: ${JSON.stringify(invalidWebhook)}`,
    );
  }

  const disabled = await post(
    `/api/workflows/${workflowId}/triggers/disabled_nightly/runs`,
    token,
    { input: { customer: { id: "blocked" } } },
  );
  if (
    disabled.status !== 409 ||
    disabled.payload?.error !== "trigger_kind_not_runnable"
  ) {
    throw new Error(
      `disabled trigger was not rejected: ${JSON.stringify(disabled)}`,
    );
  }

  const scheduledDirect = await post(
    `/api/workflows/${workflowId}/triggers/nightly/runs`,
    token,
    { input: {} },
  );
  if (
    scheduledDirect.status !== 409 ||
    scheduledDirect.payload?.error !== "trigger_kind_not_runnable"
  ) {
    throw new Error(
      `scheduled trigger was directly runnable: ${JSON.stringify(scheduledDirect)}`,
    );
  }

  await created.runtime.startWorkflowDispatcher();
  const scheduledDetail = await waitFor(async () => {
    const latestRuns = expectStatus(
      await get(`/api/workflows/${workflowId}/runs`, token),
      200,
      "list workflow runs waiting for scheduled dispatcher",
    );
    return latestRuns.runs?.find(
      (run) =>
        run.trigger?.kind === "scheduled" &&
        run.trigger?.triggerId === "nightly",
    );
  });
  if (
    scheduledDetail?.status !== "succeeded" ||
    scheduledDetail?.trigger?.kind !== "scheduled" ||
    scheduledDetail?.trigger?.triggerId !== "nightly" ||
    scheduledDetail?.trigger?.scheduledAt !== "2026-07-30T02:00:00.000Z"
  ) {
    throw new Error(
      `scheduled dispatcher poll failed: ${JSON.stringify(scheduledDetail)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 80));

  const duplicateScheduledScan =
    await created.runtime.dispatchDueScheduledWorkflowTriggers({
      now: new Date("2026-07-30T02:00:45.000Z"),
    });
  if (
    duplicateScheduledScan.dispatched?.length !== 0 ||
    !duplicateScheduledScan.skipped?.some(
      (item) =>
        item.triggerId === "nightly" && item.reason === "already_dispatched",
    ) ||
    !duplicateScheduledScan.skipped?.some(
      (item) =>
        item.triggerId === "invalid_nightly" &&
        item.reason === "execution_failed" &&
        item.error ===
          "Input does not match schema: $.customer.name is required",
    )
  ) {
    throw new Error(
      `scheduled dispatcher created a duplicate run: ${JSON.stringify(duplicateScheduledScan)}`,
    );
  }

  const runs = expectStatus(
    await get(`/api/workflows/${workflowId}/runs`, token),
    200,
    "list workflow runs",
  );
  const runIds = runs.runs?.map((run) => run.id).sort() ?? [];
  const expectedRunIds = [
    detail.run.id,
    webhookDetail.run.id,
    publicDetail.run.id,
    publicPathDetail.run.id,
    scheduledDetail.id,
  ].sort();
  if (JSON.stringify(runIds) !== JSON.stringify(expectedRunIds)) {
    throw new Error(
      `disabled or invalid trigger changed run list: ${JSON.stringify(runs)}`,
    );
  }

  const manualReviewPage = expectStatus(
    await get(
      `/api/workflows/${workflowId}/runs?triggerId=manual_review&limit=1`,
      token,
    ),
    200,
    "list manual_review trigger runs",
  );
  const manualReviewIds =
    manualReviewPage.runs?.map((run) => [run.id, run.trigger?.triggerId]) ?? [];
  if (
    JSON.stringify(manualReviewIds) !==
      JSON.stringify([[detail.run.id, "manual_review"]]) ||
    manualReviewPage.hasMore !== false ||
    manualReviewPage.nextOffset !== null
  ) {
    throw new Error(
      `triggerId pagination matched nested input trigger ids: ${JSON.stringify(manualReviewPage)}`,
    );
  }

  const invalidGlobalMode = await get("/api/workflow-runs?mode=preview", token);
  if (
    invalidGlobalMode.status !== 400 ||
    invalidGlobalMode.payload?.error !== "invalid mode"
  ) {
    throw new Error(
      `invalid global run mode filter was accepted: ${JSON.stringify(invalidGlobalMode)}`,
    );
  }

  const invalidGlobalModeDuplicate = await get(
    "/api/workflow-runs?mode=test&mode=live",
    token,
  );
  if (
    invalidGlobalModeDuplicate.status !== 400 ||
    invalidGlobalModeDuplicate.payload?.error !== "invalid mode"
  ) {
    throw new Error(
      `duplicate global run mode filter was accepted: ${JSON.stringify(invalidGlobalModeDuplicate)}`,
    );
  }

  const invalidGlobalWorkflowId = await get(
    "/api/workflow-runs?workflowId=bad/id",
    token,
  );
  if (
    invalidGlobalWorkflowId.status !== 400 ||
    invalidGlobalWorkflowId.payload?.error !== "invalid workflowId"
  ) {
    throw new Error(
      `invalid global run workflowId filter was accepted: ${JSON.stringify(invalidGlobalWorkflowId)}`,
    );
  }

  const invalidScopedWorkflowId = await get(
    "/api/workflows/bad:id/runs",
    token,
  );
  if (
    invalidScopedWorkflowId.status !== 400 ||
    invalidScopedWorkflowId.payload?.error !== "invalid workflowId"
  ) {
    throw new Error(
      `invalid scoped run workflowId filter returned wrong error: ${JSON.stringify(invalidScopedWorkflowId)}`,
    );
  }

  const invalidGlobalWorkflowIdDuplicate = await get(
    "/api/workflow-runs?workflowId=wf_one&workflowId=wf_two",
    token,
  );
  if (
    invalidGlobalWorkflowIdDuplicate.status !== 400 ||
    invalidGlobalWorkflowIdDuplicate.payload?.error !== "invalid workflowId"
  ) {
    throw new Error(
      `duplicate global run workflowId filter was accepted: ${JSON.stringify(invalidGlobalWorkflowIdDuplicate)}`,
    );
  }

  const invalidGlobalCreatedFrom = await get(
    "/api/workflow-runs?createdFrom=2026-02-31",
    token,
  );
  if (
    invalidGlobalCreatedFrom.status !== 400 ||
    invalidGlobalCreatedFrom.payload?.error !== "invalid createdFrom"
  ) {
    throw new Error(
      `invalid global run createdFrom filter was accepted: ${JSON.stringify(invalidGlobalCreatedFrom)}`,
    );
  }

  const invalidWorkflowCreatedTo = await get(
    `/api/workflows/${workflowId}/runs?createdTo=2026-02-31T00:00:00Z`,
    token,
  );
  if (
    invalidWorkflowCreatedTo.status !== 400 ||
    invalidWorkflowCreatedTo.payload?.error !== "invalid createdTo"
  ) {
    throw new Error(
      `invalid workflow run createdTo filter was accepted: ${JSON.stringify(invalidWorkflowCreatedTo)}`,
    );
  }

  const validOffsetCreatedFrom = await get(
    "/api/workflow-runs?createdFrom=2026-02-28T23:30:00-02:00",
    token,
  );
  if (validOffsetCreatedFrom.status !== 200) {
    throw new Error(
      `valid offset createdFrom filter was rejected: ${JSON.stringify(validOffsetCreatedFrom)}`,
    );
  }

  const invalidGlobalCreatedFromSeparator = await get(
    `/api/workflow-runs?createdFrom=${encodeURIComponent("2026-02-28 23:30:00")}`,
    token,
  );
  if (
    invalidGlobalCreatedFromSeparator.status !== 400 ||
    invalidGlobalCreatedFromSeparator.payload?.error !== "invalid createdFrom"
  ) {
    throw new Error(
      `invalid global run createdFrom separator was accepted: ${JSON.stringify(invalidGlobalCreatedFromSeparator)}`,
    );
  }

  const invalidGlobalDateRange = await get(
    "/api/workflow-runs?createdFrom=2030-01-02&createdTo=2030-01-01",
    token,
  );
  if (
    invalidGlobalDateRange.status !== 400 ||
    invalidGlobalDateRange.payload?.error !== "invalid date range"
  ) {
    throw new Error(
      `invalid global run date range was accepted: ${JSON.stringify(invalidGlobalDateRange)}`,
    );
  }

  const invalidDefinitionLimit = await get("/api/workflows?limit=abc", token);
  if (
    invalidDefinitionLimit.status !== 400 ||
    invalidDefinitionLimit.payload?.error !== "invalid limit"
  ) {
    throw new Error(
      `invalid workflow definition limit was accepted: ${JSON.stringify(invalidDefinitionLimit)}`,
    );
  }

  const invalidDefinitionStatusDuplicate = await get(
    "/api/workflows?status=draft&status=published",
    token,
  );
  if (
    invalidDefinitionStatusDuplicate.status !== 400 ||
    invalidDefinitionStatusDuplicate.payload?.error !== "invalid status"
  ) {
    throw new Error(
      `duplicate workflow definition status was accepted: ${JSON.stringify(invalidDefinitionStatusDuplicate)}`,
    );
  }

  const invalidGlobalRunLimit = await get(
    "/api/workflow-runs?limit=abc",
    token,
  );
  if (
    invalidGlobalRunLimit.status !== 400 ||
    invalidGlobalRunLimit.payload?.error !== "invalid limit"
  ) {
    throw new Error(
      `invalid global run limit was accepted: ${JSON.stringify(invalidGlobalRunLimit)}`,
    );
  }

  const invalidGlobalRunLimitRange = await get(
    "/api/workflow-runs?limit=0",
    token,
  );
  if (
    invalidGlobalRunLimitRange.status !== 400 ||
    invalidGlobalRunLimitRange.payload?.error !== "invalid limit"
  ) {
    throw new Error(
      `out-of-range global run limit was accepted: ${JSON.stringify(invalidGlobalRunLimitRange)}`,
    );
  }

  const invalidGlobalRunLimitDuplicate = await get(
    "/api/workflow-runs?limit=1&limit=2",
    token,
  );
  if (
    invalidGlobalRunLimitDuplicate.status !== 400 ||
    invalidGlobalRunLimitDuplicate.payload?.error !== "invalid limit"
  ) {
    throw new Error(
      `duplicate global run limit was accepted: ${JSON.stringify(invalidGlobalRunLimitDuplicate)}`,
    );
  }

  const invalidWorkflowRunOffset = await get(
    `/api/workflows/${workflowId}/runs?offset=1abc`,
    token,
  );
  if (
    invalidWorkflowRunOffset.status !== 400 ||
    invalidWorkflowRunOffset.payload?.error !== "invalid offset"
  ) {
    throw new Error(
      `invalid workflow run offset was accepted: ${JSON.stringify(invalidWorkflowRunOffset)}`,
    );
  }

  const invalidWorkflowRunOffsetRange = await get(
    `/api/workflows/${workflowId}/runs?offset=-1`,
    token,
  );
  if (
    invalidWorkflowRunOffsetRange.status !== 400 ||
    invalidWorkflowRunOffsetRange.payload?.error !== "invalid offset"
  ) {
    throw new Error(
      `out-of-range workflow run offset was accepted: ${JSON.stringify(invalidWorkflowRunOffsetRange)}`,
    );
  }

  const invalidWorkflowRunOffsetDuplicate = await get(
    `/api/workflows/${workflowId}/runs?offset=0&offset=1`,
    token,
  );
  if (
    invalidWorkflowRunOffsetDuplicate.status !== 400 ||
    invalidWorkflowRunOffsetDuplicate.payload?.error !== "invalid offset"
  ) {
    throw new Error(
      `duplicate workflow run offset was accepted: ${JSON.stringify(invalidWorkflowRunOffsetDuplicate)}`,
    );
  }

  const invalidWorkflowStatus = await get(
    `/api/workflows/${workflowId}/runs?status=complete`,
    token,
  );
  if (
    invalidWorkflowStatus.status !== 400 ||
    invalidWorkflowStatus.payload?.error !== "invalid status"
  ) {
    throw new Error(
      `invalid workflow run status filter was accepted: ${JSON.stringify(invalidWorkflowStatus)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workflowId,
        runId: detail.run.id,
        runInputSpillWorkflowId: inputSpillWorkflowId,
        runInputSpillRunId: largeInputDetail.run.id,
        webhookRunId: webhookDetail.run.id,
        publicWebhookRunId: publicDetail.run.id,
        publicWebhookPathRunId: publicPathDetail.run.id,
        scheduledRunId: scheduledDetail.id,
        trigger: detail.run.trigger,
        webhookTrigger: webhookDetail.run.trigger,
        publicWebhookTrigger: publicDetail.run.trigger,
        publicWebhookPathTrigger: publicPathDetail.run.trigger,
        scheduledTrigger: scheduledDetail.trigger,
        artifactPruneResult: pruneResult,
        duplicateScheduledScan: {
          scheduledAt: duplicateScheduledScan.scheduledAt,
          dispatched: duplicateScheduledScan.dispatched.length,
          skipped: duplicateScheduledScan.skipped,
        },
        manualReviewPage,
        invalidFilters: {
          globalMode: invalidGlobalMode.payload,
          globalModeDuplicate: invalidGlobalModeDuplicate.payload,
          globalWorkflowId: invalidGlobalWorkflowId.payload,
          scopedWorkflowId: invalidScopedWorkflowId.payload,
          globalWorkflowIdDuplicate: invalidGlobalWorkflowIdDuplicate.payload,
          globalCreatedFrom: invalidGlobalCreatedFrom.payload,
          globalCreatedFromSeparator: invalidGlobalCreatedFromSeparator.payload,
          globalDateRange: invalidGlobalDateRange.payload,
          workflowCreatedTo: invalidWorkflowCreatedTo.payload,
          workflowStatus: invalidWorkflowStatus.payload,
        },
        validFilters: {
          offsetCreatedFrom: {
            status: validOffsetCreatedFrom.status,
            runCount: validOffsetCreatedFrom.payload?.runs?.length ?? 0,
          },
        },
        invalidPagination: {
          definitionLimit: invalidDefinitionLimit.payload,
          definitionStatusDuplicate: invalidDefinitionStatusDuplicate.payload,
          globalRunLimit: invalidGlobalRunLimit.payload,
          globalRunLimitRange: invalidGlobalRunLimitRange.payload,
          globalRunLimitDuplicate: invalidGlobalRunLimitDuplicate.payload,
          workflowRunOffset: invalidWorkflowRunOffset.payload,
          workflowRunOffsetRange: invalidWorkflowRunOffsetRange.payload,
          workflowRunOffsetDuplicate: invalidWorkflowRunOffsetDuplicate.payload,
        },
        invalidRunBodies: {
          draftTestVersion: invalidDraftTestVersion.payload,
        },
        invalidDefinitionIds: {
          workflow: invalidWorkflowId.payload,
          node: invalidUnsafeNodeId.payload,
          trigger: invalidUnsafeTriggerId.payload,
          authenticatedTriggerRoute: invalidAuthenticatedTriggerId.payload,
          publicTriggerRoute: invalidPublicTriggerId.payload,
        },
        runCount: runs.runs.length,
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
