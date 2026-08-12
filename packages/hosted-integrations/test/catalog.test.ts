import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHostedIntegrationCatalog } from "../src/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-catalog-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writeFamily(familyId: string, yaml: string): Promise<void> {
  const dir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "family.yaml"), yaml, "utf-8");
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

describe("file-backed hosted integration catalog", () => {
  it("lists valid family manifests as stable sorted summaries", async () => {
    await writeFamily("splunk", familyYaml("splunk", "Splunk", "splunk_search"));
    await writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));

    const catalog = createFileHostedIntegrationCatalog({ dataDir });
    const families = await catalog.listFamilies();

    expect(families.map((family) => family.id)).toEqual(["qualys", "splunk"]);
    expect(families).toMatchObject([
      {
        id: "qualys",
        name: "Qualys",
        version: 1,
        toolNames: ["qualys_count_assets"],
      },
      {
        id: "splunk",
        name: "Splunk",
        version: 1,
        toolNames: ["splunk_search"],
      },
    ]);
  });

  it("gets sanitized family manifest metadata by id", async () => {
    await writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));

    const catalog = createFileHostedIntegrationCatalog({ dataDir });
    const family = await catalog.getFamily("qualys");

    expect(family).toMatchObject({
      summary: {
        id: "qualys",
        name: "Qualys",
        toolNames: ["qualys_count_assets"],
      },
      manifest: {
        id: "qualys",
        runtime: {
          language: "python",
          dependencyPolicy: { installDuringInvocation: false },
        },
      },
    });
    expect(JSON.stringify(family)).not.toContain("source/families");
  });

  it("reports malformed manifests as diagnostics without crashing the catalog", async () => {
    await writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));
    await writeFamily("broken", "id: Broken Prod\nname: Broken\nversion: nope\n");

    const catalog = createFileHostedIntegrationCatalog({ dataDir });

    await expect(catalog.listFamilies()).resolves.toEqual([
      expect.objectContaining({ id: "qualys" }),
    ]);
    await expect(catalog.getFamily("broken")).resolves.toBeNull();
    await expect(catalog.getDiagnostics()).resolves.toEqual([
      expect.objectContaining({
        familyId: "broken",
        severity: "error",
      }),
    ]);
  });
});
