import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigSchema } from "@openacme/config";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/connection.js";

describe("hosted integration DB schema", () => {
  it("creates all hosted integration persistence tables from an empty DB", () => {
    withDb((db, dbPath) => {
      expect(existsSync(dbPath)).toBe(true);
      const tables = new Set(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          )
          .all()
          .map((row) => row.name),
      );

      for (const table of HOSTED_INTEGRATION_TABLES) {
        expect(tables.has(table), table).toBe(true);
      }
    });
  });

  it("enforces active pointer, draft file, generation file, and idempotency uniqueness", () => {
    withDb((db) => {
      insertGeneration(db, "gen_1");
      insertGeneration(db, "gen_2");

      db.prepare(
        "INSERT INTO hosted_integration_active_generations " +
          "(family_id, generation_id, activated_at, activated_by) " +
          "VALUES ('qualys', 'gen_1', '2026-08-13T00:00:00Z', 'tester')",
      ).run();
      expect(() =>
        db.prepare(
          "INSERT INTO hosted_integration_active_generations " +
            "(family_id, generation_id, activated_at, activated_by) " +
            "VALUES ('qualys', 'gen_2', '2026-08-13T00:01:00Z', 'tester')",
        ).run(),
      ).toThrow();

      db.prepare(
        "INSERT INTO hosted_integration_drafts " +
          "(id, family_id, source_revision_id, lock_id, status, created_at, updated_at) " +
          "VALUES ('draft_1', 'qualys', 'source_rev_1', 'lock_1', 'open', " +
          "'2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')",
      ).run();
      insertDraftFile(db);
      expect(() => insertDraftFile(db)).toThrow();

      insertGenerationFile(db);
      expect(() => insertGenerationFile(db)).toThrow();

      insertIdempotency(db);
      expect(() => insertIdempotency(db)).toThrow();
    });
  });

  it("prevents mutation of immutable generation file rows", () => {
    withDb((db) => {
      insertGeneration(db, "gen_1");
      insertGenerationFile(db);

      expect(() =>
        db.prepare(
          "UPDATE hosted_integration_generation_files " +
            "SET content = 'changed' WHERE generation_id = 'gen_1' AND path = 'qualys.py'",
        ).run(),
      ).toThrow(/generation files are immutable/);
      expect(() =>
        db.prepare(
          "DELETE FROM hosted_integration_generation_files " +
            "WHERE generation_id = 'gen_1' AND path = 'qualys.py'",
        ).run(),
      ).toThrow(/generation files are immutable/);
    });
  });

  it("rolls back active pointer updates with failed promotion state writes", () => {
    withDb((db) => {
      insertGeneration(db, "gen_1");
      db.prepare(
        "INSERT INTO hosted_integration_active_generations " +
          "(family_id, generation_id, activated_at, activated_by) " +
          "VALUES ('qualys', 'gen_1', '2026-08-13T00:00:00Z', 'tester')",
      ).run();

      const promote = db.transaction(() => {
        insertGeneration(db, "gen_2");
        db.prepare(
          "UPDATE hosted_integration_active_generations " +
            "SET generation_id = 'gen_2', activated_at = '2026-08-13T00:01:00Z', " +
            "previous_generation_id = 'gen_1' WHERE family_id = 'qualys'",
        ).run();
        throw new Error("promotion failed after active pointer update");
      });

      expect(() => promote()).toThrow("promotion failed");
      expect(
        db
          .prepare<[], { generation_id: string }>(
            "SELECT generation_id FROM hosted_integration_active_generations " +
              "WHERE family_id = 'qualys'",
          )
          .get()?.generation_id,
      ).toBe("gen_1");
      expect(
        db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM hosted_integration_generations " +
              "WHERE id = 'gen_2'",
          )
          .get()?.count,
      ).toBe(0);
    });
  });
});

const HOSTED_INTEGRATION_TABLES = [
  "hosted_integration_families",
  "hosted_integration_source_revisions",
  "hosted_integration_source_files",
  "hosted_integration_drafts",
  "hosted_integration_draft_files",
  "hosted_integration_examples",
  "hosted_integration_proposed_families",
  "hosted_integration_locks",
  "hosted_integration_environment_configs",
  "hosted_integration_secret_metadata",
  "hosted_integration_approvals",
  "hosted_integration_disablements",
  "hosted_integration_generations",
  "hosted_integration_generation_files",
  "hosted_integration_active_generations",
  "hosted_integration_generation_invocations",
  "hosted_integration_jobs",
  "hosted_integration_job_events",
  "hosted_integration_runs",
  "hosted_integration_artifacts",
  "hosted_integration_execution_logs",
  "hosted_integration_failure_buckets",
  "hosted_integration_failure_bucket_events",
  "hosted_integration_idempotency",
] as const;

function withDb(
  fn: (db: ReturnType<typeof createDatabase>, dbPath: string) => void,
): void {
  const dataDir = mkdtempSync(path.join(tmpdir(), "openacme-db-hosted-"));
  const dbPath = path.join(dataDir, "state.db");
  const db = createDatabase(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
  );
  try {
    fn(db, dbPath);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function insertGeneration(
  db: ReturnType<typeof createDatabase>,
  generationId: string,
): void {
  db.prepare(
    "INSERT INTO hosted_integration_generations " +
      "(id, family_id, source_revision_id, status, promoted_at, promoted_by, " +
      "manifest_json, tool_names_json, validation_json, provenance_json) " +
      "VALUES (?, 'qualys', 'source_rev_1', 'active', '2026-08-13T00:00:00Z', " +
      "'tester', '{}', '[]', '{}', '{}')",
  ).run(generationId);
}

function insertDraftFile(db: ReturnType<typeof createDatabase>): void {
  db.prepare(
    "INSERT INTO hosted_integration_draft_files " +
      "(draft_id, path, content, sha256, size, updated_at) " +
      "VALUES ('draft_1', 'qualys.py', 'content', 'sha', 7, " +
      "'2026-08-13T00:00:00Z')",
  ).run();
}

function insertGenerationFile(db: ReturnType<typeof createDatabase>): void {
  db.prepare(
    "INSERT INTO hosted_integration_generation_files " +
      "(generation_id, path, content, sha256, size, created_at) " +
      "VALUES ('gen_1', 'qualys.py', 'content', 'sha', 7, " +
      "'2026-08-13T00:00:00Z')",
  ).run();
}

function insertIdempotency(db: ReturnType<typeof createDatabase>): void {
  db.prepare(
    "INSERT INTO hosted_integration_idempotency " +
      "(key, operation, actor_id, target_json, request_hash, status, created_at) " +
      "VALUES ('idem_1', 'promote', 'tester', '{}', 'hash', 'completed', " +
      "'2026-08-13T00:00:00Z')",
  ).run();
}
