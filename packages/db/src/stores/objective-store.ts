import type { WasmDatabase } from "../wasm/adapter.js";
import { drizzle } from "../wasm/drizzle.js";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  OBJECTIVE_STATUSES,
  objectiveEvents,
  objectives,
  type ObjectiveEventRow,
  type ObjectiveRow,
} from "../schema.js";

export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

const OBJECTIVE_STATUS_SET = new Set<string>(OBJECTIVE_STATUSES);

export type ObjectiveStoreErrorCode = "not_found" | "invalid_status";

export class ObjectiveStoreError extends Error {
  constructor(
    readonly code: ObjectiveStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ObjectiveStoreError";
  }
}

export interface ObjectiveStoreOptions {
  now?: () => Date;
}

export interface CreateObjectiveInput {
  id?: string;
  title: string;
  description?: string;
  status?: ObjectiveStatus;
  ownerAgentId: string;
  ownerSessionId?: string | null;
  createdBy: string;
  createdInSessionId?: string | null;
  closeoutPrompt?: string;
}

export interface ObjectiveListFilter {
  ownerAgentId?: string;
  ownerSessionId?: string;
  status?: ObjectiveStatus;
  limit?: number;
}

export interface ObjectiveUpdatePatch {
  title?: string;
  description?: string;
  status?: ObjectiveStatus;
  ownerAgentId?: string;
  ownerSessionId?: string | null;
  closeoutPrompt?: string;
  completedAt?: string | null;
  completionSummary?: string | null;
  lastCloseoutFingerprint?: string | null;
  lastCloseoutBriefJson?: string | null;
  lastCloseoutBriefAt?: string | null;
}

export interface ObjectiveEventInput {
  id?: string;
  objectiveId: string;
  eventType: string;
  actor: string;
  summary: string;
  details?: unknown;
}

export interface ObjectiveEvent {
  id: string;
  objectiveId: string;
  eventType: string;
  actor: string;
  summary: string;
  details: unknown | null;
  createdAt: number;
}

export interface CloseoutBriefSnapshot {
  fingerprint: string;
  packet?: unknown;
  brief?: unknown;
  [key: string]: unknown;
}

export interface DeleteObjectivesForOwnerResult {
  deletedIds: string[];
  deletedCount: number;
}

/**
 * SQL-backed objective aggregate and ledger. This store is deliberately
 * deterministic and side-effect free outside SQLite: no agent, dispatcher,
 * inbox, route, or tool behavior lives here.
 */
export function createObjectiveStore(
  db: WasmDatabase,
  opts: ObjectiveStoreOptions = {},
) {
  const orm = drizzle(db);
  const now = opts.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const nowMs = () => now().getTime();

  const appendEvent = (input: ObjectiveEventInput): ObjectiveEvent => {
    const row = orm
      .insert(objectiveEvents)
      .values({
        id: input.id ?? randomUUID(),
        objectiveId: input.objectiveId,
        eventType: input.eventType,
        actor: input.actor,
        summary: input.summary,
        detailsJson:
          input.details !== undefined ? JSON.stringify(input.details) : null,
        createdAt: nowMs(),
      })
      .returning()
      .get();
    return mapObjectiveEvent(row);
  };

  const getRequired = (id: string): ObjectiveRow => {
    const objective =
      orm.select().from(objectives).where(eq(objectives.id, id)).get() ?? null;
    if (!objective) {
      throw new ObjectiveStoreError("not_found", `Objective ${id} not found`);
    }
    return objective;
  };

  const updateAndGet = (
    id: string,
    patch: ObjectiveUpdatePatch,
  ): ObjectiveRow => {
    const current = getRequired(id);
    if (patch.status !== undefined) assertObjectiveStatus(patch.status);
    const updated = orm
      .update(objectives)
      .set({
        title: patch.title ?? current.title,
        description: patch.description ?? current.description,
        status: patch.status ?? current.status,
        ownerAgentId: patch.ownerAgentId ?? current.ownerAgentId,
        ownerSessionId:
          patch.ownerSessionId !== undefined
            ? patch.ownerSessionId
            : current.ownerSessionId,
        closeoutPrompt: patch.closeoutPrompt ?? current.closeoutPrompt,
        completedAt:
          patch.completedAt !== undefined
            ? patch.completedAt
            : current.completedAt,
        completionSummary:
          patch.completionSummary !== undefined
            ? patch.completionSummary
            : current.completionSummary,
        lastCloseoutFingerprint:
          patch.lastCloseoutFingerprint !== undefined
            ? patch.lastCloseoutFingerprint
            : current.lastCloseoutFingerprint,
        lastCloseoutBriefJson:
          patch.lastCloseoutBriefJson !== undefined
            ? patch.lastCloseoutBriefJson
            : current.lastCloseoutBriefJson,
        lastCloseoutBriefAt:
          patch.lastCloseoutBriefAt !== undefined
            ? patch.lastCloseoutBriefAt
            : current.lastCloseoutBriefAt,
        updatedAt: nowIso(),
      })
      .where(eq(objectives.id, id))
      .returning()
      .get();
    if (!updated) {
      throw new ObjectiveStoreError("not_found", `Objective ${id} not found`);
    }
    return updated;
  };

  const closeObjective = (
    id: string,
    status: Extract<ObjectiveStatus, "completed" | "failed" | "canceled">,
    summary: string,
    actor: string,
  ): ObjectiveRow => {
    const closedAt = nowIso();
    const objective = updateAndGet(id, {
      status,
      completedAt: closedAt,
      completionSummary: summary,
    });
    appendEvent({
      objectiveId: id,
      eventType: `objective_${status}`,
      actor,
      summary,
      details: { status, completedAt: closedAt },
    });
    return objective;
  };

  return {
    createObjective(input: CreateObjectiveInput): ObjectiveRow {
      const status = input.status ?? "active";
      assertObjectiveStatus(status);
      const createdAt = nowIso();
      const objective = orm
        .insert(objectives)
        .values({
          id: input.id ?? randomUUID(),
          title: input.title,
          description: input.description ?? "",
          status,
          ownerAgentId: input.ownerAgentId,
          ownerSessionId: input.ownerSessionId ?? null,
          createdBy: input.createdBy,
          createdInSessionId: input.createdInSessionId ?? null,
          closeoutPrompt: input.closeoutPrompt ?? "",
          createdAt,
          updatedAt: createdAt,
        })
        .returning()
        .get();
      appendEvent({
        objectiveId: objective.id,
        eventType: "objective_created",
        actor: input.createdBy,
        summary: `Objective created: ${input.title}`,
        details: {
          status,
          ownerAgentId: input.ownerAgentId,
          ownerSessionId: input.ownerSessionId ?? null,
          createdInSessionId: input.createdInSessionId ?? null,
        },
      });
      return objective;
    },

    getObjective(id: string): ObjectiveRow | null {
      return (
        orm.select().from(objectives).where(eq(objectives.id, id)).get() ?? null
      );
    },

    listObjectives(filter: ObjectiveListFilter = {}): ObjectiveRow[] {
      if (filter.status !== undefined) assertObjectiveStatus(filter.status);
      const filters = [];
      if (filter.ownerAgentId !== undefined) {
        filters.push(eq(objectives.ownerAgentId, filter.ownerAgentId));
      }
      if (filter.ownerSessionId !== undefined) {
        filters.push(eq(objectives.ownerSessionId, filter.ownerSessionId));
      }
      if (filter.status !== undefined) {
        filters.push(eq(objectives.status, filter.status));
      }
      const q = orm
        .select()
        .from(objectives)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(objectives.updatedAt), asc(objectives.id));
      return filter.limit !== undefined ? q.limit(filter.limit).all() : q.all();
    },

    updateObjective(
      id: string,
      patch: ObjectiveUpdatePatch,
      actor: string,
    ): ObjectiveRow {
      const objective = updateAndGet(id, patch);
      appendEvent({
        objectiveId: id,
        eventType: "objective_updated",
        actor,
        summary: "Objective updated",
        details: { fields: Object.keys(patch).sort() },
      });
      return objective;
    },

    completeObjective(
      id: string,
      summary: string,
      actor: string,
    ): ObjectiveRow {
      return closeObjective(id, "completed", summary, actor);
    },

    failObjective(id: string, summary: string, actor: string): ObjectiveRow {
      return closeObjective(id, "failed", summary, actor);
    },

    cancelObjective(id: string, summary: string, actor: string): ObjectiveRow {
      return closeObjective(id, "canceled", summary, actor);
    },

    appendObjectiveEvent(input: ObjectiveEventInput): ObjectiveEvent {
      getRequired(input.objectiveId);
      return appendEvent(input);
    },

    listObjectiveEvents(objectiveId: string): ObjectiveEvent[] {
      return orm
        .select()
        .from(objectiveEvents)
        .where(eq(objectiveEvents.objectiveId, objectiveId))
        .orderBy(asc(objectiveEvents.createdAt), sql`rowid asc`)
        .all()
        .map(mapObjectiveEvent);
    },

    recordCloseoutBrief(
      id: string,
      snapshot: CloseoutBriefSnapshot,
      actor: string,
    ): ObjectiveRow {
      const briefAt = nowIso();
      const objective = updateAndGet(id, {
        lastCloseoutFingerprint: snapshot.fingerprint,
        lastCloseoutBriefJson: JSON.stringify(snapshot),
        lastCloseoutBriefAt: briefAt,
      });
      if (snapshot.brief !== null && snapshot.brief !== undefined) {
        appendEvent({
          objectiveId: id,
          eventType: "closeout_brief_generated",
          actor,
          summary: "Closeout brief generated",
          details: {
            fingerprint: snapshot.fingerprint,
            generatedAt: briefAt,
          },
        });
      }
      return objective;
    },

    deleteObjectivesForOwner(
      ownerAgentId: string,
      actor: string,
    ): DeleteObjectivesForOwnerResult {
      void actor;
      const rows = orm
        .select({ id: objectives.id })
        .from(objectives)
        .where(eq(objectives.ownerAgentId, ownerAgentId))
        .orderBy(asc(objectives.id))
        .all();
      if (rows.length === 0) return { deletedIds: [], deletedCount: 0 };
      orm
        .delete(objectives)
        .where(eq(objectives.ownerAgentId, ownerAgentId))
        .run();
      const deletedIds = rows.map((row) => row.id);
      return { deletedIds, deletedCount: deletedIds.length };
    },
  };
}

function assertObjectiveStatus(
  status: string,
): asserts status is ObjectiveStatus {
  if (!OBJECTIVE_STATUS_SET.has(status)) {
    throw new ObjectiveStoreError(
      "invalid_status",
      `Invalid objective status: ${status}`,
    );
  }
}

function mapObjectiveEvent(row: ObjectiveEventRow): ObjectiveEvent {
  return {
    id: row.id,
    objectiveId: row.objectiveId,
    eventType: row.eventType,
    actor: row.actor,
    summary: row.summary,
    details: parseDetails(row.detailsJson),
    createdAt: row.createdAt,
  };
}

function parseDetails(detailsJson: string | null): unknown | null {
  if (detailsJson === null) return null;
  try {
    return JSON.parse(detailsJson);
  } catch {
    return null;
  }
}

export type ObjectiveStore = ReturnType<typeof createObjectiveStore>;
