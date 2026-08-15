import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS } from "../src/index.js";

describe("hosted integration DB schema contract", () => {
  it("has DB schema declarations for every persistence contract table family", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schemaFile = await readFile(
      path.resolve(here, "../../db/src/schema.ts"),
      "utf-8",
    );

    for (const tableName of new Set(
      HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS.flatMap(
        (contract) => contract.dbTableFamilies,
      ),
    )) {
      expect(schemaFile, tableName).toContain(`"${tableName}"`);
    }
  });
});
