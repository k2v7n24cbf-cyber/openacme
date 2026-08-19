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
import { AgentDefinitionSchema, ConfigSchema } from "@openacme/config";
import {
  createDbHostedIntegrationService,
  createFileHostedIntegrationEnvironmentConfigStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
} from "@openacme/hosted-integrations";
import { withSplitToolContractFiles } from "../../hosted-integrations/test/test-support/split-contract-fixtures.js";
import { createDatabase } from "@openacme/db";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let runtime: Awaited<ReturnType<typeof createApp>>["runtime"];
let closeApp: () => Promise<void>;
let authToken: string;
let generationCounter: number;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-hosted-routes-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager, runtime, close: closeApp } = await createApp(config));
  generationCounter = 0;
  const member = manager.authStore.createMember({
    email: "test@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
});

afterEach(async () => {
  await closeApp();
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
  const splitFiles = withSplitToolContractFiles({
    "family.yaml": yaml,
    ...files,
  });
  for (const [relPath, content] of Object.entries(splitFiles)) {
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
runtimeConfig:
  requiredConfigKeys: []
  requiredSecretKeys: []
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

function hostedFamilyPackageDocument(
  id: string,
  name: string,
  toolName: string,
): Record<string, unknown> {
  const files = withSplitToolContractFiles({
    "family.yaml": familyYaml(id, name, toolName),
    [`${id}.py`]: hostedPackagePythonSource(toolName),
  });
  return {
    kind: "openacme.hostedFamilyPackage",
    version: 1,
    metadata: { familyId: id },
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      content,
    })),
  };
}

function hostedPackagePythonSource(toolName: string): string {
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
    `def tool_${toolName}(args, context):`,
    "    return {'ok': True}",
    "",
  ].join("\n");
}

function asyncFamilyYaml(id: string, name: string, toolName: string): string {
  return familyYaml(id, name, toolName).replace(
    "      execution: sync",
    "      execution: async",
  );
}

function familyYamlWithRuntimeConfigContract(input: {
  requiredConfigKeys: string[];
  requiredSecretKeys: string[];
}): string {
  const configKeys =
    input.requiredConfigKeys.length === 0
      ? "[]"
      : `\n${input.requiredConfigKeys.map((key) => `    - ${key}`).join("\n")}`;
  const secretKeys =
    input.requiredSecretKeys.length === 0
      ? "[]"
      : `\n${input.requiredSecretKeys.map((key) => `    - ${key}`).join("\n")}`;
  return familyYaml("qualys", "Qualys", "qualys_count_assets").replace(
    "runtimeConfig:\n  requiredConfigKeys: []\n  requiredSecretKeys: []",
    `runtimeConfig:\n  requiredConfigKeys: ${configKeys}\n  requiredSecretKeys: ${secretKeys}`,
  );
}

function familyYamlWithoutRuntimeConfigContract(): string {
  return familyYaml("qualys", "Qualys", "qualys_count_assets").replace(
    "runtimeConfig:\n  requiredConfigKeys: []\n  requiredSecretKeys: []\n",
    "",
  );
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

function destructiveFamilyYaml(): string {
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
runtimeConfig:
  requiredConfigKeys: []
  requiredSecretKeys: []
tools:
  - name: qualys_delete_asset
    title: Delete asset
    description: Delete one asset.
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
    expectNoValidationErrors(await res.json());

    res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ families: [] });

    res = await req("/api/hosted-integrations/families?includeProposed=true");
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

  it("validates a hosted family package through the product API without creating a draft", async () => {
    const packageDocument = hostedFamilyPackageDocument(
      "github",
      "GitHub",
      "github_search",
    );
    let res = await req("/api/hosted-integrations/packages/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        packageDocument,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "help_example_missing" }),
      ]),
      files: ["family.yaml", "github.py", "tools.yaml"],
    });

    res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ families: [] });

    res = await req("/api/hosted-integrations/packages/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        packageDocument,
        targetFamilyId: "splunk",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "package_target_family_mismatch",
        }),
      ]),
    });
  });

  it("rejects operational artifact paths through package validate and import APIs", async () => {
    const packageDocument = hostedFamilyPackageDocument(
      "github",
      "GitHub",
      "github_search",
    );
    const unsafePackageDocument = {
      ...packageDocument,
      files: [
        ...((packageDocument.files as Array<Record<string, unknown>>) ?? []),
        { path: "logs/invocation.json", content: "{}" },
      ],
    };

    let res = await req("/api/hosted-integrations/packages/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        packageDocument: unsafePackageDocument,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "package_file_path_operational",
        }),
      ]),
      files: [],
    });

    res = await req("/api/hosted-integrations/packages/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        mode: "create",
        packageDocument: unsafePackageDocument,
        ttlMs: 60_000,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_package" },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "package_file_path_operational",
        }),
      ]),
    });

    res = await req("/api/hosted-integrations/families?includeProposed=true");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ families: [] });
  });

  it("rejects package export when source files contain raw secret-shaped content", async () => {
    writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"), {
      "qualys.py":
        hostedPackagePythonSource("qualys_count_assets") +
        "\nAPI_TOKEN = 'raw-token-export-leak'\n",
    });

    const res = await req("/api/hosted-integrations/packages/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        source: { type: "current_source", familyId: "qualys" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: "invalid_package" },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "package_file_secret",
          message:
            "file qualys.py contains secret-shaped content; remove raw credentials before package import/export",
        }),
      ]),
    });
    expect(JSON.stringify(body)).not.toContain("raw-token-export-leak");
    expect(JSON.stringify(body)).not.toContain("packageDocument");
  });

  it("imports a hosted family package through the product API without promoting it", async () => {
    const res = await req("/api/hosted-integrations/packages/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        mode: "create",
        packageDocument: hostedFamilyPackageDocument(
          "github",
          "GitHub",
          "github_search",
        ),
        ttlMs: 60_000,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      mode: "create",
      family: {
        id: "github",
        name: "GitHub",
        status: "proposed",
        toolNames: ["github_search"],
      },
      validation: { ok: true },
      nextAction: "run_examples",
    });
    expect(body.importedFiles).toEqual([
      "family.yaml",
      "github.py",
      "tools.yaml",
    ]);

    const exportRes = await req("/api/hosted-integrations/packages/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        source: { type: "draft", draftId: body.draft.id },
        includeExamples: false,
      }),
    });
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json();
    expect(exportBody).toMatchObject({
      ok: true,
      packageDocument: {
        kind: "openacme.hostedFamilyPackage",
        metadata: {
          familyId: "github",
          exportedBy: "agent:tool-developer",
          sourceDraftId: body.draft.id,
        },
      },
      exportedFiles: ["family.yaml", "github.py", "tools.yaml"],
    });
    expect(JSON.stringify(exportBody)).not.toContain("secret");

    const familiesRes = await req(
      "/api/hosted-integrations/families?includeProposed=true",
    );
    expect(familiesRes.status).toBe(200);
    expect(await familiesRes.json()).toMatchObject({
      families: [
        {
          id: "github",
          status: "proposed",
          toolNames: ["github_search"],
        },
      ],
    });
    await expect(runtime.hostedIntegrationService.generations.listGenerations())
      .resolves.toEqual([]);
  });

  it("allows environment config setup for imported proposed families before promotion", async () => {
    const packageDocument = {
      kind: "openacme.hostedFamilyPackage",
      version: 1,
      metadata: { familyId: "qualys" },
      files: Object.entries(
        withSplitToolContractFiles({
          "family.yaml": familyYamlWithRuntimeConfigContract({
            requiredConfigKeys: ["QUALYS_BASE_URL"],
            requiredSecretKeys: ["QUALYS_PASSWORD"],
          }),
          "qualys.py": hostedPackagePythonSource("qualys_count_assets"),
        }),
      ).map(([filePath, content]) => ({ path: filePath, content })),
    };

    let res = await req("/api/hosted-integrations/packages/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        mode: "create",
        packageDocument,
        ttlMs: 60_000,
      }),
    });
    expect(res.status).toBe(201);
    const imported = (await res.json()) as {
      draft: { id: string };
      lock: { id: string };
    };

    res = await req("/api/hosted-integrations/environment-configs/qualys/prod", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: { QUALYS_BASE_URL: "https://qualys.example" },
        secrets: { QUALYS_PASSWORD: { configured: true } },
        updatedBy: "human:test",
      }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      environmentConfig: {
        id: "qualys-prod",
        familyId: "qualys",
        environment: "prod",
      },
    });

    await upsertSmokeExample(imported.draft.id, imported.lock.id);

    res = await req(
      `/api/hosted-integrations/drafts/${imported.draft.id}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          lockId: imported.lock.id,
        }),
      },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      generation: { familyId: "qualys", status: "active" },
    });
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

    res = await req("/api/hosted-integrations/families/qualys/lock");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      lock: { id: lockId, familyId: "qualys" },
    });

    res = await req("/api/hosted-integrations/families/qualys/source/files");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      files: [
        { path: "docs/readme.md" },
        { path: "family.yaml" },
        { path: "qualys.py" },
        { path: "tools.yaml" },
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

    res = await req(
      "/api/hosted-integrations/families/qualys/source/files/..%2Fraw-token-route-leak",
    );
    expect(res.status).toBe(400);
    const unsafePathBody = await res.json();
    expect(JSON.stringify(unsafePathBody)).not.toContain("raw-token-route-leak");
    expect(unsafePathBody).toEqual({
      error: "path escapes source root",
    });

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

    res = await req("/api/hosted-integrations/families/qualys/lock");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lock: null });
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
      files: [{ path: "family.yaml" }, { path: "qualys.py" }, { path: "tools.yaml" }],
    });

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/qualys.py`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lockId,
          lockedBy: "agent:other",
          content: "def run():\n    return {'changed': False}\n",
        }),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "lock_conflict" });

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/qualys.py`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lockId,
          lockedBy: "agent:tool-developer",
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
          content: pythonTool("return {'ok': True}"),
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

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/tools/qualys_count_assets/help`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lockId,
          lockedBy: "agent:tool-developer",
          help: {
            summary: "Count assets with documented filters.",
            full: "Use this tool when the caller only needs a count.",
            whenToUse: ["Count assets."],
            whenNotToUse: ["Do not fetch records."],
            parameters: {
              filter_body: {
                summary: "Native filter body.",
                full: "Use native Qualys filter field names.",
                rules: ["asset_last_updated is not a filter field."],
                examples: [{ filter_body: { filters: [] } }],
              },
            },
            examples: [{ args: {} }],
            noExampleJustification: "Registered smoke example exists.",
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    res = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/tools.yaml`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { content: string }).toMatchObject({
      content: expect.stringContaining(
        "description: Count assets with documented filters.",
      ),
    });

    res = await req(`/api/hosted-integrations/drafts/${draftId}/validate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expectNoValidationErrors(await res.json());
  });

  it("returns focused source views to the Tool Developer Agent", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": [
          "def normalize(args):",
          "    return args",
          "",
          "def tool_qualys_count_assets(args, context):",
          "    return {'count': len(normalize(args))}",
          "",
        ].join("\n"),
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
    const draftId = ((await res.json()) as { draft: { id: string } }).draft.id;

    res = await req("/api/hosted-integrations/source-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "agent:analyst", kind: "agent" },
        draftId,
        familyId: "qualys",
        toolName: "qualys_count_assets",
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });

    res = await req("/api/hosted-integrations/source-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "human:viewer", kind: "human", roles: [] },
        draftId,
        familyId: "qualys",
        toolName: "qualys_count_assets",
      }),
    });
    expect(res.status).toBe(403);

    res = await req("/api/hosted-integrations/source-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: {
          id: "web-settings",
          kind: "human",
          roles: ["tool_developer"],
        },
        draftId,
        familyId: "qualys",
        toolName: "qualys_count_assets",
        includeSharedHelpers: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      view: {
        mode: "focused",
        source: {
          selectedHandler: {
            source: expect.stringContaining("def tool_qualys_count_assets"),
          },
          helpers: [{ name: "normalize" }],
        },
      },
    });
  });
});

describe("hosted integrations environment config routes", () => {
  it("lists, reads, and upserts canonical environment configs", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req(
      "/api/hosted-integrations/environment-configs/qualys/prod",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: {
            QUALYS_USERNAME: {
              configured: false,
              value: "must-not-survive",
            },
          },
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      environmentConfig: {
        id: "qualys-prod",
        familyId: "qualys",
        environment: "prod",
        revision: 1,
        config: { QUALYS_BASE_URL: "https://qualys.example" },
        secrets: { QUALYS_USERNAME: { configured: false } },
        updatedBy: "human:alen",
      },
    });

    res = await req("/api/hosted-integrations/environment-configs");
    expect(res.status).toBe(200);
    const listBody = await res.json();
    expect(listBody.environmentConfigs).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain("must-not-survive");

    res = await req("/api/hosted-integrations/environment-configs/qualys/prod");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      environmentConfig: { id: "qualys-prod", environment: "prod" },
    });

    res = await req(
      "/api/hosted-integrations/environment-configs/qualys/stage",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: {},
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_environment" });
  });

  it("updates environment config secret metadata without echoing secret values", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req(
      "/api/hosted-integrations/environment-configs/qualys/test_debug",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: {
            QUALYS_USERNAME: { configured: false },
            QUALYS_PASSWORD: { configured: false },
          },
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(200);

    res = await req(
      "/api/hosted-integrations/environment-configs/qualys/test_debug/secrets",
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
    const body = await res.json();
    expect(body).toMatchObject({
      metadata: {
        environmentConfigId: "qualys-test_debug",
        secrets: {
          QUALYS_USERNAME: { configured: true },
          QUALYS_PASSWORD: { configured: false },
        },
      },
      environmentConfig: {
        id: "qualys-test_debug",
        revision: 2,
        secrets: {
          QUALYS_USERNAME: { configured: true },
          QUALYS_PASSWORD: { configured: false },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("api-user");
  });
});

describe("hosted integrations readiness routes", () => {
  it("returns sanitized environment config readiness states", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );

    let res = await req(
      "/api/hosted-integrations/readiness/environment-configs/qualys/prod",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      readiness: {
        kind: "environment_config",
        status: "blocked",
        code: "missing",
        target: {
          familyId: "qualys",
          environment: "prod",
          environmentConfigId: "qualys-prod",
        },
      },
    });

    res = await req(
      "/api/hosted-integrations/environment-configs/qualys/prod",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { endpoint: "https://qualys.example.test" },
          secrets: { apiToken: { configured: false } },
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(200);

    res = await req(
      "/api/hosted-integrations/readiness/environment-configs/qualys/prod",
    );
    expect(res.status).toBe(200);
    const incomplete = await res.json();
    expect(incomplete).toMatchObject({
      ok: true,
      readiness: {
        kind: "environment_config",
        status: "blocked",
        code: "incomplete",
        blockers: [
          {
            code: "missing_secret",
            path: "secrets.apiToken",
          },
        ],
      },
    });
    expect(JSON.stringify(incomplete)).not.toContain("qualys.example.test");

    res = await req(
      "/api/hosted-integrations/environment-configs/qualys/prod/secrets",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secrets: { apiToken: "raw-token-123" },
          updatedBy: "human:alen",
        }),
      },
    );
    expect(res.status).toBe(200);

    res = await req(
      "/api/hosted-integrations/readiness/environment-configs/qualys/prod",
    );
    expect(res.status).toBe(200);
    const ready = await res.json();
    expect(ready).toMatchObject({
      ok: true,
      readiness: {
        status: "ready",
        code: "ready",
        blockers: [],
      },
    });
    expect(JSON.stringify(ready)).not.toContain("raw-token-123");
  });

  it("returns binding, debug, invocation, and publish readiness snapshots", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
    );
    await seedEnvironmentConfig("qualys", "prod");

    let res = await req(
      "/api/hosted-integrations/readiness/bindings/agent:analyst/qualys/qualys_count_assets",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      readiness: {
        kind: "binding",
        status: "blocked",
        code: "missing",
      },
    });

    res = await req(
      "/api/hosted-integrations/readiness/debug?familyId=qualys&toolName=qualys_count_assets&environment=prod",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      readiness: {
        kind: "debug",
        status: "blocked",
        code: "prod_environment_requires_explicit_allow",
      },
    });

    res = await req(
      "/api/hosted-integrations/readiness/invocation?agentId=agent:analyst&familyId=qualys&toolName=qualys_count_assets",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      readiness: {
        kind: "invocation",
        status: "blocked",
        code: "binding_missing",
      },
    });

    const { draftId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );
    res = await req(
      `/api/hosted-integrations/readiness/drafts/${draftId}/publish`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      readiness: {
        kind: "publish",
        status: "ready",
        code: "ready",
      },
    });

    res = await req(
      ["/api/hosted-integrations/readiness", "mig" + "ration"].join("/"),
    );
    expect(res.status).toBe(404);
  });

  it("reports invocation blocked when active generation lacks runtime config even if current source has it", async () => {
    writeFamily(
      "qualys",
      familyYamlWithRuntimeConfigContract({
        requiredConfigKeys: ["endpoint"],
        requiredSecretKeys: ["apiToken"],
      }),
    );
    const generationId = await promoteFamily("qualys");
    removeGenerationRuntimeConfig(generationId);
    await seedEnvironmentConfig("qualys", "test_debug");
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "analyst",
        name: "Analyst",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Use hosted integrations.",
        tools: ["hosted_qualys__qualys_count_assets"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:test",
          },
        ],
      }),
    );

    const res = await req(
      "/api/hosted-integrations/readiness/invocation?agentId=analyst&familyId=qualys&toolName=qualys_count_assets",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      readiness: {
        kind: "invocation",
        status: "blocked",
        code: "environment_incomplete",
        blockers: [
          {
            code: "runtime_config_contract_missing",
          },
        ],
      },
    });
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
    await seedEnvironmentConfig("qualys", "test_debug");

    const res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: agentActor(),
        familyId: "qualys",
        toolName: "qualys_count_assets",
        args: {},
        hostedToolBindings: [],
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "binding_missing" },
    });
  });

  it("returns hosted tool help only for agent-bound hosted tools", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets").replace(
        "      approval: none",
        [
          "      approval: none",
          "    help:",
          "      summary: Count Qualys assets with a read-only request.",
          "      full: help/count-assets.md",
          "      parameters:",
          "        filter_body:",
          "          summary: Native Qualys filter body.",
          "          full: help/filter-body.md",
        ].join("\n"),
      ),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
        "help/count-assets.md": "Full count assets help.\n",
        "help/filter-body.md": "Use native Qualys GAV field tokens.\n",
      },
    );
    await promoteFamily("qualys");
    await seedEnvironmentConfig("qualys", "test_debug");
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "analyst",
        name: "Analyst",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Use hosted integrations.",
        tools: ["hosted_tool_help", "hosted_qualys__qualys_count_assets"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:test",
          },
        ],
      }),
    );

    let res = await req("/api/hosted-integrations/help", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "analyst", kind: "agent", roles: ["agent"] },
        tool_name: "hosted_qualys__qualys_count_assets",
        tool_detail: "full",
        parameters: [
          {
            name: "filter_body",
            detail: "full",
            include_examples: false,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      help: {
        tool_name: "hosted_qualys__qualys_count_assets",
        tool_help: {
          summary: "Count Qualys assets with a read-only request.",
          full: "Full count assets help.\n",
        },
        parameters: {
          filter_body: {
            summary: "Native Qualys filter body.",
            full: "Use native Qualys GAV field tokens.\n",
          },
        },
      },
    });

    res = await req("/api/hosted-integrations/help", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "analyst", kind: "agent", roles: ["agent"] },
        tool_name: "hosted_qualys__qualys_count_assets",
        parameters: [
          {
            name: "filter_body",
            "raw-token-route-leak": "super-secret-route-leak",
            api_key: "plain-route-secret",
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const invalidHelpBody = await res.json();
    expect(JSON.stringify(invalidHelpBody)).not.toContain("raw-token-route-leak");
    expect(JSON.stringify(invalidHelpBody)).not.toContain("api_key");
    expect(JSON.stringify(invalidHelpBody)).not.toContain(
      "super-secret-route-leak",
    );
    expect(JSON.stringify(invalidHelpBody)).not.toContain("plain-route-secret");
    expect(invalidHelpBody).toMatchObject({
      error: expect.stringContaining("[REDACTED]"),
    });

    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "analyst-no-help",
        name: "Analyst Without Help",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Use hosted integrations.",
        tools: ["hosted_qualys__qualys_count_assets"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:test",
          },
        ],
      }),
    );
    res = await req("/api/hosted-integrations/help", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "analyst-no-help", kind: "agent", roles: ["agent"] },
        tool_name: "hosted_qualys__qualys_count_assets",
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted tool help is not enabled for agent",
      },
    });

    res = await req("/api/hosted-integrations/help", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "unbound", kind: "agent", roles: ["agent"] },
        tool_name: "hosted_qualys__qualys_count_assets",
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("returns a read-only hosted-tool agent binding matrix", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
      },
    );
    await promoteFamily("qualys");

    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "matrix-analyst",
        name: "Matrix Analyst",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Use hosted integrations.",
        tools: ["hosted_qualys__qualys_count_assets"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            bindingNote: "default analyst binding",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:test",
          },
        ],
      }),
    );
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "matrix-internal",
        name: "Matrix Internal Runner",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Run parity.",
        tools: ["hosted_qualys__qualys_count_assets"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "generation", generationId: "gen_pin" },
            bindingKind: "internal",
            purpose: "parity",
            updatedAt: "2026-08-14T10:05:00.000Z",
            updatedBy: "agent:tool-developer",
          },
        ],
      }),
    );
    await manager.createAgent(
      AgentDefinitionSchema.parse({
        id: "matrix-other-tool",
        name: "Matrix Other Tool",
        role: "",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        persona: "Use a different hosted tool.",
        tools: ["hosted_qualys__qualys_other_tool"],
        hostedIntegrationBindings: [
          {
            familyId: "qualys",
            toolName: "qualys_other_tool",
            allowedEnvironments: ["prod"],
            defaultEnvironment: "prod",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:10:00.000Z",
            updatedBy: "human:test",
          },
        ],
      }),
    );

    const res = await req(
      "/api/hosted-integrations/families/qualys/tools/qualys_count_assets/agent-bindings",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      hostedToolName: "hosted_qualys__qualys_count_assets",
      bindings: [
        {
          agentId: "matrix-analyst",
          agentName: "Matrix Analyst",
          bindingKind: "agent",
          defaultEnvironment: "test_debug",
          allowedEnvironments: ["test_debug"],
          generationPin: { type: "current" },
          bindingNote: "default analyst binding",
        },
        {
          agentId: "matrix-internal",
          agentName: "Matrix Internal Runner",
          bindingKind: "internal",
          defaultEnvironment: "test_debug",
          generationPin: { type: "generation", generationId: "gen_pin" },
          purpose: "parity",
        },
      ],
    });
    expect(
      body.bindings.map((row: { agentId: string }) => row.agentId),
    ).toEqual(["matrix-analyst", "matrix-internal"]);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("endpoint");
  });

  it("starts and manages async jobs with policy and idempotency enforcement", async () => {
    writeFamily(
      "qualys",
      asyncFamilyYaml("qualys", "Qualys", "qualys_export_assets"),
      {
        "qualys.py": pythonTool(
          "return {'queued': True}",
          "qualys_export_assets",
        ),
      },
    );
    await promoteFamily("qualys");
    await seedEnvironmentConfig("qualys", "test_debug");

    let res = await req("/api/hosted-integrations/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...allowedInvokeBody("qualys_export_assets"),
        idempotencyKey: "async-key-1",
      }),
    });
    expect(res.status).toBe(201);
    const started = await res.json();
    expect(started).toMatchObject({
      ok: true,
      replayed: false,
      job: {
        id: expect.any(String),
        familyId: "qualys",
        toolName: "qualys_export_assets",
        status: "queued",
        actorId: "agent:analyst",
      },
    });
    const jobId = started.job.id as string;

    res = await req("/api/hosted-integrations/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...allowedInvokeBody("qualys_export_assets"),
        idempotencyKey: "async-key-1",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      replayed: true,
      job: { id: jobId },
    });

    res = await req("/api/hosted-integrations/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...allowedInvokeBody("qualys_export_assets"),
        args: { different: true },
        idempotencyKey: "async-key-1",
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });

    await runtime.hostedIntegrationService.jobs.markRunning({
      jobId,
      runId: "call_async_1",
      progress: { phase: "exporting", percent: 50 },
    });

    res = await req(`/api/hosted-integrations/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      job: {
        id: jobId,
        status: "running",
        progress: { phase: "exporting", percent: 50 },
      },
    });

    res = await req(`/api/hosted-integrations/jobs/${jobId}/result`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });

    await runtime.hostedIntegrationService.jobs.completeJob({
      jobId,
      resultEnvelopeRef: "call_async_1/output.json",
    });
    res = await req(`/api/hosted-integrations/jobs/${jobId}/result`);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toEqual({
      ok: true,
      result_ref: "call_async_1/output.json",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("rejects async job start for sync tools and unauthorized actors", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'count': 1}"),
      },
    );
    await promoteFamily("qualys");
    await seedEnvironmentConfig("qualys", "test_debug");

    let res = await req("/api/hosted-integrations/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "sync_only" },
    });

    writeFamily("jira", asyncFamilyYaml("jira", "Jira", "jira_export_issues"), {
      "jira.py": pythonTool("return {'queued': True}", "jira_export_issues"),
    });
    await promoteFamily("jira");
    await seedEnvironmentConfig("jira", "test_debug");

    res = await req("/api/hosted-integrations/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...allowedInvokeBody("jira_export_issues", "jira"),
        hostedToolBindings: [],
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "binding_missing" },
      readiness: {
        kind: "invocation",
        status: "blocked",
        code: "binding_missing",
      },
    });
  });

  it("cancels only running async jobs", async () => {
    writeFamily(
      "qualys",
      asyncFamilyYaml("qualys", "Qualys", "qualys_export_assets"),
      {
        "qualys.py": pythonTool(
          "return {'queued': True}",
          "qualys_export_assets",
        ),
      },
    );
    await promoteFamily("qualys");
    await seedEnvironmentConfig("qualys", "test_debug");

    let res = await req("/api/hosted-integrations/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody("qualys_export_assets")),
    });
    expect(res.status).toBe(201);
    const jobId = ((await res.json()) as { job: { id: string } }).job.id;

    res = await req(`/api/hosted-integrations/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: agentActor() }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "not_running" },
    });

    await runtime.hostedIntegrationService.jobs.markRunning({
      jobId,
      runId: "call_async_1",
    });
    res = await req(`/api/hosted-integrations/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: agentActor() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      job: { id: jobId, status: "cancelled" },
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
    await seedEnvironmentConfig("qualys", "test_debug");

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
        environmentConfigId: null,
        configRevision: null,
        status: "succeeded",
      },
    });
    expect(JSON.stringify(runBody)).not.toContain("apiToken");

    res = await req("/api/hosted-integrations/runs?familyId=qualys&limit=10");
    expect(res.status).toBe(403);

    res = await req(
      "/api/hosted-integrations/runs?actorId=agent:tool-developer&familyId=qualys&toolName=qualys_count_assets&limit=10",
    );
    expect(res.status).toBe(200);
    const runsBody = await res.json();
    expect(runsBody).toMatchObject({
      runs: [
        {
          runId,
          familyId: "qualys",
          toolName: "qualys_count_assets",
          actorId: "agent:analyst",
          status: "succeeded",
        },
      ],
    });
    expect(JSON.stringify(runsBody)).not.toContain("apiToken");

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

  it("authorizes artifact reads with DB-backed execution logs and artifact metadata", async () => {
    await closeApp();
    closeApp = async () => {};
    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const hostedDb = createDatabase(config);
    const created = await createApp(config, {
      hostedIntegrationPersistenceBackend: "db",
      hostedIntegrationService: createDbHostedIntegrationService({
        db: hostedDb,
        dataDir,
      }),
    });
    app = created.app;
    manager = created.manager;
    runtime = created.runtime;
    closeApp = async () => {
      await created.close();
      hostedDb.close();
    };
    const member = manager.authStore.createMember({
      email: "db-backed-test@example.com",
      password: "test-password-123",
    });
    authToken = manager.authStore.createSession(member.id).token;
    const persistence = await req("/api/hosted-integrations/persistence");
    expect(persistence.status).toBe(200);
    expect(await persistence.json()).toEqual({
      persistence: { backend: "db" },
    });

    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool(
          "return {'count': 2, 'token': 'raw-token-123'}",
        ),
      },
    );
    await promoteFamilyWithService("qualys");
    await runtime.hostedIntegrationService.environmentConfigs.upsertEnvironmentConfig(
      {
        familyId: "qualys",
        environment: "test_debug",
        config: { endpoint: "https://qualys.example.test" },
        secrets: { apiToken: { configured: true } },
        updatedBy: "human:alen",
      },
    );
    await runtime.hostedIntegrationService.secrets.writeHumanOwnedSecrets({
      environmentConfigId: "qualys-test_debug",
      secrets: { apiToken: "raw-token-123" },
      updatedBy: "human:alen",
    });

    let res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(200);
    const invoked = await res.json();
    const runId = invoked.runId as string;
    expect(invoked).toMatchObject({ ok: true, runId });

    res = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/output.json`,
    );
    expect(res.status).toBe(403);

    res = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/output.json?actorId=agent:analyst`,
    );
    expect(res.status).toBe(200);
    const artifact = await res.json();
    expect(artifact).toMatchObject({
      runId,
      name: "output.json",
      content: expect.stringContaining('"count": 2'),
    });
    expect(JSON.stringify(artifact)).not.toContain("raw-token-123");
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
    await seedEnvironmentConfig("qualys", "test_debug");

    const res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(500);
    const failed = await res.json();
    const runId = failed.runId as string;

    const ordinary = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/error.json?actorId=agent:management-tool`,
    );
    expect(ordinary.status).toBe(403);

    const spoofedRole = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/error.json?roles=tool_developer`,
    );
    expect(spoofedRole.status).toBe(403);

    const developer = await req(
      `/api/hosted-integrations/runs/${runId}/artifacts/error.json?actorId=agent:tool-developer`,
    );
    expect(developer.status).toBe(200);
    const body = await developer.json();
    expect(body.content).toContain("tool_bug");
    expect(body.content).not.toContain("super-secret-token");
  });

  it("exposes failure bucket repair routes to the Tool Developer Agent", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("raise ValueError('route-bucket-failure')"),
      },
    );
    const draftId = await createDraft("qualys");
    await promoteFamily("qualys", draftId);
    await seedEnvironmentConfig("qualys", "test_debug");

    let res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(500);
    const failed = await res.json();
    expect(failed).not.toHaveProperty("taskId");
    expect(JSON.stringify(failed)).not.toContain("repair");

    res = await req("/api/hosted-integrations/failure-buckets");
    expect(res.status).toBe(403);

    res = await req(
      "/api/hosted-integrations/failure-buckets?roles=tool_developer&familyId=qualys",
    );
    expect(res.status).toBe(403);

    res = await req(
      "/api/hosted-integrations/failure-buckets?actorId=agent:tool-developer&familyId=qualys",
    );
    expect(res.status).toBe(200);
    const listed = await res.json();
    expect(listed).toMatchObject({
      buckets: [
        {
          familyId: "qualys",
          toolName: "qualys_count_assets",
          status: "open",
          count: 1,
        },
      ],
    });
    const bucketId = listed.buckets[0].id as string;
    const repairTasks = manager.taskStore
      .list({ assignee: "tool-developer" })
      .filter((task) =>
        task.body.includes(
          `openacme:hosted-integration-repair-bucket=${bucketId}`,
        ),
      );
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      assignee: "tool-developer",
      created_by: "system:hosted-integrations",
      status: "open",
    });
    expect(repairTasks[0]?.body).toContain(`bucket_id: ${bucketId}`);
    expect(repairTasks[0]?.body).toContain(`latest_run_ref: ${failed.runId}`);
    expect(repairTasks[0]?.body).toContain("family_id: qualys");
    expect(repairTasks[0]?.body).toContain("tool_name: qualys_count_assets");
    expect(repairTasks[0]?.body).toContain("generation_id: gen_qualys_1");
    expect(repairTasks[0]?.body).toContain(
      "sanitized_error_category: tool_bug",
    );

    res = await req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(allowedInvokeBody()),
    });
    expect(res.status).toBe(500);
    expect(
      manager.taskStore
        .list({ assignee: "tool-developer" })
        .filter((task) =>
          task.body.includes(
            `openacme:hosted-integration-repair-bucket=${bucketId}`,
          ),
        ),
    ).toHaveLength(1);

    res = await req(
      `/api/hosted-integrations/failure-buckets/${bucketId}?actorId=agent:tool-developer`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bucket: { id: bucketId, familyId: "qualys", count: 2 },
    });

    res = await req(
      `/api/hosted-integrations/failure-buckets/${bucketId}/assign`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          assignedTo: "tool-developer",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      bucket: { id: bucketId, assignedTo: "tool-developer" },
    });

    const lockId = await readDraftLockId(draftId);
    await upsertSmokeExample(draftId, lockId, "regression");
    const failingRegressionGenerationId = await promoteDraftViaRoutes(
      draftId,
      lockId,
    );
    res = await req(
      `/api/hosted-integrations/failure-buckets/${bucketId}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          draftId,
          generationId: failingRegressionGenerationId,
          regressionExampleId: "smoke_count",
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "regression_example_failed" },
      runId: expect.any(String),
    });

    await writeDraftFileViaRoutes(
      draftId,
      lockId,
      "qualys.py",
      pythonTool("return {'fixed': True}"),
    );
    await upsertSmokeExample(draftId, lockId, "smoke");
    const smokeFixGenerationId = await promoteDraftViaRoutes(draftId, lockId);
    res = await req(
      `/api/hosted-integrations/failure-buckets/${bucketId}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          draftId,
          generationId: smokeFixGenerationId,
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "regression_example_required" },
    });

    await upsertSmokeExample(draftId, lockId, "regression");
    const regressionFixGenerationId = await promoteDraftViaRoutes(
      draftId,
      lockId,
    );
    expect(
      readFileSync(
        path.join(
          dataDir,
          "hosted-integrations",
          "source",
          "families",
          "qualys",
          "examples.yaml",
        ),
        "utf-8",
      ),
    ).toContain("category: regression");

    res = await req(
      `/api/hosted-integrations/failure-buckets/${bucketId}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          draftId,
          generationId: regressionFixGenerationId,
          regressionExampleId: "smoke_count",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      bucket: { id: bucketId, status: "closed" },
    });
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
    await seedEnvironmentConfig("qualys", "test_debug");

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
        environment: "test_debug",
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

  it("debug-run failures do not create repair buckets or tasks", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("raise ValueError('debug-failure')"),
      },
    );
    const draftId = await createDraft("qualys");
    await promoteFamily("qualys", draftId);
    await seedEnvironmentConfig("qualys", "test_debug");

    let res = await req("/api/hosted-integrations/debug-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        familyId: "qualys",
        toolName: "qualys_count_assets",
        environment: "test_debug",
        operationClass: "read",
        args: {},
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "tool_bug" },
      runId: expect.any(String),
    });

    res = await req(
      "/api/hosted-integrations/failure-buckets?actorId=agent:tool-developer&familyId=qualys",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buckets: [] });
    expect(manager.taskStore.list({ assignee: "tool-developer" })).toEqual([]);
  });

  it("rejects debug-run maintenance mode for non Tool Developer actors even with spoofed roles", async () => {
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": pythonTool("return {'debug': True}"),
      },
    );
    const draftId = await createDraft("qualys");
    await promoteFamily("qualys", draftId);
    await seedEnvironmentConfig("qualys", "test_debug");

    const res = await req("/api/hosted-integrations/debug-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: {
          id: "agent:analyst",
          kind: "agent",
          roles: ["tool_developer"],
        },
        familyId: "qualys",
        toolName: "qualys_count_assets",
        environment: "test_debug",
        operationClass: "read",
        args: {},
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "actor_denied" },
      readiness: {
        kind: "debug",
        status: "blocked",
        code: "actor_denied",
      },
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
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "tool_not_debuggable" },
      readiness: {
        kind: "debug",
        status: "blocked",
        code: "tool_not_debuggable",
      },
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

  it("returns generation diffs only to the Tool Developer Agent", async () => {
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
      familyYaml("qualys", "Qualys", "qualys_count_assets").replace(
        "description: Read safe Qualys metadata.",
        "description: Read filtered Qualys metadata.",
      ),
      {
        "qualys.py": pythonTool("return {'count': 2}"),
      },
    );
    const secondGenerationId = await promoteFamily("qualys");

    let res = await req(
      `/api/hosted-integrations/generations/${firstGenerationId}/diff/${secondGenerationId}?actorId=agent:analyst&mode=summary`,
    );
    expect(res.status).toBe(403);

    res = await req(
      `/api/hosted-integrations/generations/${firstGenerationId}/diff/${secondGenerationId}?actorId=agent:tool-developer&mode=summary`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      diff: {
        mode: "summary",
        familyId: "qualys",
        baseGenerationId: firstGenerationId,
        compareGenerationId: secondGenerationId,
        summary: {
          changedFiles: [
            { path: "qualys.py", changeType: "modified" },
            { path: "tools.yaml", changeType: "modified" },
          ],
          changedTools: [
            {
              name: "qualys_count_assets",
              changeType: "modified",
              changedFields: ["description", "help"],
            },
          ],
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
    await seedEnvironmentConfig("qualys", "test_debug");
    await createFileHostedIntegrationSecretStore({
      dataDir,
    }).writeHumanOwnedSecrets({
      environmentConfigId: "qualys-test_debug",
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
      }).readSecretsForRuntime({ environmentConfigId: "qualys-test_debug" }),
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
    await seedEnvironmentConfig("qualys", "test_debug");

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

describe("hosted integrations example execution and promotion routes", () => {
  it("lists active generation examples for read-only inspection", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );
    await upsertSmokeExample(draftId, lockId);
    const generationId = await promoteDraftViaRoutes(draftId, lockId);

    let res = await req(
      "/api/hosted-integrations/families/qualys/examples?toolName=qualys_count_assets",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generationId,
      examples: [
        {
          id: "smoke_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "smoke",
        },
      ],
    });

    res = await req(
      "/api/hosted-integrations/families/qualys/examples?toolName=missing_tool",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      generationId,
      examples: [],
    });
  });

  it("runs a draft example and writes sanitized debug artifacts", async () => {
    const { draftId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );
    await upsertSmokeExample(draftId);

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/run-example`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          exampleId: "smoke_count",
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      envelope: { ok: true, result: { count: 2 } },
    });

    const artifact = await req(
      `/api/hosted-integrations/runs/${body.runId}/artifacts/output.json?actorId=agent:tool-developer`,
    );
    expect(artifact.status).toBe(200);
    expect(await artifact.json()).toMatchObject({
      name: "output.json",
      content: expect.stringContaining('"count": 2'),
    });
  });

  it("does not run discovery-required draft examples", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );
    await upsertSmokeExample(
      draftId,
      lockId,
      "discovery_required",
      "qualys_count_assets",
    );

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/run-example`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          exampleId: "smoke_count",
        }),
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        code: "example_not_runnable",
        message: expect.stringContaining("not ready-to-send"),
      },
    });
  });

  it("refuses invalid draft promotion", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );
    const write = await req(
      `/api/hosted-integrations/drafts/${draftId}/files/family.yaml`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lockId, content: "not: [valid" }),
      },
    );
    expect(write.status).toBe(200);

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
      readiness: {
        kind: "publish",
        status: "blocked",
        code: "validation_failed",
      },
    });
  });

  it("refuses promotion when required tool examples are missing", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        code: "missing_required_examples",
        toolNames: ["qualys_count_assets"],
      },
    });
  });

  it("requires the current draft lock for promotion", async () => {
    const { draftId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
    );
    await upsertSmokeExample(draftId);

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: toolDeveloperActor(),
          lockId: "lock_stale",
        }),
      },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "lock_required" },
      readiness: {
        kind: "publish",
        status: "blocked",
        code: "lock_required",
      },
    });
  });

  it("blocks GA promotion when required runtime config has no prod environment config", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
      familyYamlWithRuntimeConfigContract({
        requiredConfigKeys: ["QUALYS_BASE_URL"],
        requiredSecretKeys: ["QUALYS_PASSWORD"],
      }),
    );
    await upsertSmokeExample(draftId, lockId);

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "production_config_missing" },
      readiness: {
        kind: "publish",
        status: "blocked",
        code: "production_config_missing",
      },
    });
  });

  it("blocks GA promotion when runtime config contract is missing", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
      familyYamlWithoutRuntimeConfigContract(),
    );
    await upsertSmokeExample(draftId, lockId);

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: "runtime_config_contract_missing" },
      readiness: {
        kind: "publish",
        status: "blocked",
        code: "runtime_config_contract_missing",
      },
    });
  });

  it("blocks GA promotion with sanitized missing runtime config keys", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 2}"),
      familyYamlWithRuntimeConfigContract({
        requiredConfigKeys: ["QUALYS_BASE_URL", "QUALYS_API_VERSION"],
        requiredSecretKeys: ["QUALYS_PASSWORD"],
      }),
    );
    await upsertSmokeExample(draftId, lockId);
    const configRes = await req(
      "/api/hosted-integrations/environment-configs/qualys/prod",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: { QUALYS_PASSWORD: { configured: false } },
          updatedBy: "human:test",
        }),
      },
    );
    expect(configRes.status).toBe(200);

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: "production_config_incomplete" },
      readiness: {
        kind: "publish",
        status: "blocked",
        code: "production_config_incomplete",
        sanitizedDetails: {
          missingConfigKeys: ["QUALYS_API_VERSION"],
          missingSecretKeys: ["QUALYS_PASSWORD"],
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("qualys.example");
  });

  it("promotes a draft, updates canonical source, and seeds the next draft revision", async () => {
    const currentSource = pythonTool("return {'count': 3}");
    const { draftId, lockId } = await createDraftViaRoutes(currentSource);
    await upsertSmokeExample(draftId, lockId);

    let res = await req(`/api/hosted-integrations/drafts/${draftId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
    });
    expect(res.status).toBe(200);
    const promoted = await res.json();
    expect(promoted).toMatchObject({
      ok: true,
      generation: {
        familyId: "qualys",
        sourceRevisionId: promoted.sourceRevisionId,
        status: "active",
      },
    });

    res = await req(
      "/api/hosted-integrations/families/qualys/source/files/qualys.py",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "qualys.py",
      content: currentSource,
    });

    const staleSource = pythonTool("return {'count': 99}");
    writeFamily(
      "qualys",
      familyYaml("qualys", "Qualys", "qualys_count_assets"),
      {
        "qualys.py": staleSource,
      },
    );

    res = await req("/api/hosted-integrations/families/qualys/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockId }),
    });
    expect(res.status).toBe(201);
    const nextDraftBody = (await res.json()) as {
      draft: { id: string; sourceRevisionId: string };
    };
    expect(nextDraftBody).toMatchObject({
      draft: { sourceRevisionId: promoted.sourceRevisionId },
    });

    res = await req(
      `/api/hosted-integrations/drafts/${nextDraftBody.draft.id}/files/qualys.py`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "qualys.py",
      content: currentSource,
    });
  });

  it("refreshes /api/tools and evicts affected agents after promotion", async () => {
    await createAgentViaRoutes("qualys-agent", [
      "hosted_qualys__qualys_count_assets",
    ]);
    const cachedAgent = manager.getAgent("qualys-agent");
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 4}"),
    );
    await upsertSmokeExample(draftId, lockId);

    const promoted = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );
    expect(promoted.status).toBe(200);
    const { sourceRevisionId, generation } = await promoted.json();

    const tools = await req("/api/tools");
    expect(tools.status).toBe(200);
    const toolsBody = (await tools.json()) as {
      toolsets: string[];
      tools: Array<{ name: string }>;
    };
    expect(toolsBody.toolsets).toContain("hosted-integrations");
    expect(
      toolsBody.tools.find(
        (tool) => tool.name === "hosted_qualys__qualys_count_assets",
      ),
    ).toMatchObject({
      name: "hosted_qualys__qualys_count_assets",
      toolset: "hosted-integrations",
      source: {
        kind: "hosted_integration",
        familyId: "qualys",
        familyName: "Qualys",
        toolName: "qualys_count_assets",
        generationId: generation.id,
      },
    });
    expect(sourceRevisionId).toEqual(generation.sourceRevisionId);
    expect(manager.getAgent("qualys-agent")).not.toBe(cachedAgent);
  });

  it("deletes a hosted family through the API and removes its registry tools", async () => {
    await createAgentViaRoutes("qualys-agent", [
      "hosted_qualys__qualys_count_assets",
    ]);
    const cachedAgent = manager.getAgent("qualys-agent");
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 5}"),
    );
    await upsertSmokeExample(draftId, lockId);
    let res = await req(`/api/hosted-integrations/drafts/${draftId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
    });
    expect(res.status).toBe(200);
    res = await req("/api/hosted-integrations/disablements", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: toolDeveloperActor(),
        target: { level: "family", familyId: "qualys" },
        disabled: true,
        reason: "delete cleanup coverage",
      }),
    });
    expect(res.status).toBe(200);

    res = await req("/api/hosted-integrations/families/qualys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      familyId: "qualys",
      status: "deleted",
      generationIds: expect.any(Array),
    });

    res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { families: Array<{ id: string }> }).families.some(
        (family) => family.id === "qualys",
      ),
    ).toBe(false);

    res = await req("/api/tools");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { tools: Array<{ name: string }> }).tools.some(
        (tool) => tool.name === "hosted_qualys__qualys_count_assets",
      ),
    ).toBe(false);
    expect(manager.getAgent("qualys-agent")).not.toBe(cachedAgent);

    res = await req("/api/hosted-integrations/families/qualys/source/files");
    expect(res.status).toBe(404);
    res = await req("/api/hosted-integrations/disablements");
    expect(
      ((await res.json()) as { disablements: Array<{ key: string }> })
        .disablements,
    ).toEqual([]);
  });

  it("drains active invocations before finalizing hosted family delete", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'count': 5}"),
    );
    await upsertSmokeExample(draftId, lockId);
    let res = await req(`/api/hosted-integrations/drafts/${draftId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
    });
    expect(res.status).toBe(200);
    const lease =
      await runtime.hostedIntegrationService.generations.beginInvocation({
        familyId: "qualys",
      });
    expect(lease).toMatchObject({ ok: true });

    res = await req("/api/hosted-integrations/families/qualys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      familyId: "qualys",
      status: "delete_draining",
      deleted: false,
      inflightInvocations: 1,
    });

    res = await req("/api/tools");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { tools: Array<{ name: string }> }).tools.some(
        (tool) => tool.name === "hosted_qualys__qualys_count_assets",
      ),
    ).toBe(false);
    res = await req("/api/hosted-integrations/disablements");
    expect(await res.json()).toMatchObject({
      disablements: [
        {
          key: "family:qualys",
          disabled: true,
          reason: "delete_draining",
        },
      ],
    });

    if (lease.ok) {
      await runtime.hostedIntegrationService.generations.completeInvocation({
        leaseId: lease.lease.id,
      });
    }
    res = await req("/api/hosted-integrations/families/qualys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      familyId: "qualys",
      status: "deleted",
    });
    res = await req("/api/hosted-integrations/families");
    expect(
      ((await res.json()) as { families: Array<{ id: string }> }).families.some(
        (family) => family.id === "qualys",
      ),
    ).toBe(false);
  });

  it("drains real gateway invocations before finalizing hosted family delete", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(`
import time

def authenticate(ctx):
    return {}

def before_tool_call(tool_name, args, ctx, auth):
    return args

def after_tool_call(tool_name, args, ctx, result, auth):
    return result

def tool_qualys_count_assets(args, context):
    time.sleep(1.5)
    return {}

`);
    await upsertSmokeExample(draftId, lockId);
    let res = await req(`/api/hosted-integrations/drafts/${draftId}/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
    });
    const promotedBody = await res.json();
    if (res.status !== 200) {
      throw new Error(
        `promote failed: ${res.status} ${JSON.stringify(promotedBody)}`,
      );
    }

    const invokePromise = req("/api/hosted-integrations/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: agentActor(),
        familyId: "qualys",
        toolName: "qualys_count_assets",
        args: {},
        hostedToolBindings: [
          {
            agentId: "agent:analyst",
            familyId: "qualys",
            toolName: "qualys_count_assets",
            allowedEnvironments: ["test_debug"],
            defaultEnvironment: "test_debug",
            generationPin: { type: "current" },
            bindingKind: "agent",
            updatedAt: "2026-08-14T10:00:00.000Z",
            updatedBy: "human:test",
          },
        ],
      }),
    });
    await waitForHostedIntegrationInflightCount("qualys", 1);

    res = await req("/api/hosted-integrations/families/qualys", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: toolDeveloperActor() }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      familyId: "qualys",
      status: "delete_draining",
      deleted: false,
      inflightInvocations: 1,
    });

    const invoked = await invokePromise;
    const invokedBody = await invoked.json();
    if (invoked.status !== 200) {
      throw new Error(
        `invoke failed: ${invoked.status} ${JSON.stringify(invokedBody)}`,
      );
    }
    expect(invokedBody).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    res = await req("/api/hosted-integrations/families");
    expect(
      ((await res.json()) as { families: Array<{ id: string }> }).families.some(
        (family) => family.id === "qualys",
      ),
    ).toBe(false);
  });

  it("requires human approval for destructive promotion", async () => {
    const { draftId, lockId } = await createDraftViaRoutes(
      pythonTool("return {'deleted': True}", "qualys_delete_asset"),
      destructiveFamilyYaml(),
    );
    await upsertSmokeExample(
      draftId,
      lockId,
      "destructive_requires_human",
      "qualys_delete_asset",
    );

    const res = await req(
      `/api/hosted-integrations/drafts/${draftId}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "approval_required" },
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

async function createDraftViaRoutes(
  source: string,
  manifest = familyYaml("qualys", "Qualys", "qualys_count_assets"),
): Promise<{ draftId: string; lockId: string }> {
  writeFamily("qualys", manifest, {
    "qualys.py": pythonTool("return {'count': 1}"),
  });
  let res = await req("/api/hosted-integrations/families/qualys/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    }),
  });
  expect(res.status).toBe(201);
  const lockId = ((await res.json()) as { lock: { id: string } }).lock.id;
  res = await req("/api/hosted-integrations/families/qualys/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lockId, sourceRevisionId: "source_rev_1" }),
  });
  expect(res.status).toBe(201);
  const draftId = ((await res.json()) as { draft: { id: string } }).draft.id;
  res = await req(
    `/api/hosted-integrations/drafts/${draftId}/files/qualys.py`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockId, content: source }),
    },
  );
  expect(res.status).toBe(200);
  return { draftId, lockId };
}

async function upsertSmokeExample(
  draftId: string,
  lockId?: string,
  category = "smoke",
  toolName = "qualys_count_assets",
): Promise<void> {
  const actualLockId = lockId ?? (await readDraftLockId(draftId));
  const res = await req(`/api/hosted-integrations/drafts/${draftId}/examples`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lockId: actualLockId,
      example: {
        id: "smoke_count",
        familyId: "qualys",
        toolName,
        category,
        args: {},
        expected:
          category === "discovery_required"
            ? {
                discovery_tool: "qualys_search_assets",
                requires_discovered_asset_id: true,
                not_ready_to_send: true,
              }
            : {},
      },
    }),
  });
  if (res.status !== 200) {
    throw new Error(
      `upsert example failed: ${res.status} ${JSON.stringify(await res.json())}`,
    );
  }
  expect(res.status).toBe(200);
}

async function writeDraftFileViaRoutes(
  draftId: string,
  lockId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const res = await req(
    `/api/hosted-integrations/drafts/${draftId}/files/${filePath}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockId, content }),
    },
  );
  expect(res.status).toBe(200);
}

async function promoteDraftViaRoutes(
  draftId: string,
  lockId: string,
): Promise<string> {
  const res = await req(`/api/hosted-integrations/drafts/${draftId}/promote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: toolDeveloperActor(), lockId }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return (body as { generation: { id: string } }).generation.id;
}

async function readDraftLockId(draftId: string): Promise<string> {
  const res = await req(`/api/hosted-integrations/drafts/${draftId}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { draft: { lockId: string } }).draft.lockId;
}

async function createAgentViaRoutes(
  id: string,
  tools: string[],
): Promise<void> {
  const res = await req("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name: id, tools }),
  });
  expect(res.status).toBe(201);
}

function allowedInvokeBody(
  toolName = "qualys_count_assets",
  familyId = "qualys",
) {
  return {
    actor: agentActor(),
    familyId,
    toolName,
    args: {},
    hostedToolBindings: [
      {
        agentId: "agent:analyst",
        familyId,
        toolName,
        allowedEnvironments: ["test_debug"],
        defaultEnvironment: "test_debug",
        generationPin: { type: "current" },
        bindingKind: "agent",
        updatedAt: "2026-08-14T10:00:00.000Z",
        updatedBy: "human:test",
      },
    ],
  };
}

async function seedEnvironmentConfig(
  familyId: string,
  environment: "prod" | "test_debug",
): Promise<void> {
  const environmentConfigId = `${familyId}-${environment}`;
  await createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
  }).upsertEnvironmentConfig({
    familyId,
    environment,
    config: { endpoint: "https://qualys.example.test" },
    secrets: { apiToken: { configured: true } },
    updatedBy: "human:alen",
  });
  await createFileHostedIntegrationSecretStore({
    dataDir,
  }).writeHumanOwnedSecrets({
    environmentConfigId: environmentConfigId,
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

function removeGenerationRuntimeConfig(generationId: string): void {
  const metadataPath = path.join(
    dataDir,
    "hosted-integrations",
    "generations",
    generationId,
    "metadata.json",
  );
  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<
    string,
    unknown
  >;
  delete metadata.runtimeConfig;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function promoteFamilyWithService(familyId: string): Promise<string> {
  const lock = await runtime.hostedIntegrationService.locks.acquireLock({
    familyId,
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  if (!lock.ok) throw new Error(lock.reason);
  const sourceRevisionId = "source_rev_1";
  const source =
    await runtime.hostedIntegrationService.sourceFiles.replaceSourceFiles({
      familyId,
      sourceRevisionId,
      updatedBy: "agent:tool-developer",
      files: {
        "family.yaml": readFileSync(
          path.join(
            dataDir,
            "hosted-integrations",
            "source",
            "families",
            familyId,
            "family.yaml",
          ),
          "utf-8",
        ),
        "tools.yaml": readFileSync(
          path.join(
            dataDir,
            "hosted-integrations",
            "source",
            "families",
            familyId,
            "tools.yaml",
          ),
          "utf-8",
        ),
        [`${familyId}.py`]: readFileSync(
          path.join(
            dataDir,
            "hosted-integrations",
            "source",
            "families",
            familyId,
            `${familyId}.py`,
          ),
          "utf-8",
        ),
      },
    });
  if (!source.ok) throw new Error(source.reason);
  const draft = await runtime.hostedIntegrationService.drafts.createDraft({
    familyId,
    lockId: lock.lock.id,
    sourceRevisionId,
  });
  if (!draft.ok) throw new Error(draft.reason);
  const generation =
    await runtime.hostedIntegrationService.generations.promoteDraft({
      draftId: draft.draft.id,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
  if (!generation.ok) throw new Error(generation.reason);
  return generation.generation.id;
}

function pythonTool(body: string, toolName = "qualys_count_assets"): string {
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
    `def tool_${toolName}(args, context):`,
    "    ctx = context",
    `    ${body}`,
    "",
  ].join("\n");
}

function expectNoValidationErrors(validation: {
  ok: boolean;
  diagnostics: Array<{ severity: string }>;
}): void {
  expect(validation.ok, JSON.stringify(validation)).toBe(true);
  expect(
    validation.diagnostics.filter((item) => item.severity === "error"),
  ).toEqual([]);
}

async function waitForHostedIntegrationInflightCount(
  familyId: string,
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const actual =
      await runtime.hostedIntegrationService.generations.getInflightInvocationCount(
        familyId,
      );
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const actual =
    await runtime.hostedIntegrationService.generations.getInflightInvocationCount(
      familyId,
    );
  expect(actual).toBe(expected);
}
