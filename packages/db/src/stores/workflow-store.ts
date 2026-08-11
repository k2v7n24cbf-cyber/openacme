import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  JsonValue,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunEventKind,
  WorkflowRunEventLevel,
  WorkflowRunMode,
  WorkflowRunStatus,
  WorkflowRunTrigger,
  WorkflowStepStatus,
  WorkflowTrigger,
} from "@openacme/workflows";
import {
  JsonValueSchema,
  normalizeWorkflowDefinitionGraph,
  WorkflowDefinitionSchema,
  WorkflowRunSchema,
  WorkflowStepAttemptSchema,
  WorkflowRunEventSchema,
} from "@openacme/workflows";
import type { WasmDatabase } from "../wasm/adapter.js";

export interface WorkflowDraftInput {
  id?: string;
  name: string;
  description?: string | null;
  inputSchema?: JsonValue;
  triggers?: WorkflowTrigger[];
  nodes?: WorkflowNode[];
  ui?: WorkflowDefinition["ui"];
  now?: string;
}

export interface WorkflowDraftUpdate {
  name?: string;
  description?: string | null;
  inputSchema?: JsonValue | null;
  triggers?: WorkflowTrigger[];
  nodes?: WorkflowNode[];
  ui?: WorkflowDefinition["ui"] | null;
  now?: string;
}

export interface WorkflowRunInput {
  id?: string;
  workflowId: string;
  workflowVersion: number;
  definitionSource?: "draft" | "published";
  definitionSnapshot?: WorkflowDefinition;
  mode: WorkflowRunMode;
  trigger?: WorkflowRunTrigger;
  status?: WorkflowRunStatus;
  input?: JsonValue;
  context?: JsonValue;
  currentNodeId?: string | null;
  waitingReason?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

export interface WorkflowStepAttemptInput {
  id?: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: WorkflowStepStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  input?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  logsSummary?: JsonValue;
  contextDiff?: JsonValue;
}

export interface WorkflowRunEventInput {
  id?: string;
  runId: string;
  stepRunId?: string | null;
  sequence?: number;
  level: WorkflowRunEventLevel;
  kind: WorkflowRunEventKind;
  message?: string;
  payload?: JsonValue;
  createdAt?: string;
}

export interface WorkflowArtifactInput {
  id?: string;
  runId: string;
  stepRunId?: string | null;
  kind: string;
  path: string;
  preview?: string | null;
  createdAt?: string;
}

export interface WorkflowArtifact {
  id: string;
  runId: string;
  stepRunId: string | null;
  kind: string;
  path: string;
  preview: string | null;
  createdAt: string;
}

export interface WorkflowArtifactContent {
  artifact: WorkflowArtifact;
  content: JsonValue;
}

export interface WorkflowArtifactPruneInput {
  createdBefore: string;
}

export interface WorkflowArtifactPruneResult {
  scannedArtifacts: number;
  deletedFiles: number;
  missingFiles: number;
  skippedUnsafePaths: number;
}

export interface WorkflowRunFilter {
  workflowId?: string;
  mode?: WorkflowRunMode;
  status?: WorkflowRunStatus;
  triggerId?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
}

export interface WorkflowRunPage {
  runs: WorkflowRun[];
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface WorkflowDefinitionFilter {
  status?: "draft" | "published" | "archived";
  limit?: number;
}

export interface WorkflowRunStateUpdate {
  status: WorkflowRunStatus;
  context?: JsonValue;
  currentNodeId?: string | null;
  waitingReason?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

export interface WorkflowStoreOptions {
  artifactRoot?: string;
  inlineJsonByteLimit?: number;
  artifactPreviewBytes?: number;
}

const DEFAULT_INLINE_JSON_BYTE_LIMIT = 64 * 1024;
const DEFAULT_ARTIFACT_PREVIEW_BYTES = 2048;

export function createWorkflowStore(
  db: WasmDatabase,
  options: WorkflowStoreOptions = {},
) {
  return {
    createDraft(input: WorkflowDraftInput): WorkflowDefinition {
      const now = input.now ?? new Date().toISOString();
      const definition = normalizeWorkflowDefinitionGraph(
        WorkflowDefinitionSchema.parse({
          id: input.id ?? randomUUID(),
          version: 1,
          status: "draft",
          name: input.name,
          description: input.description ?? undefined,
          inputSchema: input.inputSchema,
          triggers: input.triggers,
          nodes: input.nodes ?? [],
          ui: input.ui,
          createdAt: now,
          updatedAt: now,
        }),
      );
      db.prepare(
        `INSERT INTO workflow_definitions
         (id, status, current_version, name, description, input_schema_json,
          triggers_json, nodes_json, ui_json, created_at, updated_at)
         VALUES
         (@id, @status, @currentVersion, @name, @description, @inputSchemaJson,
          @triggersJson, @nodesJson, @uiJson, @createdAt, @updatedAt)`,
      ).run(definitionToParams(definition));
      return definition;
    },

    listDefinitions(filter: WorkflowDefinitionFilter = {}) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.status) {
        clauses.push("status = @status");
        params.status = filter.status;
      } else {
        clauses.push("status != 'archived'");
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
      const rows = db
        .prepare<[Record<string, unknown>], WorkflowDefinitionRaw>(
          `SELECT * FROM workflow_definitions ${where}
           ORDER BY updated_at DESC LIMIT ${limit}`,
        )
        .all(params);
      return rows.map(definitionFromRow);
    },

    updateDraft(id: string, patch: WorkflowDraftUpdate): WorkflowDefinition {
      const current = this.getDefinition(id);
      if (!current) throw new Error(`Workflow not found: ${id}`);
      if (current.status === "archived") {
        throw new Error(`Workflow is archived: ${id}`);
      }
      const updated = normalizeWorkflowDefinitionGraph(
        WorkflowDefinitionSchema.parse({
          ...current,
          status: "draft",
          name: patch.name ?? current.name,
          description:
            patch.description === null
              ? undefined
              : (patch.description ?? current.description),
          inputSchema:
            patch.inputSchema === null
              ? undefined
              : (patch.inputSchema ?? current.inputSchema),
          triggers: patch.triggers ?? current.triggers,
          nodes: patch.nodes ?? current.nodes,
          ui: patch.ui === null ? undefined : (patch.ui ?? current.ui),
          updatedAt: patch.now ?? new Date().toISOString(),
        }),
      );
      db.prepare(
        `UPDATE workflow_definitions
         SET status = @status,
             name = @name,
             description = @description,
             input_schema_json = @inputSchemaJson,
             triggers_json = @triggersJson,
             nodes_json = @nodesJson,
             ui_json = @uiJson,
             updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: updated.id,
        status: updated.status,
        name: updated.name,
        description: updated.description ?? null,
        inputSchemaJson: maybeStringify(updated.inputSchema),
        triggersJson: stringify(updated.triggers),
        nodesJson: stringify(updated.nodes),
        uiJson: maybeStringify(updated.ui),
        updatedAt: updated.updatedAt,
      });
      return updated;
    },

    getDefinition(id: string): WorkflowDefinition | null {
      const row = db
        .prepare<
          [string],
          WorkflowDefinitionRaw
        >(`SELECT * FROM workflow_definitions WHERE id = ?`)
        .get(id);
      return row ? definitionFromRow(row) : null;
    },

    archiveDefinition(
      id: string,
      now = new Date().toISOString(),
    ): WorkflowDefinition {
      const current = this.getDefinition(id);
      if (!current) throw new Error(`Workflow not found: ${id}`);
      const archived = WorkflowDefinitionSchema.parse({
        ...current,
        status: "archived",
        updatedAt: now,
      });
      db.prepare(
        `UPDATE workflow_definitions
         SET status = @status,
             updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id,
        status: archived.status,
        updatedAt: archived.updatedAt,
      });
      return archived;
    },

    publish(id: string, now = new Date().toISOString()): WorkflowDefinition {
      const draft = this.getDefinition(id);
      if (!draft) throw new Error(`Workflow not found: ${id}`);
      if (draft.status === "archived") {
        throw new Error(`Workflow is archived: ${id}`);
      }
      const nextVersion = draft.version + 1;
      const published = WorkflowDefinitionSchema.parse({
        ...draft,
        version: nextVersion,
        status: "published",
        updatedAt: now,
      });
      db.transaction(() => {
        db.prepare(
          `INSERT INTO workflow_versions
           (workflow_id, version, name, description, input_schema_json,
            triggers_json, nodes_json, ui_json, created_at)
           VALUES
           (@workflowId, @version, @name, @description, @inputSchemaJson,
            @triggersJson, @nodesJson, @uiJson, @createdAt)`,
        ).run(versionToParams(published, now));
        db.prepare(
          `UPDATE workflow_definitions
           SET status = @status, current_version = @currentVersion,
               updated_at = @updatedAt
           WHERE id = @id`,
        ).run({
          id,
          status: "published",
          currentVersion: nextVersion,
          updatedAt: now,
        });
      })();
      return published;
    },

    getVersion(workflowId: string, version: number): WorkflowDefinition | null {
      const row = db
        .prepare<[string, number], WorkflowVersionRaw>(
          `SELECT * FROM workflow_versions
           WHERE workflow_id = ? AND version = ?`,
        )
        .get(workflowId, version);
      return row ? definitionFromVersionRow(row) : null;
    },

    createRun(input: WorkflowRunInput) {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const id = input.id ?? randomUUID();
      const redactedInput = redact(input.input ?? {});
      const redactedContext = redact(input.context ?? {});
      const spilledInput = spillRunInput(options, {
        runId: id,
        value: redactedInput,
        createdAt,
      });
      const spilledContext = spillRunContext(options, {
        runId: id,
        value: redactedContext,
        createdAt,
      });
      const run = WorkflowRunSchema.parse({
        id,
        workflowId: input.workflowId,
        workflowVersion: input.workflowVersion,
        definitionSource: input.definitionSource ?? "published",
        definitionSnapshot: input.definitionSnapshot,
        mode: input.mode,
        trigger: redact(input.trigger ?? { kind: "manual" }),
        status: input.status ?? "queued",
        input: spilledInput.value,
        context: spilledContext.value,
        currentNodeId: input.currentNodeId ?? null,
        waitingReason: input.waitingReason ?? null,
        createdAt,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        durationMs: input.durationMs ?? null,
      });
      db.transaction(() => {
        db.prepare(
          `INSERT INTO workflow_runs
           (id, workflow_id, workflow_version, definition_source,
            definition_snapshot_json, mode,
            trigger_json, status, input_json, context_json, current_node_id,
            waiting_reason, created_at, started_at, ended_at, duration_ms)
           VALUES
           (@id, @workflowId, @workflowVersion, @definitionSource,
            @definitionSnapshotJson, @mode,
            @triggerJson, @status, @inputJson, @contextJson, @currentNodeId,
            @waitingReason, @createdAt, @startedAt, @endedAt, @durationMs)`,
        ).run(runToParams(run));
        for (const artifact of [
          ...spilledInput.artifacts,
          ...spilledContext.artifacts,
        ]) {
          upsertArtifact(db, artifact);
        }
      })();
      return run;
    },

    getRun(id: string) {
      const row = db
        .prepare<
          [string],
          WorkflowRunRaw
        >(`SELECT * FROM workflow_runs WHERE id = ?`)
        .get(id);
      return row ? runFromRow(row) : null;
    },

    updateRunState(id: string, patch: WorkflowRunStateUpdate) {
      const current = this.getRun(id);
      if (!current) throw new Error(`Workflow run not found: ${id}`);
      const spilledContext =
        patch.context === undefined
          ? { value: current.context, artifacts: [] }
          : spillRunContext(options, {
              runId: id,
              value: redact(patch.context),
              createdAt:
                patch.endedAt ?? patch.startedAt ?? new Date().toISOString(),
            });
      const updated = WorkflowRunSchema.parse({
        ...current,
        status: patch.status,
        context: spilledContext.value,
        currentNodeId:
          patch.currentNodeId === undefined
            ? current.currentNodeId
            : patch.currentNodeId,
        waitingReason:
          patch.waitingReason === undefined
            ? current.waitingReason
            : patch.waitingReason,
        startedAt:
          patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        endedAt: patch.endedAt === undefined ? current.endedAt : patch.endedAt,
        durationMs:
          patch.durationMs === undefined ? current.durationMs : patch.durationMs,
      });
      db.transaction(() => {
        db.prepare(
          `UPDATE workflow_runs
           SET status = @status,
               context_json = @contextJson,
               current_node_id = @currentNodeId,
               waiting_reason = @waitingReason,
               started_at = @startedAt,
               ended_at = @endedAt,
               duration_ms = @durationMs
           WHERE id = @id`,
        ).run({
          id: updated.id,
          status: updated.status,
          contextJson: stringify(updated.context),
          currentNodeId: updated.currentNodeId,
          waitingReason: updated.waitingReason,
          startedAt: updated.startedAt,
          endedAt: updated.endedAt,
          durationMs: updated.durationMs,
        });
        for (const artifact of spilledContext.artifacts) {
          upsertArtifact(db, artifact);
        }
      })();
      return updated;
    },

    recordStepAttempt(input: WorkflowStepAttemptInput) {
      const id = input.id ?? randomUUID();
      const redactedInput =
        input.input === undefined ? undefined : redact(input.input);
      const redactedOutput =
        input.output === undefined ? undefined : redact(input.output);
      const redactedError =
        input.error === undefined ? undefined : redact(input.error);
      const spilledInput = spillStepTraceValue(options, {
        runId: input.runId,
        stepRunId: id,
        field: "input",
        kind: "step_input",
        value: redactedInput,
        createdAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
      });
      const spilledOutput = spillStepTraceValue(options, {
        runId: input.runId,
        stepRunId: id,
        field: "output",
        kind: "step_output",
        value: redactedOutput,
        createdAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
      });
      const spilledError = spillStepTraceValue(options, {
        runId: input.runId,
        stepRunId: id,
        field: "error",
        kind: "step_error",
        value: redactedError,
        createdAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
      });
      const spilledLogsSummary = spillStepTraceValue(options, {
        runId: input.runId,
        stepRunId: id,
        field: "logsSummary",
        kind: "step_logs_summary",
        value:
          input.logsSummary === undefined
            ? undefined
            : redact(input.logsSummary),
        createdAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
      });
      const spilledContextDiff = spillStepTraceValue(options, {
        runId: input.runId,
        stepRunId: id,
        field: "contextDiff",
        kind: "step_context_diff",
        value:
          input.contextDiff === undefined
            ? undefined
            : redact(input.contextDiff),
        createdAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
      });
      const step = WorkflowStepAttemptSchema.parse({
        id,
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        status: input.status,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        durationMs: input.durationMs ?? null,
        input: spilledInput.value,
        output: spilledOutput.value,
        error: spilledError.value,
        logsSummary: spilledLogsSummary.value,
        contextDiff: spilledContextDiff.value,
      });
      const params = {
        id: step.id,
        runId: step.runId,
        nodeId: step.nodeId,
        attempt: step.attempt,
        status: step.status,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        durationMs: step.durationMs,
        inputJson: maybeStringify(step.input),
        outputJson: maybeStringify(step.output),
        errorJson: maybeStringify(step.error),
        logsSummaryJson: maybeStringify(step.logsSummary),
        contextDiffJson: maybeStringify(step.contextDiff),
      };
      db.transaction(() => {
        const existing = db
          .prepare<[string, string, string, number], { id: string }>(
            `SELECT id FROM workflow_step_attempts
             WHERE id = ?
                OR (run_id = ? AND node_id = ? AND attempt = ?)
             LIMIT 1`,
          )
          .get(step.id, step.runId, step.nodeId, step.attempt);
        if (existing) {
          db.prepare(
            `UPDATE workflow_step_attempts
             SET id = @id,
                 run_id = @runId,
                 node_id = @nodeId,
                 attempt = @attempt,
                 status = @status,
                 started_at = @startedAt,
                 ended_at = @endedAt,
                 duration_ms = @durationMs,
                 input_json = @inputJson,
                 output_json = @outputJson,
                 error_json = @errorJson,
                 logs_summary_json = @logsSummaryJson,
                 context_diff_json = @contextDiffJson
             WHERE id = @existingId`,
          ).run({ ...params, existingId: existing.id });
        } else {
          db.prepare(
            `INSERT INTO workflow_step_attempts
             (id, run_id, node_id, attempt, status, started_at, ended_at,
              duration_ms, input_json, output_json, error_json, logs_summary_json,
              context_diff_json)
             VALUES
             (@id, @runId, @nodeId, @attempt, @status, @startedAt, @endedAt,
              @durationMs, @inputJson, @outputJson, @errorJson, @logsSummaryJson,
              @contextDiffJson)`,
          ).run(params);
        }
        for (const artifact of [
          ...spilledInput.artifacts,
          ...spilledOutput.artifacts,
          ...spilledError.artifacts,
          ...spilledLogsSummary.artifacts,
          ...spilledContextDiff.artifacts,
        ]) {
          upsertArtifact(db, artifact);
        }
      })();
      return {
        ...step,
      };
    },

    appendRunEvent(input: WorkflowRunEventInput) {
      const sequence = input.sequence ?? nextEventSequence(db, input.runId);
      const id = input.id ?? randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const redactedPayload =
        input.payload === undefined ? undefined : redact(input.payload);
      const spilledPayload = spillEventPayload(options, {
        runId: input.runId,
        stepRunId: input.stepRunId ?? null,
        eventId: id,
        value: redactedPayload,
        createdAt,
      });
      const event = WorkflowRunEventSchema.parse({
        id,
        runId: input.runId,
        stepRunId: input.stepRunId ?? null,
        sequence,
        level: input.level,
        kind: input.kind,
        message: input.message,
        payload: spilledPayload.value,
        createdAt,
      });
      db.transaction(() => {
        db.prepare(
          `INSERT INTO workflow_run_events
           (id, run_id, step_run_id, sequence, level, kind, message,
            payload_json, created_at)
           VALUES
           (@id, @runId, @stepRunId, @sequence, @level, @kind, @message,
            @payloadJson, @createdAt)`,
        ).run({
          id: event.id,
          runId: event.runId,
          stepRunId: event.stepRunId,
          sequence: event.sequence,
          level: event.level,
          kind: event.kind,
          message: event.message ?? null,
          payloadJson: maybeStringify(event.payload),
          createdAt: event.createdAt,
        });
        for (const artifact of spilledPayload.artifacts) {
          upsertArtifact(db, artifact);
        }
      })();
      return event;
    },

    recordArtifact(input: WorkflowArtifactInput): WorkflowArtifact {
      const artifact: WorkflowArtifact = {
        id: input.id ?? randomUUID(),
        runId: input.runId,
        stepRunId: input.stepRunId ?? null,
        kind: input.kind,
        path: input.path,
        preview: input.preview ?? null,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      upsertArtifact(db, artifact);
      return artifact;
    },

    listArtifacts(runId: string): WorkflowArtifact[] {
      const rows = db
        .prepare<[string], WorkflowArtifactRaw>(
          `SELECT * FROM workflow_artifacts
           WHERE run_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(runId);
      return rows.map(artifactFromRow);
    },

    readArtifactContent(
      runId: string,
      artifactId: string,
    ): WorkflowArtifactContent | null {
      if (!options.artifactRoot) return null;
      const row = db
        .prepare<[string, string], WorkflowArtifactRaw>(
          `SELECT * FROM workflow_artifacts
           WHERE run_id = ? AND id = ?
           LIMIT 1`,
        )
        .get(runId, artifactId);
      if (!row) return null;
      const artifact = artifactFromRow(row);
      const fullPath = resolveArtifactPath(options.artifactRoot, artifact.path);
      if (!fullPath) return null;
      try {
        return {
          artifact,
          content: JsonValueSchema.parse(
            JSON.parse(readFileSync(fullPath, "utf8")),
          ),
        };
      } catch {
        return null;
      }
    },

    pruneArtifactFiles(
      input: WorkflowArtifactPruneInput,
    ): WorkflowArtifactPruneResult {
      if (!options.artifactRoot) {
        return {
          scannedArtifacts: 0,
          deletedFiles: 0,
          missingFiles: 0,
          skippedUnsafePaths: 0,
        };
      }
      const rows = db
        .prepare<[string], WorkflowArtifactRaw>(
          `SELECT * FROM workflow_artifacts
           WHERE created_at < ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(input.createdBefore);
      const result: WorkflowArtifactPruneResult = {
        scannedArtifacts: rows.length,
        deletedFiles: 0,
        missingFiles: 0,
        skippedUnsafePaths: 0,
      };

      for (const row of rows) {
        const artifact = artifactFromRow(row);
        const fullPath = resolveArtifactPath(
          options.artifactRoot,
          artifact.path,
        );
        if (!fullPath) {
          result.skippedUnsafePaths += 1;
          continue;
        }
        if (!existsSync(fullPath)) {
          result.missingFiles += 1;
          continue;
        }
        try {
          if (!statSync(fullPath).isFile()) {
            result.skippedUnsafePaths += 1;
            continue;
          }
          unlinkSync(fullPath);
          result.deletedFiles += 1;
        } catch {
          if (existsSync(fullPath)) {
            result.skippedUnsafePaths += 1;
          } else {
            result.missingFiles += 1;
          }
        }
      }

      return result;
    },

    listRuns(filter: WorkflowRunFilter = {}) {
      return selectRunPage(db, filter).runs;
    },

    listRunsPage(filter: WorkflowRunFilter = {}): WorkflowRunPage {
      return selectRunPage(db, filter);
    },

    listStepAttempts(runId: string) {
      const rows = db
        .prepare<[string], WorkflowStepAttemptRaw>(
          `SELECT * FROM workflow_step_attempts
           WHERE run_id = ?
           ORDER BY rowid ASC`,
        )
        .all(runId);
      return rows.map(stepFromRow);
    },

    listRunEvents(runId: string) {
      const rows = db
        .prepare<[string], WorkflowRunEventRaw>(
          `SELECT * FROM workflow_run_events
           WHERE run_id = ?
           ORDER BY sequence ASC`,
        )
        .all(runId);
      return rows.map(eventFromRow);
    },
  };
}

function nextEventSequence(db: WasmDatabase, runId: string): number {
  const row = db
    .prepare<
      [string],
      { n: number | null }
    >(`SELECT max(sequence) AS n FROM workflow_run_events WHERE run_id = ?`)
    .get(runId);
  return (row?.n ?? 0) + 1;
}

function definitionToParams(def: WorkflowDefinition) {
  return {
    id: def.id,
    status: def.status,
    currentVersion: def.version,
    name: def.name,
    description: def.description ?? null,
    inputSchemaJson: maybeStringify(def.inputSchema),
    triggersJson: stringify(def.triggers),
    nodesJson: stringify(def.nodes),
    uiJson: maybeStringify(def.ui),
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

function versionToParams(def: WorkflowDefinition, createdAt: string) {
  return {
    workflowId: def.id,
    version: def.version,
    name: def.name,
    description: def.description ?? null,
    inputSchemaJson: maybeStringify(def.inputSchema),
    triggersJson: stringify(def.triggers),
    nodesJson: stringify(def.nodes),
    uiJson: maybeStringify(def.ui),
    createdAt,
  };
}

function runToParams(run: ReturnType<typeof WorkflowRunSchema.parse>) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    definitionSource: run.definitionSource,
    definitionSnapshotJson: maybeStringify(run.definitionSnapshot),
    mode: run.mode,
    triggerJson: stringify(run.trigger),
    status: run.status,
    inputJson: stringify(run.input),
    contextJson: stringify(run.context),
    currentNodeId: run.currentNodeId,
    waitingReason: run.waitingReason,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
  };
}

function definitionFromRow(row: WorkflowDefinitionRaw): WorkflowDefinition {
  return normalizeWorkflowDefinitionGraph(
    WorkflowDefinitionSchema.parse({
      id: row.id,
      version: row.current_version,
      status: row.status,
      name: row.name,
      description: row.description ?? undefined,
      inputSchema: parseOptionalJson(row.input_schema_json),
      triggers: parseJson(row.triggers_json),
      nodes: parseJson(row.nodes_json),
      ui: parseOptionalJson(row.ui_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
}

function definitionFromVersionRow(row: WorkflowVersionRaw): WorkflowDefinition {
  return normalizeWorkflowDefinitionGraph(
    WorkflowDefinitionSchema.parse({
      id: row.workflow_id,
      version: row.version,
      status: "published",
      name: row.name,
      description: row.description ?? undefined,
      inputSchema: parseOptionalJson(row.input_schema_json),
      triggers: parseJson(row.triggers_json),
      nodes: parseJson(row.nodes_json),
      ui: parseOptionalJson(row.ui_json),
      createdAt: row.created_at,
      updatedAt: row.created_at,
    }),
  );
}

function runFromRow(row: WorkflowRunRaw) {
  return WorkflowRunSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    definitionSource: row.definition_source,
    definitionSnapshot: parseOptionalJson(row.definition_snapshot_json),
    mode: row.mode,
    trigger: parseRedactedJson(row.trigger_json),
    status: row.status,
    input: parseRedactedJson(row.input_json),
    context: parseRedactedJson(row.context_json),
    currentNodeId: row.current_node_id,
    waitingReason: row.waiting_reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
  });
}

function stepFromRow(row: WorkflowStepAttemptRaw) {
  return WorkflowStepAttemptSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    input: parseOptionalRedactedJson(row.input_json),
    output: parseOptionalRedactedJson(row.output_json),
    error: parseOptionalRedactedJson(row.error_json),
    logsSummary: parseOptionalRedactedJson(row.logs_summary_json),
    contextDiff: parseOptionalRedactedJson(row.context_diff_json),
  });
}

function eventFromRow(row: WorkflowRunEventRaw) {
  return WorkflowRunEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    sequence: row.sequence,
    level: row.level,
    kind: row.kind,
    message: row.message ?? undefined,
    payload: parseOptionalRedactedJson(row.payload_json),
    createdAt: row.created_at,
  });
}

function spillStepTraceValue(
  options: WorkflowStoreOptions,
  input: {
    runId: string;
    stepRunId: string;
    field: "input" | "output" | "error" | "logsSummary" | "contextDiff";
    kind:
      | "step_input"
      | "step_output"
      | "step_error"
      | "step_logs_summary"
      | "step_context_diff";
    value: JsonValue | undefined;
    createdAt: string;
  },
): { value: JsonValue | undefined; artifacts: WorkflowArtifact[] } {
  if (input.value === undefined || !options.artifactRoot) {
    return { value: input.value, artifacts: [] };
  }
  const json = stringify(input.value);
  const byteLength = Buffer.byteLength(json, "utf8");
  const limit = options.inlineJsonByteLimit ?? DEFAULT_INLINE_JSON_BYTE_LIMIT;
  if (byteLength <= limit) return { value: input.value, artifacts: [] };

  const preview = json.slice(
    0,
    options.artifactPreviewBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES,
  );
  const artifactSuffix =
    input.field === "logsSummary"
      ? "logs_summary"
      : input.field === "contextDiff"
        ? "context_diff"
        : input.field;
  const fileName =
    input.field === "logsSummary"
      ? "logs-summary.json"
      : input.field === "contextDiff"
        ? "context-diff.json"
        : `${input.field}.json`;
  const artifactId = `${safeArtifactSegment(input.stepRunId)}_${artifactSuffix}`;
  const relativePath = [
    "runs",
    safeArtifactSegment(input.runId),
    "steps",
    safeArtifactSegment(input.stepRunId),
    fileName,
  ].join("/");
  const fullPath = path.join(options.artifactRoot, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  writeFileSync(fullPath, json, { encoding: "utf8", mode: 0o600 });

  const artifact: WorkflowArtifact = {
    id: artifactId,
    runId: input.runId,
    stepRunId: input.stepRunId,
    kind: input.kind,
    path: relativePath,
    preview,
    createdAt: input.createdAt,
  };
  return {
    value: {
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        preview,
        byteLength,
      },
    },
    artifacts: [artifact],
  };
}

function spillEventPayload(
  options: WorkflowStoreOptions,
  input: {
    runId: string;
    stepRunId: string | null;
    eventId: string;
    value: JsonValue | undefined;
    createdAt: string;
  },
): { value: JsonValue | undefined; artifacts: WorkflowArtifact[] } {
  if (input.value === undefined || !options.artifactRoot) {
    return { value: input.value, artifacts: [] };
  }
  const json = stringify(input.value);
  const byteLength = Buffer.byteLength(json, "utf8");
  const limit = options.inlineJsonByteLimit ?? DEFAULT_INLINE_JSON_BYTE_LIMIT;
  if (byteLength <= limit) return { value: input.value, artifacts: [] };

  const preview = json.slice(
    0,
    options.artifactPreviewBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES,
  );
  const artifactId = `${safeArtifactSegment(input.eventId)}_payload`;
  const relativePath = [
    "runs",
    safeArtifactSegment(input.runId),
    "events",
    safeArtifactSegment(input.eventId),
    "payload.json",
  ].join("/");
  const fullPath = path.join(options.artifactRoot, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  writeFileSync(fullPath, json, { encoding: "utf8", mode: 0o600 });

  const artifact: WorkflowArtifact = {
    id: artifactId,
    runId: input.runId,
    stepRunId: input.stepRunId,
    kind: "event_payload",
    path: relativePath,
    preview,
    createdAt: input.createdAt,
  };
  return {
    value: {
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        preview,
        byteLength,
      },
    },
    artifacts: [artifact],
  };
}

function spillRunContext(
  options: WorkflowStoreOptions,
  input: {
    runId: string;
    value: JsonValue;
    createdAt: string;
  },
): { value: JsonValue; artifacts: WorkflowArtifact[] } {
  if (!options.artifactRoot) {
    return { value: input.value, artifacts: [] };
  }
  const json = stringify(input.value);
  const byteLength = Buffer.byteLength(json, "utf8");
  const limit = options.inlineJsonByteLimit ?? DEFAULT_INLINE_JSON_BYTE_LIMIT;
  if (byteLength <= limit) return { value: input.value, artifacts: [] };

  const preview = json.slice(
    0,
    options.artifactPreviewBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES,
  );
  const artifactId = `${safeArtifactSegment(input.runId)}_context`;
  const relativePath = [
    "runs",
    safeArtifactSegment(input.runId),
    "context.json",
  ].join("/");
  const fullPath = path.join(options.artifactRoot, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  writeFileSync(fullPath, json, { encoding: "utf8", mode: 0o600 });

  const artifact: WorkflowArtifact = {
    id: artifactId,
    runId: input.runId,
    stepRunId: null,
    kind: "run_context",
    path: relativePath,
    preview,
    createdAt: input.createdAt,
  };
  return {
    value: {
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        preview,
        byteLength,
      },
    },
    artifacts: [artifact],
  };
}

function spillRunInput(
  options: WorkflowStoreOptions,
  input: {
    runId: string;
    value: JsonValue;
    createdAt: string;
  },
): { value: JsonValue; artifacts: WorkflowArtifact[] } {
  if (!options.artifactRoot) {
    return { value: input.value, artifacts: [] };
  }
  const json = stringify(input.value);
  const byteLength = Buffer.byteLength(json, "utf8");
  const limit = options.inlineJsonByteLimit ?? DEFAULT_INLINE_JSON_BYTE_LIMIT;
  if (byteLength <= limit) return { value: input.value, artifacts: [] };

  const preview = json.slice(
    0,
    options.artifactPreviewBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES,
  );
  const artifactId = `${safeArtifactSegment(input.runId)}_input`;
  const relativePath = [
    "runs",
    safeArtifactSegment(input.runId),
    "input.json",
  ].join("/");
  const fullPath = path.join(options.artifactRoot, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true, mode: 0o700 });
  writeFileSync(fullPath, json, { encoding: "utf8", mode: 0o600 });

  const artifact: WorkflowArtifact = {
    id: artifactId,
    runId: input.runId,
    stepRunId: null,
    kind: "run_input",
    path: relativePath,
    preview,
    createdAt: input.createdAt,
  };
  return {
    value: {
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        preview,
        byteLength,
      },
    },
    artifacts: [artifact],
  };
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function resolveArtifactPath(
  root: string,
  relativePath: string,
): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  return resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
    ? resolvedPath
    : null;
}

function upsertArtifact(db: WasmDatabase, artifact: WorkflowArtifact): void {
  db.prepare(
    `INSERT INTO workflow_artifacts
     (id, run_id, step_run_id, kind, path, preview, created_at)
     VALUES
     (@id, @runId, @stepRunId, @kind, @path, @preview, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       run_id = excluded.run_id,
       step_run_id = excluded.step_run_id,
       kind = excluded.kind,
       path = excluded.path,
       preview = excluded.preview,
       created_at = excluded.created_at`,
  ).run(artifactToParams(artifact));
}

function artifactToParams(artifact: WorkflowArtifact) {
  return {
    id: artifact.id,
    runId: artifact.runId,
    stepRunId: artifact.stepRunId,
    kind: artifact.kind,
    path: artifact.path,
    preview: artifact.preview,
    createdAt: artifact.createdAt,
  };
}

function artifactFromRow(row: WorkflowArtifactRaw): WorkflowArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    kind: row.kind,
    path: row.path,
    preview: row.preview,
    createdAt: row.created_at,
  };
}

function stringify(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function maybeStringify(value: unknown): string | null {
  return value === undefined ? null : stringify(value);
}

function selectRunPage(
  db: WasmDatabase,
  filter: WorkflowRunFilter = {},
): WorkflowRunPage {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.workflowId) {
    clauses.push("workflow_id = @workflowId");
    params.workflowId = filter.workflowId;
  }
  if (filter.mode) {
    clauses.push("mode = @mode");
    params.mode = filter.mode;
  }
  if (filter.status) {
    clauses.push("status = @status");
    params.status = filter.status;
  }
  if (filter.triggerId) {
    clauses.push("json_extract(trigger_json, '$.triggerId') = @triggerId");
    params.triggerId = filter.triggerId;
  }
  if (filter.createdFrom) {
    clauses.push("created_at >= @createdFrom");
    params.createdFrom = filter.createdFrom;
  }
  if (filter.createdTo) {
    clauses.push("created_at <= @createdTo");
    params.createdTo = filter.createdTo;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.min(Math.max(filter.offset ?? 0, 0), 1_000_000);
  const rows = db
    .prepare<[Record<string, unknown>], WorkflowRunRaw>(
      `SELECT * FROM workflow_runs ${where}
       ORDER BY created_at DESC, id DESC LIMIT ${limit + 1} OFFSET ${offset}`,
    )
    .all(params);
  const runs = rows
    .map(runFromRow)
    .filter(
      (run) =>
        !filter.triggerId || runTriggerId(run.trigger) === filter.triggerId,
    );
  const pageRuns = runs.slice(0, limit);
  const hasMore = rows.length > limit || runs.length > limit;
  return {
    runs: pageRuns,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + pageRuns.length : null,
  };
}

function runTriggerId(trigger: JsonValue): string | null {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    return null;
  }
  const value = trigger["triggerId"];
  return typeof value === "string" ? value : null;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseOptionalJson(value: string | null): unknown {
  return value == null ? undefined : parseJson(value);
}

function parseRedactedJson(value: string): JsonValue {
  return redact(parseJson(value) as JsonValue);
}

function parseOptionalRedactedJson(
  value: string | null,
): JsonValue | undefined {
  return value == null ? undefined : parseRedactedJson(value);
}

function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : redact(child);
  }
  return out;
}

const SECRET_KEY_RE = /api[_-]?key|authorization|password|secret|token/i;

interface WorkflowDefinitionRaw {
  id: string;
  status: string;
  current_version: number;
  name: string;
  description: string | null;
  input_schema_json: string | null;
  triggers_json: string;
  nodes_json: string;
  ui_json: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkflowVersionRaw {
  workflow_id: string;
  version: number;
  name: string;
  description: string | null;
  input_schema_json: string | null;
  triggers_json: string;
  nodes_json: string;
  ui_json: string | null;
  created_at: string;
}

interface WorkflowRunRaw {
  id: string;
  workflow_id: string;
  workflow_version: number;
  definition_source: string;
  definition_snapshot_json: string | null;
  mode: string;
  trigger_json: string;
  status: string;
  input_json: string;
  context_json: string;
  current_node_id: string | null;
  waiting_reason: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
}

interface WorkflowStepAttemptRaw {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  logs_summary_json: string | null;
  context_diff_json: string | null;
}

interface WorkflowRunEventRaw {
  id: string;
  run_id: string;
  step_run_id: string | null;
  sequence: number;
  level: string;
  kind: string;
  message: string | null;
  payload_json: string | null;
  created_at: string;
}

interface WorkflowArtifactRaw {
  id: string;
  run_id: string;
  step_run_id: string | null;
  kind: string;
  path: string;
  preview: string | null;
  created_at: string;
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>;
