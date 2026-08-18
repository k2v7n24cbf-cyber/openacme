import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHostedToolName } from "@openacme/hosted-integrations";
import { registry as toolRegistry, toolCallContext } from "@openacme/tools";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient } from "./support/client.js";

const FAMILY_ID = "safe-tools";
const TEST_ENVIRONMENT = "test_debug";
const LOCKED_BY = "agent:tool-developer";
const HOSTED_SAFE_ECHO = hostedToolName("safe_echo");
const HOSTED_SAFE_SUM = hostedToolName("safe_sum");
const HOSTED_SAFE_LARGE_RESULT = hostedToolName("safe_large_result");

let srv: E2EServer;
let c: ReturnType<typeof makeClient>;

/**
 * Hosted integrations end-to-end safe smoke. This exercises the real HTTP
 * lifecycle, registry surfacing, Agent Settings data shape, and agent/tool
 * invocation path without external credentials or destructive operations.
 */
describe("hosted integrations safe tools (e2e)", () => {
  let generationId = "";

  beforeAll(async () => {
    const requestedDataDir = process.env["OPENACME_DATA_DIR"];
    srv = await startE2EServer({
      dataDir: requestedDataDir,
      cleanupDataDir: requestedDataDir ? false : undefined,
      port: positivePort(process.env["OPENACME_E2E_PORT"]),
    });
    c = makeClient(srv.baseUrl);
  });

  afterAll(async () => {
    await srv?.close();
  });

  it("promotes safe tools through the hosted integration API lifecycle", async () => {
    const { lock, draft } = await createOrLoadDraft();

    await putDraftFile(draft.id, lock.id, "family.yaml", safeFamilyYaml());
    await putDraftFile(draft.id, lock.id, "tools.yaml", safeToolsYaml());
    await putDraftFile(draft.id, lock.id, "safe_tools.py", safeToolsPython());
    await upsertExample(draft.id, lock.id, "safe_echo_smoke", "safe_echo", {
      text: "hello from hosted integrations",
    });
    await upsertExample(draft.id, lock.id, "safe_sum_smoke", "safe_sum", {
      values: [2, 3, 5],
    });
    await upsertExample(
      draft.id,
      lock.id,
      "safe_large_result_smoke",
      "safe_large_result",
      { repeat: 80 },
    );

    const validation = await postJson(
      `/api/hosted-integrations/drafts/${draft.id}/validate`,
      {},
    );
    expect(validation.status).toBe(200);
    expect(await validation.json()).toMatchObject({ ok: true });

    const echoRun = await runExample(draft.id, "safe_echo_smoke");
    expect(echoRun).toMatchObject({
      ok: true,
      envelope: {
        ok: true,
        result: { echo: "hello from hosted integrations" },
      },
    });

    const sumRun = await runExample(draft.id, "safe_sum_smoke");
    expect(sumRun).toMatchObject({
      ok: true,
      envelope: { ok: true, result: { sum: 10, count: 3 } },
    });

    const promoted = await postJson(
      `/api/hosted-integrations/drafts/${draft.id}/promote`,
      {
        actor: toolDeveloperActor(),
        lockId: lock.id,
      },
    );
    expect(promoted.status).toBe(200);
    const promotedBody = await promoted.json();
    expect(promotedBody).toMatchObject({
      ok: true,
      generation: { familyId: FAMILY_ID, status: "active" },
    });
    generationId = promotedBody.generation.id;

    const release = await c.req(`/api/hosted-integrations/locks/${lock.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockedBy: LOCKED_BY }),
    });
    expect(release.status).toBe(200);
  });

  it("surfaces promoted safe tools through /api/tools", async () => {
    const toolsBody = await c.json("/api/tools");
    expect(toolsBody.toolsets).toContain("hosted-integrations");
    for (const toolName of ["safe_echo", "safe_sum", "safe_large_result"]) {
      const canonicalToolName = hostedToolName(toolName);
      expect(
        toolsBody.tools.find(
          (tool: { name: string }) => tool.name === canonicalToolName,
        ),
      ).toMatchObject({
        name: canonicalToolName,
        toolset: "hosted-integrations",
        source: {
          kind: "hosted_integration",
          familyId: FAMILY_ID,
          familyName: "Safe Tools",
          toolName,
          generationId,
        },
      });
    }
  });

  it("invokes selected safe tools through the real agent tool path", async () => {
    await configureEnvironmentConfig();
    await c.createAgent("safe-agent", "Safe Agent", {
      role: "Runs safe hosted integration smoke tools.",
      persona: "Use safe hosted integrations.",
      tools: [HOSTED_SAFE_ECHO, HOSTED_SAFE_SUM, HOSTED_SAFE_LARGE_RESULT],
      hostedIntegrationBindings: [
        {
          familyId: FAMILY_ID,
          toolName: "safe_echo",
          allowedEnvironments: [TEST_ENVIRONMENT],
          defaultEnvironment: TEST_ENVIRONMENT,
          generationPin: { type: "current" },
          bindingKind: "agent",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:e2e",
        },
        {
          familyId: FAMILY_ID,
          toolName: "safe_sum",
          allowedEnvironments: [TEST_ENVIRONMENT],
          defaultEnvironment: TEST_ENVIRONMENT,
          generationPin: { type: "current" },
          bindingKind: "agent",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:e2e",
        },
        {
          familyId: FAMILY_ID,
          toolName: "safe_large_result",
          allowedEnvironments: [TEST_ENVIRONMENT],
          defaultEnvironment: TEST_ENVIRONMENT,
          generationPin: { type: "current" },
          bindingKind: "agent",
          updatedAt: "2026-08-14T10:00:00.000Z",
          updatedBy: "human:e2e",
        },
      ],
    });

    const tools = toolRegistry.getVercelTools(
      new Set([HOSTED_SAFE_ECHO, HOSTED_SAFE_SUM, HOSTED_SAFE_LARGE_RESULT]),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;

    const echo = await invokeAgentTool(tools[HOSTED_SAFE_ECHO]!, {
      text: "agent settings path",
    });
    expect(echo).toMatchObject({
      ok: true,
      replayed: false,
      generationId,
      envelope: { ok: true, result: { echo: "agent settings path" } },
    });

    const sum = await invokeAgentTool(tools[HOSTED_SAFE_SUM]!, {
      values: [10, 20, 12],
    });
    expect(sum).toMatchObject({
      ok: true,
      replayed: false,
      generationId,
      envelope: { ok: true, result: { sum: 42, count: 3 } },
    });

    const large = await invokeAgentTool(tools[HOSTED_SAFE_LARGE_RESULT]!, {
      repeat: 120,
    });
    expect(large).toMatchObject({
      ok: true,
      replayed: false,
      generationId,
      envelope: {
        ok: true,
        result_ref: {
          type: "artifact",
          run_id: expect.any(String),
          name: "output.json",
        },
      },
    });
    expect(JSON.stringify(large.envelope)).not.toContain("0123456789abcdef");
  });
});

function hostedToolName(toolName: string): string {
  return buildHostedToolName({
    familyId: FAMILY_ID,
    toolName,
  });
}

async function createOrLoadDraft(): Promise<{
  lock: { id: string };
  draft: { id: string };
}> {
  const existing = await c.req(`/api/hosted-integrations/families/${FAMILY_ID}`);
  if (existing.status === 200) {
    const lock = await acquireLock();
    return { lock, draft: await createDraft(lock.id) };
  }

  const created = await postJson("/api/hosted-integrations/families", {
    familyId: FAMILY_ID,
    name: "Safe Tools",
    toolName: "safe_echo",
    lockedBy: LOCKED_BY,
    ttlMs: 120_000,
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    lock: { id: string };
    draft: { id: string };
  };
  return { lock: body.lock, draft: body.draft };
}

async function acquireLock(): Promise<{ id: string }> {
  const res = await postJson(`/api/hosted-integrations/families/${FAMILY_ID}/lock`, {
    lockedBy: LOCKED_BY,
    ttlMs: 120_000,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { lock: { id: string } }).lock;
}

async function createDraft(lockId: string): Promise<{ id: string }> {
  const res = await postJson(
    `/api/hosted-integrations/families/${FAMILY_ID}/drafts`,
    { lockId },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { draft: { id: string } }).draft;
}

async function putDraftFile(
  draftId: string,
  lockId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const res = await c.req(
    `/api/hosted-integrations/drafts/${draftId}/files/${filePath}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockId, content }),
    },
  );
  expect(res.status).toBe(200);
}

async function upsertExample(
  draftId: string,
  lockId: string,
  id: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const res = await postJson(
    `/api/hosted-integrations/drafts/${draftId}/examples`,
    {
      lockId,
      example: {
        id,
        familyId: FAMILY_ID,
        toolName,
        category: "live_safe",
        args,
        expected: {},
      },
    },
  );
  expect(res.status).toBe(200);
}

async function runExample(
  draftId: string,
  exampleId: string,
): Promise<Record<string, unknown>> {
  const res = await postJson(
    `/api/hosted-integrations/drafts/${draftId}/run-example`,
    {
      actor: toolDeveloperActor(),
      exampleId,
    },
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

async function configureEnvironmentConfig(): Promise<void> {
  const scope = await c.req(
    `/api/hosted-integrations/environment-configs/${FAMILY_ID}/${TEST_ENVIRONMENT}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { endpoint: "https://safe.example.test" },
        secrets: {},
        updatedBy: "human:e2e",
      }),
    },
  );
  expect(scope.status).toBe(200);
}

async function invokeAgentTool(
  tool: { execute: (args: Record<string, unknown>) => Promise<string> },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const output = await toolCallContext.run(
    {
      agentId: "safe-agent",
      sessionId: `session_${randomUUID()}`,
      workspaceDir: path.join(srv.dataDir, "agents", "safe-agent", "workspace"),
    },
    () => tool.execute(args),
  );
  return JSON.parse(output) as Record<string, unknown>;
}

async function postJson(pathname: string, body: unknown): Promise<Response> {
  return c.post(pathname, body);
}

function toolDeveloperActor() {
  return {
    id: LOCKED_BY,
    kind: "agent",
    roles: ["tool_developer"],
  };
}

function safeFamilyYaml(): string {
  return [
    "id: safe-tools",
    "name: Safe Tools",
    "version: 1",
    "runtime:",
    "  language: python",
    "  entrypoint: safe_tools.py",
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
    "runtimeConfig:",
    "  requiredConfigKeys: []",
    "  requiredSecretKeys: []",
    "",
  ].join("\n");
}

function safeToolsYaml(): string {
  return [
    "kind: openacme.hostedToolFamily",
    "version: 1",
    "family:",
    "  id: safe-tools",
    "tools:",
    "  - mcp:",
    "      name: hosted_safe-tools__safe_echo",
    "      title: Safe Echo",
    "      description: Echoes caller-provided text for safe hosted integration smoke testing.",
    "      inputSchema:",
    "        type: object",
    "        required: [text]",
    "        properties:",
    "          text:",
    "            type: string",
    "        additionalProperties: false",
    "      outputSchema:",
    "        type: object",
    "        required: [echo]",
    "        properties:",
    "          echo:",
    "            type: string",
    "        additionalProperties: false",
    "      annotations:",
    "        readOnlyHint: true",
    "        destructiveHint: false",
    "        idempotentHint: true",
    "        openWorldHint: false",
    "    openacme:",
    "      toolName: safe_echo",
    "      function: tool_safe_echo",
    "      lifecycle: active",
    "      classification:",
    "        operation: read",
    "        freshness: live",
    "        idempotency: idempotent",
    "        execution: sync",
    "        approval: none",
    "      selectWhen:",
    "        - Need to verify the hosted integration lifecycle with caller-provided text.",
    "      doNotSelectWhen:",
    "        - Need provider data, external network access, or a mutating operation.",
    "      prerequisites: []",
    "      parameterHelp:",
    "        text:",
    "          summary: Text to echo back in the result.",
    "      examples:",
    "        - text: hello from hosted integrations",
    "      errors: []",
    "  - mcp:",
    "      name: hosted_safe-tools__safe_sum",
    "      title: Safe Sum",
    "      description: Sums numeric values for deterministic hosted integration smoke testing.",
    "      inputSchema:",
    "        type: object",
    "        required: [values]",
    "        properties:",
    "          values:",
    "            type: array",
    "            items:",
    "              type: number",
    "        additionalProperties: false",
    "      outputSchema:",
    "        type: object",
    "        required: [sum, count]",
    "        properties:",
    "          sum:",
    "            type: number",
    "          count:",
    "            type: number",
    "        additionalProperties: false",
    "      annotations:",
    "        readOnlyHint: true",
    "        destructiveHint: false",
    "        idempotentHint: true",
    "        openWorldHint: false",
    "    openacme:",
    "      toolName: safe_sum",
    "      function: tool_safe_sum",
    "      lifecycle: active",
    "      classification:",
    "        operation: read",
    "        freshness: live",
    "        idempotency: idempotent",
    "        execution: sync",
    "        approval: none",
    "      selectWhen:",
    "        - Need to verify deterministic hosted tool argument handling with numeric arrays.",
    "      doNotSelectWhen:",
    "        - Need provider data, external network access, or a mutating operation.",
    "      prerequisites: []",
    "      parameterHelp:",
    "        values:",
    "          summary: Numeric values to add together.",
    "          full: Provide an array of integers or floating point numbers; non-numeric values are rejected.",
    "      examples:",
    "        - values: [2, 3, 5]",
    "      errors: []",
    "  - mcp:",
    "      name: hosted_safe-tools__safe_large_result",
    "      title: Safe Large Result",
    "      description: Returns a large deterministic payload to verify result_ref spillover.",
    "      inputSchema:",
    "        type: object",
    "        required: [repeat]",
    "        properties:",
    "          repeat:",
    "            type: integer",
    "            minimum: 1",
    "        additionalProperties: false",
    "      outputSchema:",
    "        type: object",
    "        required: [payload]",
    "        properties:",
    "          payload:",
    "            type: string",
    "        additionalProperties: false",
    "      annotations:",
    "        readOnlyHint: true",
    "        destructiveHint: false",
    "        idempotentHint: true",
    "        openWorldHint: false",
    "    openacme:",
    "      toolName: safe_large_result",
    "      function: tool_safe_large_result",
    "      lifecycle: active",
    "      classification:",
    "        operation: read",
    "        freshness: live",
    "        idempotency: idempotent",
    "        execution: sync",
    "        approval: none",
    "      selectWhen:",
    "        - Need to verify hosted result spillover for oversized structured output.",
    "      doNotSelectWhen:",
    "        - Need provider data, external network access, or a mutating operation.",
    "      prerequisites: []",
    "      parameterHelp:",
    "        repeat:",
    "          summary: Positive integer multiplier for the deterministic payload.",
    "      examples:",
    "        - repeat: 80",
    "      errors: []",
    "",
  ].join("\n");
}

function safeToolsPython(): string {
  return [
    "def authenticate(ctx):",
    "    return {}",
    "",
    "def before_tool_call(tool_name, args, ctx, auth):",
    "    return args",
    "",
    "def after_tool_call(tool_name, args, ctx, result, auth):",
    "    return result",
    "",
    "def tool_safe_echo(args, context):",
    "    text = args.get('text')",
    "    if not isinstance(text, str):",
    "        raise ValueError('text must be a string')",
    "    return {'echo': text}",
    "",
    "def tool_safe_sum(args, context):",
    "    values = args.get('values')",
    "    if not isinstance(values, list) or not all(isinstance(v, (int, float)) for v in values):",
    "        raise ValueError('values must be numeric')",
    "    return {'sum': sum(values), 'count': len(values)}",
    "",
    "def tool_safe_large_result(args, context):",
    "    repeat = args.get('repeat')",
    "    if not isinstance(repeat, int) or repeat < 1:",
    "        raise ValueError('repeat must be a positive integer')",
    "    return {'payload': '0123456789abcdef' * repeat}",
    "",
  ].join("\n");
}

function positivePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}
