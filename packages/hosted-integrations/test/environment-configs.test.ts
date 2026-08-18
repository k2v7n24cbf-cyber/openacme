import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationEnvironmentConfigStore,
} from "../src/index.js";
import { writeSplitFamilyFixture } from "./test-support/split-contract-fixtures.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-14T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-env-"));
  nowMs = Date.parse("2026-08-14T10:00:00.000Z");
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
  await writeSplitFamilyFixture(
    dir,
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
  );
}

function store() {
  return createFileHostedIntegrationEnvironmentConfigStore({
    dataDir,
    catalog: createFileHostedIntegrationCatalog({ dataDir }),
    now: () => new Date(nowMs),
  });
}

describe("hosted integration environment config store", () => {
  it("creates and updates only the canonical family/environment config", async () => {
    await writeSourceFamily("qualys");
    const environmentConfigs = store();

    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://old.example" },
        secrets: { QUALYS_TOKEN: { configured: false } },
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({
      ok: true,
      environmentConfig: {
        id: "qualys-prod",
        familyId: "qualys",
        environment: "prod",
        revision: 1,
        config: { QUALYS_BASE_URL: "https://old.example" },
        secrets: { QUALYS_TOKEN: { configured: false } },
        updatedAt: "2026-08-14T10:00:00.000Z",
        updatedBy: "human:alen",
      },
    });

    nowMs += 60_000;

    await expect(
      environmentConfigs.upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://new.example" },
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({
      ok: true,
      environmentConfig: {
        id: "qualys-prod",
        revision: 2,
        environment: "prod",
        config: { QUALYS_BASE_URL: "https://new.example" },
      },
    });

    await expect(environmentConfigs.listEnvironmentConfigs()).resolves.toHaveLength(
      1,
    );
  });

  it("accepts only prod and test_debug environments", async () => {
    await writeSourceFamily("qualys");

    await expect(
      store().upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "test_debug",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      store().upsertEnvironmentConfig({
        familyId: "qualys",
        environment: "stage",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_environment",
      allowedEnvironments: ["prod", "test_debug"],
    });
  });

  it("sanitizes secret metadata and rejects unknown families", async () => {
    await writeSourceFamily("qualys");

    await expect(
      store().upsertEnvironmentConfig({
        familyId: "missing",
        environment: "prod",
        config: {},
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({ ok: false, reason: "family_not_found" });

    await store().upsertEnvironmentConfig({
      familyId: "qualys",
      environment: "test_debug",
      config: {},
      secrets: {
        QUALYS_PASSWORD: {
          configured: true,
          value: "raw-secret",
        } as { configured: boolean; value: string },
      },
      updatedBy: "human:alen",
    });

    const environmentConfig = await store().getEnvironmentConfig(
      "qualys",
      "test_debug",
    );
    expect(environmentConfig?.secrets).toEqual({
      QUALYS_PASSWORD: { configured: true },
    });
    expect(JSON.stringify(environmentConfig)).not.toContain("raw-secret");
  });
});
