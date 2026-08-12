import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHostedIntegrationSourceFileStore } from "../src/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-source-files-"));
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
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "family.yaml"), `id: ${familyId}\n`, "utf-8");
  await writeFile(
    path.join(dir, `${familyId}.py`),
    "def run(): pass\n",
    "utf-8",
  );
  await writeFile(path.join(dir, "docs", "readme.md"), "# readme\n", "utf-8");
}

describe("hosted integration source file store", () => {
  it("lists and reads canonical source files", async () => {
    await writeSourceFamily("qualys");
    const store = createFileHostedIntegrationSourceFileStore({ dataDir });

    await expect(store.listSourceFiles("qualys")).resolves.toEqual({
      ok: true,
      files: [
        { path: "docs/readme.md", size: 9 },
        { path: "family.yaml", size: 11 },
        { path: "qualys.py", size: 16 },
      ],
    });
    await expect(
      store.readSourceFile({ familyId: "qualys", path: "qualys.py" }),
    ).resolves.toEqual({ ok: true, content: "def run(): pass\n" });
  });

  it("rejects invalid family ids and path traversal", async () => {
    await writeSourceFamily("qualys");
    const store = createFileHostedIntegrationSourceFileStore({ dataDir });

    await expect(store.listSourceFiles("../qualys")).rejects.toThrow();
    await expect(
      store.readSourceFile({ familyId: "qualys", path: "../secret.txt" }),
    ).rejects.toThrow("path escapes source root");
  });
});
