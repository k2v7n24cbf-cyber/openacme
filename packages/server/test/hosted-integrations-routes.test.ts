import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let authToken: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-hosted-routes-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager } = await createApp(config));
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

describe("hosted integrations read-only routes", () => {
  it("lists families from the hosted integrations source catalog", async () => {
    writeFamily("splunk", familyYaml("splunk", "Splunk", "splunk_search"));
    writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));

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
    writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));

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

  it("404s unknown families and does not expose malformed source contents", async () => {
    writeFamily("broken", "id: Broken Prod\nname: SECRET_TOKEN\nversion: nope\n");

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
