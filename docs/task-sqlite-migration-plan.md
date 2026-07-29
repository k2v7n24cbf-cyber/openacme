# OpenAcme Local Flap RCA

Date: 2026-07-29
Environment: local OpenAcme production, `http://127.0.0.1:3456`

## Symptom

The local OpenAcme service appeared to flap. Health checks to
`http://127.0.0.1:3456/api/health` intermittently failed with connection
errors even though the port was still held by the Node process.

Observed process state:

- Listener: `node` PID `81970` on `127.0.0.1:3456`
- Health: repeated `curl` failures
- Process: running, CPU-bound (`R`, over 100% CPU in sampled check)
- Log: repeated `qualys-admin` warnings and task activity in the same time window

## Root Cause

The dispatcher and agent runtime repeatedly call `TaskStore.list(filter)`.
That method is file-backed and does not use an index. Even when the caller
passes a selective filter such as `assignee` or `session_id`, it first scans
every markdown task file under:

`/Users/alenbohcelyan/.openacme/tasks/*.md`

For each file, it synchronously reads and parses YAML frontmatter:

- `packages/tasks/src/store.ts`: `TaskStore.list()`
- `packages/tasks/src/store.ts`: `parseTaskFile()`
- `packages/server/src/dispatcher.ts`: `bindUnboundTasks()`
- `packages/server/src/dispatcher.ts`: `shouldSpawn()`
- `packages/agent-core/src/agent.ts`: task lookup and prompt rendering

During the incident, `acme` created a burst of fresh-session Qualys test tasks
assigned to `qualys-admin`. Many of those tasks became `open` or
`in_progress` across separate sessions. That created a dispatcher wake/load
storm. Each dispatcher pass and agent turn caused repeated full task-directory
scans, which blocked the Node main thread with synchronous file reads and
frontmatter parsing.

The service therefore kept the TCP port open, but the event loop was too busy
to reliably answer health requests.

## Triggering Workload

The hot task files were `QUALYS HUMAN QUERY TEST ...` tasks assigned to
`qualys-admin`, including:

- `/Users/alenbohcelyan/.openacme/tasks/908.md`
- `/Users/alenbohcelyan/.openacme/tasks/909.md`
- `/Users/alenbohcelyan/.openacme/tasks/910.md`
- `/Users/alenbohcelyan/.openacme/tasks/911.md`
- `/Users/alenbohcelyan/.openacme/tasks/913.md`
- `/Users/alenbohcelyan/.openacme/tasks/914.md`
- `/Users/alenbohcelyan/.openacme/tasks/915.md`
- `/Users/alenbohcelyan/.openacme/tasks/916.md`
- `/Users/alenbohcelyan/.openacme/tasks/917.md`
- `/Users/alenbohcelyan/.openacme/tasks/918.md`
- `/Users/alenbohcelyan/.openacme/tasks/919.md`
- `/Users/alenbohcelyan/.openacme/tasks/920.md`
- `/Users/alenbohcelyan/.openacme/tasks/921.md`
- `/Users/alenbohcelyan/.openacme/tasks/922.md`
- `/Users/alenbohcelyan/.openacme/tasks/923.md`
- `/Users/alenbohcelyan/.openacme/tasks/924.md`
- `/Users/alenbohcelyan/.openacme/tasks/925.md`
- `/Users/alenbohcelyan/.openacme/tasks/926.md`
- `/Users/alenbohcelyan/.openacme/tasks/927.md`
- `/Users/alenbohcelyan/.openacme/tasks/928.md`
- `/Users/alenbohcelyan/.openacme/tasks/929.md`
- `/Users/alenbohcelyan/.openacme/tasks/930.md`
- `/Users/alenbohcelyan/.openacme/tasks/931.md`
- `/Users/alenbohcelyan/.openacme/tasks/932.md`
- `/Users/alenbohcelyan/.openacme/tasks/933.md`

## Why This Was Not a Normal Crash Loop

Earlier logs showed historical `EADDRINUSE` and an `AbortError`, but the
current failing state was different:

- The current PID still owned the port.
- The process was CPU-bound rather than exited.
- Health failed because request handling was starved, not because no process
  existed.

## Recommended Fix

Move canonical task state from markdown files to SQLite. Comments and events
already live in SQLite (`task_comments`, `task_events`), so storing task
frontmatter/body in a `tasks` table is the natural local fix.

Minimal local plan:

1. Add a SQLite `tasks` table with columns for current frontmatter fields and
   markdown body.
2. Import existing `/Users/alenbohcelyan/.openacme/tasks/*.md` files once at
   startup if the table is empty.
3. Change `TaskStore.get/list/create/update/delete` to use SQLite.
4. Leave existing markdown files as backup; stop writing new task state to
   markdown.
5. Validate task create/update/list/comment flows and dispatcher health.

Short-term mitigation, if needed before SQLite migration:

- Add an in-memory index/cache in `TaskStore` so filtered `list()` calls do not
  synchronously reread every task file on every dispatcher pass.

## SQLite Migration Plan

This is the local-prod plan. It targets a testable, deployable fix for the
current local platform, not a broad upstream migration product with dual-write
or long downgrade support.

### Development Protocol

This migration is developed as a repeated slice loop:

1. Read this document before opening a slice.
2. Tighten the active slice into a concrete goal, tests, implementation scope,
   and exit criteria.
3. Add or update failing tests first.
4. Implement the minimum production-grade code needed for that slice.
5. Run the focused tests for the slice, then widen validation when the slice
   touches shared behavior.
6. Update this document before moving on:
   - mark what changed
   - record the tests that proved it
   - record any changed decision or discovered constraint
   - name the next slice
7. Do not start the next slice while the current slice has unrecorded behavior,
   failing focused tests, or undocumented decisions.

Every slice must keep these invariants visible:

- `system_blocked` remains a supported non-terminal status.
- `TaskStore` remains the public API boundary for callers.
- Comments and events remain in SQLite.
- Markdown task files are import/backup only after the SQL-backed store takes
  over.
- DB-level correctness for same-session `in_progress` races comes from SQLite,
  not only from the in-process mutex.

#### Completed Slice: Schema, Import, and SQL Read Path

Status: completed on 2026-07-29.

Scope: Milestone 1/2/3 foundation, bounded to schema, import, and SQL read
path.

Goal:

- Create SQL task schema and bootstrap it through the existing DB migration
  path.
- Allow `TaskStore` to import existing markdown tasks once when SQL is empty.
- Make `get()` and `list(filter)` read from SQL when a DB handle is provided.
- Keep create/update/delete file-backed for this slice; write path moves in the
  next slice.

Implemented:

- Added Drizzle schema and generated migration `0016_curvy_black_bird.sql` for
  `tasks` and `task_meta`.
- Added `tasks_status_check`, covering `system_blocked`.
- Added indexed read paths for assignee/status, session/status, creator, team,
  parent, and DB-level same-session `in_progress` partial unique index.
- Added optional structural DB port to `TaskStore`.
- Added one-time import from markdown into SQL when a DB handle is provided and
  the SQL `tasks` table is empty.
- Added SQL-backed `get()` and `list(filter)` read paths while keeping the
  public `TaskStore` API unchanged.

Validation:

- DB clean bootstrap exposes `tasks`, `task_meta`, and task indexes.
- SQL-backed `TaskStore` imports markdown tasks, including `system_blocked`.
- SQL-backed `TaskStore.list(filter)` still works when markdown files are
  removed after import.
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts`
- `pnpm --filter @openacme/tasks test -- sql-store.test.ts`
- `pnpm --filter @openacme/tasks test -- store.test.ts`
- `pnpm --filter @openacme/db check-types`
- `pnpm --filter @openacme/tasks check-types`

Known boundary:

- Production/server wiring is intentionally not enabled yet. Writes are still
  file-backed in this slice, so passing a DB handle to production `TaskStore`
  must wait until SQL create/update/delete are implemented.

#### Completed Slice: SQL Write Path

Status: completed on 2026-07-29.

Scope: Milestone 4 write path.

Goal:

- Make SQL-backed `TaskStore.create()`, `update()`,
  `backfillCreatedInSessionId()`, `delete()`, and `park()` transactional.
- Use `BEGIN IMMEDIATE` through `db.transaction(...).immediate()`.
- Use `task_meta.next_id` for ID allocation.
- Preserve existing validation, recurrence, dependency, event, comment, and
  `onChange` semantics.
- Map DB partial unique-index conflicts to existing `session_busy`
  `TaskStoreError`.

Implemented:

- SQL-backed create allocates IDs from `task_meta.next_id`.
- SQL-backed create/update/backfill/delete/park run inside
  `db.transaction(...).immediate()`.
- SQL-backed create/update/delete no longer write live task markdown files.
- SQL-backed update preserves recurrence, dependency, `system_blocked`, event,
  and `onChange` semantics.
- SQL-backed delete removes task rows and task comments.
- SQLite partial unique-index conflicts are mapped to `session_busy`.

Validation:

- SQL-backed create does not write new markdown task files and is readable from
  SQL.
- Parallel SQL-backed create produces unique IDs.
- Parallel SQL-backed updates trying to set two tasks in the same session to
  `in_progress` result in exactly one success and one `session_busy` failure.
- SQL-backed update preserves `system_blocked` semantics, including clearing
  `start_at`.
- SQL-backed delete removes the task row and deletes task comments.
- `pnpm --filter @openacme/tasks test -- sql-store.test.ts`
- `pnpm --filter @openacme/tasks test -- store.test.ts`
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts`
- `pnpm --filter @openacme/tasks check-types`
- `pnpm --filter @openacme/db check-types`

Known boundary:

- `AgentManager` still constructs `TaskStore` without the DB handle, so the
  running platform remains file-backed until the next slice wires production
  construction and integration tests.

#### Completed Slice: Production Wiring and Integration

Status: completed on 2026-07-29.

Scope: Milestone 6 plus the production wiring needed to make `/api/home` stop
scanning markdown task files.

Goal:

- Pass the existing `state.db` handle into the shared server `TaskStore`.
- Prove server routes and dispatcher tests still work with SQL-backed tasks.
- Prove `/api/home` uses the SQL-backed task store through unchanged manager
  APIs.
- Keep manual deploy/runtime validation isolated to `~/.openacme-test`; do not
  touch `~/.openacme`.

Implemented:

- `AgentManager` now passes its existing `state.db` handle into the shared
  `TaskStore`.
- Server route tests prove `createApp` writes task state to SQL and does not
  create new live markdown task files.
- Dispatcher tests now run against SQL-backed `TaskStore`.

Validation:

- `pnpm --filter @openacme/tasks build`
- `pnpm --filter @openacme/server test -- app-routes.test.ts`
- `pnpm --filter @openacme/server test -- dispatcher.test.ts`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/tasks check-types`
- `pnpm --filter @openacme/db check-types`
- `pnpm --filter @openacme/tasks test -- store.test.ts`
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts`

Known boundary:

- No manual runtime/deploy check has been run yet. If needed, it must use
  `~/.openacme-test`, not `~/.openacme`.

#### Completed Slice: Performance and Deployable Validation

Status: completed on 2026-07-29.

Scope: Milestone 7.

Goal:

- Prove the original `/api/home` timeout class is fixed with a high task count.
- Prove production builds with the SQL task migration and wiring.
- Keep all runtime/manual validation isolated to `~/.openacme-test`.

Implemented:

- Added a high-count `/api/home` regression test with 750 SQL-backed tasks.
- The performance test asserts no live markdown task files are written for SQL
  task state.
- The test exercises the real `createApp` / `AgentManager` wiring.

Validation:

- `pnpm --filter @openacme/server test -- home-sql-performance.test.ts`
- `pnpm --filter @openacme/server test -- app-routes.test.ts`
- `pnpm --filter @openacme/server test -- dispatcher.test.ts`
- `pnpm --filter @openacme/tasks test -- store.test.ts`
- `pnpm --filter @openacme/db test -- clean-bootstrap.test.ts`
- `pnpm --filter @openacme/server check-types`
- `pnpm --filter @openacme/tasks check-types`
- `pnpm --filter @openacme/db check-types`
- `pnpm --filter @openacme/db build`
- `pnpm --filter @openacme/tasks build`
- `pnpm --filter @openacme/server build`

Runtime note:

- No manual runtime deploy was needed for this slice. If one is needed later,
  it must use `~/.openacme-test`; `~/.openacme` must not be touched.

Exit criteria:

- High-count home validation passes within the test timeout.
- Relevant package builds pass.
- Plan document records final evidence and any residual risk.

#### Completed Slice: Standalone Migration Script

Status: completed on 2026-07-29.

Script:

```sh
node scripts/migrate-tasks-to-sql.mjs --data-dir ~/.openacme-test --dry-run
node scripts/migrate-tasks-to-sql.mjs --data-dir ~/.openacme-test --execute
```

Production command shape:

```sh
node scripts/migrate-tasks-to-sql.mjs --data-dir ~/.openacme --dry-run
node scripts/migrate-tasks-to-sql.mjs --data-dir ~/.openacme --execute --allow-openacme
```

Behavior:

- Default mode is `--dry-run`.
- Dry-run copies `state.db`, SQLite sidecars, and `tasks/` to a temp directory
  and runs the real migration there.
- Execute mode creates `state.db.pre-task-sqlite-*.bak` before opening the
  real DB.
- Execute mode refuses `~/.openacme` unless `--allow-openacme` is explicit.
- The script emits a structured JSON report with `before`, `after`, sample
  imported tasks, and classified errors.

Observed validation:

- `~/.openacme-test --dry-run`: imported 116 markdown tasks into the temp SQL
  copy, no conflicts, `next_id = 283`.
- `~/.openacme-test --execute`: imported 116 markdown tasks into
  `~/.openacme-test/state.db`, no conflicts, backup created at
  `state.db.pre-task-sqlite-2026-07-29T20-26-42-547Z.bak`.
- `~/.openacme --dry-run`: imported 636 markdown tasks into the temp SQL copy,
  no conflicts, `next_id = 935`. This did not mutate `~/.openacme`.

Error classes the script reports:

- `legacy_task_conflict`: duplicate legacy `in_progress` task state for the
  same session during import.
- `sqlite_constraint`: another SQLite constraint rejected the import.
- `schema_not_applied`: `tasks`/`task_meta` migration did not exist after DB
  bootstrap.
- `database_locked`: another OpenAcme process is holding the DB.
- `file_permission`: the script cannot create the backup or write the target
  data dir. This was observed in the sandbox before rerunning execute with
  filesystem permission.
- `unknown`: fallback with the raw error message and remediation hint.

Residual risk:

- Existing markdown task files are retained as migration backup. New task state
  is SQL-backed once the server starts with the updated `AgentManager`.
- Databases created before this migration import markdown task files only when
  the SQL `tasks` table is empty.

#### Completed Hardening: SQL Exception Handling

Status: completed on 2026-07-29.

Implemented:

- Legacy markdown import constraint failures are surfaced as typed
  `TaskStoreError` with code `migration_conflict`, instead of raw SQLite
  errors.
- SQL create constraint failures for same-session `in_progress` remain mapped
  to `session_busy`.
- Failed SQL create attempts roll back ID allocation; the next successful task
  does not skip IDs because of a rejected transaction.

Validation:

- `pnpm --filter @openacme/tasks test -- sql-store.test.ts`
- `pnpm --filter @openacme/tasks build`
- `pnpm --filter @openacme/tasks check-types`
- `pnpm --filter @openacme/tasks test -- store.test.ts`
- `pnpm --filter @openacme/server test -- app-routes.test.ts`

#### Completed Slice: Local Production Deploy

Status: completed on 2026-07-29.

Scope: deploy the SQL-backed task store to the local production data dir
`~/.openacme` after explicit approval to touch production data.

Steps performed:

- Rebuilt `@openacme/config`, `@openacme/db`, `@openacme/tasks`,
  `@openacme/server`, and `@openacme/cli`.
- Ran final prod dry-run against `~/.openacme`: 636 markdown tasks imported in
  the temp copy, no conflicts, `next_id = 935`.
- Stopped the launchd daemon before executing the migration.
- Executed the prod migration with
  `node scripts/migrate-tasks-to-sql.mjs --data-dir ~/.openacme --execute --allow-openacme`.
- Backup created:
  `/Users/alenbohcelyan/.openacme/state.db.pre-task-sqlite-2026-07-29T20-41-27-291Z.bak`.
- Restarted launchd with the local-stage CLI build:
  `/Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage/apps/cli/dist/index.js`.

Validation:

- Prod migration result: `taskRows = 636`, `inProgressConflicts = 0`,
  `nextId = 935`.
- `GET http://127.0.0.1:3456/api/health`: `200 OK`.
- `GET http://127.0.0.1:3456/api/home`: `200`, `time_total = 0.239453s`.
- 10 deterministic random task detail HTTP responses matched the corresponding
  legacy markdown files field-for-field: `599`, `682`, `584`, `845`, `535`,
  `338`, `740`, `436`, `212`, `515`.
- Post-deploy idempotency dry-run saw `before.taskRows = 636` and
  `after.taskRows = 636`.

Rollback:

- Stop the daemon.
- Restore the backup over `~/.openacme/state.db`.
- Restart the daemon using the previous known-good binary/branch.

### Target Outcome

- Task canonical state moves from markdown files to SQLite.
- Existing `task_comments` and `task_events` remain in SQLite.
- `TaskStore` public API remains stable for callers.
- `/api/home` no longer reads/parses every task markdown file.
- Dispatcher and agent turns no longer trigger full synchronous task-directory
  scans.
- Parallel updates cannot put two tasks in `in_progress` for the same
  `session_id`.

### Canonical Status Set

The migration must preserve the platform's full task status set, including
`system_blocked`.

Canonical non-terminal statuses:

- `open`
- `in_progress`
- `blocked`
- `system_blocked`

Terminal statuses:

- `done`
- `canceled`

SQLite status check:

```sql
status TEXT NOT NULL CHECK (
  status IN (
    'open',
    'in_progress',
    'blocked',
    'system_blocked',
    'done',
    'canceled'
  )
)
```

### Proposed Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'open',
      'in_progress',
      'blocked',
      'system_blocked',
      'done',
      'canceled'
    )
  ),
  assignee TEXT NOT NULL,
  session_id TEXT,
  created_by TEXT NOT NULL,
  created_in_session_id TEXT,
  parent_id TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  start_at TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  recurrence_json TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  team TEXT,
  body TEXT NOT NULL DEFAULT ''
);

CREATE TABLE task_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_tasks_one_in_progress_per_session
ON tasks(session_id)
WHERE session_id IS NOT NULL AND status = 'in_progress';

CREATE INDEX idx_tasks_assignee_status ON tasks(assignee, status);
CREATE INDEX idx_tasks_session_status ON tasks(session_id, status);
CREATE INDEX idx_tasks_created_by ON tasks(created_by);
CREATE INDEX idx_tasks_team ON tasks(team);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
```

### DB-Level Locking and Race Control

- Mutating operations use `BEGIN IMMEDIATE`.
- SQLite connection should have a non-zero `busy_timeout`, for example 5000 ms.
- Keep the existing in-process per-task mutex as an optimization, but do not
  rely on it for correctness.
- The partial unique index
  `idx_tasks_one_in_progress_per_session` is the DB-level guarantee that two
  parallel updates cannot both set different tasks to `in_progress` for the
  same non-null `session_id`.
- If SQLite raises the unique constraint, map it to the existing
  `session_busy` `TaskStoreError`.

### Milestone 0: Baseline and Failing Tests

Goal: capture the behavior we need before changing storage.

Tests to add first:

- `TaskStore` imports existing markdown tasks into SQLite.
- `TaskStore.list(filter)` works after markdown files are unavailable.
- Two parallel updates trying to set two tasks in the same session to
  `in_progress` result in exactly one success.
- `system_blocked` imports, lists, filters, and counts as non-terminal.
- `/api/home` can build its payload from SQL-backed tasks.

### Milestone 1: Schema and Migration Plumbing

Goal: create the SQLite tables and indexes without changing callers.

Implementation:

- Add `tasks` and `task_meta` schema.
- Add idempotent migration bootstrap.
- Initialize `task_meta.next_id` from max numeric markdown task id and `.seq`.
- Add table/index tests.

### Milestone 2: Markdown Import

Goal: preserve existing local task data.

Implementation:

- On `TaskStore` initialization, if the SQL `tasks` table is empty, import
  existing `/Users/alenbohcelyan/.openacme/tasks/*.md`.
- Preserve body and frontmatter fields.
- Skip malformed files the same way current `TaskStore.list()` skips them.
- Leave markdown files in place as backup.
- Stop treating markdown as live source of truth after import.

Tests:

- Full frontmatter/body round-trip.
- Idempotent second startup.
- Malformed markdown skipped/logged.
- `system_blocked` task imported correctly.

### Milestone 3: SQL Read Path

Goal: make reads fast and indexed.

Implementation:

- `get(id)` uses `SELECT ... WHERE id = ?`.
- `list(filter)` builds SQL predicates for:
  - `assignee`
  - `status`
  - `session_id`, including `null`
  - `parent_id`
  - `created_by`
  - `team`
- Preserve sort order by `created_at ASC`.
- Parse `depends_on_json` and `recurrence_json` back into the current `Task`
  shape.
- Validate rows with the current task schema.

Tests:

- Existing list/get tests pass.
- Filter combinations match current behavior.
- Removing/renaming markdown files after import does not break reads.

### Milestone 4: SQL Write Path

Goal: make create/update/delete transactional.

Implementation:

- `create()`:
  - `BEGIN IMMEDIATE`
  - allocate id from `task_meta.next_id`
  - insert task row
  - increment `next_id`
  - emit `task_assigned`
  - commit
- `update()`:
  - `BEGIN IMMEDIATE`
  - read current row
  - validate patch
  - validate dependency existence and cycles
  - validate session binding
  - run existing recurrence reset logic
  - update row
  - map partial unique-index conflicts to `session_busy`
  - emit existing status/recurrence events
  - commit
- `delete()`:
  - `BEGIN IMMEDIATE`
  - check dependents
  - delete task row
  - delete task comments
  - emit `task_deleted`
  - force cascade dependents using current semantics

Tests:

- Existing CRUD/update/delete/dependency/recurrence tests pass.
- Parallel create produces unique IDs.
- Parallel same-session `in_progress` update has exactly one winner.
- Losing parallel update returns `session_busy`.

### Milestone 5: Derived Methods and Dispatcher Semantics

Goal: preserve higher-level task behavior.

Methods to verify:

- `byAssignee`
- `byCreator`
- `byParent`
- `dependentsOf`
- `queueFor`
- `nextEligibleFor`
- `park`
- `sweepStale`
- `renderForPrompt`

Important status behavior:

- `system_blocked` must remain supported everywhere `TaskStatus` is accepted.
- `system_blocked` must count as non-terminal for UI/home summaries.
- Dispatcher behavior for `system_blocked` must match current behavior. If the
  current code intentionally avoids waking on `system_blocked`, preserve that
  and add a regression test.

### Milestone 6: Integration Tests

Goal: prove callers still work through the unchanged `TaskStore` API.

Cover:

- Agent tools:
  - `task_create`
  - `task_update`
  - `task_list`
  - `task_view`
  - `task_comment`
  - `task_comments`
- Server routes:
  - `GET /api/tasks`
  - `GET /api/tasks/:id`
  - `PATCH /api/tasks/:id`
  - `DELETE /api/tasks/:id`
  - `GET /api/tasks/:id/comments`
  - `GET /api/tasks/:id/events`
  - `GET /api/home`
- Dispatcher:
  - unbound task session allocation
  - ready open task wake
  - in-progress continuation
  - failure park
  - startup stale sweep

### Milestone 7: Local Performance Validation

Goal: verify the original timeout is fixed.

Automated:

- Seed hundreds or thousands of SQL task rows.
- Build `/api/home` payload.
- Assert no task markdown reads are required after import.

Manual local prod:

```sh
curl -sS --max-time 5 http://127.0.0.1:3456/api/health
curl -sS --max-time 5 http://127.0.0.1:3456/api/home
openacme status
```

Expected:

- Health returns within timeout.
- Home returns within timeout.
- Logs show migration/import summary once.
- No repeated markdown parse warnings from task listing.

### Rollback Note

For local use, existing markdown files remain as backup, but after migration
new task state is SQLite-only. Reverting to an older file-backed build will not
see tasks created after the SQLite migration unless an export step is added.
