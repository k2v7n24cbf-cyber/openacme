import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let generationCounter = 0;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-generations-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  generationCounter = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function generationStore() {
  return createFileHostedIntegrationGenerationStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `gen_${++generationCounter}`,
  });
}

async function createDraft(
  familyId = "qualys",
  sourceRevisionId = "source_rev_1",
): Promise<string> {
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => "lock_1",
  });
  await lockStore.acquireLock({
    familyId,
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const result = await createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    now: () => new Date(nowMs),
    createId: () => "draft_1",
  }).createDraftFromFiles({
    familyId,
    lockId: "lock_1",
    sourceRevisionId,
    files: {
      "family.yaml": familyYaml(familyId),
      [`${familyId}.py`]: "def run():\n    return {'ok': True}\n",
    },
  });
  if (!result.ok) throw new Error(`draft creation failed: ${result.reason}`);
  return result.draft.id;
}

describe("hosted integration generation artifact store", () => {
  it("promoting creates an immutable generation directory from draft files", async () => {
    const draftId = await createDraft();

    const result = await generationStore().promoteDraft({
      draftId,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });

    expect(result).toMatchObject({
      ok: true,
      generation: { id: "gen_1", familyId: "qualys", status: "active" },
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
    ).resolves.toBe("def run():\n    return {'ok': True}\n");
  });

  it("records source draft, source revision, actor, validation result, and time", async () => {
    const draftId = await createDraft("qualys", "source_rev_7");

    await expect(
      generationStore().promoteDraft({
        draftId,
        promotedBy: "agent:tool-developer",
        validation: {
          ok: true,
          diagnostics: [
            {
              severity: "warning",
              code: "mock_warning",
              path: "$",
              message: "kept for provenance",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      generation: {
        id: "gen_1",
        familyId: "qualys",
        sourceRevisionId: "source_rev_7",
        promotedAt: "2026-08-12T10:00:00.000Z",
        promotedBy: "agent:tool-developer",
        provenance: {
          draftId,
          draftRevisionId: "2026-08-12T10:00:00.000Z",
          promotedBy: "agent:tool-developer",
          validation: {
            ok: true,
            diagnostics: [
              {
                severity: "warning",
                code: "mock_warning",
                path: "$",
                message: "kept for provenance",
              },
            ],
          },
        },
      },
    });
  });

  it("changes the active generation pointer atomically on promotion", async () => {
    const draftId = await createDraft();
    const store = generationStore();

    await store.promoteDraft({
      draftId,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    nowMs += 60_000;
    await store.promoteDraft({
      draftId,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });

    await expect(store.getActiveGeneration("qualys")).resolves.toMatchObject({
      id: "gen_2",
      familyId: "qualys",
    });
  });

  it("rolls back the active pointer to an existing generation", async () => {
    const draftId = await createDraft();
    const store = generationStore();
    await store.promoteDraft({
      draftId,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    await store.promoteDraft({
      draftId,
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });

    await expect(
      store.rollback({
        familyId: "qualys",
        generationId: "gen_1",
        rolledBackBy: "agent:tool-developer",
      }),
    ).resolves.toMatchObject({
      ok: true,
      activeGeneration: { id: "gen_1" },
    });
    await expect(store.getActiveGeneration("qualys")).resolves.toMatchObject({
      id: "gen_1",
    });
  });
});

function familyYaml(familyId: string): string {
  return `
id: ${familyId}
name: ${familyId}
version: 1
runtime:
  language: python
  entrypoint: ${familyId}.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_only
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
tools:
  - name: ${familyId}_tool
    title: ${familyId} tool
    description: ${familyId} tool.
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
