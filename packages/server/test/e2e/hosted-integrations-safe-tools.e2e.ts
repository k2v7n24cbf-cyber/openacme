import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registry as toolRegistry, toolCallContext } from "@openacme/tools";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient } from "./support/client.js";

const FAMILY_ID = "safe-tools";
const CONFIG_SCOPE_ID = "safe-tools-local";
const LOCKED_BY = "agent:tool-developer";

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
      expect(
        toolsBody.tools.find((tool: { name: string }) => tool.name === toolName),
      ).toMatchObject({
        name: toolName,
        toolset: "hosted-integrations",
        source: {
          kind: "hosted_integration",
          familyId: FAMILY_ID,
          familyName: "Safe Tools",
          generationId,
        },
      });
    }
  });

  it("invokes selected safe tools through the real agent tool path", async () => {
    await configureScope();
    await c.createAgent("safe-agent", "Safe Agent", {
      role: "Runs safe hosted integration smoke tools.",
      persona: "Use safe hosted integrations.",
      tools: ["safe_echo", "safe_sum", "safe_large_result"],
      hostedIntegrationBindings: [
        {
          familyId: FAMILY_ID,
          toolName: "safe_echo",
          allowedConfigScopeIds: [CONFIG_SCOPE_ID],
          defaultConfigScopeId: CONFIG_SCOPE_ID,
          environment: "test",
        },
        {
          familyId: FAMILY_ID,
          toolName: "safe_sum",
          allowedConfigScopeIds: [CONFIG_SCOPE_ID],
          defaultConfigScopeId: CONFIG_SCOPE_ID,
          environment: "test",
        },
        {
          familyId: FAMILY_ID,
          toolName: "safe_large_result",
          allowedConfigScopeIds: [CONFIG_SCOPE_ID],
          defaultConfigScopeId: CONFIG_SCOPE_ID,
          environment: "test",
        },
      ],
    });

    const tools = toolRegistry.getVercelTools(
      new Set(["safe_echo", "safe_sum", "safe_large_result"]),
    ) as Record<
      string,
      { execute: (args: Record<string, unknown>) => Promise<string> }
    >;

    const echo = await invokeAgentTool(tools.safe_echo!, {
      text: "agent settings path",
    });
    expect(echo).toMatchObject({
      ok: true,
      replayed: false,
      generationId,
      envelope: { ok: true, result: { echo: "agent settings path" } },
    });

    const sum = await invokeAgentTool(tools.safe_sum!, {
      values: [10, 20, 12],
    });
    expect(sum).toMatchObject({
      ok: true,
      replayed: false,
      generationId,
      envelope: { ok: true, result: { sum: 42, count: 3 } },
    });

    const large = await invokeAgentTool(tools.safe_large_result!, {
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

async function configureScope(): Promise<void> {
  const scope = await c.req(
    `/api/hosted-integrations/config-scopes/${CONFIG_SCOPE_ID}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: FAMILY_ID,
        environment: "test",
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
    "tools:",
    "  - name: safe_echo",
    "    title: Safe Echo",
    "    description: Echoes caller-provided text for safe hosted integration smoke testing.",
    "    lifecycle: active",
    "    inputSchema:",
    "      type: object",
    "      required: [text]",
    "      properties:",
    "        text:",
    "          type: string",
    "      additionalProperties: false",
    "    classification:",
    "      operation: read",
    "      freshness: live",
    "      idempotency: idempotent",
    "      execution: sync",
    "      approval: none",
    "  - name: safe_sum",
    "    title: Safe Sum",
    "    description: Sums numeric values for deterministic hosted integration smoke testing.",
    "    lifecycle: active",
    "    inputSchema:",
    "      type: object",
    "      required: [values]",
    "      properties:",
    "        values:",
    "          type: array",
    "      additionalProperties: false",
    "    classification:",
    "      operation: read",
    "      freshness: live",
    "      idempotency: idempotent",
    "      execution: sync",
    "      approval: none",
    "  - name: safe_large_result",
    "    title: Safe Large Result",
    "    description: Returns a large deterministic payload to verify result_ref spillover.",
    "    lifecycle: active",
    "    inputSchema:",
    "      type: object",
    "      required: [repeat]",
    "      properties:",
    "        repeat:",
    "          type: number",
    "      additionalProperties: false",
    "    classification:",
    "      operation: read",
    "      freshness: live",
    "      idempotency: idempotent",
    "      execution: sync",
    "      approval: none",
    "",
  ].join("\n");
}

function safeToolsPython(): string {
  return [
    "def call_tool(name, args, ctx):",
    "    if name == 'safe_echo':",
    "        text = args.get('text')",
    "        if not isinstance(text, str):",
    "            raise ValueError('text must be a string')",
    "        return {'echo': text}",
    "    if name == 'safe_sum':",
    "        values = args.get('values')",
    "        if not isinstance(values, list) or not all(isinstance(v, (int, float)) for v in values):",
    "            raise ValueError('values must be numeric')",
    "        return {'sum': sum(values), 'count': len(values)}",
    "    if name == 'safe_large_result':",
    "        repeat = args.get('repeat')",
    "        if not isinstance(repeat, int) or repeat < 1:",
    "            raise ValueError('repeat must be a positive integer')",
    "        return {'payload': '0123456789abcdef' * repeat}",
    "    raise ValueError('unknown tool')",
    "",
  ].join("\n");
}

function positivePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}
