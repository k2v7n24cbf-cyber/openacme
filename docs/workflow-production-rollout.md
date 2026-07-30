# Workflow Production Rollout Runbook

Branch: `local-stage-the-workflows`

Current rollout candidate: latest approved commit on
`origin/local-stage-the-workflows`

Production data dir: `/Users/alenbohcelyan/.openacme`

Test data dir: `/Users/alenbohcelyan/.openacme-the-workflow`

## Status

- Workflow first release M0-M8 is complete.
- Workflow visual canvas authoring M9 is complete.
- The branch is pushed to `origin/local-stage-the-workflows`.
- Production rollout has not been executed from this runbook yet.

## Hard Gates

- Do not touch production data dir `/Users/alenbohcelyan/.openacme` until the
  operator explicitly approves production rollout.
- Do not use port `3456` for workflow development or workflow smoke tests.
- Production health checks on `3456` are allowed only as production deploy
  verification, not as test-environment validation.
- Every workflow runtime/UI validation before production must use
  `/Users/alenbohcelyan/.openacme-the-workflow` and port `3458`.
- Take a production `state.db` backup before restarting production on a build
  that includes new workflow migrations.

## Candidate Scope

The production candidate includes:

- Workflow runtime, persistence, runs, artifacts, triggers, MCP tool calls,
  synchronous agent calls, foreach, Python, and run history.
- `/workflows` visual canvas authoring:
  - node palette
  - right-side inspector settings
  - visual if/if-else and foreach wiring
  - selected-node ordering
  - run status overlays
  - failed-run evidence selection from the canvas
  - optional persisted visual layout metadata
- Workflow authoring skill updates for API-based agent workflow creation and
  inspection.
- DB migration `packages/db/drizzle/0019_crazy_talisman.sql`, adding optional
  `ui_json` columns for workflow definition/version visual metadata.

## Test Evidence Before Rollout

Latest local/origin evidence:

- Commit `6216f7d Add workflow canvas authoring UI`
  - pre-commit hook passed full `check-types`.
  - pre-commit hook passed full `test`: 32 tasks successful.
  - push hook passed full `build`: 19 tasks successful.
  - push hook passed server e2e: 19 files, 81 tests.
- Commit `dd29c9a Update workflow planning brief for canvas milestone`
  - pre-commit hook passed full `check-types`.
  - pre-commit hook passed full `test`: 32 tasks successful.
  - push hook passed full `build`: 19 tasks successful.
  - push hook passed server e2e: 19 files, 81 tests.
- Commit `53e7bfb Document workflow production rollout gate`
  - pre-commit hook passed full `check-types`.
  - pre-commit hook passed full `test`: 32 tasks successful.
  - push hook passed full `build`: 19 tasks successful.
  - push hook passed server e2e: 19 files, 81 tests.

Workflow-specific evidence recorded in `docs/workflow-engine-plan.md`:

- `@openacme/workflows` schema/build/typecheck tests passed.
- `@openacme/db` workflow store tests passed.
- `@openacme/server` workflow route tests passed.
- Web workflow helper tests passed.
- Full `apps/web/e2e/workflows.spec.ts` passed on non-3456 test ports.
- Deployed-style canvas layout smoke passed on port `3458` using
  `/Users/alenbohcelyan/.openacme-the-workflow`.

## Pre-Deploy Checks

Run from the workflow worktree:

```sh
cd /Users/alenbohcelyan/Documents/AIProjects/openacme-platform-engineering/worktrees/local-stage
git status --short --branch
git log -2 --oneline --decorate
```

Expected:

- Branch is `local-stage-the-workflows`.
- `HEAD` and `origin/local-stage-the-workflows` point to the same latest
  approved workflow rollout commit.
- No tracked file changes are present.
- Existing unrelated untracked `output/` may remain untracked and must not be
  included in workflow rollout commits.

Confirm test environment is not currently occupying the rollout smoke port:

```sh
curl -sS --max-time 2 http://127.0.0.1:3458/api/health
```

Expected before a test smoke: no listener or non-success response unless a
known test server is intentionally running.

Optional final workflow smoke before production:

```sh
OPENACME_E2E_PORT=3458 \
OPENACME_E2E_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow \
pnpm --dir apps/web exec playwright test workflows.spec.ts -g "canvas layout"
```

Expected: 2 Chromium tests pass, and the post-smoke `3458` health check has no
listener after teardown.

## Production Rollout Steps

Only run this section after explicit operator approval.

1. Record production baseline:

   ```sh
   node apps/cli/dist/index.js status --data-dir "$HOME/.openacme"
   node apps/cli/dist/index.js logs --data-dir "$HOME/.openacme" --tail 80
   curl -sS --max-time 5 http://127.0.0.1:3456/api/health
   ```

2. Build the candidate:

   ```sh
   pnpm build
   ```

3. Back up the production database:

   ```sh
   cp "$HOME/.openacme/state.db" "$HOME/.openacme/state.db.pre-workflows-$(date -u +%Y-%m-%dT%H-%M-%SZ).bak"
   ```

4. Restart production on the candidate build:

   ```sh
   node apps/cli/dist/index.js restart --data-dir "$HOME/.openacme" --no-browser
   ```

5. Verify production health:

   ```sh
   node apps/cli/dist/index.js status --data-dir "$HOME/.openacme"
   curl -sS --max-time 5 http://127.0.0.1:3456/api/health
   node apps/cli/dist/index.js logs --data-dir "$HOME/.openacme" --tail 120
   ```

6. Verify workflow UI/API availability through production only after the health
   check is green:

   ```sh
   curl -sS --max-time 5 http://127.0.0.1:3456/api/workflows
   ```

   Expected: authenticated/local-trusted response according to current
   production auth mode, not a process crash or connection failure.

## Rollback

If production health fails after restart:

1. Stop production:

   ```sh
   node apps/cli/dist/index.js stop --data-dir "$HOME/.openacme"
   ```

2. Restore the backup made in this rollout:

   ```sh
   cp "$HOME/.openacme/state.db.pre-workflows-<timestamp>.bak" "$HOME/.openacme/state.db"
   ```

3. Check out or reinstall the previous known-good production binary/branch.

4. Start production:

   ```sh
   node apps/cli/dist/index.js start --data-dir "$HOME/.openacme" --no-browser
   ```

5. Verify:

   ```sh
   curl -sS --max-time 5 http://127.0.0.1:3456/api/health
   node apps/cli/dist/index.js logs --data-dir "$HOME/.openacme" --tail 120
   ```

## Close-Out Record

After production rollout, append the actual result here:

- Approval source:
- Candidate commit:
- Backup path:
- Restart command:
- Health result:
- Workflow API/UI verification:
- Log review result:
- Rollback needed:
