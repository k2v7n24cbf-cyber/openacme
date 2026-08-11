import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigSchema } from "@openacme/config";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/connection.js";

describe("database clean bootstrap", () => {
  it("creates a fresh state.db with the latest telemetry schema", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "openacme-db-bootstrap-"));
    const dbPath = path.join(dataDir, "state.db");
    const db = createDatabase(
      ConfigSchema.parse({
        dataDir,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    );

    try {
      expect(existsSync(dbPath)).toBe(true);

      const migrationCount = db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM __drizzle_migrations")
        .get()?.count;
      expect(migrationCount).toBeGreaterThanOrEqual(15);

      const tables = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          )
          .all()
          .map((row) => row.name),
      );
      expect([...tables]).toEqual(
        expect.arrayContaining([
          "__drizzle_migrations",
          "sessions",
          "messages",
          "tasks",
          "task_meta",
          "task_comments",
          "task_events",
          "objectives",
          "objective_events",
          "usage_events",
          "session_timeline_events",
          "workflow_definitions",
          "workflow_versions",
          "workflow_runs",
          "workflow_step_attempts",
          "workflow_run_events",
          "workflow_artifacts",
        ]),
      );

      const taskColumns = tableColumns(db, "tasks");
      expect(taskColumns).toEqual(
        expect.arrayContaining([
          "id",
          "title",
          "status",
          "assignee",
          "session_id",
          "objective_id",
          "created_by",
          "created_in_session_id",
          "parent_id",
          "depends_on_json",
          "start_at",
          "due_at",
          "created_at",
          "updated_at",
          "closed_at",
          "recurrence_json",
          "runs",
          "last_run_at",
          "team",
          "body",
        ]),
      );

      const objectiveColumns = tableColumns(db, "objectives");
      expect(objectiveColumns).toEqual(
        expect.arrayContaining([
          "id",
          "title",
          "description",
          "status",
          "owner_agent_id",
          "owner_session_id",
          "created_by",
          "created_in_session_id",
          "closeout_prompt",
          "created_at",
          "updated_at",
          "completed_at",
          "completion_summary",
          "last_closeout_fingerprint",
          "last_closeout_brief_json",
          "last_closeout_brief_at",
        ]),
      );

      const objectiveEventColumns = tableColumns(db, "objective_events");
      expect(objectiveEventColumns).toEqual(
        expect.arrayContaining([
          "id",
          "objective_id",
          "event_type",
          "actor",
          "summary",
          "details_json",
          "created_at",
        ]),
      );

      const usageColumns = tableColumns(db, "usage_events");
      expect(usageColumns).toEqual(
        expect.arrayContaining([
          "trace_id",
          "span_id",
          "forensic_run_id",
          "forensic_path",
          "provider_request_count",
        ]),
      );

      const sessionColumns = tableColumns(db, "sessions");
      expect(sessionColumns).toEqual(
        expect.arrayContaining([
          "kind",
          "turns_blocked_reason",
          "turns_blocked_at",
        ]),
      );

      const timelineColumns = tableColumns(db, "session_timeline_events");
      expect(timelineColumns).toEqual(
        expect.arrayContaining([
          "created_at_ms",
          "session_id",
          "event_type",
          "source",
          "trace_id",
          "span_id",
          "forensic_run_id",
          "usage_event_id",
          "duration_ms",
          "payload",
        ]),
      );

      const workflowRunColumns = tableColumns(db, "workflow_runs");
      expect(workflowRunColumns).toEqual(
        expect.arrayContaining([
          "workflow_id",
          "workflow_version",
          "definition_source",
          "mode",
          "trigger_json",
          "status",
          "input_json",
          "context_json",
          "duration_ms",
        ]),
      );

      const workflowStepColumns = tableColumns(db, "workflow_step_attempts");
      expect(workflowStepColumns).toEqual(
        expect.arrayContaining([
          "run_id",
          "node_id",
          "attempt",
          "status",
          "input_json",
          "output_json",
          "error_json",
          "context_diff_json",
        ]),
      );

      const indexes = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index'",
          )
          .all()
          .map((row) => row.name),
      );
      expect([...indexes]).toEqual(
        expect.arrayContaining([
          "idx_usage_trace",
          "idx_usage_forensic_run",
          "idx_tasks_assignee_status",
          "idx_tasks_session_status",
          "idx_tasks_created_by",
          "idx_tasks_team",
          "idx_tasks_parent",
          "idx_tasks_objective",
          "idx_tasks_one_in_progress_per_session",
          "idx_objectives_status",
          "idx_objectives_owner",
          "idx_objectives_owner_session",
          "idx_objective_events_objective",
          "idx_session_timeline_session",
          "idx_session_timeline_trace",
          "idx_session_timeline_forensic_run",
          "idx_session_timeline_usage",
          "idx_workflow_versions_workflow",
          "idx_workflow_runs_workflow",
          "idx_workflow_runs_status",
          "idx_workflow_runs_mode",
          "idx_workflow_steps_run",
          "idx_workflow_steps_run_node_attempt",
          "idx_workflow_events_run",
          "idx_workflow_events_run_sequence",
          "idx_workflow_artifacts_run",
        ]),
      );
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function tableColumns(
  db: ReturnType<typeof createDatabase>,
  tableName: string,
): string[] {
  return db
    .prepare<[string], { name: string }>(
      "SELECT name FROM pragma_table_info(?)",
    )
    .all(tableName)
    .map((row) => row.name);
}
