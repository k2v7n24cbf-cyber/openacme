#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, resolveDataDir } from "../packages/config/dist/index.js";
import { createDatabase } from "../packages/db/dist/index.js";
import { TaskStore } from "../packages/tasks/dist/index.js";

const scriptName = path.basename(fileURLToPath(import.meta.url));

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node scripts/${scriptName} --data-dir <path> [--dry-run]
  node scripts/${scriptName} --data-dir <path> --execute [--allow-openacme]

Default mode is --dry-run. Dry-run copies state.db and tasks/ to a temp dir and
runs the real migration there. Execute mode mutates the requested data dir after
creating a state.db backup.

Safety:
  --execute refuses ~/.openacme unless --allow-openacme is also passed.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    dataDir: null,
    dryRun: true,
    execute: false,
    allowOpenacme: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--data-dir") {
      args.dataDir = argv[++i] ?? null;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      args.execute = false;
      continue;
    }
    if (arg === "--execute") {
      args.execute = true;
      args.dryRun = false;
      continue;
    }
    if (arg === "--allow-openacme") {
      args.allowOpenacme = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.dataDir) usage(1);
  return args;
}

function isDefaultOpenacmeDir(dataDir) {
  return (
    path.resolve(dataDir) === path.resolve(path.join(os.homedir(), ".openacme"))
  );
}

function copyIfExists(source, dest) {
  if (!fs.existsSync(source)) return false;
  fs.cpSync(source, dest, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  return true;
}

function countMarkdownTasks(tasksDir) {
  if (!fs.existsSync(tasksDir)) return 0;
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith(".") &&
        entry.name.endsWith(".md"),
    ).length;
}

function backupStateDb(dataDir) {
  const dbPath = path.join(dataDir, "state.db");
  if (!fs.existsSync(dbPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    dataDir,
    `state.db.pre-task-sqlite-${stamp}.bak`,
  );
  fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(
        sidecar,
        `${backupPath}${suffix}`,
        fs.constants.COPYFILE_EXCL,
      );
    }
  }
  return backupPath;
}

function prepareDryRunDataDir(sourceDataDir) {
  const dryRunRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "openacme-task-sqlite-dry-run-"),
  );
  copyIfExists(
    path.join(sourceDataDir, "tasks"),
    path.join(dryRunRoot, "tasks"),
  );
  for (const name of ["state.db", "state.db-wal", "state.db-shm"]) {
    copyIfExists(path.join(sourceDataDir, name), path.join(dryRunRoot, name));
  }
  return dryRunRoot;
}

function tableExists(db, name) {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function scalar(db, sql, fallback = 0) {
  const row = db.prepare(sql).get();
  if (!row) return fallback;
  const value = Object.values(row)[0];
  return typeof value === "number" ? value : fallback;
}

function inspectSqlState(db) {
  const hasTasks = tableExists(db, "tasks");
  const taskRows = hasTasks
    ? scalar(db, "SELECT COUNT(*) AS count FROM tasks")
    : 0;
  const inProgressConflicts = hasTasks
    ? scalar(
        db,
        "SELECT COUNT(*) AS count FROM (SELECT session_id FROM tasks WHERE session_id IS NOT NULL AND status = 'in_progress' GROUP BY session_id HAVING COUNT(*) > 1)",
      )
    : 0;
  const nextId = tableExists(db, "task_meta")
    ? (db.prepare("SELECT value FROM task_meta WHERE key = 'next_id'").get()
        ?.value ?? null)
    : null;
  return { hasTasks, taskRows, inProgressConflicts, nextId };
}

function classifyError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err ? err.code : null;
  if (code === "migration_conflict") {
    return {
      kind: "legacy_task_conflict",
      code,
      message,
      remediation:
        "Legacy markdown has duplicate in_progress task state for one session. Resolve task status/session_id in markdown or import into a clean tasks table after manual cleanup.",
    };
  }
  if (/no such table: tasks/i.test(message)) {
    return {
      kind: "schema_not_applied",
      code,
      message,
      remediation:
        "The DB migration did not create tasks/task_meta. Rebuild @openacme/db and rerun the script.",
    };
  }
  if (/constraint|unique/i.test(message)) {
    return {
      kind: "sqlite_constraint",
      code,
      message,
      remediation:
        "A DB constraint rejected the import. Inspect duplicate task IDs or same-session in_progress rows.",
    };
  }
  if (/database is locked|busy/i.test(message)) {
    return {
      kind: "database_locked",
      code,
      message,
      remediation:
        "Stop the running OpenAcme process or wait for the writer to finish, then rerun.",
    };
  }
  if (/eperm|eacces|permission/i.test(message)) {
    return {
      kind: "file_permission",
      code,
      message,
      remediation:
        "Run the script with permission to write the data dir, or create a writable backup location before retrying.",
    };
  }
  return {
    kind: "unknown",
    code,
    message,
    remediation:
      "Inspect the stack trace and rerun with the OpenAcme process stopped.",
  };
}

function runMigration(targetDataDir) {
  const config = ConfigSchema.parse({ dataDir: targetDataDir });
  const db = createDatabase(config);
  try {
    const before = inspectSqlState(db);
    const store = new TaskStore(path.join(targetDataDir, "tasks"), { db });
    const after = inspectSqlState(db);
    const importedSample = store
      .list()
      .slice(0, 5)
      .map((task) => ({
        id: task.id,
        status: task.status,
        session_id: task.session_id,
        title: task.title,
      }));
    return { before, after, importedSample };
  } finally {
    db.close();
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage(1);
  }

  const sourceDataDir = resolveDataDir(args.dataDir);
  if (
    args.execute &&
    isDefaultOpenacmeDir(sourceDataDir) &&
    !args.allowOpenacme
  ) {
    throw new Error(
      "Refusing to execute against ~/.openacme without --allow-openacme. Use --dry-run first.",
    );
  }

  const sourceTasksDir = path.join(sourceDataDir, "tasks");
  const sourceMarkdownTasks = countMarkdownTasks(sourceTasksDir);
  const mode = args.execute ? "execute" : "dry-run";

  const report = {
    ok: false,
    mode,
    sourceDataDir,
    targetDataDir: null,
    sourceMarkdownTasks,
    backupPath: null,
    result: null,
    error: null,
  };

  try {
    report.targetDataDir = args.execute
      ? sourceDataDir
      : prepareDryRunDataDir(sourceDataDir);
    report.backupPath = args.execute ? backupStateDb(sourceDataDir) : null;
    report.result = runMigration(report.targetDataDir);
    report.ok = true;
  } catch (err) {
    report.error = classifyError(err);
    process.exitCode = 1;
  } finally {
    console.log(JSON.stringify(report, null, 2));
  }
}

main();
