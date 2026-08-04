# Workflow Release Readiness Matrix

Branch: `local-stage-the-workflows`

Production rollout candidate: latest approved commit on
`origin/local-stage-the-workflows`

Executable workflow source proven by final test-env smoke: `f252bb4`

Local commits may temporarily be ahead while small workflow follow-up changes
are batched to avoid repeated full push-hook cycles. Those local commits are
not production rollout candidates until pushed and accepted by the hook suite.

Production data dir: `/Users/alenbohcelyan/.openacme`

Test data dir: `/Users/alenbohcelyan/.openacme-the-workflow`

## Current State

- M0-M8 first-release workflow runtime, persistence, API, triggers, MCP,
  synchronous agent calls, foreach, Python, run history, and run inspection are
  complete.
- M9 visual canvas authoring is complete.
- The branch is pushed to `origin/local-stage-the-workflows`.
- Production rollout has not been executed.
- Production rollout remains gated by explicit operator approval before
  touching `/Users/alenbohcelyan/.openacme`.

## Acceptance Matrix

| Requirement | Status | Evidence | Remaining gate |
| --- | --- | --- | --- |
| Global workflow scope for first release | Complete | `docs/workflow-engine-planning-brief.md` locks workflows and run history as global; route tests reject unsupported `teamId`/`agentId` scoping. | None before rollout. |
| Runtime node families `builtin.*`, `mcp.*`, `agent.*` | Complete | `docs/workflow-engine-planning-brief.md` locked decision 3; workflow schema and route tests passed in recorded evidence. | None before rollout. |
| Builtin flow control and variables | Complete | `docs/workflow-engine-planning-brief.md` locked decisions 7 and 8; workflow route tests and runner tests are recorded in `docs/workflow-engine-plan.md`. | None before rollout. |
| Python builtin execution | Complete | `docs/workflow-engine-planning-brief.md` locked decision 4; deployed foreach/Python smoke evidence is recorded in `docs/workflow-engine-plan.md`. | None before rollout. |
| MCP tool discovery and execution | Complete | M5 evidence in `docs/workflow-engine-plan.md` records workflow-safe MCP metadata, real MCP execution, persisted trace, and deployed smoke. | None before rollout. |
| Synchronous `agent.call` | Complete | M6 evidence in `docs/workflow-engine-plan.md` records dedicated workflow agent-call port, API/UI metadata, persisted trace, and deployed smoke. | None before rollout. |
| Durable `agent.task` wait/resume | Deferred by design | `docs/workflow-engine-planning-brief.md` locked decision 5 requires rejection with the first-release message. | Future milestone required. |
| Manual, scheduled, and webhook trigger run paths | Complete | M8 evidence in `docs/workflow-engine-plan.md` records manual, authenticated webhook, public webhook, path-routed public webhook, and scheduled dispatcher runs using durable run history. | None before rollout. |
| Task trigger dispatch | Deferred by design | `docs/workflow-engine-planning-brief.md` locked decision 6 and M8 close-out defer task/event trigger subscription and resume semantics. | Future milestone required. |
| Durable test and live run audit | Complete | M4 and later evidence in `docs/workflow-engine-plan.md` records run history, run detail, step logs, input/output/error inspection, failed-run inspection, rerun, artifacts, and run console behavior. | None before rollout. |
| Human workflow authoring UI | Complete | M9 evidence in `docs/workflow-engine-plan.md` records `/workflows` canvas, node palette, visual branch/foreach wiring, right-side inspector, ordering, save/publish/test, run overlays, and run evidence selection. | None before rollout. |
| Agent workflow authoring | Complete | `docs/workflow-engine-planning-brief.md` states agents use API/import-export through `openacme-workflow-author` and should not use Playwright; the M9.6 evidence records skill updates. | None before rollout. |
| Optional persisted canvas layout metadata | Complete | M9.6 evidence records `ui.canvas.nodes.<nodeId>.position`, import/export preservation, `ui: null` clearing, and runtime ignoring visual metadata. | None before rollout. |
| Deployed-style test-env validation | Complete | Final smoke recorded in `docs/workflow-engine-plan.md` and `docs/workflow-production-rollout.md`: `OPENACME_E2E_PORT=3458 OPENACME_E2E_DATA_DIR=/Users/alenbohcelyan/.openacme-the-workflow pnpm --dir apps/web exec playwright test workflows.spec.ts -g "canvas layout"` passed with 2 Chromium tests against `f252bb4`. | None before rollout. |
| No workflow smoke on port `3456` | Complete | Planning brief and rollout runbook gate test validation to port `3458`; final smoke evidence records port `3456` was not used. | None before rollout. |
| Production rollout safety | Ready, not executed | `docs/workflow-production-rollout.md` defines baseline, backup, restart, health, workflow API verification, and rollback steps. | Explicit operator approval is required before touching `/Users/alenbohcelyan/.openacme`. |

## Release Gate Summary

Implementation, test-env validation, and documentation are ready for production
rollout review. The only remaining release gate is explicit operator approval
to execute `docs/workflow-production-rollout.md` against
`/Users/alenbohcelyan/.openacme`.
