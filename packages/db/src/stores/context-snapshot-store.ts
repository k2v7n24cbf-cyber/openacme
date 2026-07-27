import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { WasmDatabase } from "../wasm/adapter.js";
import { drizzle } from "../wasm/drizzle.js";
import {
  sessionContextSnapshots,
  type SessionContextSnapshotRow as RawSessionContextSnapshotRow,
} from "../schema.js";

export type ContextSnapshotReason =
  | "proactive"
  | "payload_too_large"
  | "context_overflow";

export interface ContextSnapshotInput {
  id?: string;
  sessionId: string;
  reason: ContextSnapshotReason;
  compressed: boolean;
  modelMessages: unknown[];
  canonicalMessageCount: number;
  sourceLastMessageId?: string | null;
  summaryText?: string | null;
  summarySha256?: string | null;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  reason: ContextSnapshotReason;
  compressed: boolean;
  modelMessages: unknown[];
  canonicalMessageCount: number;
  sourceLastMessageId: string | null;
  summaryText: string | null;
  summarySha256: string | null;
  createdAt: number;
}

export function createContextSnapshotStore(db: WasmDatabase) {
  const orm = drizzle(db);

  return {
    create(input: ContextSnapshotInput): ContextSnapshot {
      const row = orm
        .insert(sessionContextSnapshots)
        .values({
          id: input.id ?? randomUUID(),
          sessionId: input.sessionId,
          reason: input.reason,
          compressed: input.compressed,
          modelMessages: JSON.stringify(input.modelMessages),
          canonicalMessageCount: input.canonicalMessageCount,
          sourceLastMessageId: input.sourceLastMessageId ?? null,
          summaryText: input.summaryText ?? null,
          summarySha256: input.summarySha256 ?? null,
        })
        .returning()
        .get();
      return toContextSnapshot(row);
    },

    get(id: string): ContextSnapshot | null {
      const row =
        orm
          .select()
          .from(sessionContextSnapshots)
          .where(eq(sessionContextSnapshots.id, id))
          .get() ?? null;
      return row ? toContextSnapshot(row) : null;
    },

    listForSession(sessionId: string, limit = 50): ContextSnapshot[] {
      return orm
        .select()
        .from(sessionContextSnapshots)
        .where(eq(sessionContextSnapshots.sessionId, sessionId))
        .orderBy(desc(sessionContextSnapshots.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500))
        .all()
        .map(toContextSnapshot);
    },
  };
}

function toContextSnapshot(
  row: RawSessionContextSnapshotRow
): ContextSnapshot {
  return {
    id: row.id,
    sessionId: row.sessionId,
    reason: row.reason as ContextSnapshotReason,
    compressed: Boolean(row.compressed),
    modelMessages: parseModelMessages(row.modelMessages),
    canonicalMessageCount: row.canonicalMessageCount,
    sourceLastMessageId: row.sourceLastMessageId,
    summaryText: row.summaryText,
    summarySha256: row.summarySha256,
    createdAt: row.createdAt,
  };
}

function parseModelMessages(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type ContextSnapshotStore = ReturnType<typeof createContextSnapshotStore>;
