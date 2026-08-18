import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationLockStore,
  resolveHostedIntegrationCachePath,
} from "../src/index.js";
import {
  splitLegacyFamilyFixture,
  writeSplitFamilyFixture,
} from "./test-support/split-contract-fixtures.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-cache-contract-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration explicit cache contract", () => {
  it("rejects live tools that declare cache metadata", async () => {
    const result = await validateManifest(
      familyYaml({
        freshness: "live",
        cache: `
    cache:
      scope: family_home
      path: cache/assets.json`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "cache_not_allowed",
        path: "$.tools.0.cache",
      }),
    );
  });

  it("requires cache metadata for cached and sync tools", async () => {
    for (const freshness of ["cached", "sync"] as const) {
      const result = await validateManifest(familyYaml({ freshness }));

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "cache_metadata_required",
          path: "$.tools.0.cache",
        }),
      );
    }
  });

  it("requires cache paths to stay under family home", async () => {
    const result = await validateManifest(
      familyYaml({
        freshness: "cached",
        cache: `
    cache:
      scope: family_home
      path: ../agent-workspace/leak.json`,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "cache_path_invalid",
        path: "$.tools.0.cache.path",
      }),
    );
  });

  it("resolves cache paths under family home, not caller workspace", () => {
    const familyHome = path.join(
      dataDir,
      "hosted-integrations",
      "qualys",
      "home",
    );
    const callerWorkspace = path.join(
      dataDir,
      "agents",
      "analyst",
      "workspace",
    );

    const resolved = resolveHostedIntegrationCachePath({
      familyHome,
      cache: { scope: "family_home", path: "cache/assets.json" },
    });

    expect(resolved).toBe(path.join(familyHome, "cache", "assets.json"));
    expect(resolved.startsWith(callerWorkspace)).toBe(false);
  });
});

async function validateManifest(manifest: string) {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await writeSplitFamilyFixture(sourceDir, familyYaml({}));
  await writeFile(path.join(sourceDir, "qualys.py"), "def run(): pass\n");

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
    content: splitLegacyFamilyFixture(manifest).familyYaml,
  });
  await draftStore.writeDraftFile({
    draftId: "draft_1",
    lockId: "lock_1",
    path: "tools.yaml",
    content: splitLegacyFamilyFixture(manifest).toolsYaml,
  });

  return createFileHostedIntegrationDraftValidator({
    draftStore,
    catalog: createFileHostedIntegrationCatalog({ dataDir }),
  }).validateDraft("draft_1");
}

function familyYaml(input: {
  freshness?: "live" | "cached" | "sync";
  cache?: string;
}): string {
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
      freshness: ${input.freshness ?? "live"}
      idempotency: idempotent
      execution: sync
      approval: none${input.cache ?? ""}
`;
}
