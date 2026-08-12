import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let lockCounter = 0;
let draftCounter = 0;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-drafts-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  lockCounter = 0;
  draftCounter = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function locks() {
  return createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `lock_${++lockCounter}`,
  });
}

function drafts() {
  return createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore: locks(),
    now: () => new Date(nowMs),
    createId: () => `draft_${++draftCounter}`,
  });
}

async function writeSourceFamily(familyId: string): Promise<void> {
  const dir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "family.yaml"), `id: ${familyId}\n`, "utf-8");
  await writeFile(
    path.join(dir, `${familyId}.py`),
    "def run(): pass\n",
    "utf-8",
  );
}

describe("file-backed hosted integration draft store", () => {
  it("creates a draft by copying family source while holding the active lock", async () => {
    await writeSourceFamily("qualys");
    const lockStore = locks();
    await lockStore.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });

    const result = await createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore,
      now: () => new Date(nowMs),
      createId: () => "draft_1",
    }).createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });

    expect(result).toEqual({
      ok: true,
      draft: {
        id: "draft_1",
        familyId: "qualys",
        lockId: "lock_1",
        sourceRevisionId: "source_rev_1",
        status: "open",
        createdAt: "2026-08-12T10:00:00.000Z",
        updatedAt: "2026-08-12T10:00:00.000Z",
      },
    });
    await expect(
      readFile(
        path.join(
          dataDir,
          "hosted-integrations",
          "drafts",
          "draft_1",
          "files",
          "qualys.py",
        ),
        "utf-8",
      ),
    ).resolves.toBe("def run(): pass\n");
  });

  it("rejects draft creation without the active family lock", async () => {
    await writeSourceFamily("qualys");

    await expect(
      drafts().createDraft({
        familyId: "qualys",
        lockId: "lock_missing",
        sourceRevisionId: "source_rev_1",
      }),
    ).resolves.toEqual({ ok: false, reason: "lock_required" });
  });

  it("reads files only from the draft file root", async () => {
    await writeSourceFamily("qualys");
    const lockStore = locks();
    await lockStore.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    const draftStore = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore,
      now: () => new Date(nowMs),
      createId: () => "draft_1",
    });
    await draftStore.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });

    await expect(
      draftStore.readDraftFile({ draftId: "draft_1", path: "qualys.py" }),
    ).resolves.toEqual({ ok: true, content: "def run(): pass\n" });
    await expect(
      draftStore.readDraftFile({
        draftId: "draft_1",
        path: "../metadata.json",
      }),
    ).rejects.toThrow("path escapes draft root");
    await expect(
      draftStore.readDraftFile({ draftId: "../draft_1", path: "qualys.py" }),
    ).rejects.toThrow("draftId must be a safe path segment");
  });

  it("patches and deletes files only with the active lock id", async () => {
    await writeSourceFamily("qualys");
    const lockStore = locks();
    await lockStore.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    const draftStore = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore,
      now: () => new Date(nowMs),
      createId: () => "draft_1",
    });
    await draftStore.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });

    await expect(
      draftStore.writeDraftFile({
        draftId: "draft_1",
        lockId: "lock_wrong",
        path: "qualys.py",
        content: "changed\n",
      }),
    ).resolves.toEqual({ ok: false, reason: "lock_required" });
    await expect(
      draftStore.writeDraftFile({
        draftId: "draft_1",
        lockId: "lock_1",
        path: "qualys.py",
        content: "changed\n",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      draftStore.readDraftFile({ draftId: "draft_1", path: "qualys.py" }),
    ).resolves.toEqual({ ok: true, content: "changed\n" });

    await expect(
      draftStore.deleteDraftFile({
        draftId: "draft_1",
        lockId: "lock_1",
        path: "qualys.py",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      draftStore.readDraftFile({ draftId: "draft_1", path: "qualys.py" }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects path traversal for patch and delete", async () => {
    await writeSourceFamily("qualys");
    const lockStore = locks();
    await lockStore.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    const draftStore = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore,
      now: () => new Date(nowMs),
      createId: () => "draft_1",
    });
    await draftStore.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });

    await expect(
      draftStore.writeDraftFile({
        draftId: "draft_1",
        lockId: "lock_1",
        path: "../metadata.json",
        content: "overwrite",
      }),
    ).rejects.toThrow("path escapes draft root");
    await expect(
      draftStore.deleteDraftFile({
        draftId: "draft_1",
        lockId: "lock_1",
        path: "../metadata.json",
      }),
    ).rejects.toThrow("path escapes draft root");
  });
});
