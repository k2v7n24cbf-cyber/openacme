import { randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { loadConfig } from "@openacme/config";
import { buildHostedIntegrationManagedToolName } from "@openacme/hosted-integrations";
import { createApp } from "../src/app.js";

const dataDir =
  process.env["OPENACME_DATA_DIR"] ??
  "/Users/alenbohcelyan/.openamce-hosted-integrations-test-env";
const requestedPort = positivePort(process.env["OPENACME_E2E_PORT"]) ?? 3466;
const suffix = randomUUID().slice(0, 8);
const familyId = `real-dogfood-${suffix}`;
const scopeId = `${familyId}-local`;
const consumerId = `real-dogfood-consumer-${suffix}`;
const deniedId = `real-dogfood-denied-${suffix}`;
const echoTool = `real_echo_${suffix}`;
const largeTool = `real_large_${suffix}`;
const flakyTool = `real_flaky_${suffix}`;
const managedEchoTool = managedToolName(echoTool);
const managedLargeTool = managedToolName(largeTool);
const managedFlakyTool = managedToolName(flakyTool);
const modelToolDeadlineMs =
  positiveInteger(process.env["OPENACME_E2E_TOOL_TIMEOUT_MS"]) ?? 480_000;
const modelToolAttemptDeadlineMs =
  positiveInteger(process.env["OPENACME_E2E_TOOL_ATTEMPT_TIMEOUT_MS"]) ?? 120_000;
const modelToolMaxAttempts =
  positiveInteger(process.env["OPENACME_E2E_TOOL_MAX_ATTEMPTS"]) ?? 3;
const editLockTtlMs =
  positiveInteger(process.env["OPENACME_E2E_LOCK_TTL_MS"]) ?? 900_000;

let server: ServerType | null = null;
let baseUrl = "";
let authToken = "";
let lockId = "";
let draftId = "";
let generationId = "";
let failureBucketId = "";

installDogfoodAbortGuards();

async function main(): Promise<void> {
  process.env["OPENACME_DATA_DIR"] = dataDir;
  const config = loadConfig(dataDir);
  const { app, manager, close } = await createApp(config);

  await manager.ensureManagedAgents();
  const member =
    manager.authStore.getMemberByEmail("real-dogfood@example.com") ??
    manager.authStore.createMember({
      email: "real-dogfood@example.com",
      password: `real-dogfood-${randomUUID()}`,
    });
  authToken = manager.authStore.createSession(member.id).token;

  const started = await new Promise<{ server: ServerType; port: number }>(
    (resolve) => {
      const s = serve(
        { fetch: app.fetch, port: requestedPort, hostname: "127.0.0.1" },
        (info) => resolve({ server: s, port: info.port }),
      );
    },
  );
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;

  console.log(
    JSON.stringify({
      status: "started",
      dataDir,
      baseUrl,
      model: {
        provider: config.model.provider,
        model: config.model.model,
        auth: config.model.auth,
      },
      familyId,
      consumerId,
      deniedId,
    }),
  );

  try {
    await runDogfood();
    console.log(JSON.stringify({ status: "pass" }));
  } finally {
    await sleep(16_000);
    await close();
    await closeServer();
  }
}

async function runDogfood(): Promise<void> {
  await scenario(
    "tool-developer-skill",
    async () => {
      const skill = await askForTool(
        "tool-developer",
        [
          "Load the hosted integration lifecycle instructions.",
          "Call `skill_view` exactly once with this JSON argument:",
          jsonBlock({ name: "hosted-integrations-development" }),
          "After the tool result, give a one sentence confirmation.",
        ].join("\n"),
        "skill_view",
      );
      expectObject(skill, { success: true, name: "hosted-integrations-development" });
    },
  );

  await scenario("tool-developer-create-and-promote", async () => {
    const created = await askForTool(
      "tool-developer",
      [
        "Create a new non-destructive hosted integration family.",
        "Call `hosted_integration_family_create` exactly once with this JSON argument:",
        jsonBlock({
          family_id: familyId,
          name: "Real LLM Dogfood Tools",
          tool_name: echoTool,
          ttl_ms: editLockTtlMs,
        }),
      ].join("\n"),
      "hosted_integration_family_create",
    );
    expectObject(created, { ok: true });
    lockId = stringField(created, "lock.id");
    draftId = stringField(created, "draft.id");

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_draft_patch", {
          draft_id: draftId,
          lock_id: lockId,
          path: "family.yaml",
          content: familyYaml(),
        }),
        "hosted_integration_draft_patch",
      ),
    );
    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_draft_patch", {
          draft_id: draftId,
          lock_id: lockId,
          path: "real_dogfood_tools.py",
          content: toolsPython(false),
        }),
        "hosted_integration_draft_patch",
      ),
    );

    for (const example of [
      { id: "echo_smoke", toolName: echoTool, args: { text: "real agent" } },
      { id: "large_smoke", toolName: largeTool, args: { repeat: 80 } },
      { id: "flaky_smoke", toolName: flakyTool, args: { mode: "ok" } },
    ]) {
      await expectOk(
        askForTool(
          "tool-developer",
          promptForTool("hosted_integration_example_upsert", {
            draft_id: draftId,
            lock_id: lockId,
            example: {
              id: example.id,
              familyId,
              toolName: example.toolName,
              category: "live_safe",
              args: example.args,
              expected: {},
            },
          }),
          "hosted_integration_example_upsert",
        ),
      );
    }

    const source = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_source_read", {
        family_id: null,
        draft_id: draftId,
        path: "family.yaml",
      }),
      "hosted_integration_source_read",
    );
    expectObject(source, { ok: true, path: "family.yaml" });
    assertIncludes(source, "content", `id: ${familyId}`);

    const draft = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_draft_get", {
        draft_id: draftId,
        path: null,
      }),
      "hosted_integration_draft_get",
    );
    expectObject(draft, { ok: true, draft: { id: draftId, familyId } });

    const listedExamples = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_example_list", {
        draft_id: draftId,
      }),
      "hosted_integration_example_list",
    );
    assertJsonIncludes(listedExamples, "echo_smoke");
    assertJsonIncludes(listedExamples, "flaky_smoke");

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_validate", { draft_id: draftId }),
        "hosted_integration_validate",
      ),
    );

    const echoRun = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_example_run", {
        draft_id: draftId,
        example_id: "echo_smoke",
      }),
      "hosted_integration_example_run",
    );
    expectObject(echoRun, {
      ok: true,
      envelope: { ok: true, result: { echo: "real agent" } },
    });

    const promoted = await askForTool(
      "tool-developer",
      [
        promptForTool("hosted_integration_promote", {
          draft_id: draftId,
          lock_id: lockId,
          approval_id: null,
        }),
        "`approval_id: null` means no approval record is needed for this non-destructive promotion.",
      ].join("\n"),
      "hosted_integration_promote",
    );
    expectObject(promoted, { ok: true, generation: { familyId, status: "active" } });
    generationId = stringField(promoted, "generation.id");

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_lock_release", { lock_id: lockId }),
        "hosted_integration_lock_release",
      ),
    );
  });

  await scenario("consumer-agent-invokes-promoted-tools", async () => {
    await configureScope();
    const configScopes = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_config_scope_list", {}),
      "hosted_integration_config_scope_list",
    );
    assertJsonIncludes(configScopes, scopeId);

    const configScope = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_config_scope_get", {
        scope_id: scopeId,
      }),
      "hosted_integration_config_scope_get",
    );
    expectObject(configScope, {
      ok: true,
      configScope: { id: scopeId, familyId, environment: "test" },
    });

    await createConsumerAgent(consumerId, [echoTool, largeTool, flakyTool]);

    const echo = await askForTool(
      consumerId,
      [
        `Use the hosted integration tool \`${managedEchoTool}\` to echo "real consumer".`,
        "Call the tool exactly once with the required JSON argument.",
      ].join("\n"),
      managedEchoTool,
    );
    expectObject(echo, {
      ok: true,
      generationId,
      envelope: { ok: true, result: { echo: "real consumer" } },
    });

    const large = await askForTool(
      consumerId,
      [
        `Use the hosted integration tool \`${managedLargeTool}\` with repeat 150.`,
        "Call the tool exactly once with the required JSON argument.",
      ].join("\n"),
      managedLargeTool,
    );
    expectObject(large, {
      ok: true,
      envelope: {
        ok: true,
        result_ref: { type: "artifact", name: "output.json" },
      },
    });
    if (JSON.stringify(large.envelope).includes("REAL-DOGFOOD-LARGE-")) {
      throw new Error("large response did not spill to an artifact");
    }
    const largeRunId = stringField(large, "envelope.result_ref.run_id");

    const run = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_run_get", { run_id: largeRunId }),
      "hosted_integration_run_get",
    );
    expectObject(run, {
      ok: true,
      run: {
        runId: largeRunId,
        familyId,
        toolName: largeTool,
        actorId: consumerId,
        status: "succeeded",
      },
    });

    const artifact = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_artifact_get", {
        run_id: largeRunId,
        name: "output.json",
      }),
      "hosted_integration_artifact_get",
    );
    expectObject(artifact, { ok: true, runId: largeRunId, name: "output.json" });
    assertIncludes(artifact, "content", "REAL-DOGFOOD-LARGE-");
  });

  await scenario("agent-settings-access-policy-denies-unbound-agent", async () => {
    await createAgent(deniedId, "Real Dogfood Denied", {
      role: "Attempts hosted integration use without a binding.",
      persona: "Use the requested hosted integration tool.",
      tools: [managedEchoTool],
      hostedIntegrationBindings: [],
    });
    const denied = await askForTool(
      deniedId,
      [
        `Try to call hosted integration tool \`${managedEchoTool}\` with text "blocked".`,
        "Call the tool exactly once.",
      ].join("\n"),
      managedEchoTool,
    );
    expectObject(denied, { ok: false, error: { code: "policy_denied" } });
  });

  await scenario("failure-bucket-repair-loop", async () => {
    const failed = await askForTool(
      consumerId,
      [
        `Call hosted integration tool \`${managedFlakyTool}\` with mode "fail".`,
        "This should fail; do not retry.",
      ].join("\n"),
      managedFlakyTool,
    );
    expectObject(failed, { ok: false });
    if (JSON.stringify(failed).includes("Traceback")) {
      throw new Error("caller-facing failure leaked a traceback");
    }

    const buckets = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_failure_bucket_list", {
        family_id: familyId,
      }),
      "hosted_integration_failure_bucket_list",
    );
    failureBucketId = stringField(buckets, "buckets.0.id");

    const repairTask = await waitForRepairTask(failureBucketId);
    expectObject(repairTask, {
      assignee: "tool-developer",
      created_by: "system:hosted-integrations",
      status: "open",
    });
    const repairTaskBody =
      typeof repairTask.body === "string" ? repairTask.body : "";
    if (
      !repairTaskBody.includes(`bucket_id: ${failureBucketId}`) ||
      !repairTaskBody.includes(`family_id: ${familyId}`) ||
      !repairTaskBody.includes(`tool_name: ${flakyTool}`)
    ) {
      throw new Error(
        `repair task body did not reference bucket: ${repairTaskBody}`,
      );
    }

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_failure_bucket_assign", {
          bucket_id: failureBucketId,
          assigned_to: "tool-developer",
        }),
        "hosted_integration_failure_bucket_assign",
      ),
    );

    const repairLock = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_lock_acquire", {
        family_id: familyId,
        ttl_ms: editLockTtlMs,
      }),
      "hosted_integration_lock_acquire",
    );
    const repairLockId = stringField(repairLock, "lock.id");

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_lock_renew", {
          lock_id: repairLockId,
          ttl_ms: editLockTtlMs,
        }),
        "hosted_integration_lock_renew",
      ),
    );

    const repairDraft = await askForTool(
      "tool-developer",
      [
        promptForTool("hosted_integration_draft_create", {
          family_id: familyId,
          lock_id: repairLockId,
          source_revision_id: null,
        }),
        "`source_revision_id: null` means use the current source revision.",
      ].join("\n"),
      "hosted_integration_draft_create",
    );
    const repairDraftId = stringField(repairDraft, "draft.id");

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_draft_patch", {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          path: "scratch.txt",
          content: "temporary repair note\n",
        }),
        "hosted_integration_draft_patch",
      ),
    );
    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_draft_delete", {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          path: "scratch.txt",
        }),
        "hosted_integration_draft_delete",
      ),
    );

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_draft_patch", {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          path: "real_dogfood_tools.py",
          content: toolsPython(true),
        }),
        "hosted_integration_draft_patch",
      ),
    );

    await expectOk(
      askForTool(
        "tool-developer",
        promptForTool("hosted_integration_example_upsert", {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          example: {
            id: "flaky_regression",
            familyId,
            toolName: flakyTool,
            category: "regression",
            args: { mode: "fail" },
            expected: {},
          },
        }),
        "hosted_integration_example_upsert",
      ),
    );

    const regression = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_example_run", {
        draft_id: repairDraftId,
        example_id: "flaky_regression",
      }),
      "hosted_integration_example_run",
    );
    expectObject(regression, {
      ok: true,
      envelope: { ok: true, result: { recovered: true } },
    });

    const repaired = await askForTool(
      "tool-developer",
      [
        promptForTool("hosted_integration_promote", {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          approval_id: null,
        }),
        "`approval_id: null` means no approval record is needed for this non-destructive promotion.",
      ].join("\n"),
      "hosted_integration_promote",
    );
    const repairGenerationId = stringField(repaired, "generation.id");

    const debugRun = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_debug_run", {
        family_id: familyId,
        tool_name: flakyTool,
        environment: "test",
        config_scope_id: scopeId,
        args: { mode: "fail" },
        generation_id: repairGenerationId,
        operation_class: "read",
      }),
      "hosted_integration_debug_run",
    );
    expectObject(debugRun, {
      ok: true,
      generationId: repairGenerationId,
      envelope: { ok: true, result: { recovered: true } },
    });

    const closed = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_failure_bucket_close", {
        bucket_id: failureBucketId,
        draft_id: repairDraftId,
        generation_id: repairGenerationId,
        regression_example_id: "flaky_regression",
      }),
      "hosted_integration_failure_bucket_close",
    );
    expectObject(closed, {
      ok: true,
      bucket: { id: failureBucketId, status: "closed" },
    });

    const generations = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_generation_list", {
        family_id: familyId,
      }),
      "hosted_integration_generation_list",
    );
    assertJsonIncludes(generations, generationId);
    assertJsonIncludes(generations, repairGenerationId);

    const generation = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_generation_get", {
        generation_id: repairGenerationId,
      }),
      "hosted_integration_generation_get",
    );
    expectObject(generation, {
      ok: true,
      generation: { id: repairGenerationId, familyId },
    });

    const rollback = await askForTool(
      "tool-developer",
      promptForTool("hosted_integration_generation_rollback", {
        generation_id: generationId,
      }),
      "hosted_integration_generation_rollback",
    );
    expectObject(rollback, {
      ok: true,
      activeGeneration: { id: generationId, familyId, status: "active" },
    });
  });
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(JSON.stringify({ scenario: name, status: "start" }));
  await fn();
  console.log(JSON.stringify({ scenario: name, status: "pass" }));
}

function promptForTool(toolName: string, args: Record<string, unknown>): string {
  return [
    `Call \`${toolName}\` exactly once with this JSON argument:`,
    jsonBlock(args),
    "Do not substitute ids, rename fields, add omitted optional fields, or use generic filesystem access.",
  ].join("\n");
}

async function askForTool(
  agentId: string,
  prompt: string,
  expectedTool: string,
): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= modelToolMaxAttempts; attempt += 1) {
    try {
      return await askForToolAttempt(agentId, prompt, expectedTool, attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`attempt ${attempt}: ${message}`);
      if (attempt === modelToolMaxAttempts) {
        throw new Error(errors.join("\n"));
      }
      console.warn(
        JSON.stringify({
          status: "retrying_tool_call",
          expectedTool,
          attempt,
          message,
        }),
      );
    }
  }
  throw new Error(`unreachable askForTool retry state for ${expectedTool}`);
}

async function askForToolAttempt(
  agentId: string,
  prompt: string,
  expectedTool: string,
  attempt: number,
): Promise<Record<string, unknown>> {
  const sessionId = randomUUID();
  const attemptDeadlineMs = Math.min(
    modelToolDeadlineMs,
    modelToolAttemptDeadlineMs,
  );
  const chatCtrl = new AbortController();
  const chatTimer = setTimeout(() => chatCtrl.abort(), attemptDeadlineMs);
  let res: Response;
  try {
    res = await req("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: chatCtrl.signal,
      body: JSON.stringify({
        agentId,
        sessionId,
        messages: [
          {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: prompt }],
          },
        ],
      }),
    });
  } finally {
    clearTimeout(chatTimer);
  }
  if (res.status !== 200) {
    throw new Error(`POST /api/chat failed ${res.status}: ${await res.text()}`);
  }

  const deadline = Date.now() + attemptDeadlineMs;
  let lastAssistantText = "";
  for (;;) {
    const messages = (await getJson(
      `/api/sessions/${sessionId}/messages`,
    )) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const assistants = messages.filter((message) => message.role === "assistant");
    const assistant = assistants[assistants.length - 1];
    if (assistant) {
      lastAssistantText = textFromParts(assistant.parts);
      const part = assistant.parts.find(
        (p) =>
          p?.type === `tool-${expectedTool}` &&
          p.state === "output-available",
      );
      if (part) return parseToolPartOutput(part);
      if (lastAssistantText.trim()) {
        throw new Error(
          `Expected ${expectedTool}, but assistant answered without that tool call: ${lastAssistantText}`,
        );
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${expectedTool} on attempt ${attempt}. Last assistant text: ${lastAssistantText}`,
      );
    }
    await sleep(500);
  }
}

function installDogfoodAbortGuards(): void {
  const report = (kind: string, reason: unknown) => {
    console.warn(
      JSON.stringify({
        status: "ignored_dogfood_abort",
        kind,
        message: abortErrorMessage(reason),
      }),
    );
  };
  process.on("unhandledRejection", (reason) => {
    if (isAbortError(reason)) {
      report("unhandledRejection", reason);
      return;
    }
    throw reason;
  });
  process.on("uncaughtException", (error) => {
    if (isAbortError(error)) {
      report("uncaughtException", error);
      return;
    }
    throw error;
  });
}

function isAbortError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  return (
    value.name === "AbortError" ||
    value.message.toLowerCase().includes("operation was aborted")
  );
}

function abortErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function createConsumerAgent(id: string, tools: string[]): Promise<void> {
  await createAgent(id, "Real Dogfood Consumer", {
    role: "Consumes real LLM dogfood hosted integrations.",
    persona:
      "When asked to use a hosted integration, call the requested tool exactly once with the requested arguments.",
    tools: tools.map(managedToolName),
    hostedIntegrationBindings: tools.map((toolName) => ({
      familyId,
      toolName,
      allowedConfigScopeIds: [scopeId],
      defaultConfigScopeId: scopeId,
      environment: "test",
    })),
  });
}

function managedToolName(toolName: string): string {
  return buildHostedIntegrationManagedToolName({ familyId, toolName });
}

async function createAgent(
  id: string,
  name: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const res = await req("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name, ...extra }),
  });
  if (res.status !== 201) {
    throw new Error(`create agent ${id} failed ${res.status}: ${await res.text()}`);
  }
}

async function configureScope(): Promise<void> {
  const res = await req(`/api/hosted-integrations/config-scopes/${scopeId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      familyId,
      environment: "test",
      config: { endpoint: "https://real-dogfood.example.test" },
      secrets: {},
      updatedBy: "human:real-dogfood",
    }),
  });
  if (res.status !== 200) {
    throw new Error(`config scope failed ${res.status}: ${await res.text()}`);
  }
}

async function req(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  headers.set("authorization", `Bearer ${authToken}`);
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

async function closeServer(): Promise<void> {
  const activeServer = server;
  server = null;
  if (!activeServer) return;
  const closer = activeServer as ServerType & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
    unref?: () => void;
  };
  const closed = new Promise<void>((resolve, reject) => {
    activeServer.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const forced = sleep(1_000).then(() => {
    closer.closeIdleConnections?.();
    closer.closeAllConnections?.();
    closer.unref?.();
  });
  await Promise.race([closed, forced]);
  await Promise.race([closed, sleep(1_000)]);
}

async function getJson(pathname: string): Promise<unknown> {
  const res = await req(pathname);
  if (!res.ok) throw new Error(`GET ${pathname} failed ${res.status}`);
  return res.json();
}

async function waitForRepairTask(
  bucketId: string,
): Promise<Record<string, unknown>> {
  const marker = `openacme:hosted-integration-repair-bucket=${bucketId}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const listed = (await getJson(
      [
        "/api/tasks?assignee=tool-developer",
        "created_by=system%3Ahosted-integrations",
        "status=open",
      ].join("&"),
    )) as { tasks?: Array<Record<string, unknown>> };
    for (const task of listed.tasks ?? []) {
      const id = task.id;
      if (typeof id !== "string") continue;
      const detail = (await getJson(`/api/tasks/${id}`)) as {
        task?: Record<string, unknown>;
      };
      const body = detail.task?.body;
      if (typeof body === "string" && body.includes(marker)) {
        return detail.task;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for repair task ${marker}`);
    }
    await sleep(250);
  }
}

function parseToolPartOutput(part: Record<string, unknown>): Record<string, unknown> {
  const raw = part["output"] ?? part["result"] ?? part["content"];
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  throw new Error(`tool output is not JSON object: ${JSON.stringify(part)}`);
}

function expectOk(value: Promise<Record<string, unknown>>): Promise<void> {
  return value.then((resolved) => expectObject(resolved, { ok: true }));
}

function expectObject(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (isPlainObject(expectedValue)) {
      if (!isPlainObject(actualValue)) {
        throw new Error(`expected ${key} to be object: ${JSON.stringify(actual)}`);
      }
      expectObject(
        actualValue as Record<string, unknown>,
        expectedValue as Record<string, unknown>,
      );
    } else if (actualValue !== expectedValue) {
      throw new Error(
        `expected ${key}=${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)} in ${JSON.stringify(actual)}`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertIncludes(
  value: Record<string, unknown>,
  field: string,
  expected: string,
): void {
  const actual = value[field];
  if (typeof actual !== "string" || !actual.includes(expected)) {
    throw new Error(
      `expected ${field} to include ${JSON.stringify(expected)}: ${JSON.stringify(value)}`,
    );
  }
}

function assertJsonIncludes(value: unknown, expected: string): void {
  if (!JSON.stringify(value).includes(expected)) {
    throw new Error(`expected JSON to include ${expected}: ${JSON.stringify(value)}`);
  }
}

function stringField(value: Record<string, unknown>, dottedPath: string): string {
  let current: unknown = value;
  for (const key of dottedPath.split(".")) {
    if (/^\d+$/.test(key)) {
      current = Array.isArray(current) ? current[Number(key)] : undefined;
    } else {
      current =
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined;
    }
  }
  if (typeof current !== "string" || current.length === 0) {
    throw new Error(`expected string at ${dottedPath}: ${JSON.stringify(value)}`);
  }
  return current;
}

function textFromParts(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function familyYaml(): string {
  return [
    `id: ${familyId}`,
    "name: Real LLM Dogfood Tools",
    "version: 1",
    "runtime:",
    "  language: python",
    "  entrypoint: real_dogfood_tools.py",
    "  defaultTimeoutMs: 30000",
    "  inlineResultTokenLimit: 60",
    "  maxConcurrency: 1",
    "  runtimePolicy:",
    "    filesystem: run_dir_and_family_home",
    "    processEnv: tool_context_only",
    "    subprocess: denied",
    "    network: denied",
    "    declaredEgress: []",
    "  dependencyPolicy:",
    "    installDuringInvocation: false",
    "    allowedPackages: []",
    "    deniedPackages: []",
    "tools:",
    toolYaml(echoTool, "Real Echo", "Echoes text for real LLM dogfood.", "text", "string"),
    toolYaml(largeTool, "Real Large", "Returns a large payload to verify artifacts.", "repeat", "number"),
    toolYaml(flakyTool, "Real Flaky", "Fails on demand so repair flow can be tested.", "mode", "string"),
    "",
  ].join("\n");
}

function toolYaml(
  name: string,
  title: string,
  description: string,
  required: string,
  type: string,
): string {
  return [
    `  - name: ${name}`,
    `    title: ${title}`,
    `    description: ${description}`,
    "    lifecycle: active",
    "    inputSchema:",
    "      type: object",
    `      required: [${required}]`,
    "      properties:",
    `        ${required}:`,
    `          type: ${type}`,
    "      additionalProperties: false",
    "    classification:",
    "      operation: read",
    "      freshness: live",
    "      idempotency: idempotent",
    "      execution: sync",
    "      approval: none",
  ].join("\n");
}

function toolsPython(repaired: boolean): string {
  const flakyFail = repaired
    ? "            return {'recovered': True}"
    : "            raise RuntimeError('real_dogfood_unique_failure_marker')";
  return [
    "def call_tool(name, args, ctx):",
    `    if name == '${echoTool}':`,
    "        text = args.get('text')",
    "        if not isinstance(text, str):",
    "            raise ValueError('text must be a string')",
    "        return {'echo': text}",
    `    if name == '${largeTool}':`,
    "        repeat = args.get('repeat')",
    "        if not isinstance(repeat, int) or repeat < 1:",
    "            raise ValueError('repeat must be a positive integer')",
    "        return {'payload': 'REAL-DOGFOOD-LARGE-' * repeat}",
    `    if name == '${flakyTool}':`,
    "        mode = args.get('mode')",
    "        if mode == 'fail':",
    flakyFail,
    "        return {'mode': mode}",
    "    raise ValueError('unknown tool')",
    "",
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positivePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function positiveInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
