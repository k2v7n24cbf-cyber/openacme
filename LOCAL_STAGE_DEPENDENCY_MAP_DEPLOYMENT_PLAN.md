# Local-Stage Dependency Map Deployment Plan

## Objective

Reintroduce the task dependency map feature onto `local-stage` safely, prove it locally against the prod-clone test data, adjust that test data if the deployed code requires persisted task provenance, then push `local-stage` to `origin/local-stage` only after local validation passes.

## Current Branch Facts

- Worktree: `/Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage`
- Branch: `local-stage`
- Current HEAD before rollout: `a760785 Revert "Restore task dependency map"`
- Feature commit available in history: `1a903d9 Restore task dependency map`
- Original feature branch still exists locally: `agent/task-dependency-map`
- The branch currently tracks `origin/local-stage`.

This means the deployment should not be a hand rewrite. The safest local-first path is to revert the revert commit on `local-stage`, then resolve only real conflicts introduced since the revert.

## Feature Surface

The feature from `1a903d9` touches these main areas:

- Web task board dependency view:
  - `apps/web/app/routes/tasks.tsx`
  - `apps/web/app/tasks/dependency-map.tsx`
  - `apps/web/app/tasks/dependency-graph.ts`
  - `apps/web/app/tasks/activity-filter.tsx`
  - task row/detail/type supporting changes
- Task API:
  - `GET /api/tasks` gains `last_activity_at`
  - `GET /api/tasks/source-sessions` resolves historical source sessions
  - `GET /api/task-preview` proxies narrow read-only local preview targets
- Task persistence:
  - task frontmatter gains `created_in_session_id`
  - `task_create` records the caller session id into `created_in_session_id`
  - repair support can backfill missing `created_in_session_id`
- SQLite-backed support stores:
  - message store can list recent task tool messages
  - event store can return latest task event time by task
- CLI:
  - task-source repair command support was added in the restored feature.

## Storage And Database Analysis

Task records are markdown files under the configured data directory, not SQLite rows. The new durable field, `created_in_session_id`, is parsed through a passthrough/defaulting frontmatter schema. Existing task markdown files without this key should still parse and load, defaulting the field to `null`.

SQLite schema migration is not expected for this feature because no new SQLite table or column is introduced by the feature diff. SQLite is still involved for historical provenance resolution:

- `messages.parts` is scanned for `tool-task_create`, `tool-task_update`, and `tool-task_list` tool parts.
- `sessions` is read to render source chat cards and titles.
- `task_events` is read to compute `last_activity_at`.

Therefore the database deployment work is a data compatibility and repair step, not a schema migration step:

- Inspect `/Users/alenbohcelyan/.openacme-test/state.db` for required tables and readable session titles.
- Inspect `/Users/alenbohcelyan/.openacme-test/tasks` for tasks missing `created_in_session_id`.
- Run the feature's dry-run source-session repair against the test data.
- If the dry-run resolves credible matches, run the write repair against `/Users/alenbohcelyan/.openacme-test` only.
- Recheck that no command or config points at `/Users/alenbohcelyan/.openacme`.

## Rollout Order

1. Confirm clean `local-stage` worktree.
2. Revert `a760785` locally to reapply the dependency map feature.
3. Resolve conflicts conservatively, keeping current `local-stage` fixes unless the feature explicitly owns the same behavior.
4. Run focused tests:
   - `pnpm --filter @openacme/tasks test`
   - `pnpm --filter @openacme/tools test -- tasks`
   - `pnpm --filter @openacme/server test -- app-routes`
   - `pnpm --filter web test -- task-dependency-graph task-activity-filter`
5. Run type/build checks sufficient for changed packages:
   - `pnpm --filter @openacme/tasks check-types`
   - `pnpm --filter @openacme/tools check-types`
   - `pnpm --filter @openacme/server check-types`
   - `pnpm --filter web check-types`
   - `pnpm --filter web build`
   - `pnpm --filter @openacme/server build`
6. Inspect `/Users/alenbohcelyan/.openacme-test` data compatibility.
7. Apply the test-data source-session repair if dry-run output is credible.
8. Start the local-stage server on `127.0.0.1:3212` using `/Users/alenbohcelyan/.openacme-test`, with dispatcher enabled, and no access to `/Users/alenbohcelyan/.openacme`.
9. Validate APIs:
   - `/api/health`
   - `/api/tasks`
   - `/api/tasks/source-sessions?ids=...`
   - `/api/home`
   - target stuck/session URLs if relevant to the user scenario
10. Validate the web app locally:
   - task board loads
   - dependency view renders
   - source chat cards show real session ids/titles where the database has them
   - navigating away and back does not crash
11. Commit the final local `local-stage` state.
12. Push `local-stage` to `origin/local-stage`.

## Stop Conditions

Do not push if any of these are true:

- The app still references `/Users/alenbohcelyan/.openacme` during test deployment.
- The test server cannot boot cleanly on `3212`.
- Task list, home, or dependency source-session APIs fail against the prod-clone test DB.
- The repair resolver relies on broad event-log searching instead of durable task frontmatter plus task tool outputs.
- Source chat titles are still systematically `Untitled session` when the underlying `sessions.title` values exist.
- Validation discovers a fresh database-closed lifecycle regression.

## Expected Database Adjustment

The likely adjustment is to backfill `created_in_session_id` in test task markdown files for tasks created before the field existed. The repair must be idempotent: tasks that already have `created_in_session_id` stay unchanged, unresolved tasks stay `null`, and the repair reports what it changed.

The repair target is `/Users/alenbohcelyan/.openacme-test` only. Production data at `/Users/alenbohcelyan/.openacme` is out of scope for this rollout unless separately approved.
