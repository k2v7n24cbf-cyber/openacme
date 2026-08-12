import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSourceFileStore,
} from "../src/index.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-promotion-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration promotion source lifecycle", () => {
  it("updates canonical source and records the resulting source revision on the generation", async () => {
    await writeSourceFamily(
      "def call_tool(name, args, ctx):\n    return {'count': 1}\n",
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
    const draft = await draftStore.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });
    if (!draft.ok) throw new Error(draft.reason);
    await draftStore.writeDraftFile({
      draftId: "draft_1",
      lockId: "lock_1",
      path: "qualys.py",
      content: "def call_tool(name, args, ctx):\n    return {'count': 2}\n",
    });

    const files = await collectDraftFiles(draftStore);
    const source = await createFileHostedIntegrationSourceFileStore({
      dataDir,
    }).replaceSourceFiles({
      familyId: "qualys",
      files,
      updatedBy: "agent:tool-developer",
      sourceRevisionId: "source_rev_2",
    });
    const promoted = await createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore,
      createId: () => "gen_1",
    }).promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
      sourceRevisionId: source.sourceRevisionId,
    });

    expect(promoted).toMatchObject({
      ok: true,
      generation: { id: "gen_1", sourceRevisionId: "source_rev_2" },
    });
    await expect(
      createFileHostedIntegrationSourceFileStore({
        dataDir,
      }).readSourceFile({ familyId: "qualys", path: "qualys.py" }),
    ).resolves.toMatchObject({
      ok: true,
      content: "def call_tool(name, args, ctx):\n    return {'count': 2}\n",
    });
    await expect(
      createFileHostedIntegrationSourceFileStore({
        dataDir,
      }).getCurrentSourceRevisionId("qualys"),
    ).resolves.toBe("source_rev_2");
  });
});

async function collectDraftFiles(
  draftStore: ReturnType<typeof createFileHostedIntegrationDraftStore>,
): Promise<Record<string, string>> {
  const listed = await draftStore.listDraftFiles("draft_1");
  if (!listed.ok) throw new Error(listed.reason);
  const files: Record<string, string> = {};
  for (const file of listed.files) {
    const read = await draftStore.readDraftFile({
      draftId: "draft_1",
      path: file.path,
    });
    if (!read.ok) throw new Error(read.reason);
    files[file.path] = read.content;
  }
  return files;
}

async function writeSourceFamily(entrypoint: string): Promise<void> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "family.yaml"), familyYaml(), "utf-8");
  await writeFile(path.join(sourceDir, "qualys.py"), entrypoint, "utf-8");
}

function familyYaml(): string {
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
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets.
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
