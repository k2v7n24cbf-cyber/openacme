import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import {
  createFileHostedIntegrationConfigScopeStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
} from "@openacme/hosted-integrations";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let authToken: string;
let generationCounter: number;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-hosted-routes-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager } = await createApp(config));
  generationCounter = 0;
  const member = manager.authStore.createMember({
    email: "test@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
});

afterEach(async () => {
  await manager.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function req(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return app.request(`http://127.0.0.1${p}`, { ...init, headers });
}

function writeFamily(
  familyId: string,
  yaml: string,
  files: Record<string, string> = {},
): void {
  const dir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "family.yaml"), yaml);
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(dir, relPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
}

function familyYaml(id: string, name: string, toolName: string): string {
  return `
id: ${id}
name: ${name}
version: 1
runtime:
  language: python
  entrypoint: ${id}.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: ${toolName}
    title: ${name} read
    description: Read safe ${name} metadata.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

function lifecycleFamilyYaml(): string {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets matching a query.
    lifecycle: hidden
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_list_assets
    title: List assets
    description: List assets matching a query.
    lifecycle: deprecated
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_delete_asset
    title: Delete asset
    description: Delete one asset.
    lifecycle: removed
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: destructive
      freshness: live
      idempotency: non_idempotent
      execution: sync
      approval: human
`;
}

describe("hosted integrations read-only routes", () => {
  it("lists families from the hosted integrations source catalog", async () => {
    writeFamily("splunk", familyYaml("splunk", "Splunk", "splunk_search"));
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    const res = await req("/api/hosted-integrations/families");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      families: [
        {
          id: "qualys",
          name: "Qualys",
          status: "active",
          version: 1,
          toolNames: ["qualys_count_assets"],
        },
        {
          id: "splunk",
          name: "Splunk",
          status: "active",
          version: 1,
          toolNames: ["splunk_search"],
        },
      ],
    });
  });

  it("returns sanitized family detail and tool metadata", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req("/api/hosted-integrations/families/qualys");
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail).toMatchObject({
      family: {
        summary: {
          id: "qualys",
          status: "active",
          toolNames: ["qualys_count_assets"],
        },
      },
    });
    expect(JSON.stringify(detail)).not.toContain("source/families");
    expect(JSON.stringify(detail)).not.toContain("secret");

    res = await req("/api/hosted-integrations/families/qualys/tools");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tools: [
        {
          name: "qualys_count_assets",
          classification: { operation: "read" },
        },
      ],
    });
  });

  it("omits hidden and removed hosted tools from new selection routes", async () => {
    writeFamily("qualys", lifecycleFamilyYaml());

    let res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      families: [
        {
          id: "qualys",
          toolNames: ["qualys_list_assets"],
        },
      ],
    });

    res = await req("/api/hosted-integrations/families/qualys/tools");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tools: [
        {
          name: "qualys_list_assets",
          lifecycle: "deprecated",
        },
      ],
    });
  });

  it("404s unknown families and does not expose malformed source contents", async () => {
    writeFamily(
      "broken",
      "id: Broken Prod\nname: SECRET_TOKEN\nversion: nope\n",
    );

    let res = await req("/api/hosted-integrations/families/missing");
    expect(res.status).toBe(404);

    res = await req("/api/hosted-integrations/families/broken");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });

    res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET_TOKEN");
  });
});

describe("hosted integrations proposed family routes", () => {
  it("creates a proposed family draft and keeps it out of the runtime tool surface", async () => {
    let res = await req("/api/hosted-integrations/families", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "github",
        name: "GitHub",
        toolName: "github_search",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({
      family: {
        id: "github",
        name: "GitHub",
        status: "proposed",
        toolNames: ["github_search"],
      },
      lock: { familyId: "github", lockedBy: "agent:tool-developer" },
      draft: { familyId: "github", status: "open" },
      sourceRevisionId: "proposed_initial",
    });

    const draftId = created.draft.id as string;
    res = await req(`/api/hosted-integrations/drafts/${draftId}/validate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, diagnostics: [] });

    res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      families: [
        {
          id: "github",
          name: "GitHub",
          status: "proposed",
          version: 1,
          toolNames: ["github_search"],
          draftId,
          lockId: created.lock.id,
          sourceRevisionId: "proposed_initial",
        },
      ],
    });

    res = await req("/api/tools");
    expect(res.status).toBe(200);
    const toolsBody = await res.json();
    expect(JSON.stringify(toolsBody)).not.toContain("github_search");

    res = await req("/api/hosted-integrations/families", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "github",
        name: "GitHub duplicate",
        toolName: "github_other",
        lockedBy: "agent:tool-developer",
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_family" });
  });
});

describe("hosted integrations draft control plane routes", () => {
  it("manages family locks and reads canonical source files path-safely", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": "def run():\n    return {'ok': True}\n",
        "docs/readme.md": "# Qualys\n",
      },
    );

    let res = await req("/api/hosted-integrations/families/qualys/lock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    });
    expect(res.status).toBe(201);
    const lockBody = await res.json();
    expect(lockBody).toMatchObject({
      lock: {
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
      },
    });
    const lockId = lockBody.lock.id as string;

    res = await req("/api/hosted-integrations/families/qualys/source/files");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      files: [
        { path: "docs/readme.md" },
        { path: "family.yaml" },
        { path: "qualys.py" },
      ],
    });

    res = await req(
      "/api/hosted-integrations/families/qualys/source/files/qualys.py",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "qualys.py",
      content: "def run():\n    return {'ok': True}\n",
    });

    res = await req(
      "/api/hosted-integrations/families/qualys/source/files/..%2Fsecret.txt",
    );
    expect(res.status).toBe(400);

    res = await req(`/api/hosted-integrations/locks/${lockId}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lockedBy: "agent:tool-developer",
        ttlMs: 120_000,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lock: { id: lockId } });

    res = await req(`/api/hosted-integrations/locks/${lockId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockedBy: "agent:other" }),
    });
    expect(res.status).toBe(409);

    res = await req(`/api/hosted-integrations/locks/${lockId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockedBy: "agent:tool-developer" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates drafts, edits files with the active lock, upserts examples, and validates", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": "def run():\n    return {'ok': True}\n",
      },
    );

    let res = await req("/api/hosted-integrations/families/qualys/lock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    });
    const lockId = ((await res.json()) as { lock: { id: string } }).lock.id;

    res = await req("/api/hosted-integrations/families/qualys/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockId, sourceRevisionId: "source_rev_1" }),
    });
    expect(res.status).toBe(201);
    const draftId = ((await res.json()) as { draft: { id: string } }).draft.id;

    res = await req(`/api/hosted-integrations/drafts/${draftId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      draft: { id: draftId, familyId: "qualys", lockId },
    });

    res = await req(`/api/hosted-integrations/drafts/${draftId}/files`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      files: [{ path: "family.yaml" }, { path: "qualys.py" }],
    });

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/qualys.py`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lockId,
          content: "def run():\n    return {'changed': True}\n",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/..%2Fmetadata.json`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockId, content: "bad" }),
      },
    );
    expect(res.status).toBe(400);

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/qualys.py`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockId: "lock_wrong" }),
      },
    );
    expect(res.status).toBe(409);

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/qualys.py`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lockId,
          content: "def run():\n    return {'ok': True}\n",
        }),
      },
    );
    expect(res.status).toBe(200);

    res = await req(`/api/hosted-integrations/drafts/${draftId}/examples`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lockId,
        example: {
          id: "smoke_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "smoke",
          args: {},
          expected: { count: 0 },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    res = await req(`/api/hosted-integrations/drafts/${draftId}/examples`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      examples: [{ id: "smoke_count", toolName: "qualys_count_assets" }],
    });

    res = await req(`/api/hosted-integrations/drafts/${draftId}/validate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, diagnostics: [] });
  });
});

describe("hosted integrations config scope and secret routes", () => {
  it("lists and reads config scopes with sanitized secret metadata only", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req("/api/hosted-integrations/config-scopes/qualys-prod", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://qualys.example" },
        secrets: {
          QUALYS_USERNAME: {
            configured: false,
            value: "must-not-survive",
          },
        },
        updatedBy: "human:alen",
      }),
    });
    expect(res.status).toBe(200);

    res = await req("/api/hosted-integrations/config-scopes");
    expect(res.status).toBe(200);
    const listBody = await res.json();
    expect(listBody).toEqual({
      configScopes: [
        {
          id: "qualys-prod",
          familyId: "qualys",
          revision: 1,
          environment: "prod",
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: { QUALYS_USERNAME: { configured: false } },
          updatedAt: expect.any(String),
          updatedBy: "human:alen",
        },
      ],
    });
    expect(JSON.stringify(listBody)).not.toContain("must-not-survive");

    res = await req("/api/hosted-integrations/config-scopes/qualys-prod");
    expect(res.status).toBe(200);
    const detailBody = await res.json();
    expect(detailBody).toMatchObject({
      configScope: {
        id: "qualys-prod",
        secrets: { QUALYS_USERNAME: { configured: false } },
      },
    });
    expect(JSON.stringify(detailBody)).not.toContain("must-not-survive");
  });

  it("increments config-scope revision on PUT and maps validation failures", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req("/api/hosted-integrations/config-scopes/qualys-prod", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://old.example" },
        updatedBy: "human:alen",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configScope: { id: "qualys-prod", revision: 1 },
    });

    res = await req("/api/hosted-integrations/config-scopes/qualys-prod", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://new.example" },
        updatedBy: "human:alen",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configScope: {
        id: "qualys-prod",
        revision: 2,
        config: { QUALYS_BASE_URL: "https://new.example" },
      },
    });

    res = await req("/api/hosted-integrations/config-scopes/missing-prod", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "missing",
        environment: "prod",
        config: {},
        updatedBy: "human:alen",
      }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "family_not_found" });
  });

  it("requires a human session to write secrets and never echoes values", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req("/api/hosted-integrations/config-scopes/qualys-prod", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://qualys.example" },
        secrets: {
          QUALYS_USERNAME: { configured: false },
          QUALYS_PASSWORD: { configured: false },
        },
        updatedBy: "human:alen",
      }),
    });
    expect(res.status).toBe(200);

    res = await req(
      "/api/hosted-integrations/config-scopes/qualys-prod/secrets",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secrets: { QUALYS_USERNAME: "api-user" },
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(200);
    const secretBody = await res.json();
    expect(secretBody).toMatchObject({
      metadata: {
        scopeId: "qualys-prod",
        secrets: {
          QUALYS_USERNAME: { configured: true },
          QUALYS_PASSWORD: { configured: false },
        },
      },
      configScope: {
        id: "qualys-prod",
        revision: 2,
        secrets: {
          QUALYS_USERNAME: { configured: true },
          QUALYS_PASSWORD: { configured: false },
        },
      },
    });
    expect(JSON.stringify(secretBody)).not.toContain("api-user");

    res = await req(
      "/api/hosted-integrations/config-scopes/qualys-prod/secrets",
      {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "" },
        body: JSON.stringify({
          secrets: { QUALYS_PASSWORD: "super-secret" },
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(401);
  });
});

describe("hosted integrations approval routes", () => {
  it("creates human approval records and rejects requests without a human session", async () => {
    let res = await req("/api/hosted-integrations/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: {
          familyId: "qualys",
          draftId: "draft_123",
          draftRevisionId: "draft_rev_1",
          operation: "promote",
          operationClass: "destructive",
          toolNames: ["qualys_delete_asset"],
          destructiveToolNames: ["qualys_delete_asset"],
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      approval: {
        familyId: "qualys",
        draftId: "draft_123",
        draftRevisionId: "draft_rev_1",
        operation: "promote",
        operationClass: "destructive",
        approvedByEmail: "test@example.com",
        target: {
          destructiveToolNames: ["qualys_delete_asset"],
        },
      },
    });

    res = await req("/api/hosted-integrations/approvals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "" },
      body: JSON.stringify({
        target: {
          familyId: "qualys",
          draftId: "draft_123",
          draftRevisionId: "draft_rev_1",
          operation: "promote",
          operationClass: "destructive",
        },
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("hosted integrations invocation routes", () => {
  it("enforces access policy before runtime dispatch", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
      },
    );
    await promoteFamily("qualys");
    await seedConfigScope("qualys", "qualys-test", "test");

    const res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: agentActor(),
        familyId: "qualys",
        toolName: "qualys_count_assets",
        environment: "test",
        args: {},
        bindings: [],
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("invokes, exposes sanitized run detail, and authorizes artifact reads", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
      },
    );
    await promoteFamily("qualys");
    await seedConfigScope("qualys", "qualys-test", "test");

    let res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(200);
    const invoked = await res.json();
    expect(invoked).toMatchObject({
      ok: true,
      replayed: false,
      envelope: { ok: true, result: { count: 2 } },
    });
    const runId = invoked.runId as string;

    res = await req(
      `/api/hosted-integrations/runs/${runId}?actorId=agent:analyst`,
    );
    expect(res.status).toBe(200);
    const runBody = await res.json();
    expect(runBody).toMatchObject({
      run: {
        runId,
        actorId: "agent:analyst",
        configScopeId: "qualys-test",
        configRevision: 1,
        status: "succeeded",
      },
    });
    expect(JSON.stringify(runBody)).not.toContain("apiToken");

    res = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/output.json`,
    );
    expect(res.status).toBe(403);

    res = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/output.json?actorId=agent:analyst`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId,
      name: "output.json",
      content: expect.stringContaining('"count": 2'),
    });
  });

  it("allows the Tool Developer Agent to inspect sanitized failure artifacts", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("raise ValueError('super-secret-token')"),
      },
    );
    await promoteFamily("qualys");
    await seedConfigScope("qualys", "qualys-test", "test");

    const res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(500);
    const failed = await res.json();
    const runId = failed.runId as string;

    const ordinary = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/error.json?roles=management_tool`,
    );
    expect(ordinary.status).toBe(403);

    const developer = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/error.json?roles=tool_developer`,
    );
    expect(developer.status).toBe(200);
    const body = await developer.json();
    expect(body.content).toContain("tool_bug");
    expect(body.content).not.toContain("super-secret-token");
  });

  it("debug-runs can target drafts or promoted generations when policy allows", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'debug': True}"),
      },
    );
    const draftId = await createDraft("qualys");
    await promoteFamily("qualys", draftId);
    await seedConfigScope("qualys", "qualys-test", "test");

    let res = await req("/api/hosted-integrations/debug-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        operationClass: "read",
        draftId,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, target: "draft" });

    res = await req("/api/hosted-integrations/debug-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        familyId: "qualys",
        toolName: "qualys_count_assets",
        environment: "test",
        configScopeId: "qualys-test",
        operationClass: "read",
        args: {},
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      replayed: false,
      envelope: { ok: true, result: { debug: true } },
    });
  });

  it("debug-run route denies write replay unless explicitly allowed", async () => {
    const res = await req("/api/hosted-integrations/debug-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        operationClass: "write",
        draftId: "draft_1",
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "approval_required" },
    });
  });
});

describe("hosted integrations generation routes", () => {
  it("lists active and retired generations and returns promotion provenance detail", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 1}"),
      },
    );
    const firstGenerationId = await promoteFamily("qualys");
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
      },
    );
    const secondGenerationId = await promoteFamily("qualys");

    let res = await req("/api/hosted-integrations/generations?familyId=qualys");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generations: [
        { id: secondGenerationId, familyId: "qualys", status: "active" },
        { id: firstGenerationId, familyId: "qualys", status: "retired" },
      ],
    });

    res = await req(
      `/api/hosted-integrations/generations/${firstGenerationId}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generation: {
        id: firstGenerationId,
        familyId: "qualys",
        status: "retired",
        provenance: {
          promotedBy: "agent:tool-developer",
          validation: { ok: true, diagnostics: [] },
        },
      },
    });
  });

  it("enforces rollback policy", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 1}"),
      },
    );
    const generationId = await promoteFamily("qualys");

    const res = await req(
      `/api/hosted-integrations/generations/${generationId}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: agentActor() }),
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("rolls back only the active pointer without rewriting source or secrets", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 1}"),
      },
    );
    const firstGenerationId = await promoteFamily("qualys");
    await seedConfigScope("qualys", "qualys-test", "test");
    await createFileHostedIntegrationSecretStore({
      dataDir,
    }).writeHumanOwnedSecrets({
      scopeId: "qualys-test",
      secrets: { apiToken: "new-token-456" },
      updatedBy: "human:alen",
    });

    const currentSource = pythonTool("return {'count': 2}");
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": currentSource,
      },
    );
    await promoteFamily("qualys");

    const res = await req(
      `/api/hosted-integrations/generations/${firstGenerationId}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor() }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      activeGeneration: { id: firstGenerationId, status: "active" },
    });

    await expect(
      createFileHostedIntegrationSecretStore({
        dataDir,
      }).readSecretsForRuntime({ scopeId: "qualys-test" }),
    ).resolves.toEqual({ apiToken: "new-token-456" });
    expect(
      readFileSync(
        path.join(
          dataDir,
          "hosted-integrations",
          "source",
          "families",
          "qualys",
          "qualys.py",
        ),
        "utf-8",
      ),
    ).toBe(currentSource);
  });
});

describe("hosted integrations operational disablement routes", () => {
  it("sets, lists, and enforces operational disablements", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
      },
    );
    await promoteFamily("qualys");
    await seedConfigScope("qualys", "qualys-test", "test");

    let res = await req("/api/hosted-integrations/disablements", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: agentActor(),
        disabled: true,
        target: { level: "family", familyId: "qualys" },
      }),
    });
    expect(res.status).toBe(403);

    res = await req("/api/hosted-integrations/disablements", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        disabled: true,
        reason: "maintenance",
        target: { level: "family", familyId: "qualys" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      disablement: {
        key: "family:qualys",
        disabled: true,
        target: { level: "family", familyId: "qualys" },
        updatedBy: "agent:tool-developer",
      },
    });

    res = await req("/api/hosted-integrations/disablements");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      disablements: [
        {
          key: "family:qualys",
          disabled: true,
        },
      ],
    });

    res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "operationally_disabled" },
    });
  });
});

function agentActor() {
  return { id: "agent:analyst", kind: "agent", roles: ["agent"] };
}

function toolDeveloperActor() {
  return {
    id: "agent:tool-developer",
    kind: "agent",
    roles: ["tool_developer"],
  };
}

function allowedInvokeBody() {
  return {
    actor: agentActor(),
    familyId: "qualys",
    toolName: "qualys_count_assets",
    environment: "test",
    args: {},
    bindings: [
      {
        agentId: "agent:analyst",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedConfigScopeIds: ["qualys-test"],
        defaultConfigScopeId: "qualys-test",
        environment: "test",
      },
    ],
  };
}

async function seedConfigScope(
  familyId: string,
  scopeId: string,
  environment: string,
): Promise<void> {
  await createFileHostedIntegrationConfigScopeStore({
    dataDir,
  }).upsertConfigScope({
    scopeId,
    familyId,
    environment,
    config: { endpoint: "https://qualys.example.test" },
    secrets: { apiToken: { configured: true } },
    updatedBy: "human:alen",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    scopeId,
    secrets: { apiToken: "raw-token-123" },
    updatedBy: "human:alen",
  });
}

async function createDraft(familyId: string): Promise<string> {
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    createId: () => `lock_${familyId}`,
  });
  await lockStore.acquireLock({
    familyId,
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const draftStore = createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    createId: () => `draft_${familyId}`,
  });
  const draft = await draftStore.createDraft({
    familyId,
    lockId: `lock_${familyId}`,
    sourceRevisionId: "source_rev_1",
  });
  if (!draft.ok) throw new Error(draft.reason);
  return draft.draft.id;
}

async function promoteFamily(
  familyId: string,
  existingDraftId?: string,
): Promise<string> {
  const draftId = existingDraftId ?? (await createDraft(familyId));
  const generation = await createFileHostedIntegrationGenerationStore({
    dataDir,
    createId: () => `gen_${familyId}_${++generationCounter}`,
  }).promoteDraft({
    draftId,
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  if (!generation.ok) throw new Error(generation.reason);
  return generation.generation.id;
}

function pythonTool(body: string): string {
  return `def call_tool(name, args, ctx):\n    ${body}\n`;
}
