import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationFamilyLockSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationFamilyLock,
} from "./schemas.js";

export interface FileHostedIntegrationLockStoreOptions {
  dataDir: string;
  now?: () => Date;
  createId?: () => string;
}

export interface AcquireHostedIntegrationLockRequest {
  familyId: HostedIntegrationFamilyId | string;
  lockedBy: string;
  ttlMs: number;
  draftId?: string;
}

export type AcquireHostedIntegrationLockResult =
  | { ok: true; lock: HostedIntegrationFamilyLock }
  | { ok: false; reason: "locked"; lock: HostedIntegrationFamilyLock };

export interface RenewHostedIntegrationLockRequest {
  lockId: string;
  lockedBy: string;
  ttlMs: number;
}

export type RenewHostedIntegrationLockResult =
  | { ok: true; lock: HostedIntegrationFamilyLock }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; lock: HostedIntegrationFamilyLock };

export interface ReleaseHostedIntegrationLockRequest {
  lockId: string;
  lockedBy: string;
}

export type ReleaseHostedIntegrationLockResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; lock: HostedIntegrationFamilyLock };

export interface HostedIntegrationLockStore {
  getActiveLock(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyLock | null>;
  acquireLock(
    request: AcquireHostedIntegrationLockRequest,
  ): Promise<AcquireHostedIntegrationLockResult>;
  renewLock(
    request: RenewHostedIntegrationLockRequest,
  ): Promise<RenewHostedIntegrationLockResult>;
  releaseLock(
    request: ReleaseHostedIntegrationLockRequest,
  ): Promise<ReleaseHostedIntegrationLockResult>;
}

interface StoredLock {
  lock: HostedIntegrationFamilyLock;
  filePath: string;
}

export function createFileHostedIntegrationLockStore(
  options: FileHostedIntegrationLockStoreOptions,
): HostedIntegrationLockStore {
  return new FileHostedIntegrationLockStore(options);
}

class FileHostedIntegrationLockStore implements HostedIntegrationLockStore {
  private readonly locksDir: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: FileHostedIntegrationLockStoreOptions) {
    this.locksDir = path.join(options.dataDir, "hosted-integrations", "locks");
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `lock_${randomUUID()}`);
  }

  async getActiveLock(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyLock | null> {
    const parsedFamilyId = HostedIntegrationFamilyIdSchema.safeParse(familyId);
    if (!parsedFamilyId.success) return null;

    const stored = await this.readFamilyLock(parsedFamilyId.data);
    if (!stored || isExpired(stored.lock, this.now())) return null;
    return stored.lock;
  }

  async acquireLock(
    request: AcquireHostedIntegrationLockRequest,
  ): Promise<AcquireHostedIntegrationLockResult> {
    const familyId = HostedIntegrationFamilyIdSchema.parse(request.familyId);
    assertNonEmpty("lockedBy", request.lockedBy);
    assertPositiveTtl(request.ttlMs);

    const existing = await this.readFamilyLock(familyId);
    const now = this.now();
    if (existing && !isExpired(existing.lock, now)) {
      return { ok: false, reason: "locked", lock: existing.lock };
    }

    const lock = createLock({
      id: this.createId(),
      familyId,
      lockedBy: request.lockedBy,
      draftId: request.draftId,
      now,
      ttlMs: request.ttlMs,
    });
    await this.writeFamilyLock(lock);
    return { ok: true, lock };
  }

  async renewLock(
    request: RenewHostedIntegrationLockRequest,
  ): Promise<RenewHostedIntegrationLockResult> {
    assertNonEmpty("lockId", request.lockId);
    assertNonEmpty("lockedBy", request.lockedBy);
    assertPositiveTtl(request.ttlMs);

    const stored = await this.findLockById(request.lockId);
    if (!stored || isExpired(stored.lock, this.now()))
      return { ok: false, reason: "not_found" };
    if (stored.lock.lockedBy !== request.lockedBy) {
      return { ok: false, reason: "conflict", lock: stored.lock };
    }

    const now = this.now();
    const renewed = HostedIntegrationFamilyLockSchema.parse({
      ...stored.lock,
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    });
    await this.writeFamilyLock(renewed);
    return { ok: true, lock: renewed };
  }

  async releaseLock(
    request: ReleaseHostedIntegrationLockRequest,
  ): Promise<ReleaseHostedIntegrationLockResult> {
    assertNonEmpty("lockId", request.lockId);
    assertNonEmpty("lockedBy", request.lockedBy);

    const stored = await this.findLockById(request.lockId);
    if (!stored || isExpired(stored.lock, this.now()))
      return { ok: false, reason: "not_found" };
    if (stored.lock.lockedBy !== request.lockedBy) {
      return { ok: false, reason: "conflict", lock: stored.lock };
    }

    await unlink(stored.filePath);
    return { ok: true };
  }

  private async readFamilyLock(
    familyId: HostedIntegrationFamilyId,
  ): Promise<StoredLock | null> {
    const filePath = this.lockPath(familyId);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const lock = HostedIntegrationFamilyLockSchema.parse(JSON.parse(raw));
    return { lock, filePath };
  }

  private async findLockById(lockId: string): Promise<StoredLock | null> {
    let entries;
    try {
      entries = await readdir(this.locksDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.locksDir, entry.name);
      const raw = await readFile(filePath, "utf-8");
      const lock = HostedIntegrationFamilyLockSchema.parse(JSON.parse(raw));
      if (lock.id === lockId) return { lock, filePath };
    }
    return null;
  }

  private async writeFamilyLock(
    lock: HostedIntegrationFamilyLock,
  ): Promise<void> {
    await mkdir(this.locksDir, { recursive: true });
    const filePath = this.lockPath(lock.familyId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private lockPath(familyId: HostedIntegrationFamilyId): string {
    return path.join(this.locksDir, `${familyId}.json`);
  }
}

function createLock(input: {
  id: string;
  familyId: HostedIntegrationFamilyId;
  lockedBy: string;
  draftId?: string;
  now: Date;
  ttlMs: number;
}): HostedIntegrationFamilyLock {
  return HostedIntegrationFamilyLockSchema.parse({
    id: input.id,
    familyId: input.familyId,
    lockedBy: input.lockedBy,
    draftId: input.draftId,
    acquiredAt: input.now.toISOString(),
    renewedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
  });
}

function isExpired(lock: HostedIntegrationFamilyLock, now: Date): boolean {
  return Date.parse(lock.expiresAt) <= now.getTime();
}

function assertNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive integer");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
