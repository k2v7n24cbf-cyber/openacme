import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHostedIntegrationLockStore } from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let idCounter = 0;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-locks-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  idCounter = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function store() {
  return createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `lock_${++idCounter}`,
  });
}

describe("file-backed hosted integration lock store", () => {
  it("acquires an unlocked family", async () => {
    const locks = store();

    const result = await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });

    expect(result).toEqual({
      ok: true,
      lock: {
        id: "lock_1",
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        acquiredAt: "2026-08-12T10:00:00.000Z",
        renewedAt: "2026-08-12T10:00:00.000Z",
        expiresAt: "2026-08-12T10:01:00.000Z",
      },
    });
    await expect(locks.getActiveLock("qualys")).resolves.toMatchObject({
      id: "lock_1",
    });
  });

  it("rejects a second acquire while the family is locked", async () => {
    const locks = store();
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });

    const result = await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:other",
      ttlMs: 60_000,
    });

    expect(result).toEqual({
      ok: false,
      reason: "locked",
      lock: expect.objectContaining({
        id: "lock_1",
        lockedBy: "agent:tool-developer",
        expiresAt: "2026-08-12T10:01:00.000Z",
      }),
    });
  });

  it("renews only with the active lock id and owner", async () => {
    const locks = store();
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    nowMs += 10_000;

    await expect(
      locks.renewLock({
        lockId: "lock_wrong",
        lockedBy: "agent:tool-developer",
        ttlMs: 120_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(
      locks.renewLock({
        lockId: "lock_1",
        lockedBy: "agent:other",
        ttlMs: 120_000,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "conflict",
      lock: expect.objectContaining({ lockedBy: "agent:tool-developer" }),
    });

    await expect(
      locks.renewLock({
        lockId: "lock_1",
        lockedBy: "agent:tool-developer",
        ttlMs: 120_000,
      }),
    ).resolves.toEqual({
      ok: true,
      lock: expect.objectContaining({
        id: "lock_1",
        renewedAt: "2026-08-12T10:00:10.000Z",
        expiresAt: "2026-08-12T10:02:10.000Z",
      }),
    });
  });

  it("allows expired lock takeover", async () => {
    const locks = store();
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 1_000,
    });
    nowMs += 1_001;

    const result = await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:other",
      ttlMs: 60_000,
    });

    expect(result).toEqual({
      ok: true,
      lock: expect.objectContaining({
        id: "lock_2",
        lockedBy: "agent:other",
        expiresAt: "2026-08-12T10:01:01.001Z",
      }),
    });
  });

  it("releases the active lock before another acquire", async () => {
    const locks = store();
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });

    await expect(
      locks.releaseLock({ lockId: "lock_1", lockedBy: "agent:tool-developer" }),
    ).resolves.toEqual({ ok: true });
    await expect(locks.getActiveLock("qualys")).resolves.toBeNull();
    await expect(
      locks.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:other",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ok: true, lock: { id: "lock_2" } });
  });
});
