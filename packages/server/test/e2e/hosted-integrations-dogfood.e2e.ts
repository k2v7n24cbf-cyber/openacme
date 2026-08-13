import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHostedIntegrationManagedToolName } from "@openacme/hosted-integrations";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient, waitUntil } from "./support/client.js";

let srv: E2EServer;
let c: ReturnType<typeof makeClient>;

const suffix = randomUUID().slice(0, 8);
const familyId = `dogfood-${suffix}`;
const scopeId = `${familyId}-local`;
const echoTool = `dogfood_echo_${suffix}`;
const sumTool = `dogfood_sum_${suffix}`;
const largeTool = `dogfood_large_${suffix}`;
const flakyTool = `dogfood_flaky_${suffix}`;
const managedEchoTool = managedToolName(echoTool);
const managedSumTool = managedToolName(sumTool);
const managedLargeTool = managedToolName(largeTool);
const managedFlakyTool = managedToolName(flakyTool);

let lockId = "";
let draftId = "";
let generationId = "";
let failureBucketId = "";

/**
 * Dogfood acceptance for hosted integrations. These tests drive real HTTP chat
 * turns with the deterministic e2e model, so the agent loop, management tools,
 * registry sync, Agent Settings bindings, gateway, artifacts, and failure
 * buckets all run as they do in the daemon without external credentials.
 */
describe("hosted integrations agent dogfood (e2e)", () => {
  beforeAll(async () => {
    const requestedDataDir = process.env["OPENACME_DATA_DIR"];
    srv = await startE2EServer({
      dataDir: requestedDataDir,
      cleanupDataDir: requestedDataDir ? false : undefined,
      port: positivePort(process.env["OPENACME_E2E_PORT"]),
    });
    c = makeClient(srv.baseUrl);
    await srv.manager.ensureManagedAgents();
  });

  afterAll(async () => {
    await srv?.close();
  });

  it("materializes Tool Developer and loads the lifecycle skill through chat", async () => {
    const agents = srv.manager.listAgents();
    const toolDeveloper = agents.find((agent) => agent.id === "tool-developer");
    expect(toolDeveloper).toMatchObject({
      id: "tool-developer",
      name: "Tool Developer",
      managed: true,
      skills: ["hosted-integrations-development"],
    });

    const skill = await chatTool(
      "tool-developer",
      "load the hosted integrations lifecycle skill",
      "skill_view",
      { name: "hosted-integrations-development" },
    );
    expect(skill).toMatchObject({
      success: true,
      name: "hosted-integrations-development",
    });
    expect(JSON.stringify(skill)).toContain("Request to promotion lifecycle");
  });

  it("creates, patches, validates, examples, and promotes a family through Tool Developer chat", async () => {
    const created = await chatTool(
      "tool-developer",
      "create a new safe dogfood hosted integration family",
      "hosted_integration_family_create",
      {
        family_id: familyId,
        name: "Dogfood Tools",
        tool_name: echoTool,
        ttl_ms: 180_000,
      },
    );
    expect(created).toMatchObject({
      ok: true,
      lock: { familyId },
      draft: { familyId },
    });
    lockId = stringField(created, "lock.id");
    draftId = stringField(created, "draft.id");

    await expect(
      chatTool(
        "tool-developer",
        "patch the dogfood family manifest",
        "hosted_integration_draft_patch",
        {
          draft_id: draftId,
          lock_id: lockId,
          path: "family.yaml",
          content: familyYaml(),
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      chatTool(
        "tool-developer",
        "patch the dogfood python runtime",
        "hosted_integration_draft_patch",
        {
          draft_id: draftId,
          lock_id: lockId,
          path: "dogfood_tools.py",
          content: toolsPython(false),
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    for (const example of [
      { id: "echo_smoke", toolName: echoTool, args: { text: "agent-made" } },
      { id: "sum_smoke", toolName: sumTool, args: { values: [4, 5, 6] } },
      { id: "large_smoke", toolName: largeTool, args: { repeat: 80 } },
      { id: "flaky_smoke", toolName: flakyTool, args: { mode: "ok" } },
    ]) {
      await expect(
        chatTool(
          "tool-developer",
          `register ${example.id}`,
          "hosted_integration_example_upsert",
          {
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
          },
        ),
      ).resolves.toMatchObject({ ok: true });
    }

    await expect(
      chatTool(
        "tool-developer",
        "inspect dogfood draft source",
        "hosted_integration_source_read",
        { draft_id: draftId, path: "family.yaml" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      path: "family.yaml",
      content: expect.stringContaining(`id: ${familyId}`),
    });

    await expect(
      chatTool(
        "tool-developer",
        "inspect dogfood draft metadata",
        "hosted_integration_draft_get",
        { draft_id: draftId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      draft: { id: draftId, familyId },
    });

    await expect(
      chatTool(
        "tool-developer",
        "list dogfood draft examples",
        "hosted_integration_example_list",
        { draft_id: draftId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      examples: expect.arrayContaining([
        expect.objectContaining({ id: "echo_smoke", toolName: echoTool }),
        expect.objectContaining({ id: "flaky_smoke", toolName: flakyTool }),
      ]),
    });

    await expect(
      chatTool(
        "tool-developer",
        "validate the dogfood draft",
        "hosted_integration_validate",
        { draft_id: draftId },
      ),
    ).resolves.toMatchObject({ ok: true });

    const echoRun = await chatTool(
      "tool-developer",
      "run the dogfood echo smoke example",
      "hosted_integration_example_run",
      { draft_id: draftId, example_id: "echo_smoke" },
    );
    expect(echoRun).toMatchObject({
      ok: true,
      envelope: { ok: true, result: { echo: "agent-made" } },
    });

    const promoted = await chatTool(
      "tool-developer",
      "promote the safe dogfood generation",
      "hosted_integration_promote",
      { draft_id: draftId, lock_id: lockId },
    );
    expect(promoted).toMatchObject({
      ok: true,
      generation: { familyId, status: "active" },
    });
    generationId = stringField(promoted, "generation.id");

    await expect(
      chatTool(
        "tool-developer",
        "release the dogfood edit lock",
        "hosted_integration_lock_release",
        { lock_id: lockId },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("surfaces promoted tools and lets a consumer agent invoke them through chat", async () => {
    await configureScope();
    await expect(
      chatTool(
        "tool-developer",
        "list dogfood config scopes",
        "hosted_integration_config_scope_list",
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      configScopes: expect.arrayContaining([
        expect.objectContaining({ id: scopeId, familyId, environment: "test" }),
      ]),
    });
    await expect(
      chatTool(
        "tool-developer",
        "inspect dogfood config scope",
        "hosted_integration_config_scope_get",
        { scope_id: scopeId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      configScope: { id: scopeId, familyId, environment: "test" },
    });

    const toolsBody = await c.json("/api/tools");
    for (const [nativeToolName, canonicalToolName] of [
      [echoTool, managedEchoTool],
      [sumTool, managedSumTool],
      [largeTool, managedLargeTool],
      [flakyTool, managedFlakyTool],
    ] as const) {
      expect(
        toolsBody.tools.find(
          (tool: { name: string }) => tool.name === canonicalToolName,
        ),
      ).toMatchObject({
        name: canonicalToolName,
        toolset: "hosted-integrations",
        source: {
          kind: "hosted_integration",
          familyId,
          familyName: "Dogfood Tools",
          toolName: nativeToolName,
          generationId,
        },
      });
    }

    await createConsumerAgent("dogfood-consumer", [
      echoTool,
      sumTool,
      largeTool,
      flakyTool,
    ]);

    const echo = await chatTool(
      "dogfood-consumer",
      "use dogfood echo",
      managedEchoTool,
      {
        text: "consumer path",
      },
    );
    expect(echo).toMatchObject({
      ok: true,
      replayed: false,
      generationId,
      envelope: { ok: true, result: { echo: "consumer path" } },
    });

    const large = await chatTool(
      "dogfood-consumer",
      "use dogfood large response",
      managedLargeTool,
      { repeat: 150 },
    );
    expect(large).toMatchObject({
      ok: true,
      replayed: false,
      envelope: {
        ok: true,
        result_ref: {
          type: "artifact",
          run_id: expect.any(String),
          name: "output.json",
        },
      },
    });
    expect(JSON.stringify(large.envelope)).not.toContain("DOGFOOD-LARGE-");
    const largeRunId = stringField(large, "envelope.result_ref.run_id");

    await expect(
      chatTool(
        "tool-developer",
        "inspect dogfood large run",
        "hosted_integration_run_get",
        { run_id: largeRunId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        runId: largeRunId,
        familyId,
        toolName: largeTool,
        actorId: "dogfood-consumer",
        status: "succeeded",
      },
    });

    const artifact = await chatTool(
      "tool-developer",
      "read dogfood large artifact",
      "hosted_integration_artifact_get",
      { run_id: largeRunId, name: "output.json" },
    );
    expect(artifact).toMatchObject({
      ok: true,
      runId: largeRunId,
      name: "output.json",
    });
    expect(String(artifact.content)).toContain("DOGFOOD-LARGE-");
  });

  it("enforces hosted integration access from Agent Settings bindings", async () => {
    await c.createAgent("dogfood-denied", "Dogfood Denied", {
      role: "Attempts hosted integration use without a binding.",
      persona: "Try to use the hosted integration.",
      tools: [managedEchoTool],
      hostedIntegrationBindings: [],
    });

    const denied = await chatTool(
      "dogfood-denied",
      "attempt dogfood echo without binding",
      managedEchoTool,
      { text: "should not run" },
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("buckets a consumer failure and Tool Developer repairs and closes it through chat", async () => {
    const failed = await chatTool(
      "dogfood-consumer",
      "trigger the dogfood flaky failure",
      managedFlakyTool,
      { mode: "fail" },
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: expect.any(String) },
    });
    expect(JSON.stringify(failed)).not.toContain("Traceback");

    const buckets = await chatTool(
      "tool-developer",
      "list dogfood failure buckets",
      "hosted_integration_failure_bucket_list",
      { family_id: familyId },
    );
    expect(buckets).toMatchObject({
      ok: true,
      buckets: [expect.objectContaining({ familyId, toolName: flakyTool })],
    });
    failureBucketId = stringField(buckets, "buckets.0.id");

    await waitUntil(
      async () => repairTasksForBucket(failureBucketId).length === 1,
      { timeoutMs: 10_000, intervalMs: 100 },
    );
    const repairTask = repairTasksForBucket(failureBucketId)[0];
    expect(repairTask).toMatchObject({
      assignee: "tool-developer",
      created_by: "system:hosted-integrations",
      status: "open",
    });
    expect(repairTask?.title).toContain(`${familyId}/${flakyTool}`);
    expect(repairTask?.body).toContain(`bucket_id: ${failureBucketId}`);
    expect(repairTask?.body).toContain(`family_id: ${familyId}`);
    expect(repairTask?.body).toContain(`tool_name: ${flakyTool}`);

    await expect(
      chatTool(
        "tool-developer",
        "assign dogfood failure bucket",
        "hosted_integration_failure_bucket_assign",
        { bucket_id: failureBucketId, assigned_to: "tool-developer" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      bucket: { id: failureBucketId, assignedTo: "tool-developer" },
    });

    const repairLock = await chatTool(
      "tool-developer",
      "lock dogfood family for repair",
      "hosted_integration_lock_acquire",
      { family_id: familyId, ttl_ms: 180_000 },
    );
    expect(repairLock).toMatchObject({ ok: true, lock: { familyId } });
    const repairLockId = stringField(repairLock, "lock.id");

    await expect(
      chatTool(
        "tool-developer",
        "renew dogfood repair lock",
        "hosted_integration_lock_renew",
        { lock_id: repairLockId, ttl_ms: 180_000 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      lock: { id: repairLockId, familyId },
    });

    const repairDraft = await chatTool(
      "tool-developer",
      "create dogfood repair draft",
      "hosted_integration_draft_create",
      { family_id: familyId, lock_id: repairLockId },
    );
    expect(repairDraft).toMatchObject({ ok: true, draft: { familyId } });
    const repairDraftId = stringField(repairDraft, "draft.id");

    await expect(
      chatTool(
        "tool-developer",
        "patch temporary dogfood repair note",
        "hosted_integration_draft_patch",
        {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          path: "scratch.txt",
          content: "temporary repair note\n",
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      chatTool(
        "tool-developer",
        "delete temporary dogfood repair note",
        "hosted_integration_draft_delete",
        { draft_id: repairDraftId, lock_id: repairLockId, path: "scratch.txt" },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      chatTool(
        "tool-developer",
        "inspect the flaky dogfood repair source window",
        "hosted_integration_source_read",
        {
          draft_id: repairDraftId,
          path: "dogfood_tools.py",
          start_line: 15,
          max_lines: 8,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      path: "dogfood_tools.py",
      content: expect.stringContaining("dogfood_unique_failure_marker"),
      truncated: true,
    });

    await expect(
      chatTool(
        "tool-developer",
        "patch flaky dogfood repair with a targeted source replacement",
        "hosted_integration_draft_patch",
        {
          draft_id: repairDraftId,
          lock_id: repairLockId,
          path: "dogfood_tools.py",
          mode: "replace_text",
          old_text:
            "            raise RuntimeError('dogfood_unique_failure_marker')",
          new_text: "            return {'recovered': True}",
        },
      ),
    ).resolves.toMatchObject({ ok: true, mode: "replace_text" });

    await expect(
      chatTool(
        "tool-developer",
        "register flaky regression example",
        "hosted_integration_example_upsert",
        {
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
        },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      chatTool(
        "tool-developer",
        "run flaky regression example",
        "hosted_integration_example_run",
        { draft_id: repairDraftId, example_id: "flaky_regression" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      envelope: { ok: true, result: { recovered: true } },
    });

    const repairPromotion = await chatTool(
      "tool-developer",
      "promote dogfood repair",
      "hosted_integration_promote",
      { draft_id: repairDraftId, lock_id: repairLockId },
    );
    expect(repairPromotion).toMatchObject({
      ok: true,
      generation: { familyId, status: "active" },
    });
    const repairGenerationId = stringField(repairPromotion, "generation.id");

    const debugRun = await chatTool(
      "tool-developer",
      "debug run repaired dogfood flaky tool",
      "hosted_integration_debug_run",
      {
        family_id: familyId,
        tool_name: flakyTool,
        environment: "test",
        config_scope_id: scopeId,
        args: { mode: "fail" },
        generation_id: repairGenerationId,
        operation_class: "read",
      },
    );
    expect(debugRun).toMatchObject({
      ok: true,
      generationId: repairGenerationId,
      envelope: { ok: true, result: { recovered: true } },
    });

    await expect(
      chatTool(
        "tool-developer",
        "close dogfood failure bucket",
        "hosted_integration_failure_bucket_close",
        {
          bucket_id: failureBucketId,
          draft_id: repairDraftId,
          generation_id: repairGenerationId,
          regression_example_id: "flaky_regression",
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      bucket: { id: failureBucketId, status: "closed" },
    });

    await expect(
      chatTool(
        "tool-developer",
        "list dogfood generations",
        "hosted_integration_generation_list",
        { family_id: familyId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      generations: expect.arrayContaining([
        expect.objectContaining({ id: generationId, familyId }),
        expect.objectContaining({ id: repairGenerationId, familyId }),
      ]),
    });

    await expect(
      chatTool(
        "tool-developer",
        "inspect repaired dogfood generation",
        "hosted_integration_generation_get",
        { generation_id: repairGenerationId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      generation: { id: repairGenerationId, familyId },
    });

    await expect(
      chatTool(
        "tool-developer",
        "rollback dogfood family to original generation",
        "hosted_integration_generation_rollback",
        { generation_id: generationId },
      ),
    ).resolves.toMatchObject({
      ok: true,
      activeGeneration: { id: generationId, familyId, status: "active" },
    });
  });
});

async function chatTool(
  agentId: string,
  prompt: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = randomUUID();
  await c.chat(
    agentId,
    `${prompt} [[mock:tool:${toolName}:${JSON.stringify(args)}]]`,
    sessionId,
  );
  let output: Record<string, unknown> | null = null;
  await waitUntil(
    async () => {
      const messages = await c.messages(sessionId);
      const assistants = messages.filter(
        (message) => message.role === "assistant",
      );
      const assistant = assistants[assistants.length - 1];
      const part = assistant?.parts.find(
        (p) => p?.type === `tool-${toolName}` && p.state === "output-available",
      );
      if (!part) return false;
      output = parseToolPartOutput(part);
      return true;
    },
    { timeoutMs: 30_000, intervalMs: 100 },
  );
  expect(output, `missing output for ${toolName}`).toBeTruthy();
  return output!;
}

function repairTasksForBucket(bucketId: string) {
  const marker = `openacme:hosted-integration-repair-bucket=${bucketId}`;
  return srv.manager.taskStore
    .list({ assignee: "tool-developer" })
    .filter((task) => task.body.includes(marker));
}

function parseToolPartOutput(
  part: Record<string, unknown>,
): Record<string, unknown> {
  const raw = part["output"] ?? part["result"] ?? part["content"];
  if (typeof raw === "string")
    return JSON.parse(raw) as Record<string, unknown>;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  throw new Error(`tool output is not JSON object: ${JSON.stringify(part)}`);
}

async function createConsumerAgent(id: string, tools: string[]): Promise<void> {
  await c.createAgent(id, id, {
    role: "Consumes dogfood hosted integrations.",
    persona: "Use hosted integrations when asked.",
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

async function configureScope(): Promise<void> {
  const res = await c.req(`/api/hosted-integrations/config-scopes/${scopeId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      familyId,
      environment: "test",
      config: { endpoint: "https://dogfood.example.test" },
      secrets: {},
      updatedBy: "human:e2e",
    }),
  });
  expect(res.status).toBe(200);
}

function stringField(
  value: Record<string, unknown>,
  dottedPath: string,
): string {
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
    throw new Error(
      `expected string at ${dottedPath}: ${JSON.stringify(value)}`,
    );
  }
  return current;
}

function familyYaml(): string {
  return [
    `id: ${familyId}`,
    "name: Dogfood Tools",
    "version: 1",
    "runtime:",
    "  language: python",
    "  entrypoint: dogfood_tools.py",
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
    toolYaml(
      echoTool,
      "Dogfood Echo",
      "Echoes text for dogfood acceptance.",
      "text",
      "string",
    ),
    toolYaml(
      sumTool,
      "Dogfood Sum",
      "Sums numbers for dogfood acceptance.",
      "values",
      "array",
    ),
    toolYaml(
      largeTool,
      "Dogfood Large",
      "Returns a large payload to verify artifacts.",
      "repeat",
      "number",
    ),
    toolYaml(
      flakyTool,
      "Dogfood Flaky",
      "Fails on demand so repair flow can be tested.",
      "mode",
      "string",
    ),
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
    : "            raise RuntimeError('dogfood_unique_failure_marker')";
  return [
    "def call_tool(name, args, ctx):",
    `    if name == '${echoTool}':`,
    "        text = args.get('text')",
    "        if not isinstance(text, str):",
    "            raise ValueError('text must be a string')",
    "        return {'echo': text}",
    `    if name == '${sumTool}':`,
    "        values = args.get('values')",
    "        if not isinstance(values, list) or not all(",
    "            isinstance(v, (int, float)) for v in values",
    "        ):",
    "            raise ValueError('values must be numeric')",
    "        return {'sum': sum(values), 'count': len(values)}",
    `    if name == '${largeTool}':`,
    "        repeat = args.get('repeat')",
    "        if not isinstance(repeat, int) or repeat < 1:",
    "            raise ValueError('repeat must be a positive integer')",
    "        return {'payload': 'DOGFOOD-LARGE-' * repeat}",
    `    if name == '${flakyTool}':`,
    "        mode = args.get('mode')",
    "        if mode == 'fail':",
    flakyFail,
    "        return {'mode': mode}",
    "    raise ValueError('unknown tool')",
    "",
  ].join("\n");
}

function positivePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}
