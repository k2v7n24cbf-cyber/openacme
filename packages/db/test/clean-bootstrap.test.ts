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
      expect(migrationCount).toBeGreaterThanOrEqual(14);

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
          "usage_events",
          "session_timeline_events",
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
          "idx_session_timeline_session",
          "idx_session_timeline_trace",
          "idx_session_timeline_forensic_run",
          "idx_session_timeline_usage",
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
