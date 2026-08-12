import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationConfigScopeStore,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-config-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writeSourceFamily(familyId: string): Promise<void> {
  const dir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "family.yaml"),
    `
id: ${familyId}
name: ${familyId}
version: 1
runtime:
  language: python
  entrypoint: ${familyId}.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_only
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
tools:
  - name: ${familyId}_tool
    title: ${familyId} tool
    description: ${familyId} tool.
    inputSchema:
      type: object
      properties: {}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`,
    "utf-8",
  );
}

function store() {
  return createFileHostedIntegrationConfigScopeStore({
    dataDir,
    catalog: createFileHostedIntegrationCatalog({ dataDir }),
    now: () => new Date(nowMs),
  });
}

describe("hosted integration config scope store", () => {
  it("reads config scopes without returning secret values", async () => {
    await writeSourceFamily("qualys");
    const dir = path.join(dataDir, "hosted-integrations", "config-scopes");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "qualys-prod.json"),
      JSON.stringify(
        {
          id: "qualys-prod",
          familyId: "qualys",
          revision: 1,
          environment: "prod",
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: {
            QUALYS_USERNAME: {
              configured: true,
              value: "raw-secret-username",
            },
          },
          updatedAt: "2026-08-12T10:00:00.000Z",
          updatedBy: "human:alen",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const scope = await store().getConfigScope("qualys-prod");

    expect(scope).toEqual({
      id: "qualys-prod",
      familyId: "qualys",
      revision: 1,
      environment: "prod",
      config: { QUALYS_BASE_URL: "https://qualys.example" },
      secrets: { QUALYS_USERNAME: { configured: true } },
      updatedAt: "2026-08-12T10:00:00.000Z",
      updatedBy: "human:alen",
    });
    expect(JSON.stringify(scope)).not.toContain("raw-secret-username");
  });

  it("updates non-secret config and increments the revision", async () => {
    await writeSourceFamily("qualys");
    const configScopes = store();

    await expect(
      configScopes.upsertConfigScope({
        scopeId: "qualys-prod",
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://old.example" },
        secrets: { QUALYS_TOKEN: { configured: false } },
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({ ok: true, scope: { revision: 1 } });
    nowMs += 60_000;
    await expect(
      configScopes.upsertConfigScope({
        scopeId: "qualys-prod",
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://new.example" },
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({
      ok: true,
      scope: {
        id: "qualys-prod",
        familyId: "qualys",
        revision: 2,
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://new.example" },
        secrets: { QUALYS_TOKEN: { configured: false } },
        updatedAt: "2026-08-12T10:01:00.000Z",
        updatedBy: "human:alen",
      },
    });
  });

  it("rejects config scopes for unknown families", async () => {
    await expect(
      store().upsertConfigScope({
        scopeId: "missing-prod",
        familyId: "missing",
        environment: "prod",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({ ok: false, reason: "family_not_found" });
  });
});
