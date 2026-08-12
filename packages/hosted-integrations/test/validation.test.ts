import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-validation-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function setupDraft(
  sourceManifest = familyYaml(),
  draftManifest = sourceManifest,
): Promise<ReturnType<typeof createFileHostedIntegrationDraftValidator>> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "family.yaml"), sourceManifest, "utf-8");
  await writeFile(
    path.join(sourceDir, "qualys.py"),
    "def run(): pass\n",
    "utf-8",
  );

  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    createId: () => "lock_1",
  });
  await lockStore.acquireLock({
    familyId: "qualys",
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const draftStore = createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    createId: () => "draft_1",
  });
  await draftStore.createDraft({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
  });
  await draftStore.writeDraftFile({
    draftId: "draft_1",
    lockId: "lock_1",
    path: "family.yaml",
    content: draftManifest,
  });

  return createFileHostedIntegrationDraftValidator({
    draftStore,
    catalog: createFileHostedIntegrationCatalog({ dataDir }),
  });
}

function familyYaml(): string {
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

describe("hosted integration draft validation", () => {
  it("passes a valid draft", async () => {
    const validator = await setupDraft();

    await expect(validator.validateDraft("draft_1")).resolves.toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  it("returns structured diagnostics for missing classification", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace(
        /\n    classification:\n      operation: read\n      freshness: live\n      idempotency: idempotent\n      execution: sync\n      approval: none/,
        "",
      ),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "manifest_invalid",
        path: "$.tools.0.classification",
      }),
    );
  });

  it("fails duplicate tool names", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace("qualys_list_assets", "qualys_count_assets"),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate_tool_name",
        path: "$.tools.1.name",
      }),
    );
  });

  it("fails direct removal of an existing source tool", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace(
        /\n  - name: qualys_list_assets[\s\S]*?      approval: none\n/,
        "\n",
      ),
    );

    await expect(validator.validateDraft("draft_1")).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "breaking_tool_removal",
          path: "$.tools",
          message:
            "tool qualys_list_assets exists in source and cannot be removed directly",
        }),
      ],
    });
  });

  it("returns structured diagnostics for invalid runtime settings", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace("defaultTimeoutMs: 30000", "defaultTimeoutMs: 0"),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "manifest_invalid",
        path: "$.runtime.defaultTimeoutMs",
      }),
    );
  });
});
