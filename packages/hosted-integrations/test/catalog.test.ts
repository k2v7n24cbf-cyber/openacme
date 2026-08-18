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
  await writeFile(
    path.join(dir, "tools.yaml"),
    toolsYaml(
      familyId,
      familyId === "qualys" ? "Qualys" : "Splunk",
      familyId === "qualys" ? "qualys_count_assets" : "splunk_search",
    ),
    "utf-8",
  );
}

async function writeFamilyManifestOnly(
  familyId: string,
  yaml: string,
): Promise<void> {
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
`;
}

function toolsYaml(id: string, name: string, toolName: string): string {
  return `
kind: openacme.hostedToolFamily
version: 1
family:
  id: ${id}
tools:
  - mcp:
      name: hosted_${id}__${toolName}
      title: ${name} read
      description: Read safe ${name} metadata.
      inputSchema:
        type: object
        properties: {}
        additionalProperties: false
      outputSchema:
        type: object
        additionalProperties: true
      annotations:
        readOnlyHint: true
        destructiveHint: false
        idempotentHint: true
        openWorldHint: true
    openacme:
      toolName: ${toolName}
      function: tool_${toolName}
      lifecycle: active
      classification:
        operation: read
        freshness: live
        idempotency: idempotent
        execution: sync
        approval: none
      selectWhen:
        - Need to read safe ${name} metadata.
      doNotSelectWhen:
        - Need to mutate ${name} state.
      prerequisites: []
      parameterHelp: {}
      examples:
        - {}
      errors: []
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

  it("requires tools.yaml before listing a family", async () => {
    await writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));
    await writeFamilyManifestOnly(
      "splunk",
      familyYaml("splunk", "Splunk", "splunk_search"),
    );

    const catalog = createFileHostedIntegrationCatalog({ dataDir });

    await expect(catalog.listFamilies()).resolves.toEqual([
      expect.objectContaining({ id: "qualys" }),
    ]);
    await expect(catalog.getFamily("splunk")).resolves.toBeNull();
    await expect(catalog.getDiagnostics()).resolves.toEqual([
      expect.objectContaining({
        familyId: "splunk",
        severity: "error",
        message: expect.stringContaining("failed to read tools.yaml"),
      }),
    ]);
  });
});
