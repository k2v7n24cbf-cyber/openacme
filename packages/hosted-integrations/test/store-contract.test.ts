import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as hostedIntegrations from "../src/index.js";
import {
  HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS,
  HOSTED_INTEGRATION_SERVICE_PERSISTENCE_KEYS,
} from "../src/index.js";

describe("hosted integration persistence contract", () => {
  it("covers every service-level persistence port", () => {
    const contractedServiceKeys = new Set(
      HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS.flatMap((contract) => {
        if (!contract.serviceKey) return [];
        if (contract.serviceKey.includes(".")) return [];
        if (contract.serviceKey === "catalog") return [];
        return [contract.serviceKey];
      }),
    );

    expect(contractedServiceKeys).toEqual(
      new Set(HOSTED_INTEGRATION_SERVICE_PERSISTENCE_KEYS),
    );
  });

  it("covers the required DB-backed record kinds from the implementation plan", () => {
    const recordKinds = new Set(
      HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS.flatMap(
        (contract) => contract.recordKinds,
      ),
    );

    for (const requiredKind of [
      "source_revision",
      "source_file",
      "draft",
      "draft_file",
      "generation",
      "generation_file",
      "active_generation_pointer",
      "lock",
      "example",
      "environment_config",
      "secret_metadata",
      "execution_log",
      "artifact_metadata",
      "failure_bucket",
      "approval",
      "job",
      "idempotency_record",
      "retention_state",
      "promotion_provenance",
    ]) {
      expect(recordKinds.has(requiredKind), requiredKind).toBe(true);
    }
  });

  it("marks mutation boundaries as transactional or append-only", () => {
    for (const contract of HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS) {
      expect(contract.currentFileFactory).toMatch(/^createFileHostedIntegration/);
      expect(contract.dbTableFamilies.length).toBeGreaterThan(0);
      expect(contract.adapterContract).toEqual({
        fileBacked: "required",
        dbBacked: "required_from_17_3",
      });
      if (contract.transactionalWrites.length > 0) {
        expect([
          "transactional",
          "append_only",
          "metadata_index",
        ]).toContain(contract.shape);
      }
    }
  });

  it("declares concrete DB adapter factories or explicit delegated storage decisions", () => {
    const publicExports = hostedIntegrations as Record<string, unknown>;

    for (const contract of HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS) {
      if (contract.dbAdapter.kind === "factory") {
        expect(
          typeof publicExports[contract.dbAdapter.factory],
          contract.id,
        ).toBe("function");
        continue;
      }

      expect(contract.dbAdapter.delegatedTo.length, contract.id).toBeGreaterThan(0);
      expect(contract.dbAdapter.decision, contract.id).toMatch(/\S/);
    }
  });

  it("keeps server routes behind the service port instead of concrete file stores", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const routeFile = await readFile(
      path.resolve(here, "../../server/src/routes/hosted-integrations.ts"),
      "utf-8",
    );

    expect(routeFile).not.toMatch(/createFileHostedIntegration[A-Za-z]+/);
    expect(routeFile).toContain("service:");
  });
});
