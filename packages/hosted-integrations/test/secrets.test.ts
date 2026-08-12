import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHostedIntegrationSecretStore } from "../src/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-secrets-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function store() {
  return createFileHostedIntegrationSecretStore({ dataDir });
}

function secretFile(scopeId: string): string {
  return path.join(dataDir, "hosted-integrations", "secrets", `${scopeId}.json`);
}

describe("hosted integration secret store", () => {
  it("writes human-owned secret values atomically with restrictive permissions", async () => {
    await expect(
      store().writeHumanOwnedSecrets({
        scopeId: "qualys-prod",
        secrets: {
          QUALYS_USERNAME: "api-user",
          QUALYS_PASSWORD: "super-secret-password",
        },
        updatedBy: "human:alen",
      }),
    ).resolves.toEqual({
      ok: true,
      metadata: {
        scopeId: "qualys-prod",
        secrets: {
          QUALYS_USERNAME: { configured: true },
          QUALYS_PASSWORD: { configured: true },
        },
      },
    });

    if (process.platform !== "win32") {
      expect((await stat(secretFile("qualys-prod"))).mode & 0o777).toBe(0o600);
    }
  });

  it("returns only configured or missing metadata for API reads", async () => {
    const secretStore = store();
    await secretStore.writeHumanOwnedSecrets({
      scopeId: "qualys-prod",
      secrets: { QUALYS_TOKEN: "raw-token" },
      updatedBy: "human:alen",
    });

    await expect(
      secretStore.getSecretMetadata({
        scopeId: "qualys-prod",
        secretNames: ["QUALYS_TOKEN", "QUALYS_PASSWORD"],
      }),
    ).resolves.toEqual({
      scopeId: "qualys-prod",
      secrets: {
        QUALYS_TOKEN: { configured: true },
        QUALYS_PASSWORD: { configured: false },
      },
    });
    await expect(
      secretStore.getSecretMetadata({ scopeId: "qualys-prod" }),
    ).resolves.toEqual({
      scopeId: "qualys-prod",
      secrets: { QUALYS_TOKEN: { configured: true } },
    });
    expect(
      JSON.stringify(
        await secretStore.getSecretMetadata({ scopeId: "qualys-prod" }),
      ),
    ).not.toContain("raw-token");
  });

  it("exposes raw secret values only through the runtime resolver port", async () => {
    const secretStore = store();
    await secretStore.writeHumanOwnedSecrets({
      scopeId: "qualys-prod",
      secrets: { QUALYS_TOKEN: "raw-token" },
      updatedBy: "human:alen",
    });

    await expect(
      secretStore.readSecretsForRuntime({ scopeId: "qualys-prod" }),
    ).resolves.toEqual({ QUALYS_TOKEN: "raw-token" });
  });
});
