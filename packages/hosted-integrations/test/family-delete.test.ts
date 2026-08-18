import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDisablementStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationFamilyDeleter,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";
import { withSplitToolContractFiles } from "./test-support/split-contract-fixtures.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-delete-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration family deletion", () => {
  it("retains file-backed generation artifacts as disabled forensic evidence", async () => {
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
    const draft = await draftStore.createDraftFromFiles({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
      files: withSplitToolContractFiles({
        "family.yaml": familyYaml(),
        "qualys.py": "def tool_qualys_count_assets(args, context):\n    return {'count': 1}\n",
      }),
    });
    if (!draft.ok) throw new Error(`draft creation failed: ${draft.reason}`);

    const generations = createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore,
      createId: () => "gen_1",
    });
    await expect(
      generations.promoteDraft({
        draftId: draft.draft.id,
        promotedBy: "agent:tool-developer",
        validation: { ok: true, diagnostics: [] },
        sourceRevisionId: "source_rev_1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      generation: { id: "gen_1", status: "active" },
    });

    const deleteFamily = createFileHostedIntegrationFamilyDeleter({
      dataDir,
      generations,
      disablements: createFileHostedIntegrationDisablementStore({ dataDir }),
    });
    await expect(
      deleteFamily({
        familyId: "qualys",
        deletedBy: "agent:tool-developer",
      }),
    ).resolves.toMatchObject({
      ok: true,
      familyId: "qualys",
      status: "deleted",
      generationIds: ["gen_1"],
    });

    await expect(generations.getActiveGeneration("qualys")).resolves.toBeNull();
    await expect(generations.getGeneration("gen_1")).resolves.toMatchObject({
      id: "gen_1",
      familyId: "qualys",
      status: "disabled",
    });
    await expect(
      readFile(
        path.join(
          dataDir,
          "hosted-integrations",
          "generations",
          "gen_1",
          "files",
          "qualys.py",
        ),
        "utf-8",
      ),
    ).resolves.toContain("tool_qualys_count_assets");
  });
});

function familyYaml() {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 1000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
runtimeConfig:
  requiredConfigKeys: []
  requiredSecretKeys: []
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets matching a safe query.
    inputSchema:
      type: object
      properties: {}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}
